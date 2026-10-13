const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const files = fs.readdirSync(path.join(root, 'tests')).filter(file => /\.test\.(js|mjs)$/.test(file)).map(file => path.join('tests', file));
const suite = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' });
if (suite.status !== 0) process.exit(suite.status || 1);
const calculation = spawnSync(process.execPath, ['public/loan-rules.test.js'], { cwd: root, stdio: 'inherit' });
process.exit(calculation.status || 0);
