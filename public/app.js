/* JK CRED client app. Server RPCs are the source of truth for writes and calculations. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document) api.start(root);
})(typeof window === 'undefined' ? null : window, function () {
  'use strict';

  const iconPaths = {
    home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>', users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/>',
    inbox: '<path d="M3 13l3-8h12l3 8"/><path d="M3 13v6h18v-6h-5l-1.5 2h-5L8 13z"/>', wallet: '<path d="M4 7h14a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2h11"/>',
    card: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19M6 15h4"/>', plus: '<path d="M12 5v14M5 12h14"/>', arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    back: '<path d="M19 12H5M11 6l-6 6 6 6"/>', shield: '<path d="M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6z"/>',
    out: '<path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/>', chat: '<path d="M21 12a8 8 0 01-11.6 7.1L3 20.5l1.5-5.2A8 8 0 1121 12z"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', menu: '<path d="M4 6h16M4 12h16M4 18h16"/>', eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  };
  const icon = name => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${iconPaths[name] || ''}</svg>`;
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const val = (row, snake, camel) => row?.[snake] ?? row?.[camel];
  const money = n => Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const date = value => value ? new Date(`${String(value).slice(0, 10)}T12:00:00`).toLocaleDateString('pt-BR') : '—';
  const businessDate = (now = new Date()) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  const addCalendarDays = (isoDate, days) => {
    const value = new Date(`${isoDate}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() + Number(days));
    return value.toISOString().slice(0, 10);
  };
  function routePath(hash) { return String(hash || '#/').split('?')[0]; }
  function calculateEstimate(loanRules, settings, amount, installments) {
    return loanRules.calcLoan(amount, installments, {
      chargePercent: Number(settings.charge_percent ?? settings.chargePercent ?? loanRules.CHARGE_RATE_PERCENT),
      extraInstallmentFee: Number(settings.extra_installment_fee ?? settings.extraInstallmentFee ?? loanRules.EXTRA_INSTALLMENT_FEE / 100),
    });
  }
  function remainingInstallment(expected, payments, installment) {
    const paid = payments.filter(p => Number(val(p, 'installment_number', 'installment')) === Number(installment))
      .reduce((sum, p) => sum + Number(val(p, 'amount_paid', 'amount') || 0), 0);
    return Math.max(0, Number(expected) - paid);
  }
  function escapeSegment(value) { return encodeURIComponent(String(value)); }
  function unescapeSegment(value) { try { return decodeURIComponent(value); } catch { return ''; } }
  function table(rows, headers, empty) {
    return `<div class="table-wrap"><table><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${headers.length}" class="muted">${empty}</td></tr>`}</tbody></table></div>`;
  }
  function shell(title, content, role = 'client') {
    const isAdmin = role === 'admin';
    const links = isAdmin
      ? [['Visão geral', '#/admin'], ['Solicitações', '#/admin/solicitacoes'], ['Empréstimos', '#/admin/emprestimos'], ['Pagamentos', '#/admin/pagamentos']]
      : [['Início', '#/cliente'], ['Solicitações', '#/cliente/solicitacoes'], ['Meus empréstimos', '#/cliente/emprestimos'], ['Solicitar', '#/cliente/solicitar']];
    return `<div class="shell" id="shell"><aside class="side-nav"><a class="logo" href="#/">JK <em>CRED</em></a><strong>${escapeHtml(title)}</strong><nav aria-label="Navegação">${links.map(([label, href]) => `<a href="${href}">${label}</a>`).join('')}</nav><nav class="exit"><a href="#/sair">Sair</a></nav></aside><div class="scrim" id="scrim"></div><section><header class="topbar"><button class="menu-btn" id="menuBtn" type="button" aria-label="Abrir menu">${icon('menu')}</button><strong>${escapeHtml(title)}</strong><span class="sp"></span><a class="btn btn-ghost" href="#/sair">Sair</a></header><main class="page">${content}</main></section></div>`;
  }
  function landing() {
    return `<div class="landing"><header><a class="logo" href="#/">JK <em>CRED</em></a></header><main><section><h1>Crédito com clareza, do pedido à última parcela.</h1><p class="lead">Solicite empréstimos e acompanhe suas solicitações e parcelas em um só lugar.</p></section><section class="choices" aria-label="Escolha seu acesso"><a class="choice primary" href="#/cliente/login"><div class="ico">${icon('users')}</div><b>Sou cliente</b><span>Acompanhe seus empréstimos e solicite crédito</span>${icon('arrow')}</a><a class="choice" href="#/admin/login"><div class="ico">${icon('shield')}</div><b>Área administrativa</b><span>Gestão de solicitações e pagamentos</span>${icon('arrow')}</a></section></main><footer>© JK CRED — todos os direitos reservados</footer></div>`;
  }
  function simulator() {
    const firstDue = addCalendarDays(businessDate(), 7);
    return `<h1>Simular empréstimo</h1><p class="muted">Confira uma estimativa. O cálculo definitivo é confirmado pelo servidor ao enviar.</p><form id="f-simulador"><section class="card"><div class="row2"><div class="field"><label for="valor">Valor solicitado</label><input id="valor" name="amount" type="number" min="100" max="5000" step="0.01" value="1000" required></div><div class="field"><label for="parcelas">Parcelas</label><select id="parcelas" name="installments" required disabled><option value="">Carregando parcelas…</option></select></div></div><div class="field"><label for="dataVencimento">Primeiro vencimento</label><input id="dataVencimento" name="firstDueDate" type="date" value="${firstDue}" required></div></section><p id="estimate-validation" class="estimate-validation" role="status" hidden></p><section id="estimate-card" class="card estimate-card mt-card"><h2>Seu empréstimo em números</h2><div class="estimate-metrics"><div><span>Você recebe</span><output id="output-valor-solicitado"></output></div><div><span>Encargos estimados</span><output id="output-encargos"></output></div><div class="estimate-total"><span>Total a pagar</span><output id="output-total"></output></div></div><div class="estimate-composition"><h3>Do que é feito o total</h3><div id="estimate-bar" class="estimate-bar" aria-hidden="true"></div><div id="estimate-legend" class="estimate-legend"></div><p id="estimate-fees" class="muted"></p></div><div class="estimate-installments"><span>Pagamento mensal</span><output id="output-parcela"></output></div><div id="cronograma" aria-live="polite"></div></section><div class="notice show" role="note">O envio cria uma solicitação real para análise. A simulação, sozinha, não gera pedido.</div><button class="btn btn-primary btn-block" type="submit">Enviar solicitação real</button><div id="form-message" role="status" aria-live="polite"></div></form>`;
  }
  const statusNames = { aguardando_analise:'Aguardando análise', em_analise:'Em análise', aprovada:'Aprovada', liberada:'Liberada', recusada:'Recusada', aguardando_formalizacao:'Aguardando formalização', formalizada:'Formalizada', cancelada:'Cancelada', pendente:'Pendente', parcialmente_paga:'Parcialmente paga', paga:'Paga', atrasada:'Em atraso' };
  function statusBadge(status) {
    const known = Object.hasOwn(statusNames, status);
    return `<span class="badge badge-${known ? status : 'neutral'}">${known ? statusNames[status] : 'Situação indisponível'}</span>`;
  }
  function loanRows(rows, actions = false) {
    return rows.map(loan => `<tr><td>${escapeHtml(val(loan, 'protocol', 'protocol'))}</td><td>${escapeHtml(loan.profiles?.full_name || loan.full_name || '—')}</td><td>${money(val(loan, 'requested_amount', 'requestedAmount'))}</td><td>${escapeHtml(val(loan, 'installments', 'installments'))}</td><td>${statusBadge(val(loan, 'status', 'status'))}</td><td>${actions ? `<button class="btn btn-ghost" type="button" data-action="loan-detail" data-id="${escapeHtml(val(loan, 'id', 'id'))}">Detalhes</button>${['aguardando_analise', 'em_analise'].includes(val(loan, 'status', 'status')) ? `<button class="btn btn-primary" type="button" data-action="approve" data-id="${escapeHtml(val(loan, 'id', 'id'))}" data-status="${escapeHtml(val(loan, 'status', 'status'))}">Aprovar</button><button class="btn btn-ghost" type="button" data-action="reject" data-id="${escapeHtml(val(loan, 'id', 'id'))}" data-status="${escapeHtml(val(loan, 'status', 'status'))}">Recusar</button>` : ''}${val(loan, 'status', 'status') === 'aprovada' ? `<button class="btn btn-primary" type="button" data-action="release" data-id="${escapeHtml(val(loan, 'id', 'id'))}">Liberar</button>` : ''}` : `<a class="btn btn-ghost" href="#/cliente/emprestimo/${escapeSegment(val(loan, 'protocol', 'protocol'))}">Ver detalhes</a>`}</td></tr>`).join('');
  }
  function scheduleRows(schedule, payments, today = businessDate()) {
    return (Array.isArray(schedule) ? schedule : []).map((item, index) => {
      const installment = Number(item.n || index + 1), expected = Number(item.value || 0);
      const paid = payments.filter(p => Number(val(p, 'installment_number', 'installmentNumber')) === installment).reduce((sum, p) => sum + Number(val(p, 'amount_paid', 'amountPaid') || 0), 0);
      const due = item.due_date || item.dueDate || '';
      const status = paid >= expected ? 'Paga' : paid > 0 ? 'Parcial' : (due && due < today ? 'Atrasada' : 'Pendente');
      return `<tr><td>${installment}</td><td>${money(expected)}</td><td>${date(due)}</td><td>${money(paid)}</td><td>${money(Math.max(expected - paid, 0))}</td><td>${status}</td></tr>`;
    }).join('');
  }
  function paymentsTable(payments) {
    return table(payments.map(p => `<tr><td>${date(val(p, 'payment_date', 'date'))}</td><td>${escapeHtml(val(p, 'installment_number', 'installment'))}</td><td>${money(val(p, 'amount_paid', 'amount'))}</td><td>${escapeHtml(val(p, 'payment_method', 'method'))}</td><td>${escapeHtml(val(p, 'observation', 'observation') || '')}</td></tr>`).join(''), ['Data', 'Parcela', 'Valor', 'Forma', 'Observação'], 'Nenhum pagamento registrado.');
  }

  function start(win) {
    const doc = win.document;
    const app = doc.getElementById('app');
    let renderVersion = 0;
    let selectedPaymentLoan = null;
    let selectedPayments = [];
    let searchTimer = null;
    let settingsPromise = null;
    let searchVersion = 0;
    const errors = win.JKErrors;
    const definitiveWriteFailure = error => ['VALIDATION', 'CONFLICT', 'FORBIDDEN', 'SESSION', 'NOT_FOUND']
      .includes(errors?.normalize?.(error)?.code);
    const repo = () => {
      if (!win.JKRepository) throw new (errors?.AppError || Error)('UNAVAILABLE');
      return win.JKRepository;
    };
    const guarded = (name, work, opts = {}) => errors?.run ? errors.run(name, work, opts) : work().catch(e => { errors?.report(e, name); });
    const toast = message => { const el = doc.getElementById('toast'); if (el) { el.textContent = message; el.classList.add('show'); win.setTimeout(() => el.classList.remove('show'), 3000); } };
    const current = version => version === renderVersion && routePath(win.location.hash) === renderedPath;
    let renderedPath = '#/';
    function getRoute(path) {
      if (path === '#/admin/solicitacoes') return { role: 'admin', title: 'Solicitações', html: shell('Solicitações', `<h1>Solicitações</h1><div id="loans-table" aria-live="polite">Carregando…</div>`, 'admin'), load: 'admin-requests' };
      if (path === '#/admin/emprestimos') return { role: 'admin', title: 'Empréstimos', html: shell('Empréstimos', `<h1>Empréstimos aprovados</h1><div id="loans-table" aria-live="polite">Carregando…</div>`, 'admin'), load: 'admin-loans' };
      if (path === '#/admin/pagamentos') return { role: 'admin', title: 'Pagamentos', html: shell('Pagamentos', `<h1>Registrar pagamento</h1><div class="field"><label for="payment-search">Buscar protocolo ou cliente</label><input id="payment-search" type="search" autocomplete="off"></div><div id="payment-results" aria-live="polite">Digite para buscar.</div><section id="payment-panel"></section>`, 'admin'), load: 'payment-search' };
      if (path.startsWith('#/admin/emprestimo/')) return { role: 'admin', title: 'Detalhes', html: shell('Detalhes', `<h1>Detalhes do empréstimo</h1><div id="loan-detail">Carregando…</div>`, 'admin'), load: 'admin-detail', id: unescapeSegment(path.slice('#/admin/emprestimo/'.length)) };
      if (path === '#/admin') return { role: 'admin', title: 'Visão geral', html: shell('Visão geral', `<h1>Painel JK CRED</h1><p class="muted">Contagens abaixo representam a amostra mais recente de até 100 solicitações.</p><section class="grid g3"><article class="card"><h3>Na amostra</h3><output id="count-total">—</output></article><article class="card"><h3>Pendentes na amostra</h3><output id="count-pending">—</output></article><article class="card"><h3>Aprovadas na amostra</h3><output id="count-approved">—</output></article></section><div id="loans-table">Carregando…</div>`, 'admin'), load: 'dashboard' };
      if (path === '#/cliente/solicitar' || path === '#/cliente/simulador') return { role: 'client', title: 'Solicitar', html: shell('Solicitar', simulator()) };
      if (path === '#/cliente/solicitacoes' || path === '#/cliente/emprestimos') return { role: 'client', title: 'Minhas solicitações', html: shell('Minhas solicitações', `<h1>Minhas solicitações</h1><p class="muted">Histórico consultado da sua conta.</p><div id="loans-table" aria-live="polite">Carregando…</div>`) , load: 'client-loans' };
      if (path.startsWith('#/cliente/emprestimo/')) return { role: 'client', title: 'Detalhes', html: shell('Detalhes', `<h1>Detalhes da solicitação</h1><div id="loan-detail">Carregando…</div>`) , load: 'client-detail', protocol: unescapeSegment(path.slice('#/cliente/emprestimo/'.length)) };
      if (path === '#/cliente') return { role: 'client', title: 'Início', html: shell('Início', `<section class="hero"><div><h2>Precisa de crédito?</h2><p>Faça uma simulação e acompanhe a solicitação pelo sistema.</p></div><a class="btn btn-light" href="#/cliente/solicitar">Simular empréstimo</a></section><section class="grid g2"><article class="card"><h2>Solicitações recentes</h2><div id="loans-table">Carregando…</div></article><article class="card"><h2>Fale com a JK CRED</h2><p class="muted">O canal de atendimento ainda não foi configurado.</p></article></section>`) , load: 'client-loans' };
      if (path === '#/' || path === '') return { html: landing() };
      return { html: `<main class="page"><h1>Página não encontrada</h1><p class="muted">Confira o endereço ou volte ao início.</p><a class="btn btn-primary" href="#/">Voltar ao início</a></main>` };
    }
    async function loadRows(container, rows, actions = false, empty = 'Nenhuma solicitação encontrada.') {
      if (container) container.innerHTML = table(loanRows(rows, actions), ['Protocolo', 'Cliente', 'Solicitado', 'Parcelas', 'Status', 'Ações'], empty);
    }
    async function loadRoute(route, version) {
      const r = repo();
      try {
      if (route.load === 'client-loans') {
        const loans = await r.listLoans({ own: true, limit: 100 });
        if (!current(version)) return;
        await loadRows(doc.getElementById('loans-table'), loans);
      } else if (route.load === 'admin-requests') {
        const loans = await r.listLoans({ statuses: ['aguardando_analise', 'em_analise'], limit: 100 });
        if (!current(version)) return;
        await loadRows(doc.getElementById('loans-table'), loans, true);
      } else if (route.load === 'admin-loans') {
        const loans = await r.listLoans({ statuses: ['aprovada', 'liberada', 'formalizada'], limit: 100 });
        if (!current(version)) return;
        await loadRows(doc.getElementById('loans-table'), loans, true);
      } else if (route.load === 'dashboard') {
        const loans = await r.listLoans({ limit: 100 });
        if (!current(version)) return;
        doc.getElementById('count-total').textContent = String(loans.length);
        doc.getElementById('count-pending').textContent = String(loans.filter(x => ['aguardando_analise', 'em_analise'].includes(val(x, 'status', 'status'))).length);
        doc.getElementById('count-approved').textContent = String(loans.filter(x => val(x, 'status', 'status') === 'aprovada').length);
        await loadRows(doc.getElementById('loans-table'), loans.slice(0, 10), true);
      } else if (route.load === 'admin-detail' || route.load === 'client-detail') {
        const loan = route.id ? await r.getLoan({ id: route.id }) : await r.getLoan({ protocol: route.protocol });
        const payments = await r.listPayments(val(loan, 'id', 'id'));
        if (!current(version)) return;
        renderDetail(doc.getElementById('loan-detail'), loan, payments, route.load === 'admin-detail');
      }
      } catch (error) {
        if (current(version)) throw error;
      }
    }
    function renderDetail(container, loan, payments, admin) {
      if (!container) return;
      const schedule = val(loan, 'schedule', 'schedule') || [];
      const status = val(loan, 'status', 'status');
      container.innerHTML = `<section class="card"><div class="row3"><div class="field"><label>Protocolo</label><output>${escapeHtml(val(loan, 'protocol', 'protocol'))}</output></div><div class="field"><label>Status</label><output>${statusBadge(status)}</output></div><div class="field"><label>Data</label><output>${date(val(loan, 'created_at', 'createdAt'))}</output></div></div><div class="row3"><div class="field"><label>Valor solicitado</label><output>${money(val(loan, 'requested_amount', 'requestedAmount'))}</output></div><div class="field"><label>Total</label><output>${money(val(loan, 'total_amount', 'totalAmount'))}</output></div><div class="field"><label>Parcelas</label><output>${escapeHtml(val(loan, 'installments', 'installments'))}</output></div></div><p>Cliente: ${escapeHtml(loan.profiles?.full_name || '—')}</p>${admin && ['aguardando_analise', 'em_analise'].includes(status) ? `<button class="btn btn-primary" data-action="approve" data-id="${escapeHtml(val(loan, 'id', 'id'))}" data-status="${escapeHtml(status)}">Aprovar</button><button class="btn btn-ghost" data-action="reject" data-id="${escapeHtml(val(loan, 'id', 'id'))}" data-status="${escapeHtml(status)}">Recusar</button>` : ''}${admin && status === 'aprovada' ? `<button class="btn btn-primary" data-action="release" data-id="${escapeHtml(val(loan, 'id', 'id'))}">Liberar</button>` : ''}<p class="muted">A formalização e a cobrança ainda não estão integradas.</p></section><section class="card mt-card"><h2>Parcelas</h2>${table(scheduleRows(schedule, payments, businessDate()), ['Nº', 'Previsto', 'Vencimento', 'Pago', 'Saldo', 'Situação'], 'Cronograma indisponível.')}</section><section class="card mt-card"><h2>Histórico de pagamentos</h2>${paymentsTable(payments)}</section>`;
    }
    async function updateEstimate() {
      const amount = Number(doc.getElementById('valor')?.value);
      const installments = Number(doc.getElementById('parcelas')?.value);
      const firstDueDate = doc.getElementById('dataVencimento')?.value;
      if (!doc.getElementById('valor') || !doc.getElementById('parcelas')) return;
      const version = renderVersion;
      try {
        settingsPromise ||= repo().getSettings().catch(error => { settingsPromise = null; throw error; });
        const settings = await settingsPromise;
        const stillCurrentInputs = Number(doc.getElementById('valor')?.value) === amount && Number(doc.getElementById('parcelas')?.value) === installments && doc.getElementById('dataVencimento')?.value === firstDueDate;
        if (!current(version) || !stillCurrentInputs) return;
        const calc = win.JKLoan?.calcLoan;
        if (!calc) throw new Error('Cálculo indisponível');
        const configuredMin = Number(settings.min_amount ?? settings.minAmount ?? 100);
        const configuredMax = Number(settings.max_amount ?? settings.maxAmount ?? 5000);
        const configuredInstallments = Number(settings.max_installments ?? settings.maxInstallments ?? 12);
        if (!Number.isInteger(configuredInstallments) || configuredInstallments < 1 || configuredInstallments > 60) throw new (errors?.AppError || Error)('CONFIG');
        const installmentSelect = doc.getElementById('parcelas');
        if (installmentSelect.dataset.limit !== String(configuredInstallments)) {
          installmentSelect.innerHTML = Array.from({ length: configuredInstallments }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('');
          installmentSelect.dataset.limit = String(configuredInstallments);
          installmentSelect.value = String(installments >= 1 && installments <= configuredInstallments ? installments : Math.min(3, configuredInstallments));
          installmentSelect.disabled = false;
          if (Number(installmentSelect.value) !== installments) return updateEstimate();
        }
        const validation = doc.getElementById('estimate-validation');
        const estimateCard = doc.getElementById('estimate-card');
        const invalid = !Number.isFinite(amount) || !Number.isInteger(installments) || amount < configuredMin || amount > configuredMax || installments < 1 || installments > configuredInstallments;
        if (validation) {
          validation.hidden = !invalid;
          validation.textContent = invalid ? `Simule um valor entre ${money(configuredMin)} e ${money(configuredMax)}, em até ${configuredInstallments} parcelas.` : '';
        }
        if (estimateCard) estimateCard.hidden = invalid;
        doc.getElementById('valor').min = String(configuredMin);
        doc.getElementById('valor').max = String(configuredMax);
        if (invalid) return;
        const estimate = calculateEstimate(win.JKLoan, settings, amount, installments);
        doc.getElementById('output-valor-solicitado').textContent = money(estimate.amount);
        doc.getElementById('output-encargos').textContent = money(estimate.charge + estimate.installmentFee);
        doc.getElementById('output-total').textContent = money(estimate.total);
        doc.getElementById('output-parcela').textContent = `${installments} × ${money(estimate.installmentValue)}${estimate.lastInstallmentValue !== estimate.installmentValue ? ` · última de ${money(estimate.lastInstallmentValue)}` : ''}`;
        const principalShare = 100 * estimate.amount / estimate.total;
        const chargeShare = 100 - principalShare;
        const percent = value => value.toLocaleString('pt-BR', { maximumFractionDigits: 1 });
        doc.getElementById('estimate-bar').innerHTML = `<span class="estimate-principal"></span><span class="estimate-charge"></span>`;
        const barSegments = doc.getElementById('estimate-bar').children;
        barSegments[0].style.width = `${principalShare}%`;
        barSegments[1].style.width = `${chargeShare}%`;
        doc.getElementById('estimate-legend').innerHTML = `<span><i class="estimate-principal"></i>Valor recebido: ${percent(principalShare)}% do total</span><span><i class="estimate-charge"></i>Encargos: ${percent(chargeShare)}% do total</span>`;
        doc.getElementById('estimate-fees').textContent = `Encargo inicial: ${money(estimate.charge)} + adicional de parcelamento: ${money(estimate.installmentFee)}. Acréscimo total de ${percent(100 * (estimate.total - estimate.amount) / estimate.amount)}% sobre o valor recebido.`;
        const firstDue = doc.getElementById('dataVencimento').value;
        const baseDate = /^\d{4}-\d{2}-\d{2}$/.test(firstDue) ? new Date(`${firstDue}T12:00:00`) : null;
        const preview = baseDate && Number.isFinite(baseDate.getTime()) ? estimate.schedule.map((installmentValue, index) => {
          const month = new Date(baseDate.getFullYear(), baseDate.getMonth() + index, 1);
          const lastDay = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
          const due = new Date(month.getFullYear(), month.getMonth(), Math.min(baseDate.getDate(), lastDay));
          return `<li><span class="installment-number">${index + 1}</span><div><strong>${money(installmentValue)}</strong><span>${due.toLocaleDateString('pt-BR')}</span></div></li>`;
        }).join('') : '<p>Informe o primeiro vencimento para ver a prévia.</p>';
        doc.getElementById('cronograma').innerHTML = `<h3>Quando você paga</h3><p class="muted">Vencimentos estimados; o servidor confirma as datas no envio.</p>${baseDate ? `<ol class="installment-timeline">${preview}</ol>` : preview}`;
        const min = Number(settings.min_amount ?? settings.minAmount ?? 100), maxAmount = Number(settings.max_amount ?? settings.maxAmount ?? 5000);
        doc.getElementById('valor').min = String(min); doc.getElementById('valor').max = String(maxAmount);
        const due = doc.getElementById('dataVencimento');
        const daysMin = Number(settings.min_days_first_due ?? settings.minDaysFirstDue ?? 7), daysMax = Number(settings.max_days_first_due ?? settings.maxDaysFirstDue ?? 45);
        const today = businessDate();
        due.min = addCalendarDays(today, daysMin); due.max = addCalendarDays(today, daysMax);
      } catch (error) {
        const target = doc.getElementById('form-message');
        if (current(version) && target) errors?.show(error, target);
      }
    }
    async function paymentSearch() {
      const query = doc.getElementById('payment-search')?.value.trim().toLowerCase() || '';
      const target = doc.getElementById('payment-results');
      if (!target) return;
      target.textContent = 'Carregando…';
      const version = renderVersion, requestVersion = ++searchVersion;
      await guarded('payment-search', async () => {
        const rows = await repo().listLoans({ statuses: ['aprovada', 'liberada'], limit: 100 });
        if (!current(version) || requestVersion !== searchVersion) return;
        const found = rows.filter(row => !query || String(val(row, 'protocol', 'protocol')).toLowerCase().includes(query) || String(row.profiles?.full_name || '').toLowerCase().includes(query));
        target.innerHTML = found.length ? found.map(row => `<article class="card loan-search-card"><strong>${escapeHtml(val(row, 'protocol', 'protocol'))}</strong> — ${escapeHtml(row.profiles?.full_name || 'Cliente')} — ${money(val(row, 'requested_amount', 'requestedAmount'))} <button class="btn btn-primary" data-action="select-payment-loan" data-id="${escapeHtml(val(row, 'id', 'id'))}">Selecionar</button></article>`).join('') : '<p class="muted">Nenhum empréstimo encontrado.</p>';
        target.dataset.loaded = 'true';
      }, { target });
    }
    async function selectPaymentLoan(id) {
      const version = renderVersion;
      const panel = doc.getElementById('payment-panel');
      await guarded('payment-select', async () => {
        const loan = await repo().getLoan({ id });
        const payments = await repo().listPayments(id);
        if (!current(version)) return;
        selectedPaymentLoan = loan; selectedPayments = payments;
        const schedule = val(loan, 'schedule', 'schedule') || [];
        panel.innerHTML = `<section class="card"><h2>${escapeHtml(val(loan, 'protocol', 'protocol'))} — ${escapeHtml(loan.profiles?.full_name || 'Cliente')}</h2><form id="f-pagamento"><div class="row2"><div class="field"><label for="payment-installment">Parcela</label><select id="payment-installment" required>${schedule.map((part, i) => `<option value="${Number(part.n || i + 1)}" data-amount="${Number(part.value)}" data-due="${escapeHtml(part.due_date || '')}">Parcela ${Number(part.n || i + 1)} — ${money(part.value)} — ${date(part.due_date)}</option>`).join('')}</select></div><div class="field"><label>Saldo da parcela</label><output id="payment-balance"></output></div></div><div class="row2"><div class="field"><label for="payment-amount">Valor recebido</label><input id="payment-amount" type="number" min="0.01" step="0.01" required></div><div class="field"><label for="payment-date">Data</label><input id="payment-date" type="date" value="${businessDate()}" required></div></div><div class="row2"><div class="field"><label for="payment-method">Forma</label><select id="payment-method"><option value="pix">PIX</option><option value="transferencia">Transferência</option><option value="dinheiro">Dinheiro</option><option value="outro">Outro</option></select></div><div class="field"><label for="payment-observation">Observação</label><input id="payment-observation" maxlength="500"></div></div><button class="btn btn-primary" type="submit">Registrar pagamento</button><div id="payment-message" role="status"></div></form></section><section class="card mt-card"><h2>Histórico de pagamentos</h2>${paymentsTable(payments)}</section>`;
        updatePaymentBalance();
      }, { target: panel });
    }
    function updatePaymentBalance() {
      const select = doc.getElementById('payment-installment'); if (!select) return;
      const option = select.options[select.selectedIndex]; const number = Number(option.value), expected = Number(option.dataset.amount);
      const balance = remainingInstallment(expected, selectedPayments, number);
      doc.getElementById('payment-balance').textContent = money(balance);
      doc.getElementById('payment-amount').max = balance.toFixed(2);
      doc.getElementById('payment-amount').value = balance ? balance.toFixed(2) : '';
    }
    async function submit(event) {
      const form = event.target;
      if (form.id === 'f-simulador') {
        event.preventDefault();
        if (form.dataset.completed === 'true') return;
        const version = renderVersion;
        const messageTarget = form.querySelector('[role="status"]');
        await guarded('loan-create', async () => {
          const amount = Number(doc.getElementById('valor').value), installments = Number(doc.getElementById('parcelas').value), firstDueDate = doc.getElementById('dataVencimento').value;
          const userId = win.JKAuth?.user?.id;
          const fingerprintInput = `${amount.toFixed(2)}|${installments}|${firstDueDate}`;
          const fp = await fingerprint(win, fingerprintInput);
          const requestKey = await stableKey(win, 'loan-request', fp, userId);
          let loan;
          try { loan = await repo().createLoanRequest({ amount, installments, firstDueDate, requestKey }); }
          catch (error) {
            const safe = errors?.normalize?.(error);
            if (definitiveWriteFailure(safe)) await clearKey(win, 'loan-request', userId);
            throw error;
          }
          await clearKey(win, 'loan-request', userId);
          if (!current(version)) return;
          form.dataset.completed = 'true';
          if (messageTarget) messageTarget.textContent = `Solicitação ${val(loan, 'protocol', 'protocol')} enviada para análise.`;
          toast('Solicitação enviada para análise.');
          win.location.hash = '#/cliente/solicitacoes';
        }, { form, target: messageTarget, writing: true });
      }
      if (form.id === 'f-pagamento') {
        event.preventDefault();
        if (form.dataset.completed === 'true') return;
        const version = renderVersion;
        const messageTarget = form.querySelector('[role="status"]');
        await guarded('payment-save', async () => {
          if (!selectedPaymentLoan) throw new Error('Selecione um empréstimo.');
          const loanId = val(selectedPaymentLoan, 'id', 'id');
          const userId = win.JKAuth?.user?.id;
          const installment = Number(doc.getElementById('payment-installment').value), amount = Number(doc.getElementById('payment-amount').value), dateValue = doc.getElementById('payment-date').value;
          const method = doc.getElementById('payment-method').value, observation = doc.getElementById('payment-observation').value.trim();
          const fp = await fingerprint(win, `${val(selectedPaymentLoan, 'id', 'id')}|${installment}|${amount.toFixed(2)}|${dateValue}|${method}|${observation}`);
          const requestKey = await stableKey(win, 'payment-record', fp, userId);
          try { await repo().recordPayment({ loanId, installment, amount, date: dateValue, method, observation, requestKey }); }
          catch (error) {
            if (definitiveWriteFailure(error)) await clearKey(win, 'payment-record', userId);
            throw error;
          }
          await clearKey(win, 'payment-record', userId);
          if (!current(version) || val(selectedPaymentLoan, 'id', 'id') !== loanId) return;
          form.dataset.completed = 'true';
          toast('Pagamento registrado.');
          await selectPaymentLoan(loanId);
        }, { form, target: messageTarget, writing: true });
      }
    }
    async function action(button) {
      const kind = button.dataset.action, id = button.dataset.id;
      if (kind === 'loan-detail') { win.location.hash = `#/admin/emprestimo/${escapeSegment(id)}`; return; }
      if (kind === 'select-payment-loan') { await selectPaymentLoan(id); return; }
      const transitions = { approve: 'aprovada', reject: 'recusada', release: 'liberada' };
      const status = transitions[kind]; if (!status) return;
      const expectedStatus = button.dataset.status || (kind === 'release' ? 'aprovada' : '');
      await guarded(`loan-${kind}`, async () => {
        const version = renderVersion;
        const userId = win.JKAuth?.user?.id;
        const fp = await fingerprint(win, `${id}|${expectedStatus}|${status}`);
        const key = await stableKey(win, `status-${id}`, fp, userId);
        try { await repo().updateLoanStatus({ id, status, expectedStatus, requestKey: key }); }
        catch (error) {
          if (definitiveWriteFailure(error)) await clearKey(win, `status-${id}`, userId);
          throw error;
        }
        await clearKey(win, `status-${id}`, userId);
        toast(kind === 'reject' ? 'Solicitação recusada.' : kind === 'release' ? 'Empréstimo liberado.' : 'Solicitação aprovada.');
        if (current(version)) render();
      }, { writing: true });
    }
    function bindView(route) {
      const menu = doc.getElementById('menuBtn'), shellEl = doc.getElementById('shell'), scrim = doc.getElementById('scrim');
      if (menu && shellEl) menu.addEventListener('click', () => shellEl.classList.add('open'));
      if (scrim && shellEl) scrim.addEventListener('click', () => shellEl.classList.remove('open'));
      const simulator = doc.getElementById('f-simulador');
      if (simulator) {
        for (const id of ['valor', 'parcelas', 'dataVencimento']) {
          const field = doc.getElementById(id);
          field.addEventListener('input', updateEstimate);
          field.addEventListener('change', updateEstimate);
        }
        updateEstimate();
      }
      const search = doc.getElementById('payment-search');
      if (search) search.addEventListener('input', () => { win.clearTimeout(searchTimer); searchTimer = win.setTimeout(() => paymentSearch(), 250); });
      if (route && win.JKAuth?.views?.[route]) win.JKAuth.bind(route);
    }
    function render() {
      const path = routePath(win.location.hash || '#/');
      renderedPath = path;
      if (win.JKAuth && !win.JKAuth.ready) return;
      if (path === '#/sair') { guarded('logout', () => win.JKAuth.logout()); return; }
      const redirection = win.JKAuth?.redirectFor?.(path);
      if (redirection && redirection !== path) { win.location.hash = redirection; return; }
      const version = ++renderVersion;
      const authView = win.JKAuth?.views?.[path];
      const route = getRoute(path);
      if (authView) app.innerHTML = authView;
      else app.innerHTML = route.html;
      win.scrollTo?.(0, 0);
      bindView(authView ? path : null);
      if (route.load) {
        const targetId = route.load === 'admin-detail' || route.load === 'client-detail' ? 'loan-detail' : route.load === 'payment-search' ? 'payment-results' : 'loans-table';
        const target = doc.getElementById(targetId);
        guarded(`load-${route.load}-${version}`, () => loadRoute(route, version), { target });
      }
    }
    win.addEventListener('hashchange', render);
    win.addEventListener('jk:authchange', render);
    doc.addEventListener('submit', submit);
    app.addEventListener('change', event => { if (event.target?.id === 'payment-installment') updatePaymentBalance(); });
    app.addEventListener('click', event => {
      const button = event.target.closest?.('[data-action]'); if (!button) return;
      event.preventDefault(); guarded(`action-${button.dataset.action}`, () => action(button), { form: button.closest('form'), writing: ['approve', 'reject', 'release'].includes(button.dataset.action) });
    });
    render();
    return { render, getRoute };
  }

  async function fingerprint(win, value) {
    if (!win.crypto?.subtle || !win.TextEncoder) {
      const ErrorType = win.JKErrors?.AppError;
      throw ErrorType ? new ErrorType('UNAVAILABLE') : Object.assign(new Error('Secure fingerprint unavailable.'), { code: 'UNAVAILABLE' });
    }
    const bytes = await win.crypto.subtle.digest('SHA-256', new win.TextEncoder().encode(value));
    return Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2, '0')).join('');
  }
  async function stableKey(win, operation, fp, userId = win.JKAuth?.user?.id) {
    const scope = await fingerprint(win, `user:${userId || 'anonymous'}`);
    const storeKey = `jkcred:${scope}:${operation}:pending`;
    let saved;
    try { saved = JSON.parse(win.localStorage.getItem(storeKey) || 'null'); } catch {}
    if (saved?.key && saved.fingerprint === await fingerprint(win, `${saved.key}|${fp}`)) return saved.key;
    if (saved?.key) {
      const ErrorType = win.JKErrors?.AppError;
      throw ErrorType ? new ErrorType('WRITE_UNCONFIRMED') : Object.assign(new Error('Envio anterior sem confirmação. Confira o histórico antes de iniciar outro.'), { code: 'WRITE_UNCONFIRMED' });
    }
    if (!win.crypto?.randomUUID && !win.crypto?.getRandomValues) {
      const ErrorType = win.JKErrors?.AppError;
      throw ErrorType ? new ErrorType('UNAVAILABLE') : Object.assign(new Error('Secure random UUID unavailable.'), { code: 'UNAVAILABLE' });
    }
    const bytes = new Uint8Array(16);
    if (win.crypto.randomUUID) {
      const key = win.crypto.randomUUID();
      win.localStorage.setItem(storeKey, JSON.stringify({ key, fingerprint: await fingerprint(win, `${key}|${fp}`) }));
      return key;
    }
    win.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, x => x.toString(16).padStart(2, '0')).join('');
    const key = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    win.localStorage.setItem(storeKey, JSON.stringify({ key, fingerprint: await fingerprint(win, `${key}|${fp}`) }));
    return key;
  }
  async function clearKey(win, operation, userId = win.JKAuth?.user?.id) {
    try {
      const scope = await fingerprint(win, `user:${userId || 'anonymous'}`);
      win.localStorage.removeItem(`jkcred:${scope}:${operation}:pending`);
    } catch { /* Removal is best-effort after confirmed writes. */ }
  }
  return { start, escapeHtml, routePath, calculateEstimate, remainingInstallment, fingerprint, stableKey, clearKey, scheduleRows, paymentsTable };
});
