const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');

test('browser client rejects privileged keys and unsafe endpoints before making requests', () => {
  const source = fs.readFileSync('public/errors.js', 'utf8');
  const encoded = role => `header.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.signature`;
  for (const [url,key,valid] of [
    ['https://project.supabase.co',encoded('anon'),true],
    ['http://127.0.0.1:54321',encoded('anon'),true],
    ['http://external.test',encoded('anon'),false],
    ['https://user:password@external.test',encoded('anon'),false],
    ['https://project.supabase.co',encoded('service_role'),false],
    ['https://project.supabase.co','sb_secret_synthetic',false],
    ['javascript:alert(1)',encoded('anon'),false],
  ]) {
    let calls = 0;
    const window = { JK_CONFIG:{SUPABASE_URL:url,SUPABASE_ANON_KEY:key},atob, supabase:{createClient(){calls++;return {};}} };
    vm.runInNewContext(source,{window,URL});
    if(valid) { window.JKErrors.getClient(); assert.equal(calls,1); }
    else { assert.throws(()=>window.JKErrors.getClient(),error=>error.code==='CONFIG'); assert.equal(calls,0); }
  }
});

test('CSP protects deployment and local preview without inline or third-party scripts', () => {
  const headers = require('../scripts/security-headers');
  const policy = headers['Content-Security-Policy'];
  assert.doesNotMatch(policy,/unsafe-inline|unsafe-eval|\*/);
  const deployment = fs.readFileSync('netlify.toml','utf8');
  for(const [name,value] of Object.entries(headers)) assert.ok(deployment.includes(`${name} = "${value}"`),name);
  const html = fs.readFileSync('public/index.html','utf8');
  assert.doesNotMatch(html,/<style\b|style\s*=|<script\b[^>]*>\s*[^<\s]|https?:\/\//i);
  for(const file of ['public/app.js','public/auth.js']) assert.doesNotMatch(fs.readFileSync(file,'utf8'),/style\s*=\s*["']/i);
  const readme=fs.readFileSync('public/vendor/README.md','utf8');
  const digest=crypto.createHash('sha256').update(fs.readFileSync('public/vendor/supabase-2.45.4.js')).digest('hex');
  assert.ok(readme.includes(digest));
});


test('auth failures keep safe, actionable messages without exposing provider responses', () => {
  const errors = require('../public/errors');
  assert.equal(errors.normalize({status:401,code:'invalid_credentials',message:'private data'}).code,'INVALID_CREDENTIALS');
  assert.equal(errors.normalize({status:403,code:'email_not_confirmed'}).code,'EMAIL_NOT_CONFIRMED');
  assert.doesNotMatch(errors.normalize({status:401,code:'invalid_credentials',message:'private data'}).message,/private/);
});
