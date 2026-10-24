import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MpesaStatus, Prisma, Role, SaleStatus } from '@prisma/client';
import { AuthUser } from '../auth/decorators/current-user.decorator';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { ShiftDto, TopProductsDto, TrendDto } from './dto/report-query.dto';
import { EtimsService } from '../etims/etims.service';

type Range = { from: string; to: string }; // inclusive business days, YYYY-MM-DD

const D = (v: string | number) => new Prisma.Decimal(v);

const isRealDate = (s: string) => {
  const t = new Date(`${s}T00:00:00Z`);
  return !isNaN(t.getTime()) && t.toISOString().slice(0, 10) === s;
};
const addDays = (d: string, n: number) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
const spanDays = (r: Range) =>
  Math.round((Date.parse(r.to) - Date.parse(r.from)) / 86_400_000) + 1;

// % change vs the previous period; null when there is nothing to compare against
const pct = (cur: string | number, prev: string | number) => {
  const p = D(prev);
  return p.isZero()
    ? null
    : D(cur).sub(p).div(p).mul(100).toDecimalPlaces(1).toNumber();
};

@Injectable()
export class ReportsService {
  private readonly tz: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly inventory: InventoryService,
    private readonly etims: EtimsService,
  ) {
    this.tz = this.config.get<string>('BUSINESS_TZ', 'Africa/Nairobi');
  }

  // ---------- date handling ----------

  private today() {
    // en-CA formats as YYYY-MM-DD
    return new Intl.DateTimeFormat('en-CA', { timeZone: this.tz }).format(
      new Date(),
    );
  }

  resolveRange(q: { from?: string; to?: string }): Range {
    const today = this.today();
    const to = q.to ?? today;
    const from = q.from ?? (q.to ? q.to : today);

    if (!isRealDate(from) || !isRealDate(to))
      throw new BadRequestException('Invalid date');
    if (from > to)
      throw new BadRequestException('"from" must not be after "to"');
    if (spanDays({ from, to }) > 366)
      throw new BadRequestException('Range cannot exceed 366 days');
    return { from, to };
  }

  private previous(r: Range): Range {
    const n = spanDays(r);
    const to = addDays(r.from, -1);
    return { from: addDays(to, -(n - 1)), to };
  }

  // Local midnight(from) <= createdAt < local midnight(to + 1 day), compared in UTC
  private inRange(r: Range) {
    return Prisma.sql`s."createdAt" >= ((${r.from}::date)::timestamp AT TIME ZONE ${this.tz}::text) AT TIME ZONE 'UTC'
      AND s."createdAt" < (((${r.to}::date + 1))::timestamp AT TIME ZONE ${this.tz}::text) AT TIME ZONE 'UTC'`;
  }

  // createdAt (stored as UTC) expressed as local wall-clock time
  private localTs() {
    return Prisma.sql`((s."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${this.tz}::text)`;
  }

  // ---------- overview (KPI row) ----------

  private async totals(r: Range) {
    const [[s], [i]] = await Promise.all([
      this.prisma.$queryRaw<
        {
          transactions: number;
          revenue: string;
          netSales: string;
          tax: string;
          avgBasket: string;
        }[]
      >`
        SELECT COUNT(*)::int AS "transactions",
               COALESCE(SUM(s."total"), 0)::text AS "revenue",
               COALESCE(SUM(s."subtotal"), 0)::text AS "netSales",
               COALESCE(SUM(s."taxTotal"), 0)::text AS "tax",
               COALESCE(ROUND(AVG(s."total"), 2), 0)::text AS "avgBasket"
        FROM "Sale" s
        WHERE s."status" = 'COMPLETED' AND ${this.inRange(r)}`,
      this.prisma.$queryRaw<{ itemsSold: number; grossProfit: string }[]>`
        SELECT COALESCE(SUM(i."quantity"), 0)::int AS "itemsSold",
               COALESCE(SUM(i."lineTotal" - i."taxAmount" - i."unitCost" * i."quantity"), 0)::text AS "grossProfit"
        FROM "SaleItem" i
        JOIN "Sale" s ON s."id" = i."saleId"
        WHERE s."status" = 'COMPLETED' AND ${this.inRange(r)}`,
    ]);

    const marginPct = D(s.netSales).isZero()
      ? null
      : D(i.grossProfit).div(s.netSales).mul(100).toDecimalPlaces(1).toNumber();

    return {
      ...s,
      itemsSold: i.itemsSold,
      grossProfit: i.grossProfit,
      marginPct,
    };
  }

  private async voids(r: Range) {
    const [row] = await this.prisma.$queryRaw<
      { count: number; value: string }[]
    >`
      SELECT COUNT(*)::int AS "count", COALESCE(SUM(s."total"), 0)::text AS "value"
      FROM "Sale" s
      WHERE s."status" = 'VOIDED' AND ${this.inRange(r)}`;
    return row;
  }

  async overviewFor(r: Range) {
    const prev = this.previous(r);
    const [cur, before, voids] = await Promise.all([
      this.totals(r),
      this.totals(prev),
      this.voids(r),
    ]);
    return {
      range: r,
      previousRange: prev,
      ...cur,
      change: {
        revenue: pct(cur.revenue, before.revenue),
        transactions: pct(cur.transactions, before.transactions),
        grossProfit: pct(cur.grossProfit, before.grossProfit),
      },
      voids,
    };
  }

  overview(q: { from?: string; to?: string }) {
    return this.overviewFor(this.resolveRange(q));
  }

  // ---------- trend ----------

  trend(q: TrendDto) {
    const r = this.resolveRange(q);
    const days = spanDays(r);
    const unit =
      q.interval ?? (days === 1 ? 'hour' : days <= 62 ? 'day' : 'month');
    if (unit === 'hour' && days > 7) {
      throw new BadRequestException('Hourly trend is limited to 7 days');
    }
    return this.trendFor(r, unit);
  }

  // Includes empty buckets, so charts don't skip quiet days
  private trendFor(r: Range, unit: string) {
    return this.prisma.$queryRaw<
      { bucket: string; transactions: number; revenue: string }[]
    >`
      WITH series AS (
        SELECT generate_series(
          date_trunc(${unit}::text, ${r.from}::date::timestamp),
          date_trunc(${unit}::text, ${r.to}::date::timestamp + interval '1 day' - interval '1 second'),
          ('1 ' || ${unit}::text)::interval
        ) AS bucket
      ), agg AS (
        SELECT date_trunc(${unit}::text, ${this.localTs()}) AS bucket,
               COUNT(*)::int AS transactions,
               SUM(s."total") AS revenue
        FROM "Sale" s
        WHERE s."status" = 'COMPLETED' AND ${this.inRange(r)}
        GROUP BY 1
      )
      SELECT to_char(series.bucket, 'YYYY-MM-DD"T"HH24:MI') AS "bucket",
             COALESCE(agg.transactions, 0)::int AS "transactions",
             COALESCE(agg.revenue, 0)::text AS "revenue"
      FROM series
      LEFT JOIN agg ON agg.bucket = series.bucket
      ORDER BY series.bucket`;
  }

  // ---------- breakdowns ----------

  topProducts(q: TopProductsDto) {
    return this.topProductsFor(this.resolveRange(q), q.by, q.limit);
  }

  private topProductsFor(
    r: Range,
    by: 'revenue' | 'quantity' | 'profit',
    limit: number,
  ) {
    const orderExpr = {
      revenue: Prisma.sql`SUM(i."lineTotal")`,
      quantity: Prisma.sql`SUM(i."quantity")`,
      profit: Prisma.sql`SUM(i."lineTotal" - i."taxAmount" - i."unitCost" * i."quantity")`,
    }[by];

    return this.prisma.$queryRaw<
      {
        id: string;
        name: string;
        sku: string;
        quantitySold: number;
        revenue: string;
        grossProfit: string;
      }[]
    >`
      SELECT p."id", p."name", p."sku",
             SUM(i."quantity")::int AS "quantitySold",
             SUM(i."lineTotal")::text AS "revenue",
             SUM(i."lineTotal" - i."taxAmount" - i."unitCost" * i."quantity")::text AS "grossProfit"
      FROM "SaleItem" i
      JOIN "Sale" s ON s."id" = i."saleId"
      JOIN "Product" p ON p."id" = i."productId"
      WHERE s."status" = 'COMPLETED' AND ${this.inRange(r)}
      GROUP BY p."id", p."name", p."sku"
      ORDER BY ${orderExpr} DESC
      LIMIT ${limit}`;
  }

  // Uses each product's current category
  salesByCategory(q: { from?: string; to?: string }) {
    const r = this.resolveRange(q);
    return this.prisma.$queryRaw<
      {
        category: string;
        quantitySold: number;
        revenue: string;
        grossProfit: string;
      }[]
    >`
      SELECT COALESCE(c."name", 'Uncategorised') AS "category",
             SUM(i."quantity")::int AS "quantitySold",
             SUM(i."lineTotal")::text AS "revenue",
             SUM(i."lineTotal" - i."taxAmount" - i."unitCost" * i."quantity")::text AS "grossProfit"
      FROM "SaleItem" i
      JOIN "Sale" s ON s."id" = i."saleId"
      JOIN "Product" p ON p."id" = i."productId"
      LEFT JOIN "Category" c ON c."id" = p."categoryId"
      WHERE s."status" = 'COMPLETED' AND ${this.inRange(r)}
      GROUP BY c."name"
      ORDER BY SUM(i."lineTotal") DESC`;
  }

  paymentMethods(q: { from?: string; to?: string }) {
    const r = this.resolveRange(q);
    return this.prisma.$queryRaw<
      { method: string; payments: number; amount: string }[]
    >`
      SELECT pay."method"::text AS "method",
             COUNT(*)::int AS "payments",
             SUM(pay."amount")::text AS "amount"
      FROM "Payment" pay
      JOIN "Sale" s ON s."id" = pay."saleId"
      WHERE s."status" = 'COMPLETED' AND pay."status" = 'SUCCESS' AND ${this.inRange(r)}
      GROUP BY pay."method"
      ORDER BY SUM(pay."amount") DESC`;
  }

  // VAT by the rate that applied at the time of sale
  async tax(q: { from?: string; to?: string }) {
    const r = this.resolveRange(q);
    const rows = await this.prisma.$queryRaw<
      { rate: string; netSales: string; vat: string; gross: string }[]
    >`
      SELECT i."taxRate"::text AS "rate",
             SUM(i."lineTotal" - i."taxAmount")::text AS "netSales",
             SUM(i."taxAmount")::text AS "vat",
             SUM(i."lineTotal")::text AS "gross"
      FROM "SaleItem" i
      JOIN "Sale" s ON s."id" = i."saleId"
      WHERE s."status" = 'COMPLETED' AND ${this.inRange(r)}
      GROUP BY i."taxRate"
      ORDER BY i."taxRate" DESC`;

    const totals = rows.reduce(
      (t, x) => ({
        netSales: t.netSales.add(x.netSales),
        vat: t.vat.add(x.vat),
        gross: t.gross.add(x.gross),
      }),
      { netSales: D(0), vat: D(0), gross: D(0) },
    );
    return {
      range: r,
      byRate: rows,
      totals: {
        netSales: totals.netSales.toFixed(2),
        vat: totals.vat.toFixed(2),
        gross: totals.gross.toFixed(2),
      },
    };
  }

  cashiers(q: { from?: string; to?: string }) {
    const r = this.resolveRange(q);
    return this.prisma.$queryRaw<
      {
        id: string;
        name: string;
        transactions: number;
        revenue: string;
        avgBasket: string;
      }[]
    >`
      SELECT u."id", u."name",
             COUNT(*)::int AS "transactions",
             SUM(s."total")::text AS "revenue",
             ROUND(AVG(s."total"), 2)::text AS "avgBasket"
      FROM "Sale" s
      JOIN "User" u ON u."id" = s."cashierId"
      WHERE s."status" = 'COMPLETED' AND ${this.inRange(r)}
      GROUP BY u."id", u."name"
      ORDER BY SUM(s."total") DESC`;
  }

  // ---------- end-of-shift summary (cashier-safe) ----------

  async shift(actor: AuthUser, q: ShiftDto) {
    const cashierId =
      actor.role === Role.CASHIER ? actor.id : (q.cashierId ?? actor.id);
    const day = q.date ?? this.today();
    if (!isRealDate(day)) throw new BadRequestException('Invalid date');
    const r = { from: day, to: day };

    const [[t], byMethod] = await Promise.all([
      this.prisma.$queryRaw<{ transactions: number; revenue: string }[]>`
        SELECT COUNT(*)::int AS "transactions", COALESCE(SUM(s."total"), 0)::text AS "revenue"
        FROM "Sale" s
        WHERE s."status" = 'COMPLETED' AND s."cashierId" = ${cashierId} AND ${this.inRange(r)}`,
      this.prisma.$queryRaw<
        { method: string; payments: number; amount: string }[]
      >`
        SELECT pay."method"::text AS "method", COUNT(*)::int AS "payments", SUM(pay."amount")::text AS "amount"
        FROM "Payment" pay
        JOIN "Sale" s ON s."id" = pay."saleId"
        WHERE s."status" = 'COMPLETED' AND pay."status" = 'SUCCESS'
          AND s."cashierId" = ${cashierId} AND ${this.inRange(r)}
        GROUP BY pay."method"
        ORDER BY pay."method"`,
    ]);

    return {
      date: day,
      cashierId,
      ...t,
      byMethod,
      // Cash kept after giving change (excludes any opening float)
      cashExpected: byMethod.find((m) => m.method === 'CASH')?.amount ?? '0',
    };
  }

  // ---------- manager dashboard: one call ----------

  async dashboard() {
    const today = this.today();
    const day = { from: today, to: today };
    const week = { from: addDays(today, -6), to: today };

    const [
      overview,
      trend,
      topProducts,
      lowStock,
      recent,
      inventory,
      etimsAttention,
      unclaimedMpesa,
    ] = await Promise.all([
      this.overviewFor(day),
      this.trendFor(week, 'day'),
      this.topProductsFor(week, 'revenue', 5),
      this.prisma.$queryRaw<
        {
          id: string;
          name: string;
          sku: string;
          stockQty: number;
          reorderLevel: number;
        }[]
      >`
        SELECT "id", "name", "sku", "stockQty", "reorderLevel"
        FROM "Product"
        WHERE "isActive" = true AND "stockQty" <= "reorderLevel"
        ORDER BY "stockQty" ASC, "name" ASC
        LIMIT 10`,
      this.prisma.sale.findMany({
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          id: true,
          receiptNumber: true,
          status: true,
          total: true,
          createdAt: true,
          cashier: { select: { name: true } },
          payments: { select: { method: true } },
        },
      }),
      this.inventory.summary(),
      this.etims.attentionCount(),
      this.prisma.mpesaPayment.count({
        where: { status: MpesaStatus.SUCCESS, saleId: null, resolution: null },
      }),
    ]);

    const prefix = this.config.get<string>('RECEIPT_PREFIX', 'RCP'); // same format as SalesService
    return {
      today: overview,
      weekTrend: trend,
      weekTopProducts: topProducts,
      lowStock,
      recentSales: recent.map((s) => ({
        id: s.id,
        receiptNo: `${prefix}-${String(s.receiptNumber).padStart(6, '0')}`,
        status: s.status,
        total: s.total,
        createdAt: s.createdAt,
        cashier: s.cashier.name,
        methods: [...new Set(s.payments.map((p) => p.method))],
      })),
      inventory,
      alerts: { unclaimedMpesa, etimsAttention },
    };
  }
}
