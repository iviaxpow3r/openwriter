/**
 * Manuscript compiler — orchestrator.
 *
 * compileManuscript(manifestBody) → one assembled master markdown document +
 * any warnings (unresolved pointers, unrecognized manifest lines). Rendering to
 * EPUB / DOCX / PDF / HTML is a separate adapter layer (later phase); every
 * render target consumes this single master markdown, so preview and export are
 * the same pipeline differing only in the final step.
 *
 * adr: adr/manuscript-engine.md
 */
import { parseManifest, type ManifestMeta } from './parse.js';
import { resolveManifestDocs } from './resolve.js';
import { assemble } from './assemble.js';

export interface CompileResult {
  markdown: string;
  meta: ManifestMeta;
  warnings: string[];
}

export function compileManuscript(manifestBody: string): CompileResult {
  const manifest = parseManifest(manifestBody);
  const { bodyMap, warnings: resolveWarnings } = resolveManifestDocs(manifest);
  const { markdown, warnings: assembleWarnings } = assemble(manifest, bodyMap);
  return {
    markdown,
    meta: manifest.meta,
    warnings: [...manifest.warnings, ...resolveWarnings, ...assembleWarnings],
  };
}

export { parseManifest } from './parse.js';
export { assemble } from './assemble.js';
export type { Manifest, ManifestMeta, ManifestSection, ManifestItem } from './parse.js';
export type { ResolvedBody } from './assemble.js';

// Render adapters — every target consumes the one master markdown compileManuscript
// produces, so preview (html) and export (epub/docx) are the same pipeline.
export { renderBodyHtml } from './render/md.js';
export { renderBookHtml } from './render/html.js';
export { renderEpub } from './render/epub.js';
export { renderDocx } from './render/docx.js';
