const { test } = require('node:test');
const assert = require('node:assert/strict');
const repository = require('../public/repository.js');

const USER = '22222222-2222-4222-8222-222222222222';
const KEY = '33333333-3333-4333-8333-333333333333';

function setup({ admin = false, user = { id: USER }, data = {}, rpcData = {}, error = null } = {}) {
  const calls = [];
  global.JKAuth = { user, admin };
  global.JKErrors = {
    AppError: class AppError extends Error { constructor(code) { super(code); this.code = code; } },
    getClient: () => ({
      from(table) {
        const query = { table };
        for (const method of ['select', 'eq', 'in', 'order', 'limit']) query[method] = (...args) => {
          calls.push({ table, method, args });
          return query;
        };
        query.maybeSingle = async () => ({ data: Array.isArray(data[table]) ? data[table][0] ?? null : data[table] ?? null, error });
        query.then = (resolve, reject) => Promise.resolve({ data: data[table] ?? [], error }).then(resolve, reject);
        return query;
      },
      rpc: async (name, args) => {
        calls.push({ rpc: name, args });
        return { data: rpcData[name] ?? null, error };
      }
    })
  };
  return calls;
}

test('reads return database rows and apply ownership, status, and bounded limit filters', async () => {
  const loan = { id: 'loan-1', user_id: USER, status: 'aprovada' };
  const calls = setup({ data: { loan_requests: [loan], payments: [{ id: 'payment-1' }], loan_settings: { id: true } } });
  assert.deepEqual(await repository.listLoans({ own: true, statuses: ['aprovada'], limit: 900 }), [loan]);
  assert.deepEqual(await repository.getLoan({ id: 'loan-1' }), loan);
  assert.deepEqual(await repository.listPayments('loan-1'), [{ id: 'payment-1' }]);
  assert.deepEqual(await repository.getSettings(), { id: true });
  assert.ok(calls.some(call => call.table === 'loan_requests' && call.method === 'eq' && call.args[0] === 'user_id' && call.args[1] === USER));
  assert.ok(calls.some(call => call.table === 'loan_requests' && call.method === 'in' && call.args[0] === 'status'));
  assert.ok(calls.some(call => call.table === 'loan_requests' && call.method === 'limit' && call.args[0] === 500));
});

test('non-admin cannot list every loan or call administrative mutations', async () => {
  setup();
  await assert.rejects(repository.listLoans(), { code: 'FORBIDDEN' });
  await assert.rejects(repository.updateLoanStatus({ id: 'loan-1', status: 'liberada', expectedStatus: 'aprovada', requestKey: KEY }), { code: 'FORBIDDEN' });
  await assert.rejects(repository.recordPayment({ loanId: 'loan-1', installment: 1, amount: 1, date: '2026-10-01', method: 'pix', requestKey: KEY }), { code: 'FORBIDDEN' });
});

test('reads preserve backend errors and absent loan/settings are reported as not found', async () => {
  const dbError = Object.assign(new Error('RLS denial'), { code: '42501' });
  setup({ error: dbError });
  await assert.rejects(repository.listPayments('loan-1'), error => error === dbError);
  setup({ data: { loan_requests: null } });
  await assert.rejects(repository.getLoan({ protocol: 'JK-TEST' }), { code: 'NOT_FOUND' });
});

test('loan request forwards only canonical calculation inputs and idempotency key', async () => {
  const row = { id: 'loan-2', status: 'aguardando_analise' };
  const calls = setup({ rpcData: { create_loan_request_checked: row } });
  assert.deepEqual(await repository.createLoanRequest({ amount: '500.00', installments: '2', firstDueDate: '2026-11-01', requestKey: KEY }), row);
  assert.deepEqual(calls.at(-1), { rpc: 'create_loan_request_checked', args: { p_amount: 500, p_installments: 2, p_first_due: '2026-11-01', p_idempotency_key: KEY } });
  await assert.rejects(repository.createLoanRequest({ amount: 500, installments: 2, firstDueDate: '01/11/2026', requestKey: KEY }), { code: 'VALIDATION' });
});

test('status/payment writes use RPC only and validate status/request inputs', async () => {
  const status = { id: 'loan-1', status: 'liberada' }, payment = { id: 'payment-1', amount_paid: 30 };
  const calls = setup({ admin: true, rpcData: { update_loan_status: status, record_loan_payment: payment } });
  assert.deepEqual(await repository.updateLoanStatus({ id: 'loan-1', expectedStatus: 'aprovada', status: 'liberada', requestKey: KEY }), status);
  assert.deepEqual(await repository.recordPayment({ loanId: 'loan-1', installment: 1, amount: '30', date: '2026-10-01', method: 'pix', requestKey: KEY }), payment);
  assert.deepEqual(calls.map(call => call.rpc), ['update_loan_status', 'record_loan_payment']);
  await assert.rejects(repository.updateLoanStatus({ id: 'loan-1', expectedStatus: 'formalizada', status: 'liberada', requestKey: KEY }), { code: 'VALIDATION' });
  await assert.rejects(repository.recordPayment({ loanId: 'loan-1', installment: 1, amount: 31, date: '2026-10-01', method: 'cheque', requestKey: KEY }), { code: 'VALIDATION' });
});
