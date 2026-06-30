/**
 * Thin runtime bridge to the OpenWriter server modules this plugin needs for
 * article publishing — the active document, its title/metadata, the data dir,
 * and the shared TipTap -> DraftJS converter.
 *
 * The converter (server/tiptap-draftjs.ts) is shared with plugins/publish so
 * both posting paths produce identical X content_state. We import the compiled
 * server module at runtime rather than vendoring it, resolving both the npm
 * package layout and the monorepo layout — the same dual-path trick the publish
 * plugin's helpers use.
 */

// npm package: dist/plugins/x-api/dist/server-bridge.js -> dist/server/
// monorepo:    plugins/x-api/dist/server-bridge.js      -> packages/openwriter/dist/server/
const npmBase = new URL('../../../server/', import.meta.url).href;
const monoBase = new URL('../../../packages/openwriter/dist/server/', import.meta.url).href;

export interface ServerBridge {
  getDocument: () => any;
  getTitle: () => string;
  getMetadata: () => Record<string, any>;
  getDataDir: () => string;
  tiptapToDraftjs: (doc: any) => { blocks: any[]; entities: any[] };
}

let cached: ServerBridge | null = null;

async function tryImport(base: string) {
  const [state, helpers, draftjs] = await Promise.all([
    import(base + 'state.js'),
    import(base + 'helpers.js'),
    import(base + 'tiptap-draftjs.js'),
  ]);
  return { state, helpers, draftjs };
}

export async function getServerBridge(): Promise<ServerBridge> {
  if (cached) return cached;
  let state, helpers, draftjs;
  try {
    ({ state, helpers, draftjs } = await tryImport(npmBase));
  } catch {
    ({ state, helpers, draftjs } = await tryImport(monoBase));
  }
  cached = {
    getDocument: state.getDocument,
    getTitle: state.getTitle,
    getMetadata: state.getMetadata,
    getDataDir: helpers.getDataDir,
    tiptapToDraftjs: draftjs.tiptapToDraftjs,
  };
  return cached;
}
