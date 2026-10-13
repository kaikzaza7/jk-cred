-- ============================================================
-- JK CRED — Atualização do trigger handle_new_user (anti-race-condition)
-- Rode ESTE arquivo no SQL Editor do Supabase (não o 001_schema.sql completo)
-- ============================================================

-- 1. Atualiza a função do trigger para verificar duplicidade ANTES de inserir
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  m jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  cpf_clean text := public.only_digits(m->>'cpf');
  phone_clean text := public.only_digits(m->>'phone');
  email_clean text := lower(new.email);
  existing_profile public.profiles;
begin
  if coalesce(m->>'signup_type', '') <> 'cliente' then return new; end if;
  if coalesce(m->>'terms_version', '') = '' or coalesce(m->>'privacy_version', '') = '' then
    raise exception 'consentimento obrigatorio';
  end if;

  -- Verifica duplicidade ANTES de inserir (evita race condition + user fantasma no Auth)
  select * into existing_profile from public.profiles
   where cpf = cpf_clean or phone = phone_clean or email = email_clean
   limit 1;

  if found then
    if existing_profile.cpf = cpf_clean then
      raise exception 'JK:cpf_ja_cadastrado';
    elsif existing_profile.phone = phone_clean then
      raise exception 'JK:telefone_ja_cadastrado';
    else
      raise exception 'JK:email_ja_cadastrado';
    end if;
  end if;

  insert into public.profiles (id, full_name, email, cpf, phone, cep, street, number,
      complement, district, city, state, card_limit, card_brand)
  values (new.id, btrim(m->>'full_name'), email_clean, cpf_clean,
      phone_clean, public.only_digits(m->>'cep'), btrim(m->>'street'),
      btrim(m->>'number'), nullif(btrim(m->>'complement'), ''), btrim(m->>'district'),
      btrim(m->>'city'), upper(btrim(m->>'state')), (m->>'card_limit')::numeric, m->>'card_brand');
  insert into public.consent_log (user_id, document, version) values
      (new.id, 'termos_de_uso', m->>'terms_version'),
      (new.id, 'politica_de_privacidade', m->>'privacy_version');
  return new;
end $$;

-- 2. Promova um administrador somente após identificar e autorizar a conta no projeto.
-- Exemplo manual (substitua pelo UUID confirmado; esta migration não promove contas):
-- insert into public.admin_users (user_id) values ('UUID-DO-USUARIO-AUTORIZADO')
-- on conflict (user_id) do nothing;
