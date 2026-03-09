/**
 * Image Generation plugin for OpenWriter.
 * Right-click an empty paragraph → "Generate image" → AI creates an image inline.
 * Uses Google Gemini (Nano Banana 2) for generation, saves to /_images/.
 */

import { join } from 'path';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
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

const plugin: OpenWriterPlugin = {
  name: '@openwriter/plugin-image-gen',
  version: '0.1.0',
  description: 'Generate images with AI — right-click empty paragraphs',
  category: 'image-generation',

  configSchema: {
    'gemini-api-key': {
      type: 'string',
      env: 'GEMINI_API_KEY',
      required: true,
      description: 'Google Gemini API key for image generation',
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
        if (!apiKey) {
          res.status(400).json({ success: false, error: 'GEMINI_API_KEY not configured' });
          return;
        }

        // Dynamic import — @google/genai is ESM
        const { GoogleGenAI } = await import('@google/genai');
        const ai = new GoogleGenAI({ apiKey });

        console.log(`[ImageGen] Generating image: "${prompt.slice(0, 80)}..."`);

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
        const imageBytes = imagePart?.inlineData?.data;
        if (!imageBytes) {
          res.status(422).json({ success: false, error: 'No image data in response' });
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
        console.error('[ImageGen] Generation failed:', err?.message || err);
        res.status(500).json({ success: false, error: err?.message || 'Image generation failed' });
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
