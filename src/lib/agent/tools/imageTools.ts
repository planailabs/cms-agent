import fs from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import { z } from 'zod';
import { env } from '@/lib/env';
import { assertWritable, isScratchPath, jail } from './fsTools';
import { registerTool } from './registry';

export function registerImageTools(): void {
  registerTool({
    name: 'generate_image',
    description:
      'Generate a PNG image and save it in the site repository. Use the returned altText when adding the image to the site. Outside the EXECUTE phase only .scratch/ destinations are allowed (draft images there, promote with move_file).',
    schema: z.object({
      prompt: z.string().min(1).describe('Detailed visual description of the image'),
      path: z.string().regex(/\.png$/i).describe('Repository-relative destination ending in .png'),
      altText: z.string().min(1).describe('Concise accessible description for the generated image'),
      size: z.enum(['1024x1024', '1536x1024', '1024x1536']).default('1024x1024'),
    }),
    phases: ['plan', 'execute', 'preview', 'published'],
    async execute(input, ctx) {
      assertWritable(ctx, input.path);
      const destination = jail(ctx, input.path);
      const e = env();
      const openai = new OpenAI({ baseURL: e.OPENAI_BASE_URL, apiKey: e.OPENAI_API_KEY });
      const response = await openai.images.generate({
        model: e.OPENAI_IMAGE_MODEL,
        prompt: input.prompt,
        size: input.size,
        response_format: 'b64_json',
      });
      const image = response.data?.[0];
      let bytes: Buffer;
      if (image?.b64_json) {
        bytes = Buffer.from(image.b64_json, 'base64');
      } else if (image?.url) {
        const download = await fetch(image.url);
        if (!download.ok) throw new Error(`Generated image download failed (${download.status}).`);
        bytes = Buffer.from(await download.arrayBuffer());
      } else {
        throw new Error('Image generation returned no image data.');
      }
      if (bytes.length === 0) throw new Error('Image generation returned an empty image.');

      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, bytes);
      if (!isScratchPath(input.path)) ctx.modifiedPaths.add(input.path);
      return JSON.stringify({
        success: true,
        path: input.path,
        altText: input.altText,
        bytes: bytes.length,
      });
    },
  });
}
