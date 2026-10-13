-- Deploy BEFORE the updated acesso-cliente function. Missing RPC fails closed.
-- The local CLI is unavailable; this migration was authored and tested locally.
begin;
create index if not exists auth_attempts_created_at_idx on public.auth_attempts(created_at);

create or replace function public.consume_auth_attempt(
  p_action text, p_phone_hash text, p_ip_hash text
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  phone_lock bigint;
  ip_lock bigint;
  cutoff timestamptz;
  phone_limit integer;
  ip_limit integer;
begin
  if p_action is null or p_action not in ('login', 'recuperar')
    or p_phone_hash is null or p_phone_hash !~ '^[a-f0-9]{64}$'
    or p_ip_hash is null or p_ip_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'JK:entrada_invalida';
  end if;
  phone_lock := pg_catalog.hashtextextended('jk-auth-phone:' || p_action || ':' || p_phone_hash, 0);
  ip_lock := pg_catalog.hashtextextended('jk-auth-ip:' || p_action || ':' || p_ip_hash, 0);
  -- Stable lock ordering prevents two identities sharing an IP from deadlocking.
  perform pg_catalog.pg_advisory_xact_lock(least(phone_lock, ip_lock));
  perform pg_catalog.pg_advisory_xact_lock(greatest(phone_lock, ip_lock));
  cutoff := pg_catalog.clock_timestamp() - case when p_action = 'login' then interval '15 minutes' else interval '60 minutes' end;
  phone_limit := case when p_action = 'login' then 5 else 3 end;
  ip_limit := case when p_action = 'login' then 30 else 10 end;
  if (select count(*) from public.auth_attempts a where a.action = p_action and a.phone_hash = p_phone_hash and a.created_at >= cutoff) >= phone_limit
    or (select count(*) from public.auth_attempts a where a.action = p_action and a.ip_hash = p_ip_hash and a.created_at >= cutoff) >= ip_limit then
    return false;
  end if;
  insert into public.auth_attempts(action, phone_hash, ip_hash, created_at)
    values (p_action, p_phone_hash, p_ip_hash, pg_catalog.clock_timestamp());
  -- Bounded retention cleanup on accepted attempts, including failed logins.
  delete from public.auth_attempts where id in (
    select a.id from public.auth_attempts a
    where a.created_at < pg_catalog.clock_timestamp() - interval '24 hours'
    order by a.created_at limit 100
  );
  return true;
end $$;

revoke all on function public.consume_auth_attempt(text,text,text) from public, anon, authenticated;
grant execute on function public.consume_auth_attempt(text,text,text) to service_role;
-- Client roles never get direct access to the attempt log.
revoke all on public.auth_attempts from public, anon, authenticated;
alter table public.auth_attempts enable row level security;
commit;
