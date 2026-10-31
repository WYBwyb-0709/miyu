import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = resolve(root, 'desktop/relay-bundle.cjs');

await build({
  entryPoints: [resolve(root, 'relay/src/core.js')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: ['node20'],
  minify: false,
  legalComments: 'none',
  external: ['bufferutil', 'utf-8-validate'],
  banner: {
    js: '/* 密语本机中继 · 由 scripts/build-relay 生成，请勿手工修改 */',
  },
});

console.log('relay bundle written:', outfile);
