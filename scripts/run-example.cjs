const { spawnSync } = require('node:child_process');
const { prepare } = require('./prepare-example.cjs');
const args = process.argv.slice(2), build = args.includes('--build');
const variant = args.find(a => !a.startsWith('--')) || 'standard';
const dir = prepare(variant);
const result = build
  ? spawnSync(process.execPath, [require.resolve('electron-builder/cli.js'), '--projectDir', dir, '--config', dir+'/electron-builder.json'], {stdio:'inherit'})
  : spawnSync(require('electron'), [dir], {stdio:'inherit'});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
