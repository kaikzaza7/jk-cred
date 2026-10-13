/* JK CRED — loan-rules.js: ÚNICA fonte da regra de cálculo no front-end.
   Regra: encargo inicial de 30% + R$ 10,00 fixos por parcela adicional após a primeira.
   Tudo em centavos inteiros para evitar erro de ponto flutuante.
   O backend (supabase/migrations/003_loans.sql) confirma a regra; este arquivo só exibe/simula. */
(function (root) {
  const CHARGE_RATE_PERCENT = 30;      // acréscimo inicial
  const EXTRA_INSTALLMENT_FEE = 1000;  // centavos (R$ 10,00) por parcela após a primeira

  function calcLoan(amount, installments, rules = {}) {
    const n = Number(installments);
    const x = Number(amount) * 100;
    const cents = Math.round(x);
    if (!Number.isSafeInteger(cents) || cents < 1 || Math.abs(x - cents) > 1e-6) throw new Error('Valor solicitado inválido.');
    if (!Number.isInteger(n) || n < 1) throw new Error('Quantidade de parcelas inválida.');

    const rate = Number(rules.chargePercent ?? CHARGE_RATE_PERCENT);
    const fee = Number(rules.extraInstallmentFee ?? EXTRA_INSTALLMENT_FEE / 100);
    const feeCents = Math.round(fee * 100);
    if (!Number.isFinite(rate) || rate < 0 || !Number.isSafeInteger(feeCents) || feeCents < 0 || Math.abs(fee * 100 - feeCents) > 1e-6) throw new Error('Regras de cálculo inválidas.');
    const charge = Math.round(cents * rate / 100);   // encargo inicial
    const installmentFee = (n - 1) * feeCents;         // adicional de parcelamento
    const total = cents + charge + installmentFee;                  // valor total
    if (!Number.isSafeInteger(total)) throw new Error('Valor solicitado inválido.');
    const base = Math.floor(total / n);                             // parcela
    const last = total - base * (n - 1);                            // última absorve os centavos
    const r = c => c / 100;
    return {
      amount: r(cents), charge: r(charge), installmentFee: r(installmentFee), total: r(total),
      installments: n, installmentValue: r(base), lastInstallmentValue: r(last),
      schedule: Array.from({ length: n }, (_, i) => r(i === n - 1 ? last : base)),
    };
  }

  const fmtBRL = v => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  // Texto reutilizável para resumos e mensagens (ex.: WhatsApp), sempre gerado pela mesma função de cálculo
  function loanSummaryText(amount, installments) {
    const L = calcLoan(amount, installments);
    const parcelas = L.installmentValue === L.lastInstallmentValue
      ? `${L.installments}x de ${fmtBRL(L.installmentValue)}`
      : `${L.installments - 1}x de ${fmtBRL(L.installmentValue)} + 1x de ${fmtBRL(L.lastInstallmentValue)}`;
    return `Valor solicitado: ${fmtBRL(L.amount)}\nEncargo inicial (30%): ${fmtBRL(L.charge)}\n` +
           `Adicional de parcelamento: ${fmtBRL(L.installmentFee)}\nValor total: ${fmtBRL(L.total)}\nParcelas: ${parcelas}`;
  }

  const api = { calcLoan, fmtBRL, loanSummaryText, CHARGE_RATE_PERCENT, EXTRA_INSTALLMENT_FEE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.JKLoan = api;
})(typeof window !== 'undefined' ? window : globalThis);
