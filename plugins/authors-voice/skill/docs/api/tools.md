# API Reference

## REST Endpoints (recommended)

All endpoints require `Authorization: Bearer $AV_API_KEY`. Base URL: `https://api.authors-voice.com`

### Core Skill Endpoints

**Get voice profile** — full linguistic fingerprint (6 categories + sentence distribution):
```bash
curl -s https://api.authors-voice.com/api/voice/profiles/default \
  -H "Authorization: Bearer $AV_API_KEY"
# Optional: ?format=detailed for profile ID + summary
```

**Apply voice** — rewrite content in the author's voice:
```bash
curl -s -X POST https://api.authors-voice.com/api/voice/apply \
  -H "Authorization: Bearer $AV_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"content": "text to rewrite", "mode": "rewrite", "inputType": "ai", "category": "x"}'
```

### Additional REST Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/voice/profiles` | GET | List profiles with counts |
| `/api/voice/profiles/:profileId` | GET | Full voice profile (use `default` for default) |
| `/api/voice/apply` | POST | Rewrite content in author's voice |
| `/api/voice/setup` | POST | Analyze samples and build voice profile |
| `/api/voice/content` | GET | List writing samples (query: profileId, category) |
| `/api/voice/content` | POST | Upload content chunks |
| `/api/voice/content/bulk` | POST | Bulk upload documents |
| `/api/voice/content/:docId` | PATCH | Update doc metadata |
| `/api/voice/content/:docId` | DELETE | Delete document |
| `/api/voice/anchor/derive` | POST | Derive a voice anchor from pasted prose |
| `/api/voice/anchor` | GET/PUT/DELETE | Read / persist / clear the voice anchor |
| `/api/voice/usage` | GET | Usage stats |

---

## MCP Protocol (alternative)

For MCP-compatible clients, all tools are also available via JSON-RPC POST:

```bash
curl -s -X POST "https://api.authors-voice.com/api/voice/mcp" \
  -H "Authorization: Bearer $AV_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"TOOL_NAME","arguments":{...}}}'
```

---

## Available Tools (12)

### Content Import (3 tools)

| Tool | Description |
|------|-------------|
| `import_from_url` | Import from any public URL (Medium, Substack, WordPress, .md/.txt). Args: `url`, `categories[]`, `authenticity`. |
| `bulk_import` | Import multiple docs (max 50). Each item: `{url}` or `{content, docId}` + `categories[]`. Global `authenticity`. |
| `upload_content` | Upload raw markdown. **One-click ergonomics**: `profileId` is optional — omit it and the server auto-creates/resolves a default profile. `content` can be raw text (server chunks on blank lines) instead of pre-split `chunks[]`, so the minimal payload is `{docId, content}`. Re-uploading the same `docId` replaces (idempotent). This is the contract the OpenWriter filetree right-click ingestion posts against. |

### Voice Profiles (3 tools)

| Tool | Description |
|------|-------------|
| `list_profiles` | List voice profiles, categories, and document counts. Each profile also carries `hasAnchor` (bool) and `anchorAuthors` (the reference authors behind the anchor), so callers can tell which profiles carry an anchor without a per-profile GET. No args. |
| `get_voice_profile` | Get full voice guidelines — 6 linguistic categories + sentence stats. Use before writing to understand the author's patterns. Optional `profileId`. |
| `setup_voice` | Analyze samples → create/update voice profile. Args: `profileName`, optional `forceReanalyze`. Call after importing content. |

### Voice Anchor (1 tool)

| Tool | Description |
|------|-------------|
| `set_voice_anchor` | Derive and persist a voice anchor from pasted reference prose. The anchor is V1's lead voice signal — injected ahead of sample retrieval in `rewrite`/`generate` and the OpenWriter editor path. REST equivalents: `POST /api/voice/anchor/derive`, `GET/PUT/DELETE /api/voice/anchor`. |

### Voice Application (2 tools)

| Tool | Description |
|------|-------------|
| `rewrite` | Rewrite existing content in the author's voice. Modes: `rewrite`, `shrink`, `expand`, `custom`. Supports `contextBefore`/`contextAfter`, `inputType`, `category`. |
| `generate` | Generate NEW content in author's voice. Args: `instruction`, optional `query` (topic for retrieval), `contextBefore`/`contextAfter`, `category`, `targetWords`. |

**rewrite parameters**: `content`, `mode`, `contextBefore`, `contextAfter`, `category`, `inputType` (human/ai/ai-assisted), `targetWords` (max 2000), `format` (markdown/plaintext).

**inputType** controls how aggressively the rewrite treats the input:
- `human` — Author's own writing. Preserve word choices and quirks, only polish flow/grammar.
- `ai` — Generic AI content. Discard phrasing entirely, rewrite from scratch using voice samples.
- `ai-assisted` (default) — Mixed authorship. Preserve passages matching the author's voice, rewrite generic/formulaic parts.

**generate note**: `query` is optional — describes what content is ABOUT for better voice retrieval. When omitted, context + instruction are used for retrieval.

### Content Management (3 tools)

| Tool | Description |
|------|-------------|
| `list_content` | List writing samples with chunk counts. Optional `category` filter. |
| `update_content` | Retag a doc. Args: `docId`, `categories[]`, `authenticity`. |
| `delete_content` | Permanently delete a doc and its chunks. Args: `docId`. |
