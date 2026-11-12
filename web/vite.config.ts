import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

const target = process.env.CREMOTE_DEV_TARGET ?? 'http://127.0.0.1:7878';

// Подставляет id сборки в dist/sw.js: каждый деплой даёт новый кэш и обновляет SW
function swBuildId(): Plugin {
  let outDir = 'dist';
  return {
    name: 'cremote-sw-build-id',
    apply: 'build',
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir);
    },
    closeBundle() {
      const file = resolve(outDir, 'sw.js');
      if (!existsSync(file)) return;
      const id = Date.now().toString(36);
      writeFileSync(file, readFileSync(file, 'utf8').replaceAll('__BUILD_ID__', id));
    },
  };
}

export default defineConfig({
  plugins: [svelte(), swBuildId()],
  server: {
    proxy: {
      '/api': { target, changeOrigin: false },
      '/ws': { target, ws: true, changeOrigin: false },
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
  },
});
