import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MpesaStatus } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { MpesaClient } from '../src/mpesa/mpesa.client';
import { login, prisma, resetDb, seedBasics } from './helpers';

let productId: string;

describe('M-Pesa: still-processing answers', () => {
  let app: INestApplication;
  let token: string;
  let cashierId: string;
  const api = () => request(app.getHttpServer());

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MpesaClient)
      .useValue({
        isConfigured: () => true,
        // what Daraja says while the customer hasn't finished
        stkQuery: async () => ({
          ok: true,
          json: {
            ResultCode: '4999',
            ResultDesc: 'The transaction is still under processing',
          },
        }),
      })
      .compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.init();
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDb();
    const s = await seedBasics();
    productId = s.product.id;
    cashierId = s.cashier1.id;
    token = await login(app, 'cashier1@test.local');
  });

  const pending = (ageMs: number) =>
    prisma.mpesaPayment.create({
      data: {
        cashierId,
        phone: '254712345678',
        amount: 70,
        checkoutRequestId: `ws_CO_${ageMs}`,
        createdAt: new Date(Date.now() - ageMs),
      },
    });
  const status = (id: string) =>
    api()
      .get(`/api/v1/payments/mpesa/${id}`)
      .set({ Authorization: `Bearer ${token}` })
      .expect(200);

  it('keeps waiting when Daraja says "still processing"', async () => {
    const rec = await pending(30_000);
    expect((await status(rec.id)).body.status).toBe('PENDING');
  });

  it('keeps the internal request id off the receipt, then fills in the real code from a late callback', async () => {
    // confirmed by a status check: SUCCESS, but no receipt code yet
    const rec = await prisma.mpesaPayment.create({
      data: {
        cashierId,
        phone: '254712345678',
        amount: 70,
        checkoutRequestId: 'ws_CO_X1',
        status: MpesaStatus.SUCCESS,
      },
    });
    const auth = { Authorization: `Bearer ${token}` };

    const sale = await api()
      .post('/api/v1/sales')
      .set(auth)
      .send({
        items: [{ productId, quantity: 1 }],
        payments: [{ method: 'MPESA', amount: 70, mpesaPaymentId: rec.id }],
      })
      .expect(201);
    expect(sale.body.payments[0].reference).toBeNull();

    await api()
      .post('/api/v1/payments/hooks/stk/test-callback-secret')
      .send({
        Body: {
          stkCallback: {
            MerchantRequestID: 'm',
            CheckoutRequestID: 'ws_CO_X1',
            ResultCode: 0,
            ResultDesc: 'ok',
            CallbackMetadata: {
              Item: [
                { Name: 'Amount', Value: 70 },
                { Name: 'MpesaReceiptNumber', Value: 'LATE456' },
              ],
            },
          },
        },
      })
      .expect(200);

    const receipt = await api()
      .get(`/api/v1/sales/${sale.body.id}/receipt`)
      .set(auth)
      .expect(200);
    expect(receipt.body.payments[0].reference).toBe('LATE456');
  });

  it('gives up (non-final) after five minutes of silence', async () => {
    const rec = await pending(6 * 60_000);
    expect((await status(rec.id)).body.status).toBe('TIMEOUT');
  });

  it('lets a late success replace an earlier failed label', async () => {
    const rec = await pending(30_000);
    await prisma.mpesaPayment.update({
      where: { id: rec.id },
      data: { status: MpesaStatus.FAILED, resultCode: 4999 },
    });

    await api()
      .post('/api/v1/payments/hooks/stk/test-callback-secret')
      .send({
        Body: {
          stkCallback: {
            MerchantRequestID: 'm',
            CheckoutRequestID: rec.checkoutRequestId,
            ResultCode: 0,
            ResultDesc: 'ok',
            CallbackMetadata: {
              Item: [
                { Name: 'Amount', Value: 70 },
                { Name: 'MpesaReceiptNumber', Value: 'LATE123' },
              ],
            },
          },
        },
      })
      .expect(200);

    const after = await prisma.mpesaPayment.findUniqueOrThrow({
      where: { id: rec.id },
    });
    expect(after.status).toBe('SUCCESS');
    expect(after.receipt).toBe('LATE123');
  });
});
