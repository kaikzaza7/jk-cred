const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const { TextEncoder } = require('node:util');
const JKApp = require('../public/app.js');

function target() {
  const listeners = {};
  return {
    innerHTML: '', textContent: '', dataset: {}, classList: { add() {}, remove() {} },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    dispatch(type, event = {}) { for (const fn of listeners[type] || []) fn(event); },
    listeners,
  };
}

function appWindow({ ready = false, hash = '#/cliente/solicitacoes', loans = [] } = {}) {
  const listeners = {};
  const elements = new Map();
  const app = target(); elements.set('app', app);
  const local = new Map();
  let ownListCalls = 0, bound = [];
  const win = {
    document: {
      getElementById(id) { if (!elements.has(id)) elements.set(id, target()); return elements.get(id); },
      addEventListener(type, fn) { (listeners[`doc:${type}`] ||= []).push(fn); },
    },
    location: { hash },
    localStorage: {
      getItem(key) { return local.get(key) ?? null; },
      setItem(key, value) { local.set(key, value); },
      removeItem(key) { local.delete(key); },
      entries() { return [...local.entries()]; },
    },
    crypto: webcrypto,
    TextEncoder,
    setTimeout, clearTimeout, scrollTo() {},
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    dispatch(type) { for (const fn of listeners[type] || []) fn(); },
    JKAuth: {
      get ready() { return ready; }, user: { id: 'user-1' }, admin: false,
      views: { '#/cliente/login': '<form id="auth-login">Sign in</form>' },
      bind(path) { bound.push(path); }, redirectFor(path) { return path; }, logout() {},
    },
    JKErrors: {
      AppError: class extends Error { constructor(code) { super(code); this.code = code; } },
      normalize(error) { return error; }, show(error, id) { elements.get(id).textContent = error.message; },
      async run(_key, work) { try { return await work(); } catch (error) { this.report(error); } },
      report(error) { throw error; },
    },
    JKRepository: {
      async listLoans(opts) { if (opts.own) ownListCalls++; return loans; },
      async getLoan() { throw new Error('unexpected getLoan'); },
      async listPayments() { return []; },
      async getSettings() { return { min_amount: 100, max_amount: 5000, max_installments: 12 }; },
    },
  };
  return { win, elements, bound: () => bound, ownListCalls: () => ownListCalls, setReady(value) { ready = value; } };
}

test('escapes database values and normalizes route fragments', () => {
  assert.equal(JKApp.escapeHtml(`<img src=x onerror='x'>`), '&lt;img src=x onerror=&#39;x&#39;&gt;');
  assert.equal(JKApp.routePath('#/cliente/solicitacoes?tab=old'), '#/cliente/solicitacoes');
});

test('waits for auth bootstrap, binds auth forms after rendering, then loads owned history', async () => {
  const fixture = appWindow({ ready: false });
  JKApp.start(fixture.win);
  assert.equal(fixture.elements.get('app').innerHTML, '');
  fixture.setReady(true);
  fixture.win.location.hash = '#/cliente/login';
  fixture.win.dispatch('jk:authchange');
  assert.match(fixture.elements.get('app').innerHTML, /auth-login/);
  assert.deepEqual(fixture.bound(), ['#/cliente/login']);
  fixture.win.location.hash = '#/cliente/solicitacoes';
  fixture.win.dispatch('hashchange');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.ownListCalls(), 1);
  assert.match(fixture.elements.get('app').innerHTML, /Histórico consultado da sua conta/);
});

test('pending operation keys survive retries without storing input values', async () => {
  const fixture = appWindow();
  const fp = await JKApp.fingerprint(fixture.win, 'amount|date|term');
  const key1 = await JKApp.stableKey(fixture.win, 'loan-request', fp);
  const key2 = await JKApp.stableKey(fixture.win, 'loan-request', fp);
  assert.equal(key1, key2);
  const storedEntry = fixture.win.localStorage.entries()[0];
  assert.ok(storedEntry);
  assert.match(storedEntry[0], /^jkcred:[a-f0-9]{64}:loan-request:pending$/);
  const saved = storedEntry[1];
  assert.equal(saved.includes('amount|date|term'), false);
  await assert.rejects(JKApp.stableKey(fixture.win, 'loan-request', 'different-fingerprint'), error => error.code === 'WRITE_UNCONFIRMED');
  await JKApp.clearKey(fixture.win, 'loan-request');
  assert.equal(fixture.win.localStorage.getItem(storedEntry[0]), null);
});

