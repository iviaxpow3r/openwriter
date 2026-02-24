# Plugin Development Guide

Build plugins that extend OpenWriter with custom routes, AI tools, editor context menus, and sidebar document actions.

## Quick Start

```typescript
// src/index.ts
import type { OpenWriterPlugin } from 'openwriter/plugin-types';

const plugin: OpenWriterPlugin = {
  name: 'openwriter-plugin-hello',
  version: '0.1.0',
  description: 'A minimal OpenWriter plugin',

  contextMenuItems() {
    return [
      { label: 'Say Hello', action: 'hello:greet', condition: 'has-selection' },
    ];
  },
};

export default plugin;
```

## The `OpenWriterPlugin` Interface

```typescript
interface OpenWriterPlugin {
  name: string;                    // npm package name
  version: string;                 // semver version
  description?: string;            // shown in plugin panel
  category?: PluginCategory;       // 'writing' | 'social-media' | 'image-generation' | 'publishing' | 'productivity' | 'analytics'
  configSchema?: Record<string, PluginConfigField>;  // user-configurable settings
  registerRoutes?(ctx: PluginRouteContext): void | Promise<void>;  // HTTP endpoints
  mcpTools?(config: Record<string, string>): PluginMcpTool[];     // MCP tools for AI agents
  contextMenuItems?(): PluginContextMenuItem[];   // editor right-click menu
  sidebarMenuItems?(): PluginSidebarMenuItem[];   // sidebar doc right-click menu
}
```

## Extension Points

### HTTP Routes

Register Express routes that your plugin serves:

```typescript
registerRoutes({ app, config }) {
  app.post('/api/myplugin/action', (req, res) => {
    res.json({ success: true });
  });

  // Sidebar actions use this convention:
  app.post('/api/myplugin/sidebar-action', (req, res) => {
    const { action, filename, title } = req.body;
    // Handle document-level action
    res.json({ success: true });
  });
}
```

Routes are automatically disabled when the plugin is disabled — no cleanup needed.

### MCP Tools

Expose tools that AI agents (Claude, etc.) can call via the Model Context Protocol:

```typescript
mcpTools(config) {
  return [{
    name: 'my_tool',
    description: 'Does something useful',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Input text' } },
      required: ['text'],
    },
    handler: async (params) => {
      return { result: `Processed: ${params.text}` };
    },
  }];
}
```

Tools auto-register when enabled and auto-remove when disabled.

### Editor Context Menu

Add items to the right-click menu inside the editor:

```typescript
contextMenuItems() {
  return [
    { label: 'Rewrite', action: 'myplugin:rewrite', condition: 'has-selection' },
    { label: 'Expand', action: 'myplugin:expand', condition: 'has-selection' },
    { label: 'Generate', action: 'myplugin:generate', condition: 'empty-node', promptForInput: true },
    { label: 'Info', action: 'myplugin:info', condition: 'always' },
  ];
}
```

**Conditions:**
- `has-selection` — only when text is selected
- `empty-node` — only when cursor is in an empty paragraph
- `always` — always shown

**`promptForInput: true`** — shows a text input before dispatching the action.

**Action namespacing:** Use `prefix:action` format (e.g. `av:rewrite`). The prefix is stripped before reaching your route handler.

### Sidebar Document Menu

Add items to the right-click menu on documents in the sidebar:

```typescript
sidebarMenuItems() {
  return [
    { label: 'Schedule Post', action: 'scheduler:schedule-post' },
    { label: 'Export PDF', action: 'exporter:pdf' },
  ];
}
```

When clicked, OpenWriter sends `POST /api/plugins/sidebar-action` with `{ action, filename, title }`. The action's prefix routes to your plugin's `/api/{prefix}/sidebar-action` endpoint.

## Config Schema

Define user-configurable settings with optional env var fallback:

```typescript
configSchema: {
  'api-key': { type: 'string', required: true, env: 'MY_API_KEY', description: 'API key for the service' },
  'base-url': { type: 'string', env: 'MY_BASE_URL', description: 'Override the default API URL' },
}
```

**Resolution order:** Saved config (in `~/.openwriter/config.json`) > environment variable > empty.

Users configure these in the OpenWriter Plugin Panel UI.

## Package Conventions

### Naming

- **Community plugins:** `openwriter-plugin-*` (e.g. `openwriter-plugin-grammarly`)
- **Scoped community:** `@yourscope/openwriter-plugin-*`
- **First-party:** `@openwriter/plugin-*`

### package.json

```json
{
  "name": "openwriter-plugin-my-plugin",
  "version": "1.0.0",
  "type": "module",
  "main": "dist/index.js",
  "openwriter": {
    "displayName": "My Plugin",
    "category": "writing"
  },
  "scripts": {
    "build": "tsc"
  },
  "files": ["dist/", "package.json"]
}
```

**Required:**
- `"type": "module"` — ESM only
- `"main"` — points to compiled entry that exports `default` plugin object
- `"openwriter"` field — discovery metadata

### The `openwriter` manifest field

```json
{
  "openwriter": {
    "displayName": "Human-readable name",
    "category": "writing",
    "minVersion": "0.3.0"
  }
}
```

## Development

### Monorepo workflow (for bundled plugins)

1. Create a directory in `plugins/your-plugin/`
2. Add `package.json`, `tsconfig.json`, `src/index.ts`
3. Run `npm run build` from the plugin directory
4. Start OpenWriter — your plugin appears in the Plugin Panel

### Testing locally (for npm plugins)

```bash
# In your plugin directory
npm link

# In ~/.openwriter/plugins/
npm link openwriter-plugin-my-plugin
```

Or install from a local tarball:

```bash
openwriter plugin install /path/to/openwriter-plugin-my-plugin-1.0.0.tgz
```

## Publishing

1. Publish to npm: `npm publish`
2. Submit a PR to add your plugin to [`registry.json`](../registry.json)

### Registry entry format

```json
{
  "name": "openwriter-plugin-my-plugin",
  "displayName": "My Plugin",
  "description": "What it does in one sentence",
  "category": "writing",
  "author": "Your Name",
  "pricing": "free",
  "npm": "openwriter-plugin-my-plugin",
  "repository": "https://github.com/you/openwriter-plugin-my-plugin"
}
```

**Pricing values:** `free`, `freemium`, `paid`

## User Installation

End users install plugins via CLI:

```bash
openwriter plugin install openwriter-plugin-my-plugin
openwriter plugin list
openwriter plugin remove openwriter-plugin-my-plugin
```

Plugins are stored in `~/.openwriter/plugins/` and survive OpenWriter upgrades.

## Reference Plugins

Study the built-in plugins for patterns:

- **[Author's Voice](../plugins/authors-voice/)** — Routes + context menu + MCP tools (full integration)
- **[Image Generator](../plugins/image-gen/)** — Routes + context menu with `promptForInput`
- **[X / Twitter](../plugins/x-api/)** — Routes + MCP tools (no context menu)
