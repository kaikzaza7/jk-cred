import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startLab } from '../scripts/integration-lab.mjs';

test('request flows through the real repository, local HTTP and SQL from customer to administrator', async () => {
  const lab = await startLab();
  try {
    const client = await lab.repository('client');
    const admin = await lab.repository('admin');
    const other = await lab.repository('other');
    const settings = await client.getSettings();
    assert.equal(Number(settings.max_installments),12);
    const due = (await lab.db.query("select ((now() at time zone 'America/Sao_Paulo')::date + 10)::text as due")).rows[0].due;
    const request = { amount:1000,installments:3,firstDueDate:due,requestKey:randomUUID() };
    const loan = await client.createLoanRequest(request);
    assert.ok(loan.id && loan.protocol);
    assert.equal(Number(loan.total_amount),1320);
    const mine = await client.listLoans({own:true});
    assert.equal(mine.length,1);
    assert.equal(mine[0].protocol,loan.protocol);
    const incoming = await admin.listLoans({statuses:['aguardando_analise','em_analise']});
    assert.equal(incoming.length,1);
    assert.equal(incoming[0].id,loan.id);
    assert.equal(incoming[0].profiles.full_name,'Cliente de Homologação');
    assert.equal(Number(incoming[0].requested_amount),1000);
    assert.equal((await other.listLoans({own:true})).length,0);
    await assert.rejects(other.getLoan({id:loan.id}),error=>error.code==='NOT_FOUND');
    await assert.rejects(client.updateLoanStatus({id:loan.id,status:'aprovada',expectedStatus:'aguardando_analise',requestKey:randomUUID()}),error=>error.code==='FORBIDDEN');
    await admin.updateLoanStatus({id:loan.id,status:'aprovada',expectedStatus:'aguardando_analise',requestKey:randomUUID()});
    const refreshedClient = await lab.repository('client');
    assert.equal((await refreshedClient.getLoan({protocol:loan.protocol})).status,'aprovada');
    assert.equal((await admin.listLoans({statuses:['aprovada']})).length,1);
    await admin.recordPayment({loanId:loan.id,installment:1,amount:440,date:due,method:'pix',requestKey:randomUUID()});
    const payments=await refreshedClient.listPayments(loan.id);
    assert.equal(payments.length,1);
    assert.equal(Number(payments[0].amount_paid),440);
    const replay=await client.createLoanRequest(request);
    assert.equal(replay.id,loan.id);
    assert.equal((await admin.listLoans()).length,1);
    assert.equal((await fetch(lab.base+'/api',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
  } finally { await lab.close(); }
});