test('pending request keys are isolated by signed-in user', async () => {
  const fixture = appWindow();
  const first = await JKApp.stableKey(fixture.win, 'payment-record', 'same-operation');
  fixture.win.JKAuth.user = { id: 'user-2' };
  const second = await JKApp.stableKey(fixture.win, 'payment-record', 'same-operation');
  assert.notEqual(first, second);
  assert.equal(fixture.win.localStorage.entries().length, 2);
});

test('estimates follow current settings and payment balance includes partial payments', () => {
  const rules = require('../public/loan-rules.js');
  const estimate = JKApp.calculateEstimate(rules, { charge_percent: 40, extra_installment_fee: 12 }, 1000, 3);
  assert.equal(estimate.charge, 400);
  assert.equal(estimate.installmentFee, 24);
  assert.equal(estimate.total, 1424);
  const payments = [{ installment_number: 2, amount_paid: 25 }, { installment_number: 2, amount_paid: 35 }];
  assert.equal(JKApp.remainingInstallment(100, payments, 2), 40);
  assert.equal(JKApp.remainingInstallment(100, [...payments, { installment_number: 2, amount_paid: 50 }], 2), 0);
});

test('stale history response does not overwrite the newer route result', async () => {
  const fixture = appWindow({ ready: true });
  const resolve = [];
  fixture.win.JKRepository.listLoans = () => new Promise(done => resolve.push(done));
  JKApp.start(fixture.win);
  fixture.win.location.hash = '#/cliente';
  fixture.win.dispatch('hashchange');
  assert.equal(resolve.length, 2);
  resolve[1]([{ protocol: 'NEW', requested_amount: 1, installments: 1, status: 'aprovada' }]);
  await new Promise(done => setImmediate(done));
  const table = fixture.elements.get('loans-table').innerHTML;
  resolve[0]([{ protocol: 'OLD', requested_amount: 1, installments: 1, status: 'aprovada' }]);
  await new Promise(done => setImmediate(done));
  assert.equal(fixture.elements.get('loans-table').innerHTML, table);
  assert.match(table, /NEW/);
  assert.doesNotMatch(table, /OLD/);
});

test('stale history failure does not report into a newly rendered route', async () => {
  const fixture = appWindow({ ready: true });
  const pending = [];
  fixture.win.JKRepository.listLoans = () => new Promise((resolve, reject) => pending.push({ resolve, reject }));
  JKApp.start(fixture.win);
  fixture.win.location.hash = '#/cliente';
  fixture.win.dispatch('hashchange');
  pending[1].resolve([{ protocol: 'CURRENT', requested_amount: 1, installments: 1, status: 'aprovada' }]);
  await new Promise(done => setImmediate(done));
  const currentHtml = fixture.elements.get('loans-table').innerHTML;
  pending[0].reject(new Error('stale read failure'));
  await new Promise(done => setImmediate(done));
  assert.equal(fixture.elements.get('loans-table').innerHTML, currentHtml);
  assert.match(currentHtml, /CURRENT/);
});


test('a newer route read is not blocked by the duplicate-write guard', async () => {
  const fixture=appWindow({ready:true});
  const locks=new Set(), requests=[];
  fixture.win.JKErrors.run=async(key,work)=>{
    if(locks.has(key))return;
    locks.add(key);try{return await work();}finally{locks.delete(key);}
  };
  fixture.win.JKRepository.listLoans=()=>new Promise(resolve=>requests.push(resolve));
  JKApp.start(fixture.win);
  fixture.win.location.hash='#/cliente';fixture.win.dispatch('hashchange');
  assert.equal(requests.length,2);
  requests[1]([{protocol:'LATEST',requested_amount:1000,installments:3,status:'aguardando_analise'}]);
  requests[0]([]);
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(fixture.elements.get('loans-table').innerHTML,/LATEST/);
});

test('estimate renders latest input when server settings were still loading', async () => {
  const fixture=appWindow({ready:true,hash:'#/cliente/solicitar'});
  fixture.win.JKLoan=require('../public/loan-rules.js');
  const el=id=>fixture.win.document.getElementById(id);
  el('valor').value='1000';el('parcelas').value='3';el('parcelas').dataset.limit='12';
  el('dataVencimento').value='2026-10-20';
  el('estimate-bar').children=[{style:{}},{style:{}}];
  let finish,calls=0;
  fixture.win.JKRepository.getSettings=()=>{calls++;return new Promise(resolve=>{finish=resolve;});};
  JKApp.start(fixture.win);
  el('valor').value='1600';el('valor').dispatch('input');
  finish({min_amount:100,max_amount:5000,max_installments:12});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls,1);
  assert.match(el('output-valor-solicitado').textContent,/1.600/);
  assert.match(el('output-total').textContent,/2.100/);
});
