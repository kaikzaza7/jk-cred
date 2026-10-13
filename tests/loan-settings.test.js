const { test } = require('node:test');
const assert = require('node:assert/strict');
const { calcLoan } = require('../public/loan-rules.js');
test('simulation uses current server settings including zero fees and cent rounding', () => {
  const loan = calcLoan(1000, 3, { chargePercent: 20, extraInstallmentFee: 5 });
  assert.deepEqual(loan.schedule, [403.33, 403.33, 403.34]);
  assert.equal(loan.total, 1210);
  assert.equal(calcLoan(1000, 3, { chargePercent: 0, extraInstallmentFee: 0 }).total, 1000);
  assert.throws(() => calcLoan(1000, 3, { chargePercent: -1 }));
  assert.throws(() => calcLoan(1000, 3, { extraInstallmentFee: 0.001 }));
});
