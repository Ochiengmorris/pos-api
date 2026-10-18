import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient, Role, StockMovementType } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';

export const prisma = new PrismaClient();
export const PASSWORD = 'Passw0rd!123';

// resetDb() wipes every table. Never let it near a real database.
function assertTestDb() {
  if (!process.env.DATABASE_URL?.includes('_test')) {
    throw new Error(
      'Refusing to run: DATABASE_URL must point at a *_test database',
    );
  }
}

export async function createApp(): Promise<INestApplication> {
  assertTestDb();
  const mod = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = mod.createNestApplication();
  configureApp(app);
  await app.init();
  return app;
}

export async function resetDb() {
  assertTestDb();
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "StockMovement","Payment","SaleItem","MpesaPayment","StoreSettings","Sale","Customer","Product","TaxInvoice","EtimsJob","EtimsEvent","EtimsSequence","TaxType","Category","User" RESTART IDENTITY CASCADE`,
  );
}

// Staff plus one product: price 70, cost 50, 16% VAT, 10 in stock
export async function seedBasics() {
  const passwordHash = await bcrypt.hash(PASSWORD, 4); // low cost: tests run fast
  const mk = (email: string, name: string, role: Role) =>
    prisma.user.create({ data: { email, name, role, passwordHash } });

  const admin = await mk('admin@test.local', 'Admin', Role.ADMIN);
  const cashier1 = await mk('cashier1@test.local', 'Cashier One', Role.CASHIER);
  const cashier2 = await mk('cashier2@test.local', 'Cashier Two', Role.CASHIER);

  const product = await prisma.product.create({
    data: {
      sku: 'SODA',
      barcode: '111',
      name: 'Soda',
      price: 70,
      costPrice: 50,
      taxRate: 16,
      stockQty: 10,
      reorderLevel: 3,
    },
  });
  await prisma.stockMovement.create({
    data: {
      productId: product.id,
      type: StockMovementType.PURCHASE,
      quantity: 10,
      reason: 'Opening stock',
    },
  });
  return { admin, cashier1, cashier2, product };
}

export async function login(app: INestApplication, email: string) {
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, password: PASSWORD })
    .expect(200);
  return res.body.accessToken as string;
}
