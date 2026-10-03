const { copyFileSync, mkdirSync } = require('node:fs');
mkdirSync('dist/desktop/src', { recursive: true });
copyFileSync('src/rescue.html', 'dist/desktop/src/rescue.html');
copyFileSync('../web/public/icons/icon-192.png', 'dist/desktop/src/mark.png');

const { readFileSync, writeFileSync, unlinkSync } = require('node:fs');
for (const name of ['preload', 'rescue']) {
  const path = `dist/desktop/src/${name}.js`;
  const source = readFileSync(path, 'utf8').replace(/import \{([^}]+)\} from 'electron';/, 'const {$1} = require("electron");').replace(/export \{\};?/, '');
  writeFileSync(`dist/desktop/src/${name}.cjs`, source);
  unlinkSync(path);
}
