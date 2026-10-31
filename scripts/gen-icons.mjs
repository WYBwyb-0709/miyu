import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeIcon, makeIco } from './icon-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webIcons = resolve(root, 'app/www/icons');
const desktopBuild = resolve(root, 'desktop/build');
mkdirSync(webIcons, { recursive: true });
mkdirSync(desktopBuild, { recursive: true });

for (const size of [192, 512]) {
  writeFileSync(resolve(webIcons, `icon-${size}.png`), makeIcon(size));
}
writeFileSync(resolve(webIcons, 'icon-180.png'), makeIcon(180));
writeFileSync(resolve(webIcons, 'favicon-32.png'), makeIcon(32));
writeFileSync(resolve(desktopBuild, 'icon.png'), makeIcon(512));
writeFileSync(resolve(desktopBuild, 'icon.ico'), makeIco([16, 24, 32, 48, 64, 128, 256]));

console.log('icons written');
