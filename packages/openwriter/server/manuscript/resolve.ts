/**
 * Manuscript doc resolution — disk I/O.
 *
 * Maps each manifest doc-pointer (docId) to its current on-disk body. Resolution
 * is by stable docId (rename-safe): filenameByDocId → readFrontmatter().content.
 * The body read from disk is the canonical, ACCEPTED text — pending agent
 * suggestions live in the `_pending/<docId>.json` sidecar, never in the .md body
 * — so a compiled manuscript never ships an un-accepted edit. A docId resolves
 * regardless of which workspace/container the doc lives in (location-independent),
 * which is why a transition doc written "in some random folder" links fine.
 *
 * adr: adr/manuscript-engine.md
 */
import { filenameByDocId } from '../documents.js';
import { readFrontmatter } from '../backlinks.js';
import type { Manifest } from './parse.js';
import type { ResolvedBody } from './assemble.js';

export function resolveManifestDocs(manifest: Manifest): {
  bodyMap: Map<string, ResolvedBody>;
  warnings: string[];
} {
  const bodyMap = new Map<string, ResolvedBody>();
  const warnings: string[] = [];

  for (const section of manifest.sections) {
    for (const item of section.items) {
      if (item.kind !== 'doc' || !item.docId) continue;
      if (bodyMap.has(item.docId)) continue;

      const filename = filenameByDocId(item.docId);
      if (!filename) {
        warnings.push(`docId ${item.docId} not found (${item.text ?? ''})`);
        continue;
      }
      const fm = readFrontmatter(filename);
      if (!fm) {
        warnings.push(`Could not read ${filename} for docId ${item.docId}`);
        continue;
      }
      bodyMap.set(item.docId, {
        title: (fm.data.title as string) || item.text || 'Untitled',
        body: fm.content,
      });
    }
  }

  return { bodyMap, warnings };
}
