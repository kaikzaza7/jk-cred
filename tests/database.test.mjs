import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

test('SQL migrations persist records, enforce ownership, status transitions and replay-safe payments', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jk-cred-test-'));
  let db = new PGlite(directory);
  const clientId = '11111111-1111-4111-8111-111111111111';
  const otherId = '22222222-2222-4222-8222-222222222222';
  const adminId = '33333333-3333-4333-8333-333333333333';
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth;
      create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
      $$;
      grant usage on schema auth, public to anon, authenticated;
      grant execute on function auth.uid() to anon, authenticated;
    `);
    const migrationDirectory = new URL('../supabase/migrations/', import.meta.url);
    const migrations = (await readdir(migrationDirectory)).filter(name => name.endsWith('.sql') && !name.startsWith('002_')).sort();
    for (const name of migrations) {
      try { await db.exec(await readFile(new URL(name, migrationDirectory), 'utf8')); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`); }
    }
    // The atomic limiter is callable only from server credentials.
    await db.exec('set role authenticated');
    await assert.rejects(db.query("select public.consume_auth_attempt('login',$1,$2)",['a'.repeat(64),'b'.repeat(64)]),/permission denied/);
    await db.exec('reset role; set role service_role');
    for(let i=0;i<5;i++) assert.equal((await db.query("select public.consume_auth_attempt('login',$1,$2) as allowed",['a'.repeat(64),'b'.repeat(64)])).rows[0].allowed,true);
    assert.equal((await db.query("select public.consume_auth_attempt('login',$1,$2) as allowed",['a'.repeat(64),'b'.repeat(64)])).rows[0].allowed,false);
    await assert.rejects(db.query("select public.consume_auth_attempt('login','invalid',$1)",['b'.repeat(64)]),/entrada_invalida/);
    for(let i=0;i<3;i++) assert.equal((await db.query("select public.consume_auth_attempt('recuperar',$1,$2) as allowed",['a'.repeat(64),'b'.repeat(64)])).rows[0].allowed,true);
    assert.equal((await db.query("select public.consume_auth_attempt('recuperar',$1,$2) as allowed",['a'.repeat(64),'b'.repeat(64)])).rows[0].allowed,false);
    for(let i=0;i<25;i++) assert.equal((await db.query("select public.consume_auth_attempt('login',$1,$2) as allowed",[i.toString(16).padStart(64,'0'),'b'.repeat(64)])).rows[0].allowed,true);
    assert.equal((await db.query("select public.consume_auth_attempt('login',$1,$2) as allowed",['c'.repeat(64),'b'.repeat(64)])).rows[0].allowed,false);
    await db.exec('reset role');
    await db.exec("update public.auth_attempts set created_at=now()-interval '2 hours'");
    await db.exec('set role service_role');
    assert.equal((await db.query("select public.consume_auth_attempt('login',$1,$2) as allowed",['a'.repeat(64),'b'.repeat(64)])).rows[0].allowed,true);
    await db.exec('reset role');
    // Synthetic identities; admin deliberately has no customer profile.
    await db.query('insert into auth.users(id,email) values ($1,$2),($3,$4),($5,$6)', [clientId, 'client@example.test', otherId, 'other@example.test', adminId, 'admin@example.test']);
    await db.query(`insert into public.profiles (id,full_name,email,cpf,phone,cep,street,number,district,city,state,card_limit,card_brand)
      values ($1,'Cliente de Teste','client@example.test','52998224725','79999999999','49000000','Rua Teste','1','Centro','Aracaju','SE',0,'nao_informado')`, [clientId]);
    await db.query('insert into public.admin_users(user_id) values ($1)', [adminId]);
    const identity = async id => {
      await db.exec('reset role');
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
      await db.exec('set role authenticated');
    };
    await identity(clientId);
    const due = (await db.query("select ((now() at time zone 'America/Sao_Paulo')::date + 10)::text as due")).rows[0].due;
    const createKey = '44444444-4444-4444-8444-444444444444';
    const create = (amount = 1000) => db.query('select (public.create_loan_request_checked($1,3,$2::date,$3::uuid)).*', [amount, due, createKey]);
    const loan = (await create()).rows[0];
    assert.equal(Number(loan.total_amount), 1320);
    assert.equal(loan.schedule.length, 3);
    assert.equal((await create()).rows[0].id, loan.id);
    await assert.rejects(create(1100), /chave_reutilizada/);
    await assert.rejects(db.query("select public.update_loan_status($1,'aprovada','aguardando_analise',$2)", [loan.id, '55555555-5555-4555-8555-555555555555']), /permissao_negada/);
    await assert.rejects(db.query("update public.loan_requests set status='aprovada' where id=$1", [loan.id]), /permission denied/);
    await identity(otherId);
    assert.equal((await db.query('select id from public.loan_requests')).rows.length, 0);
    await identity(adminId);
    const statusKey = '55555555-5555-4555-8555-555555555555';
    const approve = () => db.query("select (public.update_loan_status($1,'aprovada','aguardando_analise',$2)).*", [loan.id, statusKey]);
    assert.equal((await approve()).rows[0].status, 'aprovada');
    assert.equal((await approve()).rows[0].status, 'aprovada');
    await assert.rejects(db.query("select public.update_loan_status($1,'liberada','aguardando_analise',$2)", [loan.id, '66666666-6666-4666-8666-666666666666']), /status_conflitante/);
    await db.query("select public.update_loan_status($1,'liberada','aprovada',$2)", [loan.id, '66666666-6666-4666-8666-666666666666']);
    const paymentKey = '77777777-7777-4777-8777-777777777777';
    const payment = (amount = 100, key = paymentKey, installment = 1) => db.query("select (public.record_loan_payment($1,$2,$3,$4::date,'pix',null,$5::uuid)).*", [loan.id, installment, amount, due, key]);
    const paid = (await payment()).rows[0];
    assert.equal(paid.created_by, adminId);
    assert.equal((await payment()).rows[0].id, paid.id);
    await assert.rejects(payment(101), /chave_reutilizada/);
    await assert.rejects(payment(341, '88888888-8888-4888-8888-888888888888'), /valor_acima_do_saldo/);
    await assert.rejects(payment(1, '88888888-8888-4888-8888-888888888888', 9), /parcela_invalida/);
    await payment(340, '88888888-8888-4888-8888-888888888888');
    const installment = (await db.query('select * from public.get_installment_status($1,1)', [loan.id])).rows[0];
    assert.equal(Number(installment.remaining), 0);
    assert.equal(installment.status, 'paga');
    await assert.rejects(db.query('delete from public.payments where id=$1', [paid.id]), /permission denied/);
    await db.exec('reset role');
    await db.close();
    db = new PGlite(directory);
    assert.equal(Number((await db.query('select sum(amount_paid) as total from public.payments')).rows[0].total), 440);
    assert.equal((await db.query('select status from public.loan_requests where id=$1', [loan.id])).rows[0].status, 'liberada');
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
