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

describe('stock count', () => {
  let app: INestApplication;
  let admin: string;
  let manager: string;
  let cashier: string;
  let sodaId: string;
  const api = () => request(app.getHttpServer());
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const soda = () =>
    prisma.product.findUniqueOrThrow({ where: { sku: 'SODA' } });
  const start = (body: object = {}, t = admin) =>
    api().post('/api/v1/stock-counts').set(auth(t)).send(body);
  const countSoda = (id: string, qty: number, t = admin) =>
    api()
      .post(`/api/v1/stock-counts/${id}/entries`)
      .set(auth(t))
      .send({ entries: [{ productId: sodaId, countedQty: qty }] });
  const apply = (id: string, t = admin) =>
    api().post(`/api/v1/stock-counts/${id}/apply`).set(auth(t)).send({});

  beforeAll(async () => {
    app = await createApp();
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetDb();
    await seedBasics(); // SODA: barcode 111, cost 50, stock 10
    await prisma.user.create({
      data: {
        email: 'manager@test.local',
        name: 'Mary',
        role: 'MANAGER',
        passwordHash: await bcrypt.hash(PASSWORD, 4),
      },
    });
    admin = await login(app, 'admin@test.local');
    manager = await login(app, 'manager@test.local');
    cashier = await login(app, 'cashier1@test.local');
    sodaId = (await soda()).id;
  });
  afterEach(() => {
    delete process.env.STOCK_COUNT_APPROVAL_VALUE;
  });

  it('allows one open count at a time and keeps cashiers out', async () => {
    await start().expect(201);
    await start().expect(409);
    await start({}, cashier).expect(403);
  });

  it('applies differences as adjustments and leaves matching products alone', async () => {
    const { body: c } = await start().expect(201);
    await countSoda(c.id, 8).expect(201);
    expect(
      (
        await api()
          .get(`/api/v1/stock-counts/${c.id}`)
          .set(auth(admin))
          .expect(200)
      ).body.totals.shortUnits,
    ).toBe(2);
    await apply(c.id).expect(201);
    expect((await soda()).stockQty).toBe(8);
    const moves = await prisma.stockMovement.findMany({
      where: { productId: sodaId, reason: { startsWith: 'Stock count #' } },
    });
    expect(moves).toHaveLength(1);
    expect(moves[0].quantity).toBe(-2);

    const { body: c2 } = await start().expect(201); // now counting exactly what the system shows
    await countSoda(c2.id, 8).expect(201);
    await apply(c2.id).expect(201);
    expect(
      await prisma.stockMovement.count({
        where: { productId: sodaId, reason: { startsWith: 'Stock count #' } },
      }),
    ).toBe(1);
  });

  it('keeps sales made during the count, because it adds the difference rather than overwriting', async () => {
    const { body: c } = await start().expect(201);
    await countSoda(c.id, 8).expect(201); // system said 10 when it was counted
    await prisma.product.update({
      where: { id: sodaId },
      data: { stockQty: 7 },
    }); // 3 sold afterwards
    await apply(c.id).expect(201);
    expect((await soda()).stockQty).toBe(5); // 7 - 2, not 8
  });

  it('refuses an adjustment that would go below zero, and changes nothing', async () => {
    const { body: c } = await start().expect(201);
    await countSoda(c.id, 0).expect(201); // difference of -10
    await prisma.product.update({
      where: { id: sodaId },
      data: { stockQty: 4 },
    });
    const res = await apply(c.id).expect(400);
    expect(res.body.message).toMatch(/Recount/);
    expect((await soda()).stockQty).toBe(4);
    expect(
      (await prisma.stockCount.findUniqueOrThrow({ where: { id: c.id } }))
        .status,
    ).toBe('OPEN');
  });

  it('needs an administrator to apply a large difference', async () => {
    process.env.STOCK_COUNT_APPROVAL_VALUE = '100';
    const { body: c } = await start({}, manager).expect(201);
    await countSoda(c.id, 4, manager).expect(201); // 6 units x 50 = 300 at cost
    await apply(c.id, manager).expect(403);
    expect((await soda()).stockQty).toBe(10);
    await apply(c.id, admin).expect(201);
    expect((await soda()).stockQty).toBe(4);
  });

  it('rejects products outside the chosen category', async () => {
    const cat = await prisma.category.create({ data: { name: 'Aisle 9' } });
    const { body: c } = await start({ categoryId: cat.id }).expect(201);
    await countSoda(c.id, 5).expect(400);
  });

  it('replaces an earlier entry when a product is recounted', async () => {
    const { body: c } = await start().expect(201);
    await countSoda(c.id, 3).expect(201);
    await countSoda(c.id, 9).expect(201);
    const lines = await prisma.stockCountLine.findMany({
      where: { countId: c.id },
    });
    expect(lines).toHaveLength(1);
    expect(lines[0].countedQty).toBe(9);
  });

  it('changes no stock when cancelled, and finds a product by barcode', async () => {
    const { body: c } = await start().expect(201);
    const found = (
      await api()
        .get(`/api/v1/stock-counts/${c.id}/find?q=111`)
        .set(auth(admin))
        .expect(200)
    ).body;
    expect(found.exact).toBe(true);
    expect(found.items[0].sku).toBe('SODA');
    await countSoda(c.id, 1).expect(201);
    await api()
      .post(`/api/v1/stock-counts/${c.id}/cancel`)
      .set(auth(admin))
      .expect(201);
    expect((await soda()).stockQty).toBe(10);
    await countSoda(c.id, 2).expect(400); // closed counts cannot be edited
  });
});
