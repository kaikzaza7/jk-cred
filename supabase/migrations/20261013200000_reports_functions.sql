-- JK CRED — Funções para relatórios financeiros e auditoria
-- Execute no SQL Editor do Supabase

-- ========== 1. Indicadores financeiros ==========
create or replace function public.get_financial_indicators(
  p_date_from date default null,
  p_date_to date default null,
  p_status text default null,
  p_search text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_where text := '';
  v_params jsonb := '[]';
  v_result jsonb;
begin
  if v_actor is null then raise exception 'JK:nao_autenticado'; end if;
  if not public.is_admin() then raise exception 'JK:permissao_negada'; end if;

  -- Build dynamic WHERE clause
  if p_date_from is not null then
    v_where := v_where || ' and lr.created_at >= $' || (jsonb_array_length(v_params) + 1);
    v_params := v_params || to_jsonb(p_date_from);
  end if;
  if p_date_to is not null then
    v_where := v_where || ' and lr.created_at <= ($' || (jsonb_array_length(v_params) + 1) || ' + interval ''1 day'')';
    v_params := v_params || to_jsonb(p_date_to);
  end if;
  if p_status is not null then
    v_where := v_where || ' and lr.status = $' || (jsonb_array_length(v_params) + 1);
    v_params := v_params || to_jsonb(p_status);
  end if;
  if p_search is not null and p_search <> '' then
    v_where := v_where || ' and (lr.protocol ILIKE $' || (jsonb_array_length(v_params) + 1) || ' or p.full_name ILIKE $' || (jsonb_array_length(v_params) + 1) || ')';
    v_params := v_params || to_jsonb('%' || p_search || '%');
  end if;

  -- Main aggregated query
  execute format($q$
    select jsonb_build_object(
      'totalRequests', coalesce(count(*), 0),
      'approvedCount', count(*) filter (where lr.status = 'aprovada'),
      'releasedCount', count(*) filter (where lr.status = 'liberada'),
      'totalRequested', coalesce(sum(lr.requested_amount), 0),
      'totalApproved', coalesce(sum(lr.requested_amount) filter (where lr.status in ('aprovada','liberada','aguardando_formalizacao','formalizada')), 0),
      'totalReleased', coalesce(sum(lr.total_amount) filter (where lr.status = 'liberada'), 0),
      'totalPayments', coalesce((
        select sum(p.amount_paid)
        from public.payments p
        join public.loan_requests lr2 on lr2.id = p.loan_request_id
        where lr2.created_at >= $1 and lr2.created_at <= ($2 + interval '1 day')
          %s
      ), 0),
      'pendingBalance', coalesce((
        select sum(lr3.total_amount) - coalesce(sum(p2.amount_paid), 0)
        from public.loan_requests lr3
        left join public.payments p2 on p2.loan_request_id = lr3.id
        where lr3.status = 'liberada'
          and lr3.created_at >= $1 and lr3.created_at <= ($2 + interval '1 day')
          %s
      ), 0),
      'paidInstallments', coalesce((
        select count(*)
        from public.loan_requests lr4
        cross join lateral jsonb_array_elements(lr4.schedule) with ordinality as s(inst, idx)
        where lr4.created_at >= $1 and lr4.created_at <= ($2 + interval '1 day')
          and (s.inst->>'value')::numeric <= (
            select coalesce(sum(p3.amount_paid), 0)
            from public.payments p3
            where p3.loan_request_id = lr4.id
              and p3.installment_number = (s.inst->>'n')::int
          )
          %s
      ), 0),
      'pendingInstallments', coalesce((
        select count(*)
        from public.loan_requests lr5
        cross join lateral jsonb_array_elements(lr5.schedule) with ordinality as s(inst, idx)
        where lr5.created_at >= $1 and lr5.created_at <= ($2 + interval '1 day')
          and (s.inst->>'value')::numeric > (
            select coalesce(sum(p4.amount_paid), 0)
            from public.payments p4
            where p4.loan_request_id = lr5.id
              and p4.installment_number = (s.inst->>'n')::int
          )
          and (s.inst->>'due_date')::date >= (now() at time zone 'America/Sao_Paulo')::date
          %s
      ), 0),
      'overdueInstallments', coalesce((
        select count(*)
        from public.loan_requests lr6
        cross join lateral jsonb_array_elements(lr6.schedule) with ordinality as s(inst, idx)
        where lr6.created_at >= $1 and lr6.created_at <= ($2 + interval '1 day')
          and (s.inst->>'value')::numeric > (
            select coalesce(sum(p5.amount_paid), 0)
            from public.payments p5
            where p5.loan_request_id = lr6.id
              and p5.installment_number = (s.inst->>'n')::int
          )
          and (s.inst->>'due_date')::date < (now() at time zone 'America/Sao_Paulo')::date
          %s
      ), 0),
      'partialInstallments', coalesce((
        select count(*)
        from public.loan_requests lr7
        cross join lateral jsonb_array_elements(lr7.schedule) with ordinality as s(inst, idx)
        where lr7.created_at >= $1 and lr7.created_at <= ($2 + interval '1 day')
          and (s.inst->>'value')::numeric > (
            select coalesce(sum(p6.amount_paid), 0)
            from public.payments p6
            where p6.loan_request_id = lr7.id
              and p6.installment_number = (s.inst->>'n')::int
          )
          and (select coalesce(sum(p6.amount_paid), 0)
               from public.payments p6
               where p6.loan_request_id = lr7.id
                 and p6.installment_number = (s.inst->>'n')::int) > 0
          %s
      ), 0)
    )
    from public.loan_requests lr
    left join public.profiles p on p.id = lr.user_id
    where lr.created_at >= $1 and lr.created_at <= ($2 + interval '1 day')
      %s
  $q$, v_where, v_where, v_where, v_where, v_where)
  into v_result
  using p_date_from, p_date_to;

  -- Time series for charts
  v_result := v_result || jsonb_build_object(
    'requestsByDay', (
      select jsonb_agg(jsonb_build_object('day', day, 'count', cnt) order by day)
      from (
        select (lr.created_at at time zone 'America/Sao_Paulo')::date as day, count(*) as cnt
        from public.loan_requests lr
        left join public.profiles p on p.id = lr.user_id
        where lr.created_at >= p_date_from and lr.created_at <= (p_date_to + interval '1 day')
          and (p_status is null or lr.status = p_status)
          and (p_search is null or p_search = '' or lr.protocol ILIKE '%' || p_search || '%' or p.full_name ILIKE '%' || p_search || '%')
        group by 1
      ) t
    ),
    'statusBreakdown', (
      select jsonb_agg(jsonb_build_object('status', status, 'count', cnt) order by cnt desc)
      from (
        select lr.status, count(*) as cnt
        from public.loan_requests lr
        left join public.profiles p on p.id = lr.user_id
        where lr.created_at >= p_date_from and lr.created_at <= (p_date_to + interval '1 day')
          and (p_search is null or p_search = '' or lr.protocol ILIKE '%' || p_search || '%' or p.full_name ILIKE '%' || p_search || '%')
        group by 1
      ) t
    ),
    'releasedByDay', (
      select jsonb_agg(jsonb_build_object('day', day, 'amount', amt) order by day)
      from (
        select (lr.created_at at time zone 'America/Sao_Paulo')::date as day, sum(lr.total_amount) as amt
        from public.loan_requests lr
        left join public.profiles p on p.id = lr.user_id
        where lr.status = 'liberada'
          and lr.created_at >= p_date_from and lr.created_at <= (p_date_to + interval '1 day')
          and (p_search is null or p_search = '' or lr.protocol ILIKE '%' || p_search || '%' or p.full_name ILIKE '%' || p_search || '%')
        group by 1
      ) t
    ),
    'paymentsByDay', (
      select jsonb_agg(jsonb_build_object('day', day, 'amount', amt) order by day)
      from (
        select (p.payment_date at time zone 'America/Sao_Paulo')::date as day, sum(p.amount_paid) as amt
        from public.payments p
        join public.loan_requests lr on lr.id = p.loan_request_id
        left join public.profiles pr on pr.id = lr.user_id
        where p.payment_date >= p_date_from and p.payment_date <= (p_date_to + interval '1 day')
          and (p_status is null or lr.status = p_status)
          and (p_search is null or p_search = '' or lr.protocol ILIKE '%' || p_search || '%' or pr.full_name ILIKE '%' || p_search || '%')
        group by 1
      ) t
    )
  );

  return v_result;
end $$;

revoke all on function public.get_financial_indicators(date, date, text, text) from public, anon;
grant execute on function public.get_financial_indicators(date, date, text, text) to authenticated;

-- ========== 2. Relatório detalhado de empréstimos ==========
create or replace function public.get_loans_report(
  p_date_from date default null,
  p_date_to date default null,
  p_status text default null,
  p_search text default null,
  p_limit int default 500
)
returns setof public.loan_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_where text := '';
  v_params jsonb := '[]';
begin
  if v_actor is null then raise exception 'JK:nao_autenticado'; end if;
  if not public.is_admin() then raise exception 'JK:permissao_negada'; end if;

  if p_date_from is not null then
    v_where := v_where || ' and lr.created_at >= $' || (jsonb_array_length(v_params) + 1);
    v_params := v_params || to_jsonb(p_date_from);
  end if;
  if p_date_to is not null then
    v_where := v_where || ' and lr.created_at <= ($' || (jsonb_array_length(v_params) + 1) || ' + interval ''1 day'')';
    v_params := v_params || to_jsonb(p_date_to);
  end if;
  if p_status is not null then
    v_where := v_where || ' and lr.status = $' || (jsonb_array_length(v_params) + 1);
    v_params := v_params || to_jsonb(p_status);
  end if;
  if p_search is not null and p_search <> '' then
    v_where := v_where || ' and (lr.protocol ILIKE $' || (jsonb_array_length(v_params) + 1) || ' or p.full_name ILIKE $' || (jsonb_array_length(v_params) + 1) || ')';
    v_params := v_params || to_jsonb('%' || p_search || '%');
  end if;

  return query execute format($q$
    select lr.*, p.full_name,
      (select coalesce(sum(amount_paid), 0) from public.payments where loan_request_id = lr.id) as paid_total
    from public.loan_requests lr
    left join public.profiles p on p.id = lr.user_id
    where lr.created_at >= $1 and lr.created_at <= ($2 + interval '1 day')
      %s
    order by lr.created_at desc
    limit %L
  $q$, v_where, p_limit)
  using p_date_from, p_date_to;
end $$;

revoke all on function public.get_loans_report(date, date, text, text, int) from public, anon;
grant execute on function public.get_loans_report(date, date, text, text, int) to authenticated;

-- ========== 3. Relatório de parcelas e pagamentos ==========
create or replace function public.get_installments_report(
  p_date_from date default null,
  p_date_to date default null,
  p_status text default null,
  p_search text default null,
  p_limit int default 500
)
returns table (
  id uuid,
  protocol text,
  full_name text,
  installment_number int,
  installment_value numeric(12,2),
  paid_amount numeric(12,2),
  due_date date,
  payment_date timestamptz,
  installment_status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_where text := '';
begin
  if v_actor is null then raise exception 'JK:nao_autenticado'; end if;
  if not public.is_admin() then raise exception 'JK:permissao_negada'; end if;

  if p_date_from is not null then
    v_where := v_where || ' and lr.created_at >= $1';
  end if;
  if p_date_to is not null then
    v_where := v_where || ' and lr.created_at <= ($2 + interval ''1 day'')';
  end if;
  if p_status is not null then
    v_where := v_where || ' and lr.status = $3';
  end if;
  if p_search is not null and p_search <> '' then
    v_where := v_where || ' and (lr.protocol ILIKE $4 or p.full_name ILIKE $4)';
  end if;

  return query execute format($q$
    select
      lr.id,
      lr.protocol,
      p.full_name,
      (s.inst->>'n')::int as installment_number,
      (s.inst->>'value')::numeric(12,2) as installment_value,
      coalesce((
        select sum(pay.amount_paid)
        from public.payments pay
        where pay.loan_request_id = lr.id
          and pay.installment_number = (s.inst->>'n')::int
      ), 0) as paid_amount,
      (s.inst->>'due_date')::date as due_date,
      (
        select max(pay2.payment_date)
        from public.payments pay2
        where pay2.loan_request_id = lr.id
          and pay2.installment_number = (s.inst->>'n')::int
      ) as payment_date,
      case
        when coalesce((
          select sum(pay3.amount_paid)
          from public.payments pay3
          where pay3.loan_request_id = lr.id
            and pay3.installment_number = (s.inst->>'n')::int
        ), 0) >= (s.inst->>'value')::numeric then 'paga'
        when coalesce((
          select sum(pay4.amount_paid)
          from public.payments pay4
          where pay4.loan_request_id = lr.id
            and pay4.installment_number = (s.inst->>'n')::int
        ), 0) > 0 then 'parcialmente_paga'
        when (s.inst->>'due_date')::date < (now() at time zone 'America/Sao_Paulo')::date then 'atrasada'
        else 'pendente'
      end as installment_status
    from public.loan_requests lr
    left join public.profiles p on p.id = lr.user_id
    cross join lateral jsonb_array_elements(lr.schedule) as s(inst)
    where lr.created_at >= $1 and lr.created_at <= ($2 + interval '1 day')
      %s
    order by lr.created_at desc, (s.inst->>'n')::int
    limit %L
  $q$, v_where, p_limit)
  using p_date_from, p_date_to, p_status, '%' || p_search || '%';
end $$;

revoke all on function public.get_installments_report(date, date, text, text, int) from public, anon;
grant execute on function public.get_installments_report(date, date, text, text, int) to authenticated;

-- ========== 4. Log de auditoria ==========
create table if not exists public.audit_log (
  id bigserial primary key,
  operation text not null,
  actor_id uuid not null references auth.users(id),
  actor_email text,
  table_name text not null,
  record_id uuid,
  protocol text,
  old_status text,
  new_status text,
  observation text,
  created_at timestamptz not null default now()
);

alter table public.audit_log enable row level security;
revoke all on public.audit_log from anon, authenticated;

create policy "admin le audit_log" on public.audit_log
  for select to authenticated using (public.is_admin());
grant select on public.audit_log to authenticated;

create index if not exists audit_log_created_at_idx on public.audit_log (created_at desc);
create index if not exists audit_log_protocol_idx on public.audit_log (protocol);

create or replace function public.get_audit_log(
  p_date_from date default null,
  p_date_to date default null,
  p_limit int default 200
)
returns setof public.audit_log
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_where text := '';
begin
  if v_actor is null then raise exception 'JK:nao_autenticado'; end if;
  if not public.is_admin() then raise exception 'JK:permissao_negada'; end if;

  if p_date_from is not null then
    v_where := v_where || ' and created_at >= $1';
  end if;
  if p_date_to is not null then
    v_where := v_where || ' and created_at <= ($2 + interval ''1 day'')';
  end if;

  return query execute format($q$
    select al.*, u.email as admin_name
    from public.audit_log al
    left join auth.users u on u.id = al.actor_id
    where true %s
    order by al.created_at desc
    limit %L
  $q$, v_where, p_limit)
  using p_date_from, p_date_to;
end $$;

revoke all on function public.get_audit_log(date, date, int) from public, anon;
grant execute on function public.get_audit_log(date, date, int) to authenticated;

-- ========== 5. Triggers para auditoria automática ==========
-- Trigger function for loan_requests status changes
create or replace function public.log_loan_status_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if TG_OP = 'UPDATE' and OLD.status IS DISTINCT FROM NEW.status then
    insert into public.audit_log (operation, actor_id, actor_email, table_name, record_id, protocol, old_status, new_status)
    values (
      'status_change',
      auth.uid(),
      (select email from auth.users where id = auth.uid()),
      'loan_requests',
      NEW.id,
      NEW.protocol,
      OLD.status,
      NEW.status
    );
  end if;
  return NEW;
end $$;

revoke all on function public.log_loan_status_audit() from public, anon;
grant execute on function public.log_loan_status_audit() to authenticated;

-- Trigger function for payments insert
create or replace function public.log_payment_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if TG_OP = 'INSERT' then
    insert into public.audit_log (operation, actor_id, actor_email, table_name, record_id, protocol, observation)
    values (
      'payment_recorded',
      auth.uid(),
      (select email from auth.users where id = auth.uid()),
      'payments',
      NEW.loan_request_id,
      (select protocol from public.loan_requests where id = NEW.loan_request_id),
      format('Pagamento parcela %s: %s (%s)', NEW.installment_number, NEW.amount_paid, NEW.payment_method)
    );
  end if;
  return NEW;
end $$;

revoke all on function public.log_payment_audit() from public, anon;
grant execute on function public.log_payment_audit() to authenticated;

-- Attach trigger to loan_requests for status changes
drop trigger if exists audit_loan_status on public.loan_requests;
create trigger audit_loan_status
after update of status on public.loan_requests
for each row execute function public.log_loan_status_audit();

-- Attach trigger to payments for new payments
drop trigger if exists audit_payment on public.payments;
create trigger audit_payment
after insert on public.payments
for each row execute function public.log_payment_audit();