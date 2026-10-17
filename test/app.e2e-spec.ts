import { INestApplication } from '@nestjs/common';
import { MpesaStatus } from '@prisma/client';
import request from 'supertest';
import { createApp, login, prisma, resetDb, seedBasics } from './helpers';

describe('POS API (e2e)', () => {
  let app: INestApplication;
  let adminToken: string, c1Token: string, c2Token: string;
  let productId: string, c1Id: string;

  const api = () => request(app.getHttpServer());
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const cash = (amount: number, tendered?: number) => ({
    method: 'CASH',
    amount,
    ...(tendered && { tendered }),
  });
  const sale = (
    token: string,
    quantity: number,
    payments: object[],
    extra: object = {},
  ) =>
    api()
      .post('/api/v1/sales')
      .set(auth(token))
      .send({ items: [{ productId, quantity }], payments, ...extra });
  const stock = async () =>
    (await prisma.product.findUniqueOrThrow({ where: { id: productId } }))
      .stockQty;

  beforeAll(async () => {
    app = await createApp();
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDb();
    const s = await seedBasics();
    productId = s.product.id;
    c1Id = s.cashier1.id;
    adminToken = await login(app, 'admin@test.local');
    c1Token = await login(app, 'cashier1@test.local');
    c2Token = await login(app, 'cashier2@test.local');
  });

  describe('store settings', () => {
    it('lets only admins change them, and receipts use them', async () => {
      await api()
        .patch('/api/v1/settings/store')
        .set(auth(c1Token))
        .send({ name: 'Nope' })
        .expect(403);
      await api()
        .patch('/api/v1/settings/store')
        .set(auth(adminToken))
        .send({ name: 'Mama Njeri Mart', taxPin: 'P000000000A' })
        .expect(200);

      const made = await sale(c1Token, 1, [cash(70)]).expect(201);
      const res = await api()
        .get(`/api/v1/sales/${made.body.id}/receipt`)
        .set(auth(c1Token))
        .expect(200);
      expect(res.body.store.name).toBe('Mama Njeri Mart');
      expect(res.body.store.taxPin).toBe('P000000000A');
    });
  });

  describe('auth and roles', () => {
    it('rejects bad credentials and missing tokens', async () => {
      await api()
        .post('/api/v1/auth/login')
        .send({ email: 'admin@test.local', password: 'wrong-password' })
        .expect(401);
      await api().get('/api/v1/auth/me').expect(401);
    });

    it('keeps cashiers out of manager endpoints', async () => {
      await api()
        .post('/api/v1/products')
        .set(auth(c1Token))
        .send({ sku: 'X', name: 'X', price: 1 })
        .expect(403);
      await api()
        .get('/api/v1/reports/overview')
        .set(auth(c1Token))
        .expect(403);
      await api().get('/api/v1/reports/shift').set(auth(c1Token)).expect(200);
    });

    it('cuts off a deactivated user immediately', async () => {
      await prisma.user.update({
        where: { id: c1Id },
        data: { isActive: false },
      });
      await api().get('/api/v1/auth/me').set(auth(c1Token)).expect(401);
    });
  });

  describe('checkout', () => {
    it('extracts VAT from the price, deducts stock, and hides cost from cashiers', async () => {
      const res = await sale(c1Token, 3, [cash(210, 500)]).expect(201);
      expect(Number(res.body.total)).toBe(210);
      expect(Number(res.body.taxTotal)).toBe(28.97);
      expect(Number(res.body.subtotal)).toBe(181.03);
      expect(Number(res.body.payments[0].change)).toBe(290);
      expect(res.body.receiptNo).toMatch(/^RCP-\d{6}$/);
      expect(res.body.items[0].unitCost).toBeUndefined();
      expect(await stock()).toBe(7);
    });

    it('rejects an oversell and leaves no trace', async () => {
      await sale(c1Token, 11, [cash(770)]).expect(400);
      expect(await stock()).toBe(10);
      expect(await prisma.sale.count()).toBe(0);
      expect(await prisma.stockMovement.count()).toBe(1); // only the opening stock
    });

    it('rejects payments that do not add up to the total', async () => {
      await sale(c1Token, 3, [cash(200)]).expect(400);
      expect(await stock()).toBe(10);
    });

    it('treats a repeated clientRequestId as the same sale', async () => {
      const body = [cash(70)];
      const a = await sale(c1Token, 1, body, {
        clientRequestId: 'req-1',
      }).expect(201);
      const b = await sale(c1Token, 1, body, {
        clientRequestId: 'req-1',
      }).expect(201);
      expect(b.body.id).toBe(a.body.id);
      expect(await stock()).toBe(9); // deducted once
    });

    it('never oversells the last units under concurrent checkouts', async () => {
      await prisma.product.update({
        where: { id: productId },
        data: { stockQty: 5 },
      });
      const results = await Promise.all([
        sale(c1Token, 3, [cash(210)]),
        sale(c2Token, 3, [cash(210)]),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 400]);
      expect(await stock()).toBe(2);
    });

    it('lets cashiers see only their own sales', async () => {
      const res = await sale(c1Token, 1, [cash(70)]).expect(201);
      await api()
        .get(`/api/v1/sales/${res.body.id}`)
        .set(auth(c2Token))
        .expect(404);
      await api()
        .get(`/api/v1/sales/${res.body.id}`)
        .set(auth(c1Token))
        .expect(200);
    });
  });

  describe('void', () => {
    it('restores stock once, and only managers can do it', async () => {
      const res = await sale(c1Token, 3, [cash(210)]).expect(201);
      await api()
        .post(`/api/v1/sales/${res.body.id}/void`)
        .set(auth(c1Token))
        .send({ reason: 'mistake' })
        .expect(403);

      await api()
        .post(`/api/v1/sales/${res.body.id}/void`)
        .set(auth(adminToken))
        .send({ reason: 'mistake' })
        .expect(201);
      expect(await stock()).toBe(10);
      await api()
        .post(`/api/v1/sales/${res.body.id}/void`)
        .set(auth(adminToken))
        .send({ reason: 'again' })
        .expect(400);
      expect(await stock()).toBe(10);
    });
  });

  describe('stock ledger', () => {
    it('movements always sum to the product quantity', async () => {
      const s1 = await sale(c1Token, 4, [cash(280)]).expect(201);
      await sale(c2Token, 2, [cash(140)]).expect(201);
      await api()
        .post(`/api/v1/sales/${s1.body.id}/void`)
        .set(auth(adminToken))
        .send({ reason: 'test' })
        .expect(201);
      await api()
        .post('/api/v1/inventory/restock')
        .set(auth(adminToken))
        .send({ productId, quantity: 5 })
        .expect(201);
      await api()
        .post('/api/v1/inventory/adjust')
        .set(auth(adminToken))
        .send({ productId, quantity: -1, reason: 'damaged' })
        .expect(201);

      const sum = await prisma.stockMovement.aggregate({
        where: { productId },
        _sum: { quantity: true },
      });
      expect(sum._sum.quantity).toBe(await stock());
    });

    it('refuses an adjustment that would go negative', async () => {
      await api()
        .post('/api/v1/inventory/adjust')
        .set(auth(adminToken))
        .send({ productId, quantity: -11, reason: 'test' })
        .expect(400);
      expect(await stock()).toBe(10);
    });
  });

  describe('M-Pesa', () => {
    const SECRET = 'test-callback-secret';
    const callback = (
      checkoutRequestId: string,
      amount: number,
      receipt = 'R123ABC',
    ) => ({
      Body: {
        stkCallback: {
          MerchantRequestID: 'm1',
          CheckoutRequestID: checkoutRequestId,
          ResultCode: 0,
          ResultDesc: 'ok',
          CallbackMetadata: {
            Item: [
              { Name: 'Amount', Value: amount },
              { Name: 'MpesaReceiptNumber', Value: receipt },
            ],
          },
        },
      },
    });
    const pending = (checkoutRequestId: string) =>
      prisma.mpesaPayment.create({
        data: {
          cashierId: c1Id,
          phone: '254712345678',
          amount: 70,
          checkoutRequestId,
          status: MpesaStatus.PENDING,
        },
      });

    it('settles a payment from a valid callback', async () => {
      const rec = await pending('ws_CO_1');
      await api()
        .post(`/api/v1/payments/hooks/stk/${SECRET}`)
        .send(callback('ws_CO_1', 70))
        .expect(200);
      const after = await prisma.mpesaPayment.findUniqueOrThrow({
        where: { id: rec.id },
      });
      expect(after.status).toBe('SUCCESS');
      expect(after.receipt).toBe('R123ABC');
    });

    it('rejects a wrong secret and ignores a wrong amount', async () => {
      const rec = await pending('ws_CO_2');
      await api()
        .post('/api/v1/payments/hooks/stk/nope')
        .send(callback('ws_CO_2', 70))
        .expect(403);
      await api()
        .post(`/api/v1/payments/hooks/stk/${SECRET}`)
        .send(callback('ws_CO_2', 1))
        .expect(200);
      expect(
        (await prisma.mpesaPayment.findUniqueOrThrow({ where: { id: rec.id } }))
          .status,
      ).toBe('PENDING');
    });

    it('lets a sale claim a confirmed payment exactly once', async () => {
      const rec = await pending('ws_CO_3');
      await api()
        .post(`/api/v1/payments/hooks/stk/${SECRET}`)
        .send(callback('ws_CO_3', 70))
        .expect(200);

      const pay = [{ method: 'MPESA', amount: 70, mpesaPaymentId: rec.id }];
      const res = await sale(c1Token, 1, pay).expect(201);
      expect(res.body.payments[0].reference).toBe('R123ABC');
      await sale(c1Token, 1, pay).expect(409); // already used
    });

    it('does not accept a typed-in M-Pesa code when manual references are off', async () => {
      await sale(c1Token, 1, [
        { method: 'MPESA', amount: 70, reference: 'FAKE12345' },
      ]).expect(400);
    });
  });

  describe('reports', () => {
    it('counts completed sales only and reports voids separately', async () => {
      const res = await sale(c1Token, 3, [cash(210)]).expect(201);
      let o = (
        await api()
          .get('/api/v1/reports/overview')
          .set(auth(adminToken))
          .expect(200)
      ).body;
      expect(Number(o.revenue)).toBe(210);
      expect(Number(o.grossProfit)).toBe(31.03);
      expect(o.transactions).toBe(1);

      await api()
        .post(`/api/v1/sales/${res.body.id}/void`)
        .set(auth(adminToken))
        .send({ reason: 'test' })
        .expect(201);
      o = (
        await api()
          .get('/api/v1/reports/overview')
          .set(auth(adminToken))
          .expect(200)
      ).body;
      expect(Number(o.revenue)).toBe(0);
      expect(o.voids.count).toBe(1);
    });
  });

  describe('forced password change', () => {
    it('blocks a new account from everything but changing its password', async () => {
      await api()
        .post('/api/v1/users')
        .set(auth(adminToken))
        .send({
          email: 'new@test.local',
          name: 'New Person',
          password: 'temporary1',
          role: 'CASHIER',
        })
        .expect(201);

      const login = await api()
        .post('/api/v1/auth/login')
        .send({ email: 'new@test.local', password: 'temporary1' })
        .expect(200);
      expect(login.body.user.mustChangePassword).toBe(true);
      const token: string = login.body.accessToken;

      const blocked = await api()
        .get('/api/v1/products')
        .set(auth(token))
        .expect(403);
      expect(blocked.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
      await api().get('/api/v1/auth/me').set(auth(token)).expect(200); // still allowed

      await api()
        .patch('/api/v1/users/me/password')
        .set(auth(token))
        .send({ currentPassword: 'temporary1', newPassword: 'temporary1' })
        .expect(400); // must differ
      await api()
        .patch('/api/v1/users/me/password')
        .set(auth(token))
        .send({ currentPassword: 'temporary1', newPassword: 'my-own-password' })
        .expect(200);

      await api().get('/api/v1/products').set(auth(token)).expect(200); // unblocked straight away
    });
  });
});
