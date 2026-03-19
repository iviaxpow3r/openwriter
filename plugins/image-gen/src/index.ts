/**
 * Image Generation plugin for OpenWriter.
 * Right-click an empty paragraph → "Generate image" → AI creates an image inline.
 * Uses Google Gemini (Nano Banana 2) for generation, saves to /_images/.
 */

import { join } from 'path';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { homedir } from 'os';
import type { Express, Request, Response } from 'express';

interface PluginConfigField {
  type: 'string' | 'number' | 'boolean';
  required?: boolean;
  env?: string;
  description?: string;
}

interface PluginRouteContext {
  app: Express;
  config: Record<string, string>;
  dataDir: string;
}

interface PluginContextMenuItem {
  label: string;
  shortcut?: string;
  action: string;
  condition?: 'has-selection' | 'empty-node' | 'always';
  promptForInput?: boolean;
}

interface OpenWriterPlugin {
  name: string;
  version: string;
  description?: string;
  category?: 'writing' | 'social-media' | 'image-generation';
  configSchema?: Record<string, PluginConfigField>;
  registerRoutes?(ctx: PluginRouteContext): void | Promise<void>;
  contextMenuItems?(): PluginContextMenuItem[];
}

/** Fallback: generate image via the publish platform API, download and save locally */
async function generateViaPlatform(
  prompt: string,
  dataDir: string,
  aspectRatio: string = '16:9',
): Promise<{ success: true; src: string } | null> {
  const configPath = join(homedir(), '.openwriter', 'config.json');
  if (!existsSync(configPath)) return null;

  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const publishConfig = config.plugins?.['@openwriter/plugin-publish']?.config || {};
  const platformKey = publishConfig['api-key'];
  const apiUrl = publishConfig['api-url'] || 'https://publish.openwriter.io';
  const profile = config.activeProfile || 'Default';

  if (!platformKey) return null;

  console.log(`[ImageGen] Generating image (platform): "${prompt.slice(0, 80)}..."`);

  const res = await fetch(`${apiUrl}/images/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${platformKey}`,
      'X-Profile': profile,
    },
    body: JSON.stringify({ prompt, aspect_ratio: aspectRatio }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error((err as any).error || 'Platform image generation failed');
  }

  const data = await res.json() as { url: string };

  // Download image and save locally
  const imageRes = await fetch(data.url);
  const imageBuffer = Buffer.from(await imageRes.arrayBuffer());

  const imagesDir = join(dataDir, '_images');
  if (!existsSync(imagesDir)) mkdirSync(imagesDir, { recursive: true });
  const filename = `${randomUUID().slice(0, 8)}.png`;
  writeFileSync(join(imagesDir, filename), imageBuffer);

  console.log(`[ImageGen] Saved (platform): ${join(imagesDir, filename)}`);
  return { success: true, src: `/_images/${filename}` };
}

const plugin: OpenWriterPlugin = {
  name: '@openwriter/plugin-image-gen',
  version: '0.1.0',
  description: 'Generate images with AI — right-click empty paragraphs',
  category: 'image-generation',

  configSchema: {
    'gemini-api-key': {
      type: 'string',
      env: 'GEMINI_API_KEY',
      required: false,
      description: 'Google Gemini API key for image generation (optional — falls back to publish platform)',
    },
  },

  registerRoutes(ctx: PluginRouteContext) {
    ctx.app.post('/api/image-gen/generate', async (req: Request, res: Response) => {
      try {
        const { prompt } = req.body;
        if (!prompt || typeof prompt !== 'string') {
          res.status(400).json({ success: false, error: 'prompt is required' });
          return;
        }
        if (prompt.length > 1000) {
          res.status(400).json({ success: false, error: 'prompt must be under 1000 characters' });
          return;
        }

        const apiKey = ctx.config['gemini-api-key'] || process.env.GEMINI_API_KEY || '';

        let imageBytes: string | undefined;

        if (apiKey) {
          // Local Gemini generation
          const { GoogleGenAI } = await import('@google/genai');
          const ai = new GoogleGenAI({ apiKey });

          console.log(`[ImageGen] Generating image (local): "${prompt.slice(0, 80)}..."`);

          const response = await ai.models.generateContent({
            model: 'gemini-3.1-flash-image-preview',
            contents: `Generate a 16:9 aspect ratio image: ${prompt}`,
            config: {
              responseModalities: ['IMAGE'],
            },
          });

          const parts = response.candidates?.[0]?.content?.parts;
          if (!parts || parts.length === 0) {
            res.status(422).json({ success: false, error: 'No image generated — content may have been filtered' });
            return;
          }

          const imagePart = parts.find((p: any) => p.inlineData);
          imageBytes = imagePart?.inlineData?.data;
          if (!imageBytes) {
            res.status(422).json({ success: false, error: 'No image data in response' });
            return;
          }
        } else {
          // Fallback: generate via publish platform API
          const platformResult = await generateViaPlatform(prompt, ctx.dataDir);
          if (!platformResult) {
            res.status(400).json({ success: false, error: 'No GEMINI_API_KEY and publish platform not configured. Set GEMINI_API_KEY or log in to the publish plugin.' });
            return;
          }
          // platformResult already saved to disk
          res.json(platformResult);
          return;
        }

        // Save to dataDir/_images/
        const imagesDir = join(ctx.dataDir, '_images');
        if (!existsSync(imagesDir)) mkdirSync(imagesDir, { recursive: true });
        const filename = `${randomUUID().slice(0, 8)}.png`;
        const filepath = join(imagesDir, filename);
        writeFileSync(filepath, Buffer.from(imageBytes, 'base64'));

        console.log(`[ImageGen] Saved: ${filepath}`);
        res.json({ success: true, src: `/_images/${filename}` });
      } catch (err: any) {
        const msg = err?.message || 'Image generation failed';
        console.error('[ImageGen] Generation failed:', msg);
        const friendly = /Unexpected token.*<!DOCTYPE/i.test(msg)
          ? 'Image generation failed — your Gemini API key may be invalid or expired. Check your GEMINI_API_KEY.'
          : msg;
        res.status(500).json({ success: false, error: friendly });
      }
    });
  },

  contextMenuItems() {
    return [
      {
        label: 'Generate image',
        action: 'img:generate',
        condition: 'always' as const,
        promptForInput: true,
      },
    ];
  },
};

export default plugin;
