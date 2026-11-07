import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, TillPayment } from '@prisma/client';
import { timingSafeEqual } from 'crypto';
import { AuthUser } from '../auth/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import {
  IgnoreDto,
  ListQueryDto,
  ReserveDto,
  WaitingQueryDto,
} from './dto/till-payments.dto';

const D = (v: Prisma.Decimal | number | string | null | undefined) =>
  new Prisma.Decimal(v ?? 0);

/** Either the normal Prisma client or the one inside a $transaction. */
type Db = PrismaService | Prisma.TransactionClient;

const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;
const CODE_RE = /^[A-Za-z0-9]{6,32}$/;

// Kenya has no daylight saving, so a fixed +03:00 is correct for "what day was it in the shop".
const EAT = '+03:00';

function csvCell(v: unknown) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

@Injectable()
export class TillPaymentsService {
  private readonly log = new Logger(TillPaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  // ---------------------------------------------------------------- settings

  get enabled() {
    return this.config.get<string>('C2B_ENABLED') === 'true';
  }

  private num(key: string, fallback: number) {
    const n = Number(this.config.get<string>(key));
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }

  private get requireCodeEntry() {
    return this.config.get<string>('C2B_REQUIRE_CODE_ENTRY') === 'true';
  }

  publicConfig() {
    return {
      enabled: this.enabled,
      tillNumber: this.config.get<string>('C2B_TILL_NUMBER') ?? null,
      requireCodeEntry: this.requireCodeEntry,
      windowMinutes: this.num('C2B_MATCH_WINDOW_MINUTES', 20),
    };
  }

  // ------------------------------------------------- inbound (from Safaricom)

  /**
   * The callback URL contains a secret. Anyone who can POST to it can invent a payment,
   * so a wrong token looks exactly like a page that does not exist.
   */
  assertCallbackAccess(token: string, ip?: string) {
    const expected = this.config.get<string>('C2B_CALLBACK_TOKEN') ?? '';
    const a = Buffer.from(String(token));
    const b = Buffer.from(expected);
    const ok =
      this.enabled &&
      expected.length >= 24 &&
      a.length === b.length &&
      timingSafeEqual(a, b);
    if (!ok) throw new NotFoundException();

    const allow = (this.config.get<string>('C2B_ALLOWED_IPS') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (allow.length) {
      const clean = (ip ?? '').replace(/^::ffff:/, '');
      if (!allow.includes(clean)) {
        this.log.warn(
          `C2B callback from ${clean || 'unknown ip'} is not in C2B_ALLOWED_IPS`,
        );
        throw new NotFoundException();
      }
    }
  }

  /** Safaricom sends TransTime as yyyyMMddHHmmss in Nairobi time. */
  private parseTime(v: unknown): Date {
    const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(
      String(v ?? ''),
    );
    if (!m) return new Date();
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${EAT}`);
    return Number.isNaN(d.getTime()) ? new Date() : d;
  }

  /**
   * Store one payment notification. Safe to call twice with the same payload.
   * Bad payloads are logged and dropped (returns 'ignored') so Safaricom does not retry them forever.
   * Database errors are thrown, so Safaricom retries those.
   */
  async recordConfirmation(
    body: Record<string, unknown>,
  ): Promise<'stored' | 'duplicate' | 'ignored'> {
    const transId = String(body.TransID ?? '').trim();
    const amountRaw = String(body.TransAmount ?? '').trim();
    const shortCode = String(body.BusinessShortCode ?? '').trim();
    const expectedShort = String(
      this.config.get<string>('C2B_SHORTCODE') ?? '',
    ).trim();

    if (
      !CODE_RE.test(transId) ||
      !AMOUNT_RE.test(amountRaw) ||
      D(amountRaw).lte(0)
    ) {
      this.log.warn(
        `Dropped a C2B notification with an unusable code or amount (code="${transId}", amount="${amountRaw}")`,
      );
      return 'ignored';
    }
    if (expectedShort && shortCode !== expectedShort) {
      this.log.warn(
        `Dropped a C2B notification for shortcode ${shortCode}; expected ${expectedShort}`,
      );
      return 'ignored';
    }

    const name = [body.FirstName, body.MiddleName, body.LastName]
      .map((x) => String(x ?? '').trim())
      .filter(Boolean)
      .join(' ')
      .slice(0, 80);

    try {
      await this.prisma.tillPayment.create({
        data: {
          transId,
          transTime: this.parseTime(body.TransTime),
          amount: amountRaw,
          shortCode,
          billRef:
            String(body.BillRefNumber ?? '')
              .trim()
              .slice(0, 60) || null,
          payerName: name || null,
          payerPhone:
            String(body.MSISDN ?? '')
              .trim()
              .slice(0, 80) || null,
          rawPayload: body as Prisma.InputJsonValue,
        },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      )
        return 'duplicate';
      throw e;
    }

    await this.matchStk([transId]);
    return 'stored';
  }

  /**
   * An M-Pesa payment made by an STK push to the same till may ALSO be reported here.
   * If its code is already on a sale's payment, it is not an "extra" payment. Mark it matched.
   * Runs when a notification arrives and whenever a list is read, so either order of arrival works.
   */
  async matchStk(ids?: string[]) {
    const pending = await this.prisma.tillPayment.findMany({
      where: {
        status: 'UNCLAIMED',
        ...(ids
          ? { transId: { in: ids } }
          : { createdAt: { gte: new Date(Date.now() - 24 * 3600_000) } }),
      },
      select: { transId: true },
    });
    if (!pending.length) return 0;

    const used = await this.prisma.payment.findMany({
      where: {
        method: 'MPESA',
        reference: { in: pending.map((p) => p.transId) },
      },
      select: { reference: true },
    });
    const refs = used.map((u) => u.reference).filter((r): r is string => !!r);
    if (!refs.length) return 0;

    const res = await this.prisma.tillPayment.updateMany({
      where: { transId: { in: refs }, status: 'UNCLAIMED' },
      data: {
        status: 'MATCHED_STK',
        note: 'Already recorded on a sale (STK push)',
      },
    });
    return res.count;
  }

  // ------------------------------------------------------ at the till (cashier)

  private view(r: TillPayment, userId: string, now = new Date()) {
    return {
      transId: r.transId,
      amount: D(r.amount).toFixed(2),
      time: r.transTime.toISOString(),
      payerName: r.payerName,
      reservedByMe:
        r.reservedById === userId && !!r.reservedUntil && r.reservedUntil > now,
    };
  }

  /** Payments that have arrived and are free to use. `matches` are the exact amount for this sale. */
  async waiting(user: AuthUser, q: WaitingQueryDto) {
    if (!this.enabled)
      return { ...this.publicConfig(), matches: [], others: [] };
    await this.matchStk();

    const now = new Date();
    // Looking up by the customer's SMS code can go further back than the normal live window
    const minutes = q.code ? 360 : this.num('C2B_MATCH_WINDOW_MINUTES', 20);
    const since = new Date(now.getTime() - minutes * 60_000);

    const rows = await this.prisma.tillPayment.findMany({
      where: {
        status: 'UNCLAIMED',
        createdAt: { gte: since },
        AND: [
          {
            OR: [
              { reservedUntil: null },
              { reservedUntil: { lt: now } },
              { reservedById: user.id },
            ],
          },
          q.code ? { transId: { endsWith: q.code, mode: 'insensitive' } } : {},
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });

    const want = q.amount ? D(q.amount) : null;
    const views = rows.map((r) => ({ row: r, v: this.view(r, user.id, now) }));
    return {
      ...this.publicConfig(),
      matches: views
        .filter((x) => want && D(x.row.amount).eq(want))
        .map((x) => x.v),
      others: views
        .filter((x) => !want || !D(x.row.amount).eq(want))
        .slice(0, 5)
        .map((x) => x.v),
    };
  }

  /** Hold a payment for this cashier for a short time, so another till cannot take it while the sale is finished. */
  async reserve(user: AuthUser, transIdRaw: string, dto: ReserveDto) {
    const transId = String(transIdRaw).toUpperCase();
    if (
      this.requireCodeEntry &&
      (dto.codeLast4 ?? '').toUpperCase() !== transId.slice(-4)
    ) {
      throw new BadRequestException(
        "Type the last 4 characters of the M-Pesa code from the customer's SMS.",
      );
    }

    const now = new Date();
    const until = new Date(
      now.getTime() + this.num('C2B_RESERVE_SECONDS', 120) * 1000,
    );

    const res = await this.prisma.tillPayment.updateMany({
      where: {
        transId,
        status: 'UNCLAIMED',
        OR: [
          { reservedUntil: null },
          { reservedUntil: { lt: now } },
          { reservedById: user.id },
        ],
      },
      data: { reservedById: user.id, reservedUntil: until },
    });

    const row = await this.prisma.tillPayment.findUnique({
      where: { transId },
    });
    if (res.count === 1 && row) return this.view(row, user.id, now);

    if (!row)
      throw new NotFoundException('No payment with that code has arrived yet.');
    if (row.status !== 'UNCLAIMED')
      throw new ConflictException('That payment has already been used.');
    throw new ConflictException(
      'Another till is using that payment right now.',
    );
  }

  /**
   * Called by SalesService INSIDE the sale's transaction, after the sale row exists.
   * If anything is wrong this throws, and the whole sale rolls back, so a sale can never
   * be marked paid by a payment that is unknown, already used, or for a different amount.
   */
  async claimForSale(
    db: Db,
    a: {
      transId: string;
      saleId: string;
      amount: Prisma.Decimal | string | number;
      userId: string;
    },
  ) {
    const transId = String(a.transId).toUpperCase();
    const row = await db.tillPayment.findUnique({ where: { transId } });
    if (!row)
      throw new BadRequestException(
        'That M-Pesa payment has not arrived. Check the code, or ask the customer to wait a moment.',
      );
    if (row.status !== 'UNCLAIMED')
      throw new ConflictException('That M-Pesa payment has already been used.');

    if (!D(row.amount).eq(D(a.amount))) {
      throw new BadRequestException(
        `The customer paid KSh ${D(row.amount).toFixed(2)}, but this sale is KSh ${D(a.amount).toFixed(2)}. Ask a manager to sort out the difference.`,
      );
    }
    const now = new Date();
    if (
      row.reservedById &&
      row.reservedById !== a.userId &&
      row.reservedUntil &&
      row.reservedUntil > now
    ) {
      throw new ConflictException(
        'Another till is using that payment right now.',
      );
    }

    const res = await db.tillPayment.updateMany({
      where: { id: row.id, status: 'UNCLAIMED' },
      data: {
        status: 'CLAIMED',
        claimedById: a.userId,
        claimedAt: now,
        saleId: a.saleId,
        reservedById: null,
        reservedUntil: null,
      },
    });
    if (res.count !== 1)
      throw new ConflictException('That M-Pesa payment has already been used.');
    return { transId, amount: D(row.amount).toFixed(2) };
  }

  /**
   * A sale paid with a till payment was voided. The customer's money is still in the till account,
   * so the payment goes back to unclaimed, where it can be used for the corrected sale or dealt with by a manager.
   */
  async releaseForSale(db: Db, saleId: string) {
    await db.tillPayment.updateMany({
      where: { saleId, status: 'CLAIMED' },
      data: {
        status: 'UNCLAIMED',
        saleId: null,
        claimedById: null,
        claimedAt: null,
        note: 'Its sale was voided. Use it for the corrected sale, or check whether the customer needs a refund.',
      },
    });
  }

  // ------------------------------------------------------------- manager

  private dayBounds(date: string) {
    const from = new Date(`${date}T00:00:00${EAT}`);
    if (Number.isNaN(from.getTime()))
      throw new BadRequestException('That date is not valid.');
    return { from, to: new Date(from.getTime() + 24 * 3600_000) };
  }

  /** Everything that arrived on a day, with totals to compare against the M-Pesa statement. */
  async list(q: ListQueryDto) {
    await this.matchStk();
    const { from, to } = this.dayBounds(q.date);
    const rows = await this.prisma.tillPayment.findMany({
      where: {
        transTime: { gte: from, lt: to },
        ...(q.status ? { status: q.status } : {}),
      },
      orderBy: { transTime: 'asc' },
    });

    const sum = (pick: (r: TillPayment) => boolean) =>
      rows.filter(pick).reduce((acc, r) => acc.add(D(r.amount)), D(0));
    const count = (pick: (r: TillPayment) => boolean) =>
      rows.filter(pick).length;
    const bucket = (s: TillPayment['status']) => ({
      count: count((r) => r.status === s),
      amount: sum((r) => r.status === s).toFixed(2),
    });

    return {
      date: q.date,
      totals: {
        received: { count: rows.length, amount: sum(() => true).toFixed(2) },
        claimed: bucket('CLAIMED'),
        matchedStk: bucket('MATCHED_STK'),
        unclaimed: bucket('UNCLAIMED'),
        ignored: bucket('IGNORED'),
      },
      rows: rows.map((r) => ({
        id: r.id,
        transId: r.transId,
        time: r.transTime.toISOString(),
        amount: D(r.amount).toFixed(2),
        payerName: r.payerName,
        status: r.status,
        saleId: r.saleId,
        note: r.note,
        ignoredReason: r.ignoredReason,
      })),
    };
  }

  /** A CSV to lay beside the statement downloaded from the M-PESA Business portal. */
  async exportCsv(date: string) {
    const data = await this.list({ date });
    const head = [
      'M-Pesa code',
      'Time',
      'Amount',
      'Paid by',
      'Status',
      'Sale id',
      'Note',
    ];
    const lines = data.rows.map((r) =>
      [
        r.transId,
        r.time,
        r.amount,
        r.payerName,
        r.status,
        r.saleId,
        r.ignoredReason ?? r.note,
      ]
        .map(csvCell)
        .join(','),
    );
    return {
      filename: `till-payments-${date}.csv`,
      csv: [head.join(','), ...lines].join('\n'),
    };
  }

  /** Set a payment aside with a reason (for example: a customer paid the wrong till, refunded by hand). */
  async ignore(user: AuthUser, id: string, dto: IgnoreDto) {
    const res = await this.prisma.tillPayment.updateMany({
      where: { id, status: 'UNCLAIMED' },
      data: {
        status: 'IGNORED',
        ignoredById: user.id,
        ignoredReason: dto.reason.trim(),
        reservedById: null,
        reservedUntil: null,
      },
    });
    if (res.count !== 1)
      throw new ConflictException(
        'Only an unclaimed payment can be set aside.',
      );
    return { ok: true };
  }
}
