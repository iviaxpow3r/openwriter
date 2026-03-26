/**
 * Image upload and static serving for OpenWriter.
 * Images are stored in {DATA_DIR}/_images/ and referenced as relative paths in markdown.
 */

import { Router } from 'express';
import multer from 'multer';
import { existsSync, mkdirSync } from 'fs';
import { join, extname } from 'path';
import { randomUUID } from 'crypto';
import { getDataDir, ensureDataDir } from './helpers.js';
import express from 'express';

function getImagesDir(): string { return join(getDataDir(), '_images'); }

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
    try {
      const response = await fetch(url);
      if (!response.ok) {
        res.status(400).json({ error: 'Failed to fetch image' });
        return;
      }
      const contentType = response.headers.get('content-type') || 'image/png';
      if (!contentType.startsWith('image/')) {
        res.status(400).json({ error: 'URL is not an image' });
        return;
      }
      const ext = contentType.includes('jpeg') || contentType.includes('jpg') ? '.jpg'
        : contentType.includes('gif') ? '.gif'
        : contentType.includes('webp') ? '.webp'
        : '.png';
      ensureImagesDir();
      const filename = `${randomUUID().slice(0, 8)}${ext}`;
      const filePath = join(getImagesDir(), filename);
      const buffer = Buffer.from(await response.arrayBuffer());
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
