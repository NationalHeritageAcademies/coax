import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { loadEnv, type Plugin } from 'vite';
import angular from '@analogjs/vite-plugin-angular';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load env (.env, .env.local, etc) so we can bake the values into the main
// bundle at build time. We use a blank prefix so both `SENTRY_DSN` (consumed
// by the main process via `process.env.SENTRY_DSN`) and `VITE_SENTRY_DSN`
// (consumed by the renderer via `import.meta.env.VITE_SENTRY_DSN`) get
// picked up. Falls back to whatever's already on the parent shell.
const env = loadEnv('', __dirname, '');
const SENTRY_DSN = env.SENTRY_DSN ?? '';
const VITE_SENTRY_DSN = env.VITE_SENTRY_DSN ?? '';

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
  '@telemetry': resolve(__dirname, 'src/telemetry'),
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
    // Bake the build-time env into the main bundle so `process.env.SENTRY_DSN`
    // resolves to a string literal at runtime — the bundled main has no
    // access to the developer's shell environment when launched as a
    // packaged .app/.exe. JSON.stringify('') yields '""', which our telemetry
    // init reads as "no DSN, skip everything" (the intended no-op default).
    define: {
      'process.env.SENTRY_DSN': JSON.stringify(SENTRY_DSN),
    },
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
    // Same bake-in pattern as main: the renderer reads
    // `import.meta.env.VITE_SENTRY_DSN`. Vite normally resolves VITE_*
    // automatically from the renderer's `envDir`, but electron-vite's
    // working-dir nesting can confuse that lookup — defining it explicitly
    // here is a single source of truth that works in both dev and packaged.
    define: {
      'import.meta.env.VITE_SENTRY_DSN': JSON.stringify(VITE_SENTRY_DSN),
    },
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/ui/index.html') } } },
  },
});
