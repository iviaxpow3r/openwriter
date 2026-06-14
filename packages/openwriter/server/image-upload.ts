/**
 * Image upload and static serving for OpenWriter.
 * Images are stored in {DATA_DIR}/_images/ and referenced as relative paths in markdown.
 */

import { Router } from 'express';
import multer from 'multer';
import { existsSync, mkdirSync } from 'fs';
import { join, extname } from 'path';
import { randomUUID } from 'crypto';
import { isIP } from 'net';
import { lookup } from 'dns/promises';
import { getDataDir, ensureDataDir } from './helpers.js';
import express from 'express';

function getImagesDir(): string { return join(getDataDir(), '_images'); }

// ── SSRF guard for /api/download-image (MCP-8) ──────────────────────────────
// The endpoint server-side-fetches a caller-supplied URL. Without a guard an
// attacker can point it at internal services, the cloud metadata endpoint
// (169.254.169.254), or loopback — a classic SSRF. We allow only https, block
// every private / loopback / link-local / reserved IP range (resolving DNS
// first), follow redirects manually with re-validation at each hop, and cap
// both response size and request time.

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB, matches the upload limit
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0) return true;                       // 0.0.0.0/8 "this host"
  if (a === 10) return true;                      // 10.0.0.0/8 private
  if (a === 127) return true;                     // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true;        // 169.254.0.0/16 link-local (incl. metadata 169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true;        // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true;                       // 224.0.0.0/4 multicast + 240/4 reserved + 255 broadcast
  return false;
}

function isBlockedIpv6(ip: string): boolean {
  const s = ip.toLowerCase().replace(/^\[|\]$/g, '');
  // IPv4-mapped (::ffff:a.b.c.d) — classify on the embedded v4 address.
  const mapped = s.match(/(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/);
  if (mapped) return isBlockedIpv4(mapped[1]);
  if (s === '::1' || s === '::') return true;     // loopback / unspecified
  if (s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb')) return true; // fe80::/10 link-local
  if (s.startsWith('fc') || s.startsWith('fd')) return true; // fc00::/7 unique-local
  if (s.startsWith('ff')) return true;            // ff00::/8 multicast
  return false;
}

function isBlockedAddress(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) return isBlockedIpv4(ip);
  if (fam === 6) return isBlockedIpv6(ip);
  return true; // not a recognizable IP → refuse
}

/** Throw unless `rawUrl` is an https URL whose host resolves only to public addresses. */
async function assertSafeImageUrl(rawUrl: string): Promise<void> {
  let parsed: URL;
  try { parsed = new URL(rawUrl); } catch { throw new Error('blocked'); }
  if (parsed.protocol !== 'https:') throw new Error('blocked');
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw new Error('blocked');
    return;
  }
  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new Error('blocked');
  }
  if (addrs.length === 0) throw new Error('blocked');
  for (const a of addrs) {
    if (isBlockedAddress(a.address)) throw new Error('blocked');
  }
}

/** Fetch an image with SSRF guards: https-only, public-IP-only, manual
 *  redirect re-validation, size cap, and timeout. Returns the response for a
 *  caller to read (the caller still enforces the byte cap while streaming). */
async function safeImageFetch(initialUrl: string): Promise<Response> {
  let current = initialUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertSafeImageUrl(current);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(current, { redirect: 'manual', signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return response;
      current = new URL(location, current).toString(); // re-validated at loop top
      continue;
    }
    return response;
  }
  throw new Error('blocked');
}

/** Read a response body into a Buffer, aborting (returns null) once `max` bytes
 *  are exceeded so a server that lies about content-length can't blow past the cap. */
async function readCapped(response: Response, max: number): Promise<Buffer | null> {
  if (!response.body) {
    const buf = Buffer.from(await response.arrayBuffer());
    return buf.length > max ? null : buf;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.length;
      if (total > max) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks);
}

function ensureImagesDir(): void {
  ensureDataDir();
  const dir = getImagesDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    ensureImagesDir();
    cb(null, getImagesDir());
  },
  filename: (_req, file, cb) => {
    const ext = extname(file.originalname) || '.png';
    cb(null, `${randomUUID().slice(0, 8)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  },
});

export function createImageRouter(): Router {
  const router = Router();

  // Dynamic static serving — resolves active profile's images dir per request
  ensureImagesDir();
  router.use('/_images', (req, res, next) => {
    express.static(getImagesDir())(req, res, next);
  });

  // Upload endpoint
  router.post('/api/upload-image', upload.single('image'), (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'No image file provided' });
      return;
    }
    const src = `/_images/${req.file.filename}`;
    res.json({ src });
  });

  // Download external URL and save locally
  router.post('/api/download-image', async (req, res) => {
    const { url } = req.body;
    if (!url || typeof url !== 'string') {
      res.status(400).json({ error: 'No URL provided' });
      return;
    }
    let response: Response;
    try {
      response = await safeImageFetch(url);
    } catch {
      // SSRF guard rejected the URL (bad scheme, private/blocked host, too many
      // redirects). Generic message — never echo the resolved host or reason.
      res.status(400).json({ error: 'URL not allowed' });
      return;
    }
    try {
      if (!response.ok) {
        res.status(400).json({ error: 'Failed to fetch image' });
        return;
      }
      const contentType = response.headers.get('content-type') || 'image/png';
      if (!contentType.startsWith('image/')) {
        res.status(400).json({ error: 'URL is not an image' });
        return;
      }
      // Reject early if the server declares an over-limit size.
      const declaredLen = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLen) && declaredLen > MAX_IMAGE_BYTES) {
        res.status(400).json({ error: 'Image too large' });
        return;
      }
      const ext = contentType.includes('jpeg') || contentType.includes('jpg') ? '.jpg'
        : contentType.includes('gif') ? '.gif'
        : contentType.includes('webp') ? '.webp'
        : '.png';
      // Stream with a hard byte cap so a lying/streaming server can't exhaust disk.
      const buffer = await readCapped(response, MAX_IMAGE_BYTES);
      if (!buffer) {
        res.status(400).json({ error: 'Image too large' });
        return;
      }
      ensureImagesDir();
      const filename = `${randomUUID().slice(0, 8)}${ext}`;
      const filePath = join(getImagesDir(), filename);
      const { writeFileSync } = await import('fs');
      writeFileSync(filePath, buffer);
      const src = `/_images/${filename}`;
      res.json({ src });
    } catch {
      res.status(500).json({ error: 'Download failed' });
    }
  });

  return router;
}
