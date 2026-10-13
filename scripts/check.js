const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
let count = 0;
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.(js|mjs)$/.test(file)) {
      const check = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
      if (check.status) process.exit(check.status);
      count++;
    } else if (file.endsWith('.html')) {
      const text = fs.readFileSync(file, 'utf8');
      for (const match of text.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(match[1], { filename: file });
    }
  }
}
for (const folder of ['public', 'tests', 'scripts', 'supabase/functions']) walk(path.join(root, folder));
console.log(`${count} arquivos JavaScript verificados.`);
