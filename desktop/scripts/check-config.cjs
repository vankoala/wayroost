const { validateConfiguration } = require('app-builder-lib/out/util/config/config.js');
const { DebugLogger } = require('builder-util');
const { readFileSync } = require('node:fs');
const config = JSON.parse(readFileSync('package.json', 'utf8')).build;
validateConfiguration(config, new DebugLogger()).then(() => {
  console.log('electron-builder configuration: valid');
}).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
