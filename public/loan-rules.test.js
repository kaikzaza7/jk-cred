// Rodar com: node site/tests/loan-rules.test.js
const assert = require('node:assert/strict');
const { calcLoan, loanSummaryText } = require('./loan-rules.js');
let ok = 0; const t = (nome, fn) => { fn(); ok++; console.log('OK  ', nome); };

t('R$ 1.000 em 3x = total 1.320, 3 x 440', () => {
  const r = calcLoan(1000, 3);
  assert.deepEqual([r.charge, r.installmentFee, r.total], [300, 20, 1320]);
  assert.deepEqual(r.schedule, [440, 440, 440]);
});
t('R$ 1.000 em 5x = total 1.340, 5 x 268', () => {
  const r = calcLoan(1000, 5);
  assert.deepEqual([r.charge, r.installmentFee, r.total], [300, 40, 1340]);
  assert.deepEqual(r.schedule, [268, 268, 268, 268, 268]);
});
t('1 parcela: sem adicional (1.000 -> 1.300)', () => {
  const r = calcLoan(1000, 1); assert.deepEqual([r.installmentFee, r.total, r.schedule], [0, 1300, [1300]]);
});
t('ajuste de centavos na última parcela (1000,01 em 3x)', () => {
  const r = calcLoan(1000.01, 3);
  assert.equal(r.total, 1320.01); assert.deepEqual(r.schedule, [440, 440, 440.01]);
});
t('soma das parcelas == total (vários casos)', () => {
  for (const a of [0.01, 33.33, 99.99, 250.5, 1234.56, 5000]) for (const n of [1, 2, 3, 7, 12, 24]) {
    const r = calcLoan(a, n); const s = Math.round(r.schedule.reduce((x, y) => x + y, 0) * 100);
    assert.equal(s, Math.round(r.total * 100), `${a} em ${n}x`);
  }
});
t('NÃO usa 10% por parcela (regra antiga)', () => {
  assert.notEqual(calcLoan(1000, 3).total, 1000 * 1.3 * 1.1);
});
t('entradas inválidas são recusadas', () => {
  for (const [a, n] of [[0, 3], [-5, 3], [NaN, 3], ['abc', 3], [10.001, 3], [1000, 0], [1000, 2.5], [1000, -1], [1000, NaN]])
    assert.throws(() => calcLoan(a, n), undefined, `${a},${n}`);
});
t('texto de resumo (WhatsApp) usa a mesma regra', () => {
  const s = loanSummaryText(1000, 3).replace(/\u00a0/g, ' ');
  assert.ok(s.includes('R$ 1.320,00') && s.includes('3x de R$ 440,00'), s);
});
console.log(`\n${ok} testes passaram.`);
