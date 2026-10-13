(function (root) {
  'use strict';

  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const transitions = {
    aguardando_analise: ['em_analise', 'aprovada', 'recusada', 'cancelada'],
    em_analise: ['aprovada', 'recusada', 'cancelada'],
    aprovada: ['aguardando_formalizacao', 'liberada', 'recusada', 'cancelada'],
    aguardando_formalizacao: ['formalizada', 'cancelada'],
    liberada: ['formalizada', 'cancelada'],
    recusada: [],
    formalizada: [],
    cancelada: []
  };

  function appError(code) {
    const Errors = root.JKErrors;
    return Errors?.AppError ? new Errors.AppError(code) : Object.assign(new Error(code), { code });
  }
  function client() {
    if (!root.JKErrors?.getClient) throw appError('CONFIG');
    return root.JKErrors.getClient();
  }
  function requireUser() {
    const user = root.JKAuth?.user;
    if (!user?.id) throw appError('SESSION');
    return user;
  }
  function requireAdmin() {
    const user = requireUser();
    if (root.JKAuth?.admin !== true) throw appError('FORBIDDEN');
    return user;
  }
  function requireRequestKey(key) {
    if (typeof key !== 'string' || !uuidPattern.test(key)) throw appError('VALIDATION');
    return key;
  }
  function unwrap(result) {
    if (result?.error) throw result.error;
    return result?.data;
  }
  function firstRow(data) {
    return Array.isArray(data) ? data[0] ?? null : data ?? null;
  }
  function requiredText(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  const repository = {
    async listLoans({ own = false, statuses, limit = 100 } = {}) {
      const user = requireUser();
      if (!own && root.JKAuth?.admin !== true) throw appError('FORBIDDEN');
      let query = client().from('loan_requests').select('*, profiles(full_name)').order('created_at', { ascending: false });
      if (own) query = query.eq('user_id', user.id);
      if (Array.isArray(statuses) && statuses.length) query = query.in('status', statuses);
      const boundedLimit = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(500, Math.trunc(Number(limit)))) : 100;
      return unwrap(await query.limit(boundedLimit)) ?? [];
    },

    async getLoan({ id, protocol } = {}) {
      requireUser();
      const loanId = requiredText(id);
      const loanProtocol = requiredText(protocol);
      if (!loanId && !loanProtocol) throw appError('VALIDATION');
      let query = client().from('loan_requests').select('*, profiles(full_name)');
      if (loanId) query = query.eq('id', loanId);
      if (loanProtocol) query = query.eq('protocol', loanProtocol);
      const row = unwrap(await query.maybeSingle());
      if (!row) throw appError('NOT_FOUND');
      return row;
    },

    async listPayments(loanId) {
      requireUser();
      if (!requiredText(loanId)) throw appError('VALIDATION');
      return unwrap(await client().from('payments').select('*').eq('loan_request_id', loanId)
        .order('payment_date', { ascending: false })) ?? [];
    },

    async getSettings() {
      requireUser();
      const row = unwrap(await client().from('loan_settings').select('*').eq('id', true).maybeSingle());
      if (!row) throw appError('NOT_FOUND');
      return row;
    },

    async createLoanRequest({ amount, installments, firstDueDate, requestKey } = {}) {
      requireUser();
      const key = requireRequestKey(requestKey);
      const value = Number(amount);
      const count = Number(installments);
      if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(count) || count < 1 ||
          typeof firstDueDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(firstDueDate)) throw appError('VALIDATION');
      const data = unwrap(await client().rpc('create_loan_request_checked', {
        p_amount: value,
        p_installments: count,
        p_first_due: firstDueDate,
        p_idempotency_key: key
      }));
      const row = firstRow(data);
      if (!row) throw appError('INVALID_RESPONSE');
      return row;
    },

    async updateLoanStatus({ id, status, expectedStatus, requestKey } = {}) {
      requireAdmin();
      const loanId = requiredText(id), expected = requiredText(expectedStatus), target = requiredText(status);
      const key = requireRequestKey(requestKey);
      if (!loanId || !expected || !target || !transitions[expected]?.includes(target)) throw appError('VALIDATION');
      const data = unwrap(await client().rpc('update_loan_status', {
        p_loan_request_id: loanId,
        p_status: target,
        p_expected_status: expected,
        p_idempotency_key: key
      }));
      const row = firstRow(data);
      if (!row) throw appError('INVALID_RESPONSE');
      return row;
    },

    async recordPayment({ loanId, installment, amount, date, method, observation = null, requestKey } = {}) {
      requireAdmin();
      const id = requiredText(loanId), paymentDate = requiredText(date), paymentMethod = requiredText(method);
      const number = Number(installment), value = Number(amount), key = requireRequestKey(requestKey);
      if (!id || !Number.isInteger(number) || number < 1 || !Number.isFinite(value) || value <= 0 ||
          !/^\d{4}-\d{2}-\d{2}$/.test(paymentDate) || !['pix', 'transferencia', 'dinheiro', 'outro'].includes(paymentMethod) ||
          (observation != null && typeof observation !== 'string')) throw appError('VALIDATION');
      const data = unwrap(await client().rpc('record_loan_payment', {
        p_loan_request_id: id,
        p_installment_number: number,
        p_amount_paid: value,
        p_payment_date: paymentDate,
        p_payment_method: paymentMethod,
        p_observation: observation?.trim() || null,
        p_idempotency_key: key
      }));
      const row = firstRow(data);
      if (!row) throw appError('INVALID_RESPONSE');
      return row;
    },

    async getFinancialIndicators({ dateFrom, dateTo, status, search } = {}) {
      requireAdmin();
      const data = unwrap(await client().rpc('get_financial_indicators', {
        p_date_from: dateFrom,
        p_date_to: dateTo,
        p_status: status,
        p_search: search
      }));
      return firstRow(data) ?? {};
    },

    async getLoansReport({ dateFrom, dateTo, status, search, limit = 500 } = {}) {
      requireAdmin();
      const data = unwrap(await client().rpc('get_loans_report', {
        p_date_from: dateFrom,
        p_date_to: dateTo,
        p_status: status,
        p_search: search,
        p_limit: limit
      }));
      return data ?? [];
    },

    async getInstallmentsReport({ dateFrom, dateTo, status, search, limit = 500 } = {}) {
      requireAdmin();
      const data = unwrap(await client().rpc('get_installments_report', {
        p_date_from: dateFrom,
        p_date_to: dateTo,
        p_status: status,
        p_search: search,
        p_limit: limit
      }));
      return data ?? [];
    },

    async getAuditLog({ dateFrom, dateTo, limit = 200 } = {}) {
      requireAdmin();
      const data = unwrap(await client().rpc('get_audit_log', {
        p_date_from: dateFrom,
        p_date_to: dateTo,
        p_limit: limit
      }));
      return data ?? [];
    },

    transitions: Object.freeze(Object.fromEntries(Object.entries(transitions).map(([key, values]) => [key, Object.freeze(values.slice())])))
  };

  root.JKRepository = repository;
  if (typeof module !== 'undefined') module.exports = repository;
})(typeof window === 'undefined' ? globalThis : window);
