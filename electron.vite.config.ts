import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { type Plugin } from 'vite';
import angular from '@analogjs/vite-plugin-angular';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Strip `crossorigin` from the emitted <script>/<link> tags in index.html.
// The attribute is only meaningful for HTTP CORS; under file:// (the packaged
// app) it has a destructive side effect — the bundled stylesheet is no longer
// flagged "origin-clean" so any code that reads `link.sheet.cssRules` (e.g.
// the Monaco editor's shadow-root style mirror in monaco-editor.ts) gets
// SecurityError instead of the actual rules, and Monaco renders without its
// own layout CSS. The attribute serves no purpose for an asset that ships
// inside the .app bundle.
const stripCrossOriginPlugin: Plugin = {
  name: 'strip-crossorigin',
  enforce: 'post',
  transformIndexHtml(html) {
    return html.replace(/\s+crossorigin(?=[\s>])/g, '');
  },
};

const alias = {
  '@parser': resolve(__dirname, 'src/parser'),
  '@resolver': resolve(__dirname, 'src/resolver'),
  '@storage': resolve(__dirname, 'src/storage'),
  '@secrets': resolve(__dirname, 'src/secrets'),
  '@runner': resolve(__dirname, 'src/runner'),
  '@ipc': resolve(__dirname, 'src/ipc'),
  '@app': resolve(__dirname, 'src/app'),
  '@ui': resolve(__dirname, 'src/ui'),
  '@importer': resolve(__dirname, 'src/importer'),
  '@workspace-fs': resolve(__dirname, 'src/workspace-fs'),
};

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin(),
      viteStaticCopy({
        // electron-vite builds the main process as an SSR (node) build, which
        // Vite 6 runs in the environment named 'ssr'. vite-plugin-static-copy
        // defaults to only copying in the 'client' environment, so without
        // this the copy silently no-ops and out/main/migrations goes missing
        // (workspace:open then fails with ENOENT at runtime).
        environment: 'ssr',
        targets: [
          {
            src: resolve(__dirname, 'src/storage/migrations/*'),
            dest: 'migrations',
          },
          {
            src: resolve(__dirname, 'build/icon.png'),
            dest: '.',
          },
        ],
      }),
    ],
    resolve: { alias },
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/app/main.ts') } } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/app/preload.ts') } } },
  },
  renderer: {
    resolve: { alias },
    root: resolve(__dirname, 'src/ui'),
    // The Angular renderer is compiled by Analog's Vite plugin — the same
    // plugin NHA.Frontend uses — so JIT/AOT behavior matches what we run
    // elsewhere. tokens.css is served straight out of src/ui/public (Vite's
    // default publicDir for this root) and copied verbatim into the bundle.
    plugins: [angular(), stripCrossOriginPlugin],
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/ui/index.html') } } },
  },
});
