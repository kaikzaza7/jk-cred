// Isolated local lab: synthetic identities, real SQL/RLS/RPCs, no Supabase traffic.
import http from 'node:http';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, basename, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { PGlite } from '@electric-sql/pglite';

const require = createRequire(import.meta.url);
const project = resolve(fileURLToPath(new URL('..', import.meta.url)));
const headers = require('./security-headers');
export const identities = {
  client: '11111111-1111-4111-8111-111111111111',
  other: '22222222-2222-4222-8222-222222222222',
  admin: '33333333-3333-4333-8333-333333333333',
};

export async function startLab() {
  const directory = await mkdtemp(join(tmpdir(), 'jk-integration-lab-'));
  const removeDirectory = async () => {
    const target = resolve(directory), temporaryRoot = resolve(tmpdir());
    if (!target.startsWith(temporaryRoot + sep) || !basename(target).startsWith('jk-integration-lab-')) throw new Error('Invalid lab cleanup target');
    await rm(target,{recursive:true,force:true});
  };
  const db = new PGlite(directory);
  let server;
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create schema auth;
      create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
      $$;
      grant usage on schema auth, public to anon,authenticated;
      grant execute on function auth.uid() to anon,authenticated;`);
    const migrationPath = join(project, 'supabase/migrations');
    for (const name of (await readdir(migrationPath)).filter(n => n.endsWith('.sql') && !n.startsWith('002_')).sort()) {
      await db.exec(await readFile(join(migrationPath, name), 'utf8'));
    }
    for (const [role, id] of Object.entries(identities)) {
      await db.query('insert into auth.users(id,email) values($1,$2)', [id, `${role}@example.test`]);
    }
    await db.query(`insert into public.profiles(id,full_name,email,cpf,phone,cep,street,number,district,city,state,card_limit,card_brand)
      values($1,'Cliente de Homologação','client@example.test','52998224725','79999999999','49000000','Rua de Teste','1','Centro','Aracaju','SE',0,'nao_informado')`, [identities.client]);
    await db.query('insert into public.admin_users(user_id) values($1)', [identities.admin]);
    const tokens = Object.fromEntries(Object.keys(identities).map(role => [role, randomBytes(32).toString('hex')]));
    let queue = Promise.resolve();
    const statements = {
      create_loan_request_checked: ['select (public.create_loan_request_checked($1,$2,$3::date,$4::uuid)).*', ['p_amount','p_installments','p_first_due','p_idempotency_key']],
      update_loan_status: ['select (public.update_loan_status($1,$2,$3,$4::uuid)).*', ['p_loan_request_id','p_status','p_expected_status','p_idempotency_key']],
      record_loan_payment: ['select (public.record_loan_payment($1,$2,$3,$4::date,$5,$6,$7::uuid)).*', ['p_loan_request_id','p_installment_number','p_amount_paid','p_payment_date','p_payment_method','p_observation','p_idempotency_key']],
    };
    const execute = (role, spec) => {
      const work = queue.then(async () => {
        await db.exec('begin');
        try {
          await db.query("select set_config('request.jwt.claim.sub',$1,true)", [identities[role]]);
          await db.exec('set local role authenticated');
          let data;
          if (spec.rpc) {
            const statement = statements[spec.rpc];
            if (!statement) throw new Error('Lab RPC not allowed');
            data = (await db.query(statement[0], statement[1].map(name => spec.params?.[name] ?? null))).rows;
          } else {
            const tables = {
              loan_requests: { from: 'public.loan_requests l left join public.profiles p on p.id=l.user_id', select: "l.*,jsonb_build_object('full_name',p.full_name) as profiles", alias: 'l', columns: ['id','protocol','user_id','status','created_at'] },
              payments: { from:'public.payments l',select:'l.*',alias:'l',columns:['loan_request_id','payment_date'] },
              loan_settings: { from:'public.loan_settings l',select:'l.*',alias:'l',columns:['id'] },
            };
            const table = tables[spec.table];
            if (!table) throw new Error('Lab table not allowed');
            const values = [], filters = [];
            for (const filter of spec.filters || []) {
              if (!table.columns.includes(filter.column) || !['eq','in'].includes(filter.kind)) throw new Error('Lab filter not allowed');
              values.push(filter.value);
              filters.push(`${table.alias}.${filter.column} ${filter.kind === 'in' ? '= any' : '='} ${filter.kind === 'in' ? `($${values.length}::text[])` : `$${values.length}`}`);
            }
            const order = table.columns.includes(spec.order?.column) ? ` order by l.${spec.order.column} ${spec.order.ascending ? 'asc' : 'desc'}` : '';
            values.push(Math.max(1, Math.min(500, Math.trunc(Number(spec.limit) || 100))));
            const rows = (await db.query(`select ${table.select} from ${table.from}${filters.length ? ' where ' + filters.join(' and ') : ''}${order} limit $${values.length}`, values)).rows;
            data = spec.single ? rows[0] || null : rows;
          }
          await db.exec('commit');
          return { data, error: null };
        } catch (error) {
          await db.exec('rollback');
          return { data:null,error:{code:error.code || 'LAB_ERROR',message:error.message} };
        }
      });
      queue = work.catch(() => {});
      return work;
    };
    const send = (res, status, type, body) => { res.writeHead(status, { ...headers, 'Content-Type':type, 'Cache-Control':'no-store' }); res.end(body); };
    server = http.createServer(async (req,res) => {
      try {
        const pathname = new URL(req.url,'http://localhost').pathname;
        if (pathname === '/api' && req.method === 'POST') {
          const role = Object.keys(tokens).find(key => tokens[key] === req.headers['x-lab-token']);
          if (!role) return send(res,401,'application/json','{"error":{"code":"SESSION"}}');
          let size=0, text='';
          for await (const chunk of req) { size+=chunk.length; if(size>16384) return send(res,413,'application/json','{}'); text+=chunk; }
          return send(res,200,'application/json',JSON.stringify(await execute(role,JSON.parse(text))));
        }
        if(req.method !== 'GET') return send(res,405,'text/plain','Method not allowed');
        if(['/client','/admin','/other'].includes(pathname)) {
          const role=pathname.slice(1);
          const html=`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Homologação local JK CRED</title><link rel="stylesheet" href="/styles.css"></head><body><div class="preview-bar">Homologação LOCAL · dados fictícios · gravação em banco isolado · <a href="/client#/cliente/solicitar">Cliente</a> · <a href="/admin#/admin/solicitacoes">Administrador</a></div><div id="app"></div><div id="toast" class="toast"></div><script src="/errors.js"></script><script src="/loan-rules.js"></script><script src="/lab-adapter.js"></script><script src="/${role}-fixture.js"></script><script src="/repository.js"></script><script src="/app.js"></script></body></html>`;
          return send(res,200,'text/html; charset=utf-8',html);
        }
        const match=/^\/(client|admin|other)-fixture\.js$/.exec(pathname);
        if(match) {
          const role=match[1], admin=role==='admin';
          const js=`window.JKAuth={ready:true,user:{id:${JSON.stringify(identities[role])}},admin:${admin},views:{},redirectFor:p=>p};window.JKErrors.getClient=()=>window.makeLabClient('',${JSON.stringify(tokens[role])});if(!location.hash)location.hash=${JSON.stringify(admin ? '#/admin/solicitacoes' : '#/cliente/solicitar')};`;
          return send(res,200,'text/javascript',js);
        }
        const allowed=['app.js','errors.js','repository.js','loan-rules.js','styles.css'];
        if(allowed.includes(pathname.slice(1))) return send(res,200,pathname.endsWith('.css')?'text/css':'text/javascript',await readFile(join(project,'public',pathname.slice(1))));
        if(pathname==='/lab-adapter.js') return send(res,200,'text/javascript',await readFile(join(project,'scripts/lab-adapter.js')));
        return send(res,404,'text/plain','Not found');
      } catch { return send(res,400,'application/json','{"error":{"code":"VALIDATION"}}'); }
    });
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const base=`http://127.0.0.1:${server.address().port}`;
    const repository = async role => {
      const window={JKAuth:{user:{id:identities[role]},admin:role==='admin'}, JKErrors:{...require('../public/errors')}};
      const context={window,globalThis:window,fetch};
      vm.runInNewContext(await readFile(join(project,'scripts/lab-adapter.js'),'utf8'),context);
      window.JKErrors.getClient=()=>window.makeLabClient(base,tokens[role]);
      vm.runInNewContext(await readFile(join(project,'public/repository.js'),'utf8'),context);
      return window.JKRepository;
    };
    return {
      base,directory,repository,db,
      async close(){await new Promise(resolve=>server.close(resolve));await queue;await db.close();await removeDirectory();},
    };
  } catch(error) { if(server) server.close(); await db.close();await removeDirectory();throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const lab=await startLab();
  console.log(`Homologação LOCAL: ${lab.base}/client e ${lab.base}/admin (dados fictícios)`);
  const stop=async()=>{await lab.close();process.exit(0);};
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
}
