import {
  PaymentMethod,
  PaymentStatus,
  Prisma,
  PrismaClient,
  Role,
  SaleStatus,
  StockMovementType,
} from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { priceLine } from '../src/sales/pricing';

const prisma = new PrismaClient();
const isProd = process.env.NODE_ENV === 'production';

// Reproducible randomness: the demo data is identical every run (mulberry32)
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Sample values only: set your real prices, costs and VAT rates
const CATALOG = [
  {
    category: 'Beverages',
    sku: 'SODA-500',
    barcode: '600000000011',
    name: 'Soda 500ml',
    price: 70,
    cost: 50,
    tax: 16,
    stock: 120,
    reorder: 24,
  },
  {
    category: 'Beverages',
    sku: 'WATER-1L',
    barcode: '600000000028',
    name: 'Bottled Water 1L',
    price: 60,
    cost: 38,
    tax: 16,
    stock: 150,
    reorder: 30,
  },
  {
    category: 'Beverages',
    sku: 'JUICE-1L',
    barcode: '600000000035',
    name: 'Orange Juice 1L',
    price: 220,
    cost: 160,
    tax: 16,
    stock: 8,
    reorder: 10,
  },
  {
    category: 'Snacks',
    sku: 'CRISPS-50',
    barcode: '600000000042',
    name: 'Potato Crisps 50g',
    price: 60,
    cost: 40,
    tax: 16,
    stock: 90,
    reorder: 20,
  },
  {
    category: 'Snacks',
    sku: 'CHOC-100',
    barcode: '600000000059',
    name: 'Chocolate Bar 100g',
    price: 100,
    cost: 68,
    tax: 16,
    stock: 70,
    reorder: 15,
  },
  {
    category: 'Snacks',
    sku: 'BISC-PK',
    barcode: '600000000066',
    name: 'Biscuits Pack',
    price: 85,
    cost: 58,
    tax: 16,
    stock: 80,
    reorder: 15,
  },
  {
    category: 'Dairy',
    sku: 'MILK-500',
    barcode: '600000000073',
    name: 'Fresh Milk 500ml',
    price: 65,
    cost: 54,
    tax: 0,
    stock: 100,
    reorder: 24,
  },
  {
    category: 'Dairy',
    sku: 'YOG-250',
    barcode: '600000000080',
    name: 'Yoghurt 250ml',
    price: 90,
    cost: 62,
    tax: 16,
    stock: 0,
    reorder: 12,
  },
  {
    category: 'Bakery',
    sku: 'BREAD-400',
    barcode: '600000000097',
    name: 'Bread 400g',
    price: 65,
    cost: 52,
    tax: 0,
    stock: 60,
    reorder: 20,
  },
  {
    category: 'Bakery',
    sku: 'BUNS-6',
    barcode: '600000000103',
    name: 'Buns 6-pack',
    price: 150,
    cost: 105,
    tax: 16,
    stock: 40,
    reorder: 10,
  },
  {
    category: 'Household',
    sku: 'SOAP-BAR',
    barcode: '600000000110',
    name: 'Laundry Soap Bar',
    price: 130,
    cost: 92,
    tax: 16,
    stock: 60,
    reorder: 12,
  },
  {
    category: 'Household',
    sku: 'DISH-500',
    barcode: '600000000127',
    name: 'Dish Soap 500ml',
    price: 190,
    cost: 135,
    tax: 16,
    stock: 45,
    reorder: 10,
  },
  {
    category: 'Household',
    sku: 'TP-4',
    barcode: '600000000134',
    name: 'Toilet Paper 4-pack',
    price: 240,
    cost: 175,
    tax: 16,
    stock: 50,
    reorder: 12,
  },
  {
    category: 'Personal Care',
    sku: 'TOOTH-100',
    barcode: '600000000141',
    name: 'Toothpaste 100g',
    price: 210,
    cost: 150,
    tax: 16,
    stock: 5,
    reorder: 10,
  },
];

async function upsertUser(
  email: string,
  name: string,
  role: Role,
  password: string,
) {
  return prisma.user.upsert({
    where: { email: email.toLowerCase() },
    update: {},
    create: {
      email: email.toLowerCase(),
      name,
      role,
      passwordHash: await bcrypt.hash(password, 12),
    },
  });
}

async function seedCatalog() {
  for (const c of CATALOG) {
    const category = await prisma.category.upsert({
      where: { name: c.category },
      update: {},
      create: { name: c.category },
    });
    if (await prisma.product.findUnique({ where: { sku: c.sku } })) continue;

    await prisma.$transaction(async (tx) => {
      const p = await tx.product.create({
        data: {
          sku: c.sku,
          barcode: c.barcode,
          name: c.name,
          categoryId: category.id,
          price: c.price,
          costPrice: c.cost,
          taxRate: c.tax,
          stockQty: c.stock,
          reorderLevel: c.reorder,
        },
      });
      if (c.stock > 0) {
        await tx.stockMovement.create({
          data: {
            productId: p.id,
            type: StockMovementType.PURCHASE,
            quantity: c.stock,
            reason: 'Opening stock',
          },
        });
      }
    });
  }
}

