// e2e test for till payments (C2B). Needs a test database, like your other e2e specs.
// ADJUST: the two lines marked below to match how your other specs create the app.
process.env.C2B_ENABLED = 'true';
process.env.C2B_CALLBACK_TOKEN = 'test-token-0123456789abcdef0123456789';
process.env.C2B_SHORTCODE = '123456';
process.env.C2B_REQUIRE_CODE_ENTRY = 'false';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup'; // ADJUST if your helper is named differently
import { PrismaService } from '../src/prisma/prisma.service';
import { TillPaymentsService } from '../src/till-payments/till-payments.service';

const TOKEN = process.env.C2B_CALLBACK_TOKEN!;
const url = (p: string) => `/api/v1/c2b/${TOKEN}/${p}`;
const payload = (over: Record<string, unknown> = {}) => ({
  TransactionType: 'Pay Merchant',
  TransID: 'QTEST00001',
  TransTime: '20261107142530',
  TransAmount: '390.00',
  BusinessShortCode: '123456',
  BillRefNumber: '',
  MSISDN: 'hashed-or-masked',
  FirstName: 'JANE',
  LastName: 'WANJIKU',
  ...over,
});

describe('Till payments (C2B)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tills: TillPaymentsService;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    tills = app.get(TillPaymentsService);
  });

  beforeEach(async () => {
    await prisma.tillPayment.deleteMany({});
  });

  afterAll(async () => {
    await prisma.tillPayment.deleteMany({});
    await app.close();
  });

  it('answers 404 for a wrong secret, and stores nothing', async () => {
    await request(app.getHttpServer()).post('/api/v1/c2b/wrong-token/confirmation').send(payload()).expect(404);
    expect(await prisma.tillPayment.count()).toBe(0);
  });

  it('stores a confirmation and replies the way Safaricom expects', async () => {
    const res = await request(app.getHttpServer()).post(url('confirmation')).send(payload()).expect(200);
    expect(res.body).toEqual({ ResultCode: 0, ResultDesc: 'Accepted' });
    const row = await prisma.tillPayment.findUniqueOrThrow({ where: { transId: 'QTEST00001' } });
    expect(row.amount.toString()).toBe('390');
    expect(row.status).toBe('UNCLAIMED');
    // 14:25:30 Nairobi time is 11:25:30 UTC
    expect(row.transTime.toISOString()).toBe('2026-11-07T11:25:30.000Z');
  });

  it('counts a replayed notification once', async () => {
    await request(app.getHttpServer()).post(url('confirmation')).send(payload()).expect(200);
    await request(app.getHttpServer()).post(url('confirmation')).send(payload()).expect(200);
    expect(await prisma.tillPayment.count()).toBe(1);
  });

  it('drops a notification for another shortcode or a bad amount, but still replies OK', async () => {
    await request(app.getHttpServer()).post(url('confirmation')).send(payload({ BusinessShortCode: '999999' })).expect(200);
    await request(app.getHttpServer()).post(url('confirmation')).send(payload({ TransID: 'QTEST00002', TransAmount: '-5' })).expect(200);
    expect(await prisma.tillPayment.count()).toBe(0);
  });

  it('claims once, and refuses a second use, a wrong amount, and another cashier mid-reservation', async () => {
    await request(app.getHttpServer()).post(url('confirmation')).send(payload()).expect(200);

    await expect(
      prisma.$transaction((tx) => tills.claimForSale(tx, { transId: 'QTEST00001', saleId: 's1', amount: '380', userId: 'u1' })),
    ).rejects.toThrow(/paid KSh 390\.00/);

    await prisma.tillPayment.update({
      where: { transId: 'QTEST00001' },
      data: { reservedById: 'u2', reservedUntil: new Date(Date.now() + 60_000) },
    });
    await expect(
      prisma.$transaction((tx) => tills.claimForSale(tx, { transId: 'QTEST00001', saleId: 's1', amount: '390', userId: 'u1' })),
    ).rejects.toThrow(/another till/i);

    const ok = await prisma.$transaction((tx) =>
      tills.claimForSale(tx, { transId: 'QTEST00001', saleId: 's1', amount: '390', userId: 'u2' }),
    );
    expect(ok.amount).toBe('390.00');

    await expect(
      prisma.$transaction((tx) => tills.claimForSale(tx, { transId: 'QTEST00001', saleId: 's2', amount: '390', userId: 'u2' })),
    ).rejects.toThrow(/already been used/i);
  });

  it('puts a payment back when its sale is voided', async () => {
    await request(app.getHttpServer()).post(url('confirmation')).send(payload()).expect(200);
    await prisma.$transaction((tx) =>
      tills.claimForSale(tx, { transId: 'QTEST00001', saleId: 's1', amount: '390', userId: 'u1' }),
    );
    await prisma.$transaction((tx) => tills.releaseForSale(tx, 's1'));
    const row = await prisma.tillPayment.findUniqueOrThrow({ where: { transId: 'QTEST00001' } });
    expect(row.status).toBe('UNCLAIMED');
    expect(row.saleId).toBeNull();
  });
});
