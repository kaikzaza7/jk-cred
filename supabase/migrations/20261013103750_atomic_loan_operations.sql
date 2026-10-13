-- Atomic, server-authorized loan status and payment operations.
-- Supabase CLI was unavailable when this source migration was created; no remote DB was changed.
begin;

-- 005 documents this status but its original CHECK constraint never admitted it.
alter table public.loan_requests drop constraint if exists loan_requests_status_check;
alter table public.loan_requests add constraint loan_requests_status_check
  check (status in ('aguardando_analise','em_analise','aprovada','recusada',
                    'aguardando_formalizacao','formalizada','cancelada','liberada'));

-- Existing payments remain intact and replay-safe keys are optional for historical rows.
alter table public.payments add column if not exists idempotency_key uuid;
create unique index if not exists payments_created_by_idempotency_key_key
  on public.payments (created_by, idempotency_key) where idempotency_key is not null;

-- The original FK incorrectly required every admin to have a customer profile.
alter table public.payments drop constraint if exists payments_created_by_fkey;
alter table public.payments add constraint payments_created_by_fkey
  foreign key (created_by) references auth.users(id) on delete restrict;

create table if not exists public.loan_status_events (
  request_key uuid primary key,
  loan_request_id uuid not null references public.loan_requests(id) on delete restrict,
  actor_id uuid not null references auth.users(id) on delete restrict,
  expected_status text not null,
  resulting_status text not null,
  created_at timestamptz not null default now()
);
alter table public.loan_status_events enable row level security;
revoke all on public.loan_status_events from anon, authenticated;

-- Direct table writes can bypass server-side transition, payment balance, and idempotency checks.
revoke update (status) on public.loan_requests from authenticated;
revoke all on public.payments from anon, authenticated;
grant select on public.payments to authenticated;

-- The existing create_loan_request RPC safely deduplicates by user/key, but returns
-- that row even if a caller accidentally reuses a key for different loan inputs.
-- This wrapper checks the payload before and after the existing atomic server write.
create or replace function public.create_loan_request_checked(
  p_amount numeric,
  p_installments integer,
  p_first_due date,
  p_idempotency_key uuid
) returns public.loan_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_loan public.loan_requests%rowtype;
begin
  if v_actor is null then raise exception 'JK:nao_autenticado'; end if;
  if p_idempotency_key is null then raise exception 'JK:chave_invalida'; end if;
  select * into v_loan from public.loan_requests
   where user_id = v_actor and idempotency_key = p_idempotency_key;
  if found then
    if v_loan.requested_amount is distinct from p_amount or v_loan.installments is distinct from p_installments or
       v_loan.first_due_date is distinct from p_first_due then raise exception 'JK:chave_reutilizada'; end if;
    return v_loan;
  end if;
  v_loan := public.create_loan_request(p_amount, p_installments, p_first_due, p_idempotency_key);
  if v_loan.requested_amount is distinct from p_amount or v_loan.installments is distinct from p_installments or
     v_loan.first_due_date is distinct from p_first_due then raise exception 'JK:chave_reutilizada'; end if;
  return v_loan;
end;
$$;
revoke all on function public.create_loan_request(numeric, integer, date, uuid) from public, anon, authenticated;
revoke all on function public.create_loan_request_checked(numeric, integer, date, uuid) from public, anon;
grant execute on function public.create_loan_request_checked(numeric, integer, date, uuid) to authenticated;

create or replace function public.update_loan_status(
  p_loan_request_id uuid,
  p_status text,
  p_expected_status text,
  p_idempotency_key uuid
) returns public.loan_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_loan public.loan_requests%rowtype;
  v_event public.loan_status_events%rowtype;
  v_allowed boolean := false;
