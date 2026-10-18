import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { EtimsWorker } from '../src/etims/etims.worker';
import { MockEtimsProvider } from '../src/etims/providers/mock.provider';
import { createApp, login, prisma, resetDb, seedBasics } from './helpers';

describe('eTIMS (mock provider)', () => {
  let app: INestApplication;
  let worker: EtimsWorker;
  let mock: MockEtimsProvider;
  let token: string, adminToken: string, productId: string;
  const api = () => request(app.getHttpServer());
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const sell = (body: object = {}) =>
    api()
      .post('/api/v1/sales')
      .set(auth(token))
      .send({
        items: [{ productId, quantity: 1 }],
        payments: [{ method: 'CASH', amount: 70 }],
        ...body,
      });
  const invoice = (saleId: string) =>
    prisma.taxInvoice.findUniqueOrThrow({
      where: { saleId_type: { saleId, type: 'SALE' } },
    });
  const drain = async () => {
    for (let i = 0; i < 5; i++) await worker.tick();
  };

  beforeAll(async () => {
    app = await createApp();
    worker = app.get(EtimsWorker);
    mock = app.get(MockEtimsProvider);
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetDb();
    mock.reset();
    mock.setMode('ok');
    productId = (await seedBasics()).product.id;
    token = await login(app, 'cashier1@test.local');
    adminToken = await login(app, 'admin@test.local');
  });

  it('queues a pending invoice with the sale, then the worker accepts it as MOCK', async () => {
    const sale = (await sell().expect(201)).body;
    let inv = await invoice(sale.id);
    expect(inv.status).toBe('PENDING');
    expect(inv.invcNo).toBeNull(); // no KRA number is used until it is actually sent

    await drain();
    inv = await invoice(sale.id);
    expect(inv.status).toBe('ACCEPTED');
    expect(inv.environment).toBe('MOCK');
    expect(inv.invcNo).toBe(1);
    expect(inv.rcptSign).toMatch(/^MOCK/);
    expect(inv.qrPayload).toContain('MOCK-NOT-A-KRA-FILING');

    const status = await api()
      .get(`/api/v1/etims/sales/${sale.id}`)
      .set(auth(token))
      .expect(200);
    expect(status.body.status).toBe('MOCK_ACCEPTED'); // never plain "ACCEPTED" for a mock filing
  });

  it('does not create a second invoice when a checkout is retried', async () => {
    const a = (await sell({ clientRequestId: 'etims-1' }).expect(201)).body;
    const b = (await sell({ clientRequestId: 'etims-1' }).expect(201)).body;
    expect(b.id).toBe(a.id);
    expect(await prisma.taxInvoice.count()).toBe(1);
  });

  it('retries after KRA is down, and reuses the same invoice number', async () => {
    mock.setMode('down');
    const sale = (await sell().expect(201)).body;
    await worker.tick();
    let inv = await invoice(sale.id);
    expect(inv.status).toBe('PENDING');
    expect(inv.attemptCount).toBe(1);

    mock.setMode('ok');
    await prisma.etimsJob.updateMany({ data: { nextAttemptAt: new Date() } }); // skip the backoff wait
    await drain();
    inv = await invoice(sale.id);
    expect(inv.status).toBe('ACCEPTED');
    expect(inv.invcNo).toBe(1);
  });

  it('after a lost reply, reconciles instead of submitting twice', async () => {
    mock.setMode('lost_response');
    const sale = (await sell().expect(201)).body;
    await worker.tick();
    expect((await invoice(sale.id)).status).toBe('UNCERTAIN');

    await prisma.etimsJob.updateMany({ data: { nextAttemptAt: new Date() } });
    await drain();
    const inv = await invoice(sale.id);
    expect(inv.status).toBe('ACCEPTED');
    expect(await prisma.taxInvoice.count()).toBe(1);
  });

  it('escalates when KRA refuses a duplicate and gives no signature back', async () => {
    mock.setMode('lost_response_strict');
    const sale = (await sell().expect(201)).body;
    await worker.tick();
    await prisma.etimsJob.updateMany({ data: { nextAttemptAt: new Date() } });
    await worker.tick();
    const inv = await invoice(sale.id);
    expect(inv.status).toBe('UNCERTAIN'); // never marked accepted without KRA's data
    expect(inv.lastErrorCode).toBe('994');
  });

  it('voiding: cancels an unsent invoice (no number used), and credit-notes an accepted one', async () => {
    const unsent = (await sell().expect(201)).body;
    await api()
      .post(`/api/v1/sales/${unsent.id}/void`)
      .set(auth(adminToken))
      .send({ reason: 'wrong item' })
      .expect(201);
    expect((await invoice(unsent.id)).status).toBe('CANCELLED');

    const sent = (await sell().expect(201)).body;
    await drain();
    await api()
      .post(`/api/v1/sales/${sent.id}/void`)
      .set(auth(adminToken))
      .send({ reason: 'refund' })
      .expect(201);
    const note = await prisma.taxInvoice.findUniqueOrThrow({
      where: { saleId_type: { saleId: sent.id, type: 'CREDIT_NOTE' } },
    });
    expect(note.status).toBe('PENDING');
    await drain();
    expect(
      (await prisma.taxInvoice.findUniqueOrThrow({ where: { id: note.id } }))
        .status,
    ).toBe('ACCEPTED');
    expect((await invoice(unsent.id)).invcNo).toBeNull(); // the cancelled one never consumed a KRA number
  });

  it('blocks a void while the invoice outcome is unresolved', async () => {
    mock.setMode('timeout');
    const sale = (await sell().expect(201)).body;
    await worker.tick();
    await api()
      .post(`/api/v1/sales/${sale.id}/void`)
      .set(auth(adminToken))
      .send({ reason: 'oops' })
      .expect(409);
  });

  it('lets only managers retry, and not an accepted invoice', async () => {
    const sale = (await sell().expect(201)).body;
    await drain();
    const inv = await invoice(sale.id);
    await api()
      .post(`/api/v1/etims/invoices/${inv.id}/retry`)
      .set(auth(token))
      .expect(403);
    await api()
      .post(`/api/v1/etims/invoices/${inv.id}/retry`)
      .set(auth(adminToken))
      .expect(400);
  });
});
