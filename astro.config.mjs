import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import node from '@astrojs/node';

export default defineConfig({
  // Fully SSR app (auth middleware on every route) — never prerender.
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  vite: {
    envPrefix: ['VITE_', 'PUBLIC_'],
    plugins: [tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve('./src'),
      },
    },
  },
  devToolbar: {
    enabled: false,
  },
  trailingSlash: 'always',
});
