#!/usr/bin/env node
// x-writer/scripts/polish.js — Polish tweets in @Meta_Trav's voice via Author's Voice API
// Zero npm dependencies. Uses Node.js built-in https module.
//
// Usage:
//   node polish.js "raw tweet text"                    # polish and print
//   node polish.js "text1" "text2" "text3"             # batch polish
//   node polish.js "text" --intensity full             # full transformation
//   node polish.js "text" --json                       # structured output

const https = require('https');

// ============ CONFIGURATION ============
const CONFIG = {
  AV_API_KEY: process.env.AV_API_KEY || 'av_live_530eb8b35c6646cbbcb76a210dc1822fee1366d4dd1bf8c9014c70ec44865ded',
  AV_BASE_URL: process.env.AV_BASE_URL || 'https://breewriter-app-5eifi.ondigitalocean.app/api/voice/mcp',
  CATEGORY: 'x',
  INTENSITY: 'moderate',
  MODE: 'rewrite',
};

// ============ ARGUMENT PARSING ============

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = { texts: [], intensity: CONFIG.INTENSITY, json: false };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--intensity' && args[i + 1]) { parsed.intensity = args[++i]; continue; }
    if (args[i] === '--json') { parsed.json = true; continue; }
    if (!args[i].startsWith('--')) { parsed.texts.push(args[i]); }
  }

  return parsed;
}

// ============ AUTHOR'S VOICE API ============

function callAV(toolName, toolArgs) {
  const url = new URL(CONFIG.AV_BASE_URL);

  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: toolName, arguments: toolArgs },
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CONFIG.AV_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          // Parse SSE response — find the data: line
          const lines = data.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const json = JSON.parse(line.slice(6));
              const text = json.result?.content?.[0]?.text;
              if (text) {
                // text might be JSON string or plain text
                try {
                  const parsed = JSON.parse(text);
                  resolve(parsed.content || parsed.text || parsed.result || text);
                } catch {
                  resolve(text);
                }
                return;
              }
            }
          }
          // Fallback: try parsing entire response as JSON (non-SSE)
          try {
            const json = JSON.parse(data);
            const text = json.result?.content?.[0]?.text;
            if (text) {
              try { resolve(JSON.parse(text).content || JSON.parse(text).text || text); }
              catch { resolve(text); }
              return;
            }
          } catch {}
          reject(new Error(`No content in response. Raw: ${data.substring(0, 300)}`));
        } catch (err) {
          reject(new Error(`Parse error: ${err.message}\nRaw: ${data.substring(0, 300)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30_000, () => { req.destroy(); reject(new Error('Request timeout (30s)')); });
    req.write(body);
    req.end();
  });
}

async function applyVoice(text, intensity) {
  return callAV('apply_voice', {
    content: text,
    mode: CONFIG.MODE,
    category: CONFIG.CATEGORY,
    intensity: intensity,
    format: 'plaintext',
  });
}

// ============ MAIN ============

async function main() {
  const parsed = parseArgs();

  if (parsed.texts.length === 0) {
    console.log('Usage: node polish.js "tweet text" [options]');
    console.log('');
    console.log('Polishes tweet text in @Meta_Trav\'s voice via Author\'s Voice API.');
    console.log('Scheduling/posting is OpenWriter-native (mcp__openwriter__schedule_post,');
    console.log('post_to_x, manage_schedule) — not handled by this script.');
    console.log('');
    console.log('Options:');
    console.log('  --intensity <level>  light, moderate (default), full');
    console.log('  --json               Output as JSON');
    console.log('');
    console.log('Examples:');
    console.log('  node polish.js "Society rewards conformity"');
    console.log('  node polish.js "Tweet 1" "Tweet 2" "Tweet 3"');
    console.log('  node polish.js "Raw take" --intensity full');
    process.exit(0);
  }

  const results = [];

  for (const raw of parsed.texts) {
    if (!parsed.json) {
      console.log(`\n  Original (${raw.length} chars):`);
      console.log(`  "${raw}"`);
    }

    try {
      const polished = await applyVoice(raw, parsed.intensity);

      if (!parsed.json) {
        console.log(`  Polished (${polished.length} chars):`);
        console.log(`  "${polished}"`);
        if (polished.length > 280) {
          console.log(`  !! ${polished.length} chars — over 280 limit`);
        }
      }

      results.push({ original: raw, polished, chars: polished.length });
    } catch (err) {
      if (!parsed.json) console.error(`  Error: ${err.message}`);
      results.push({ original: raw, error: err.message });
    }
  }

  if (parsed.json) {
    console.log(JSON.stringify(results, null, 2));
  } else if (parsed.texts.length === 1 && results[0]?.polished) {
    // Single tweet — print clean output for easy copy
    console.log(`\n${results[0].polished}`);
  }
}

main();