begin
  if v_actor is null then raise exception 'JK:nao_autenticado'; end if;
  if not public.is_admin() then raise exception 'JK:permissao_negada'; end if;
  if p_loan_request_id is null or p_idempotency_key is null or
     p_status is null or p_expected_status is null then raise exception 'JK:entrada_invalida'; end if;

  select * into v_loan from public.loan_requests where id = p_loan_request_id for update;
  if not found then raise exception 'JK:solicitacao_nao_encontrada'; end if;

  select * into v_event from public.loan_status_events where request_key = p_idempotency_key;
  if found then
    if v_event.actor_id <> v_actor or v_event.loan_request_id <> p_loan_request_id or
       v_event.expected_status <> p_expected_status or v_event.resulting_status <> p_status then
      raise exception 'JK:chave_reutilizada';
    end if;
    return v_loan;
  end if;

  if v_loan.status <> p_expected_status then raise exception 'JK:status_conflitante'; end if;
  v_allowed := case p_expected_status
    when 'aguardando_analise' then p_status in ('em_analise','aprovada','recusada','cancelada')
    when 'em_analise' then p_status in ('aprovada','recusada','cancelada')
    when 'aprovada' then p_status in ('aguardando_formalizacao','liberada','recusada','cancelada')
    when 'aguardando_formalizacao' then p_status in ('formalizada','cancelada')
    when 'liberada' then p_status in ('formalizada','cancelada')
    else false
  end;
  if not v_allowed then raise exception 'JK:transicao_invalida'; end if;

  update public.loan_requests set status = p_status where id = p_loan_request_id returning * into v_loan;
  insert into public.loan_status_events (request_key, loan_request_id, actor_id, expected_status, resulting_status)
  values (p_idempotency_key, p_loan_request_id, v_actor, p_expected_status, p_status);
  return v_loan;
end;
$$;
revoke all on function public.update_loan_status(uuid, text, text, uuid) from public, anon;
grant execute on function public.update_loan_status(uuid, text, text, uuid) to authenticated;

create or replace function public.record_loan_payment(
  p_loan_request_id uuid,
  p_installment_number integer,
  p_amount_paid numeric,
  p_payment_date date,
  p_payment_method text,
  p_observation text,
  p_idempotency_key uuid
) returns public.payments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_loan public.loan_requests%rowtype;
  v_existing public.payments%rowtype;
  v_payment public.payments%rowtype;
  v_due numeric(12,2);
  v_paid numeric(12,2);
begin
  if v_actor is null then raise exception 'JK:nao_autenticado'; end if;
  if not public.is_admin() then raise exception 'JK:permissao_negada'; end if;
  if p_loan_request_id is null or p_idempotency_key is null or p_payment_date is null or
     p_installment_number is null or p_amount_paid is null or p_amount_paid <= 0 or
     scale(p_amount_paid) > 2 or p_payment_method is null or
     p_payment_method not in ('pix','transferencia','dinheiro','outro') then
    raise exception 'JK:pagamento_invalido';
  end if;
  if p_observation is not null and char_length(p_observation) > 1000 then raise exception 'JK:pagamento_invalido'; end if;

  select * into v_loan from public.loan_requests where id = p_loan_request_id for update;
  if not found then raise exception 'JK:solicitacao_nao_encontrada'; end if;

  select * into v_existing from public.payments where created_by = v_actor and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.loan_request_id <> p_loan_request_id or
       v_existing.installment_number <> p_installment_number or
       v_existing.amount_paid <> p_amount_paid or
       (v_existing.payment_date at time zone 'America/Sao_Paulo')::date <> p_payment_date or
       v_existing.payment_method <> p_payment_method or
       v_existing.observation is distinct from nullif(btrim(p_observation), '') then
      raise exception 'JK:chave_reutilizada';
    end if;
    return v_existing;
  end if;

  if v_loan.status not in ('aprovada','liberada') then raise exception 'JK:emprestimo_nao_liberado'; end if;
  if p_installment_number < 1 or p_installment_number > v_loan.installments then raise exception 'JK:parcela_invalida'; end if;
  v_due := (v_loan.schedule -> (p_installment_number - 1) ->> 'value')::numeric(12,2);
  if v_due is null or v_due <= 0 then raise exception 'JK:parcela_invalida'; end if;
  select coalesce(sum(pg.amount_paid), 0) into v_paid from public.payments as pg
   where pg.loan_request_id = p_loan_request_id and pg.installment_number = p_installment_number;
  if p_amount_paid > v_due - v_paid then raise exception 'JK:valor_acima_do_saldo'; end if;

  insert into public.payments (
    loan_request_id, installment_number, amount_paid, payment_date,
    payment_method, observation, created_by, idempotency_key
  ) values (
    p_loan_request_id, p_installment_number, p_amount_paid,
    p_payment_date::timestamp at time zone 'America/Sao_Paulo',
    p_payment_method, nullif(btrim(p_observation), ''), v_actor, p_idempotency_key
  ) returning * into v_payment;
  return v_payment;
