import { INestApplication } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import {
  PASSWORD,
  createApp,
  login,
  prisma,
  resetDb,
  seedBasics,
} from './helpers';

describe('cash control', () => {
  let app: INestApplication;
  let cashier: string;
  let manager: string;
  const api = () => request(app.getHttpServer());
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  const sellAs = async (token: string) => {
    const p = await prisma.product.findUniqueOrThrow({
      where: { sku: 'SODA' },
    });
    return api()
      .post('/api/v1/sales')
      .set(auth(token))
      .send({
        items: [{ productId: p.id, quantity: 1 }],
        payments: [{ method: 'CASH', amount: 70 }],
      });
  };
  const open = (float: number, t = cashier) =>
    api()
      .post('/api/v1/cash/shifts')
      .set(auth(t))
      .send({ openingFloat: float });
  const move = (id: string, body: object, t = cashier) =>
    api().post(`/api/v1/cash/shifts/${id}/movements`).set(auth(t)).send(body);
  const close = (id: string, counted: number, note?: string, t = cashier) =>
    api()
      .post(`/api/v1/cash/shifts/${id}/close`)
      .set(auth(t))
      .send({ countedCash: counted, note });

  beforeAll(async () => {
    app = await createApp();
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetDb();
    await seedBasics();
    await prisma.user.create({
      data: {
        email: 'manager@test.local',
        name: 'Mary',
        role: 'MANAGER',
        passwordHash: await bcrypt.hash(PASSWORD, 4),
      },
    });
    cashier = await login(app, 'cashier1@test.local');
    manager = await login(app, 'manager@test.local');
  });
  afterEach(() => {
    delete process.env.CASH_REQUIRE_SHIFT;
    delete process.env.CASH_PAID_OUT_LIMIT;
  });

  it('allows one open shift per cashier', async () => {
    await open(1000).expect(201);
    await open(500).expect(409);
  });

  it('works out the expected cash from the float, cash sales, paid-outs and drops', async () => {
    const { body: s } = await open(1000).expect(201);
    await sellAs(cashier);
    await move(s.id, {
      type: 'PAID_OUT',
      amount: 200,
      reason: 'Ice delivery',
    }).expect(201);
    await move(s.id, { type: 'CASH_DROP', amount: 300 }).expect(201);
    const cur = (
      await api()
        .get('/api/v1/cash/shifts/current')
        .set(auth(cashier))
        .expect(200)
    ).body;
    expect(cur.shift.figures.expectedCash).toBe('570.00'); // 1000 + 70 - 200 - 300

    const closed = (await close(s.id, 565).expect(201)).body; // 5 short is inside the tolerance
    expect(closed.variance).toBe('-5.00');
    expect(closed.expectedCash).toBe('570.00');
    expect(closed.needsReview).toBe(false);
    await close(s.id, 570).expect(400); // already closed
  });

  it('wants a note for a big difference, and flags it until a manager acknowledges it', async () => {
    const { body: s } = await open(1000).expect(201);
    await close(s.id, 700).expect(400); // 300 short, no note
    const closed = (
      await close(s.id, 700, 'Gave change from my own pocket').expect(201)
    ).body;
    expect(closed.needsReview).toBe(true);

    const flagged = (
      await api()
        .get('/api/v1/cash/shifts?review=needed')
        .set(auth(manager))
        .expect(200)
    ).body;
    expect(flagged.items).toHaveLength(1);
    await api()
      .post(`/api/v1/cash/shifts/${s.id}/acknowledge`)
      .set(auth(cashier))
      .send({ note: 'ok' })
      .expect(403);
    await api()
      .post(`/api/v1/cash/shifts/${s.id}/acknowledge`)
      .set(auth(manager))
      .send({ note: 'Spoke to her, agreed' })
      .expect(201);
    expect(
      (
        await api()
          .get('/api/v1/cash/shifts?review=needed')
          .set(auth(manager))
          .expect(200)
      ).body.items,
    ).toHaveLength(0);
  });

  it('keeps large paid-outs, and adding cash, for managers', async () => {
    const { body: s } = await open(5000).expect(201);
    await move(s.id, {
      type: 'PAID_OUT',
      amount: 3000,
      reason: 'Supplier cash payment',
    }).expect(403);
    await move(
      s.id,
      { type: 'PAID_OUT', amount: 3000, reason: 'Supplier cash payment' },
      manager,
    ).expect(201);
    await move(s.id, {
      type: 'CASH_IN',
      amount: 500,
      reason: 'Float top-up',
    }).expect(403);
    await move(
      s.id,
      { type: 'CASH_IN', amount: 500, reason: 'Float top-up' },
      manager,
    ).expect(201);
  });

  it('never lets more leave the drawer than it holds, and needs a reason for a paid-out', async () => {
    const { body: s } = await open(100).expect(201);
    await move(s.id, { type: 'CASH_DROP', amount: 150 }).expect(400);
    await move(s.id, { type: 'PAID_OUT', amount: 20 }).expect(400); // no reason
  });

  it("keeps one cashier out of another's shift", async () => {
    await prisma.user.create({
      data: {
        email: 'cashier9@test.local',
        name: 'Zed',
        role: 'CASHIER',
        passwordHash: await bcrypt.hash(PASSWORD, 4),
      },
    });
    const other = await login(app, 'cashier9@test.local');
    const { body: s } = await open(1000).expect(201);
    await api().get(`/api/v1/cash/shifts/${s.id}`).set(auth(other)).expect(403);
    await close(s.id, 1000, undefined, other).expect(403);
    await api().get('/api/v1/cash/summary').set(auth(cashier)).expect(403);
  });

  it('lets a manager close for a cashier, but only with a note', async () => {
    const { body: s } = await open(1000).expect(201);
    await close(s.id, 1000, undefined, manager).expect(400);
    await close(s.id, 1000, 'Cashier left sick', manager).expect(201);
  });

  it('blocks sales without an open shift when a shift is required', async () => {
    process.env.CASH_REQUIRE_SHIFT = 'true';
    const blocked = await sellAs(cashier);
    expect(blocked.status).toBe(409);
    await open(1000).expect(201);
    expect((await sellAs(cashier)).status).toBe(201);
  });

  it("totals the manager's day", async () => {
    const { body: s } = await open(1000).expect(201);
    await sellAs(cashier);
    await close(s.id, 1070).expect(201);
    const day = (
      await api().get('/api/v1/cash/summary').set(auth(manager)).expect(200)
    ).body;
    expect(day.totals.shifts).toBe(1);
    expect(day.totals.cashSales).toBe('70.00');
    expect(day.totals.variance).toBe('0.00');
  });
});
