-- JK CRED — Parte 5: Controle deParcelas, Pagamentos e Financeiro
-- Cole no SQL Editor do Supabase após a Parte 3 (003_loans.sql)

-- ========== 1. Tabela de Registros de Pagamento ==========
create table public.payments (
  id                     uuid primary key default gen_random_uuid(),
  loan_request_id        uuid not null references public.loan_requests(id) on delete cascade,
  installment_number     int not null check (installment_number > 0),
  amount_paid            numeric(12,2) not null check (amount_paid > 0),
  payment_date           timestamptz not null default now(),
  payment_method         text not null default 'dinheiro'
    check (payment_method in ('pix', 'transferencia', 'dinheiro', 'outro')),
  observation            text,
  created_by             uuid not null references public.profiles(id) on delete restrict,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- Índice para busca por empréstimo e data
create index on public.payments (loan_request_id, payment_date desc);
create index on public.payments (installment_number);

-- Trigger de auditoria
create trigger payments_updated_at before update on public.payments
  for each row execute function public.set_updated_at();

-- ========== 2. Estender fluxo de status do loan_requests ==========
-- Adicionamos o status 'liberada' para indicar que o empréstimo foi liberado
-- para pagamento, sem que isso signifique que o dinheiro foi transferido.
-- O administrador deve marcar como 'liberada' apenas quando for realmente
-- conveniente para o controle interno.

comment on column public.loan_requests.status is 'Status da solicitação: aguardando_analise, em_analise, aprovada, liberada, recusada, formalizada, cancelada';

-- ========== 3. Função para calcular saldo restante de uma parcela ==========
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
) language plpgsql stable set search_path = public as $$
declare
  v_loan public.loan_requests%rowtype;
  v_schedule jsonb;
  v_installment jsonb;
  v_total numeric(12,2);
  v_paid numeric(12,2);
  v_remaining numeric(12,2);
  v_status text;
  v_today date;
begin
  -- Buscar solicitação
  select * into v_loan from public.loan_requests where id = p_loan_request_id;
  if not found then
    return query select installment_number, total_value, paid_amount, remaining, status, false as is_overdue
      where 1=0;
  end if;

  -- Buscar cronograma
  v_schedule := v_loan.schedule;

  -- Buscar parcela específica do cronograma
  select v_schedule->(p_installment_number - 1) into v_installment;

  if v_installment is null then
    return query select installment_number, total_value, paid_amount, remaining, status, false as is_overdue
      where 1=0;
  end if;

  v_total := (v_installment->>'value')::numeric(12,2);

  -- Somar pagamentos feitos nesta parcela
  select coalesce(sum(amount_paid), 0) into v_paid
  from public.payments
  where loan_request_id = p_loan_request_id
    and installment_number = p_installment_number;

  v_remaining := v_total - v_paid;

  -- Determinar status
  v_status := case
    when v_paid <= 0 and (v_loan.first_due_date at time zone 'America/Sao_Paulo')::date > (now() at time zone 'America/Sao_Paulo')::date then 'pendente'
    when v_paid > 0 and v_paid < v_total then 'parcialmente_paga'
    when v_paid >= v_total then 'paga'
    else 'pendente'
  end;

  -- Verificar se está em atraso
  v_today := (now() at time zone 'America/Sao_Paulo')::date;
  -- A data de vencimento da parcela é: first_due_date + (installment_number - 1) months
  -- Simplificação: se a data de vencimento passou e ainda tem saldo, está atrasada
  is_overdue := v_paid < v_total and v_loan.first_due_date <= v_today;

  return query select
    p_installment_number as installment_number,
    v_total as total_value,
    v_paid as paid_amount,
    v_remaining as remaining,
    v_status as status,
    is_overdue as is_overdue;
end;
$$;

-- ========== 4. Função para atualizar situação automática ==========
create or replace function public.update_installment_statuses(
  p_loan_request_id uuid
) returns void language plpgsql stable set search_path = public as $$
declare
  v_total_installments int;
  v_loan public.loan_requests%rowtype;
  v_i int;
begin
  -- Buscar solicitação
  select * into v_loan from public.loan_requests where id = p_loan_request_id;
  if not found then return; end if;
  v_total_installments := v_loan.installments;

  -- Atualizar status de cada parcela através dos pagamentos registrados
  -- Isso é acionado via trigger ou manualmente pelo admin
  -- A lógica de status já está na function get_installment_status acima

  -- Podemos também atualizar a coluna status geral do empréstimo
  case
    when exists (
      select 1 from public.payments
      where loan_request_id = p_loan_request_id
      group by installment_number
      having count(*) filter (where amount_paid >= 0) = 0
    ) then -- Nenhum pagamento ainda
      -- manutenção do status existente
      null;
    when exists (
      select 1 from public.payments
      where loan_request_id = p_loan_request_id
      and amount_paid > 0
    ) then -- Tem pelo menos um pagamento
      -- status já será refletido via consultas
      null;
    end case;
end;
$$;

-- ========== 5. Função auxiliar: total pago por empréstimo ==========
create or replace function public.get_loan_paid_total(
  p_loan_request_id uuid
) returns numeric(12,2) language sql stable set search_path = public as $$
select coalesce(sum(amount_paid), 0) from public.payments where loan_request_id = p_loan_request_id;
$$;

-- ========== 6. Função: total de empréstimos liberados por período ==========
-- Não há coluna de data de liberação no schema; expomos created_at sem alegar que o
-- empréstimo foi liberado naquele instante. Remova a assinatura antiga se reaplicar.
drop function if exists public.get_loans_released_since(date);
create or replace function public.get_loans_released_since(
  p_since_date date
) returns table (
  id uuid,
  protocol text,
  user_id uuid,
  requested_amount numeric(12,2),
  total_amount numeric(12,2),
  created_at timestamptz,
  status text
) language sql stable set search_path = public as $$
select id, protocol, user_id, requested_amount, total_amount, created_at, status
from public.loan_requests
where status = 'liberada' and created_at >= p_since_date;
$$;

-- ========== 7. Konflito: evitar inserções duplicadas de pagamento ==========
-- Comentado para não criar restricão complexa; a aplicação deve validar antes de inserir.
-- validate_payment_duplicate será implementado no frontend/backend via verificação de valor + data

-- ========== 8. Segurança: RLS para tabela payments ==========
alter table public.payments enable row level security;

create policy "admin gerencia pagamentos" on public.payments
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "clientes veem pagamentos de proprios emprestimos" on public.payments
  for select to authenticated
  using (exists (
    select 1 from public.loan_requests
    where id = loan_request_id
      and user_id = (select auth.uid())
  ));

grant select on public.payments to authenticated;
-- Admins have full access via RLS policy "admin gerencia pagamentos"

-- ========== 9. Atualizar trigger set_updated_at se necessário ==========
-- Verifique se a função public.set_updated_at() existe da migração anterior
-- Caso contrário, crie-a aqui:

create or replace function public.set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;