end;
$$;
revoke all on function public.record_loan_payment(uuid, integer, numeric, date, text, text, uuid) from public, anon;
grant execute on function public.record_loan_payment(uuid, integer, numeric, date, text, text, uuid) to authenticated;

-- Keep historical helpers usable while fixing their empty CASE branches and incorrect due date.
create or replace function public.update_installment_statuses(p_loan_request_id uuid)
returns void language plpgsql stable set search_path = '' as $$
begin
  -- Installment state is derived from the schedule and payment rows at read time.
  perform 1 from public.loan_requests where id = p_loan_request_id;
end;
$$;

create or replace function public.get_installment_status(
  p_loan_request_id uuid,
  p_installment_number int
) returns table (
  installment_number int,
  total_value numeric(12,2),
  paid_amount numeric(12,2),
  remaining numeric(12,2),
  status text,
  is_overdue boolean
) language plpgsql stable set search_path = '' as $$
declare
  v_loan public.loan_requests%rowtype;
  v_installment jsonb;
  v_total numeric(12,2);
  v_paid numeric(12,2);
  v_status text;
  v_due_date date;
begin
  select * into v_loan from public.loan_requests where id = p_loan_request_id;
  if not found or p_installment_number is null or p_installment_number < 1 then return; end if;
  v_installment := v_loan.schedule -> (p_installment_number - 1);
  if v_installment is null then return; end if;
  v_total := (v_installment ->> 'value')::numeric(12,2);
  v_due_date := coalesce((v_installment ->> 'due_date')::date,
    (v_loan.first_due_date + (p_installment_number - 1) * interval '1 month')::date);
  select coalesce(sum(pg.amount_paid), 0) into v_paid from public.payments as pg
   where pg.loan_request_id = p_loan_request_id and pg.installment_number = p_installment_number;
  v_status := case when v_paid <= 0 then 'pendente' when v_paid < v_total then 'parcialmente_paga' else 'paga' end;
  return query select p_installment_number, v_total, v_paid, v_total - v_paid, v_status,
    (v_paid < v_total and v_due_date < (now() at time zone 'America/Sao_Paulo')::date);
end;
$$;

revoke all on function public.update_installment_statuses(uuid) from public, anon;
revoke all on function public.get_installment_status(uuid, int) from public, anon;
grant execute on function public.get_installment_status(uuid, int) to authenticated;

-- The old helper labelled request creation time as a release timestamp. No release-time
-- column exists, so keep its filter but return the actual created_at field honestly.
drop function if exists public.get_loans_released_since(date);
create function public.get_loans_released_since(p_since_date date)
returns table (
  id uuid,
  protocol text,
  user_id uuid,
  requested_amount numeric(12,2),
  total_amount numeric(12,2),
  created_at timestamptz,
  status text
) language sql stable set search_path = '' as $$
  select lr.id, lr.protocol, lr.user_id, lr.requested_amount, lr.total_amount, lr.created_at, lr.status
  from public.loan_requests as lr
  where lr.status = 'liberada' and lr.created_at >= p_since_date;
$$;
revoke all on function public.get_loans_released_since(date) from public, anon;
grant execute on function public.get_loans_released_since(date) to authenticated;
commit;