async function seedDemoSales(cashiers: { id: string }[], managerId: string) {
  if ((await prisma.sale.count()) > 0) {
    console.log('Sales already exist, skipping demo sales');
    return;
  }
  const products = await prisma.product.findMany({ where: { isActive: true } });
  const stock = new Map(products.map((p) => [p.id, p.stockQty]));
  const rand = rng(42);
  const pick = <T>(a: T[]) => a[Math.floor(rand() * a.length)];
  const now = new Date();
  let refCounter = 1;

  for (let daysAgo = 13; daysAgo >= 0; daysAgo--) {
    // Trading hours roughly 08:00-20:00 EAT = 05:00-17:00 UTC; sorted so receipt numbers follow time
    const times = Array.from(
      { length: 4 + Math.floor(rand() * 8) },
      () =>
        new Date(
          Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate() - daysAgo,
            5 + Math.floor(rand() * 12),
            Math.floor(rand() * 60),
          ),
        ),
    ).sort((a, b) => a.getTime() - b.getTime());

    for (const createdAt of times) {
      if (createdAt > now) continue;

      const lines: { p: (typeof products)[number]; qty: number }[] = [];
      for (let k = 0, want = 1 + Math.floor(rand() * 4); k < want; k++) {
        const p = pick(products);
        const qty = 1 + Math.floor(rand() * 3);
        if (lines.some((l) => l.p.id === p.id) || (stock.get(p.id) ?? 0) < qty)
          continue;
        lines.push({ p, qty });
      }
      if (!lines.length) continue;

      let total = new Prisma.Decimal(0);
      let taxTotal = new Prisma.Decimal(0);
      const items = lines.map(({ p, qty }) => {
        const { lineTotal, taxAmount } = priceLine(p.price, p.taxRate, qty);
        total = total.add(lineTotal);
        taxTotal = taxTotal.add(taxAmount);
        return {
          productId: p.id,
          productName: p.name,
          quantity: qty,
          unitPrice: p.price,
          unitCost: p.costPrice,
          taxRate: p.taxRate,
          taxAmount,
          lineTotal,
        };
      });

      const r = rand();
      const method =
        r < 0.55
          ? PaymentMethod.CASH
          : r < 0.9
            ? PaymentMethod.MPESA
            : PaymentMethod.CARD;
      const tendered = new Prisma.Decimal(
        Math.ceil(total.toNumber() / 100) * 100,
      );
      const payment: Prisma.PaymentCreateWithoutSaleInput =
        method === PaymentMethod.CASH
          ? {
              method,
              status: PaymentStatus.SUCCESS,
              amount: total,
              tendered,
              change: tendered.sub(total),
            }
          : {
              method,
              status: PaymentStatus.SUCCESS,
              amount: total,
              reference: `SEED${String(refCounter++).padStart(6, '0')}`,
            };

      const cashier = pick(cashiers);
      const voided = rand() < 0.03; // a few voids so the dashboard has something to show

      await prisma.$transaction(async (tx) => {
        const sale = await tx.sale.create({
          data: {
            cashierId: cashier.id,
            createdAt,
            subtotal: total.sub(taxTotal),
            taxTotal,
            total,
            status: voided ? SaleStatus.VOIDED : SaleStatus.COMPLETED,
            ...(voided && {
              voidedAt: createdAt,
              voidReason: 'Seed: customer changed mind',
              voidedById: managerId,
            }),
            items: { create: items },
            payments: { create: [payment] },
          },
        });
        if (voided) return; // a void nets to zero stock change
        for (const { p, qty } of lines) {
          await tx.product.update({
            where: { id: p.id },
            data: { stockQty: { decrement: qty } },
          });
          await tx.stockMovement.create({
            data: {
              productId: p.id,
              type: StockMovementType.SALE,
              quantity: -qty,
              reason: 'Sale',
              userId: cashier.id,
              saleId: sale.id,
              createdAt,
            },
          });
        }
      });
      if (!voided)
        for (const { p, qty } of lines)
          stock.set(p.id, (stock.get(p.id) ?? 0) - qty);
    }
  }
}

async function main() {
  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@shop.local';
  const adminPassword =
    process.env.SEED_ADMIN_PASSWORD ?? (isProd ? undefined : 'ChangeMe123!');
  if (!adminPassword)
    throw new Error('Set SEED_ADMIN_PASSWORD to seed a production database');

  await upsertUser(adminEmail, 'Admin', Role.ADMIN, adminPassword);
  console.log(`Admin ready: ${adminEmail}`);
  if (isProd) return; // production gets only the admin

  const staffPassword = process.env.SEED_STAFF_PASSWORD ?? 'Passw0rd!123';
  const manager = await upsertUser(
    'manager@shop.local',
    'Mary Manager',
    Role.MANAGER,
    staffPassword,
  );
  const c1 = await upsertUser(
    'cashier1@shop.local',
    'Chris Cashier',
    Role.CASHIER,
    staffPassword,
  );
  const c2 = await upsertUser(
    'cashier2@shop.local',
    'Jane Cashier',
    Role.CASHIER,
    staffPassword,
  );
  await seedCatalog();
  console.log(
    `Staff ready (password: ${staffPassword}): manager@, cashier1@, cashier2@shop.local`,
  );

  if (process.env.SEED_DEMO_SALES === 'true') {
    await seedDemoSales([c1, c2], manager.id);
    console.log('Demo sales created');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
