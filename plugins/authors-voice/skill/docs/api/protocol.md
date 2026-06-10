# Voice Emulation Protocol

Two API endpoints do the voice work. The agent's job is to gather inputs,
call the endpoint, and return the result. The server handles profile loading,
sample retrieval, voice-guided generation, and anti-AI passes.

**Do not attempt to emulate the voice yourself** — the API is the only path
that produces reliable voice quality.

- **Rewrite existing text** → `rewrite` (see `/voice-apply`)
- **Generate new content** → `generate` (see `/voice-generate`)

## API Base

```
BASE_URL=https://api.authors-voice.com
```

All endpoints require `Authorization: Bearer $AV_API_KEY`.

## rewrite — Rewrite Existing Text

```bash
curl -s -N -X POST "${BASE_URL}/api/voice/mcp" \
  -H "Authorization: Bearer $AV_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
    "name":"rewrite","arguments":{
      "content":"<text to rewrite>",
      "mode":"rewrite",
      "category":"<x|blog|email|...>",
      "inputType":"ai-assisted",
      "contextBefore":"<optional>",
      "contextAfter":"<optional>",
      "format":"plaintext"
    }}}'
```

**Required**: `content`, `category`.
**Defaults**: `mode=rewrite`, `inputType=ai-assisted`, `format=plaintext`.

### Modes

- `rewrite` — standard voice rewrite (default)
- `shrink` — compress while keeping voice
- `expand` — lengthen while keeping voice
- `custom` — pass `customInstruction` with specific directives

### inputType

- `human` — author's own writing. Preserve word choices and quirks; only polish flow.
- `ai` — generic AI content. Discard phrasing entirely; rewrite from scratch using voice samples.
- `ai-assisted` (default) — mixed. Preserve author-sounding passages; rewrite generic parts.

## generate — Create New Content

```bash
curl -s -N -X POST "${BASE_URL}/api/voice/mcp" \
  -H "Authorization: Bearer $AV_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
    "name":"generate","arguments":{
      "instruction":"<what to write>",
      "category":"<x|blog|email|...>",
      "query":"<optional topic keywords>",
      "targetWords":500,
      "contextBefore":"<optional>",
      "contextAfter":"<optional>",
      "format":"plaintext"
    }}}'
```

**Required**: `instruction`, `category`.
**`query`**: optional — use when the retrieval topic differs from the instruction wording. If omitted, instruction + context are used for retrieval.
**`targetWords`**: optional; max 2000.

## Voice Anchor (V1 lead signal)

An anchor is reference prose the author wants to sound like. When set, it's
injected **ahead of** sample retrieval in both `rewrite` and `generate` (and the
OpenWriter editor path), so it's the strongest single voice lever available.

Derive + persist from pasted prose:

```bash
curl -s -X POST "${BASE_URL}/api/voice/anchor/derive" \
  -H "Authorization: Bearer $AV_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"content":"<reference prose>","profileId":"<optional>"}'
```

Read / replace / clear the persisted anchor:

```bash
curl -s     "${BASE_URL}/api/voice/anchor" -H "Authorization: Bearer $AV_API_KEY"   # GET
curl -s -X PUT    "${BASE_URL}/api/voice/anchor" ... # replace
curl -s -X DELETE "${BASE_URL}/api/voice/anchor" ... # clear
```

MCP equivalent: the `set_voice_anchor` tool. `list_profiles` reports `hasAnchor`
and `anchorAuthors` per profile so you can check anchor state without a GET.

## Response Parsing

The response is Server-Sent Events. Find the line starting `data: `, parse
the JSON, and extract the text:

```
result.content[0].text
```

That text is the final voice-matched output. Return it verbatim — no
post-processing needed.

**Defensive fallback**: if the text itself parses as JSON, extract `.content`
or `.text` from the parsed object. Most responses are plain text, but the
wire format permits JSON envelopes.

## Categories

Always pass `category` — scopes retrieval to the right writing style.

Built-in: `x`, `blog`, `email`, `newsletter`, `linkedin`, `technical`,
`business`, `academic`, `fiction`.

## Context

When editing inside existing text, pass `contextBefore` and `contextAfter`
as the surrounding paragraphs. Context guides flow but is **never included
in the output**.

## Errors

- `401` → API key invalid. User should run `/voice-setup`.
- `404 profile not found` → profile not built. User should run `/voice-setup`.
- `429` → rate limit. Wait and retry.
- Timeout (>30s) → retry once; then surface the error.

