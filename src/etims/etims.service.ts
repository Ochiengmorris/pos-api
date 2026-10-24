import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import {
  PaymentMethod,
  Prisma,
  Role,
  TaxInvoice,
  TaxTypeCode,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import { AuthUser } from '../auth/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { EtimsConfig } from './etims.config';
import {
  ETIMS_PROVIDER,
  type ETimsProvider,
  type SalesPayload,
} from './etims.types';
import {
  buildCreditNotePayload,
  buildSalePayload,
  etimsItemCode,
  type BuildSaleInput,
} from './payload';
import {
  ListInvoicesDto,
  ResolveInvoiceDto,
  TaxReviewQueryDto,
} from './dto/etims.dto';
import { audit } from '../audit/audit';

type Db = Prisma.TransactionClient;

// KRA's published tax classes (OSCU specification, section 4.1). Rates live in the database from here on.
const DEFAULT_TAX_TYPES: { code: TaxTypeCode; name: string; rate: number }[] = [
  { code: 'A', name: 'A - Exempt', rate: 0 },
  { code: 'B', name: 'B - Standard rate', rate: 16 },
  { code: 'C', name: 'C - Zero-rated', rate: 0 },
  { code: 'D', name: 'D - Non-VAT', rate: 0 },
  { code: 'E', name: 'E - Reduced rate', rate: 8 },
];

// What the till and receipt may say about an invoice. Mock filings never read as real ones.
export type DisplayStatus =
  | 'NOT_REQUIRED'
  | 'PENDING'
  | 'ACCEPTED'
  | 'FAILED'
  | 'CANCELLED'
  | 'MOCK_ACCEPTED';

export function displayStatus(
  inv: { status: string; environment: string } | null,
): DisplayStatus {
  if (!inv) return 'NOT_REQUIRED';
  switch (inv.status) {
    case 'ACCEPTED':
      return inv.environment === 'MOCK' ? 'MOCK_ACCEPTED' : 'ACCEPTED';
    case 'REJECTED':
    case 'FAILED':
      return 'FAILED';
    case 'CANCELLED':
      return 'CANCELLED';
    default:
      return 'PENDING'; // PENDING and UNCERTAIN both mean "not confirmed by KRA"
  }
}

@Injectable()
export class EtimsService implements OnModuleInit {
  private readonly logger = new Logger(EtimsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: EtimsConfig,
    private readonly settings: SettingsService,
    @Inject(ETIMS_PROVIDER) private readonly provider: ETimsProvider,
  ) {}

  async onModuleInit() {
    await this.ensureTaxTypes(this.prisma);
    if (this.cfg.enabled) {
      this.logger.warn(
        `eTIMS is ON using the "${this.cfg.provider}" provider (${this.cfg.environment}).`,
      );
      if (this.cfg.provider === 'mock')
        this.logger.warn('MOCK MODE: no invoice is being filed with KRA.');
    }
  }

  // ---------- tax classes ----------

  private async ensureTaxTypes(db: Db) {
    await db.taxType.createMany({
      data: DEFAULT_TAX_TYPES,
      skipDuplicates: true,
    });
  }

  async taxRates(
    db: Db = this.prisma,
  ): Promise<Map<TaxTypeCode, Prisma.Decimal>> {
    let rows = await db.taxType.findMany();
    if (rows.length < DEFAULT_TAX_TYPES.length) {
      await this.ensureTaxTypes(db);
      rows = await db.taxType.findMany();
    }
    return new Map(rows.map((r) => [r.code, r.rate]));
  }

  // ---------- queueing (called inside the sale's own database transaction) ----------

  async enqueueSaleInvoice(
    tx: Db,
    a: {
      saleId: string;
      internalNo: string;
      createdAt: Date;
      cashier: { id: string; name: string };
      methods: PaymentMethod[];
      customerPin?: string | null;
      customerName?: string | null;
      lines: (Omit<
        BuildSaleInput['lines'][number],
        'itemCd' | 'itemClsCd' | 'barcode' | 'pkgUnitCd' | 'qtyUnitCd'
      > & { productId: string })[];
      products: Map<
        string,
        {
          etimsSeq: number;
          etimsItemClsCd: string | null;
          barcode: string | null;
          pkgUnitCd: string;
          qtyUnitCd: string;
        }
      >;
      rates: Map<TaxTypeCode, Prisma.Decimal>;
    },
  ) {
    if (!this.cfg.enabled) return;
    const store = await this.settings.get();

    const payload = buildSalePayload({
      tin: this.cfg.tin || 'A123456789Z',
      bhfId: this.cfg.bhfId,
      basis: this.cfg.taxableBasis,
      internalNo: a.internalNo,
      createdAt: a.createdAt,
      cashier: a.cashier,
      store: { name: store.name, address: store.address },
      methods: a.methods,
      customer: { pin: a.customerPin, name: a.customerName },
      rates: a.rates,
      lines: a.lines.map((l) => {
        const p = a.products.get(l.productId)!;
        return {
          ...l,
          itemCd: etimsItemCode(p),
          itemClsCd: p.etimsItemClsCd,
          barcode: p.barcode,
          pkgUnitCd: p.pkgUnitCd,
          qtyUnitCd: p.qtyUnitCd,
        };
      }),
    });

    const correlationId = randomUUID();
    await tx.taxInvoice.create({
      data: {
        saleId: a.saleId,
        type: 'SALE',
        internalNo: a.internalNo,
        environment: this.cfg.environment,
        customerPin: a.customerPin ?? null,
        customerName: a.customerName ?? null,
        payload: payload as unknown as Prisma.InputJsonValue,
        // the job is created in the SAME transaction as the sale: either both exist or neither does
        job: {
          create: { idempotencyKey: `sale:${a.saleId}:SALE`, correlationId },
        },
        events: {
          create: {
            type: 'QUEUED',
            message: `Queued for ${this.cfg.provider} (${this.cfg.environment})`,
            correlationId,
          },
        },
      },
    });
  }

  // ---------- voids ----------

  // Called inside the void transaction. Throws if the invoice is in a state that cannot be reversed safely.
  async onSaleVoided(tx: Db, saleId: string, actor: AuthUser) {
    const inv = await tx.taxInvoice.findUnique({
      where: { saleId_type: { saleId, type: 'SALE' } },
    });
    if (!inv || inv.status === 'CANCELLED') return; // sale predates eTIMS, or already cancelled

    if (inv.status === 'ACCEPTED') {
      // an accepted invoice cannot be deleted: reverse it with a credit note
      const original = inv.payload as unknown as SalesPayload;
      const internalNo = `CN-${inv.internalNo}`;
      const correlationId = randomUUID();
      await tx.taxInvoice.create({
        data: {
          saleId,
          type: 'CREDIT_NOTE',
          internalNo,
          environment: inv.environment,
          originalInvoiceId: inv.id,
          customerPin: inv.customerPin,
          customerName: inv.customerName,
          payload: buildCreditNotePayload(
            original,
            inv.invcNo!,
            internalNo,
            new Date(),
          ) as unknown as Prisma.InputJsonValue,
          job: {
            create: {
              idempotencyKey: `sale:${saleId}:CREDIT_NOTE`,
              correlationId,
            },
          },
          events: {
            create: {
              type: 'QUEUED',
              message: 'Credit note queued because the sale was voided',
              actorId: actor.id,
              correlationId,
            },
          },
        },
      });
      return;
    }

    // never sent to KRA, so no invoice number was used: it can simply be cancelled
    const cancelled = await tx.taxInvoice.updateMany({
      where: { id: inv.id, status: 'PENDING', invcNo: null, attemptCount: 0 },
      data: { status: 'CANCELLED' },
    });
    if (cancelled.count === 1) {
      await tx.etimsJob.updateMany({
        where: { invoiceId: inv.id },
        data: { status: 'CANCELLED', lockedUntil: null },
      });
      await tx.etimsEvent.create({
        data: {
          invoiceId: inv.id,
          type: 'CANCELLED',
          message: 'Sale voided before submission',
          actorId: actor.id,
        },
      });
      return;
    }

    throw new ConflictException(
      "This sale's tax invoice is still being sent to KRA or needs attention. Resolve it on the eTIMS screen before voiding the sale.",
    );
  }

  // ---------- reading status ----------

  async statusForSale(saleId: string, actor: AuthUser) {
    const sale = await this.prisma.sale.findUnique({
      where: { id: saleId },
      select: { cashierId: true },
    });
    if (!sale || (actor.role === Role.CASHIER && sale.cashierId !== actor.id))
      throw new NotFoundException('Sale not found');

    const inv = await this.prisma.taxInvoice.findUnique({
      where: { saleId_type: { saleId, type: 'SALE' } },
    });
    return {
      status: displayStatus(inv),
      environment: inv?.environment ?? null,
      internalNo: inv?.internalNo ?? null,
      invoiceNo: inv?.invcNo ?? null,
      receiptNo: inv?.receiptNo ?? null,
      acceptedAt: inv?.acceptedAt ?? null,
      attempts: inv?.attemptCount ?? 0,
      lastError:
        actor.role === Role.CASHIER
          ? undefined
          : (inv?.lastErrorMessage ?? null), // details are for managers
    };
  }

  // ---------- dashboard ----------

  private stuckBefore() {
    return new Date(Date.now() - this.cfg.stuckMinutes * 60_000);
  }

  async attentionCount(): Promise<number> {
    if (!this.cfg.enabled) return 0;
    const [bad, stuck] = await Promise.all([
      this.prisma.taxInvoice.count({
        where: { status: { in: ['REJECTED', 'FAILED', 'UNCERTAIN'] } },
      }),
      this.prisma.taxInvoice.count({
        where: { status: 'PENDING', createdAt: { lt: this.stuckBefore() } },
      }),
    ]);
    return bad + stuck;
  }

  async summary() {
    const [groups, oldest, lastAccepted, unreviewed, stuck] = await Promise.all(
      [
        this.prisma.taxInvoice.groupBy({
          by: ['status'],
          _count: { _all: true },
        }),
        this.prisma.taxInvoice.findFirst({
          where: { status: { in: ['PENDING', 'UNCERTAIN'] } },
          orderBy: { createdAt: 'asc' },
          select: { createdAt: true },
        }),
        this.prisma.taxInvoice.findFirst({
          where: { status: 'ACCEPTED' },
          orderBy: { acceptedAt: 'desc' },
          select: { acceptedAt: true },
        }),
        this.prisma.product.count({
          where: { isActive: true, taxConfirmed: false },
        }),
        this.prisma.taxInvoice.count({
          where: { status: 'PENDING', createdAt: { lt: this.stuckBefore() } },
        }),
      ],
    );
    const n = (s: string) =>
      groups.find((g) => g.status === s)?._count._all ?? 0;
    const counts = {
      pending: n('PENDING'),
      uncertain: n('UNCERTAIN'),
      rejected: n('REJECTED'),
      failed: n('FAILED'),
      accepted: n('ACCEPTED'),
      cancelled: n('CANCELLED'),
    };
    return {
      provider: this.cfg.provider,
      environment: this.cfg.environment,
      mock: this.cfg.provider === 'mock',
      mockMode: this.cfg.provider === 'mock' ? this.cfg.mockMode : null,
      workerOn: this.cfg.workerOn,
      counts,
      stuck,
      needsAttention:
        counts.rejected + counts.failed + counts.uncertain + stuck,
      oldestPendingAt: oldest?.createdAt ?? null,
      lastAcceptedAt: lastAccepted?.acceptedAt ?? null,
      unreviewedProducts: unreviewed,
    };
  }

  private searchFilter(search: string): Prisma.TaxInvoiceWhereInput {
    const s = search.trim();
    const num = /^\d{1,9}$/.test(s) ? Number(s) : null;
    return {
      OR: [
        { internalNo: { contains: s, mode: 'insensitive' } }, // "RCP-000123"
        { rcptSign: { contains: s, mode: 'insensitive' } },
        { customerPin: { contains: s, mode: 'insensitive' } },
        ...(num !== null
          ? [
              { invcNo: num },
              { receiptNo: num },
              { sale: { receiptNumber: num } },
            ]
          : []),
      ],
    };
  }

  async listInvoices(q: ListInvoicesDto) {
    const and: Prisma.TaxInvoiceWhereInput[] = [];
    if (q.type) and.push({ type: q.type });
    if (q.status === 'ATTENTION') {
      and.push({
        OR: [
          { status: { in: ['REJECTED', 'FAILED', 'UNCERTAIN'] } },
          { status: 'PENDING', createdAt: { lt: this.stuckBefore() } },
        ],
      });
    } else if (q.status) {
      and.push({ status: q.status });
    }
    if (q.from || q.to) {
      and.push({
        createdAt: {
          ...(q.from && { gte: new Date(q.from) }),
          ...(q.to && { lte: new Date(q.to) }),
        },
      });
    }
    if (q.search?.trim()) and.push(this.searchFilter(q.search));
    const where: Prisma.TaxInvoiceWhereInput = and.length ? { AND: and } : {};

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.taxInvoice.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.limit,
        take: q.limit,
        include: {
          job: { select: { status: true, nextAttemptAt: true } },
          sale: {
            select: {
              id: true,
              total: true,
              cashier: { select: { name: true } },
            },
          },
        },
      }),
      this.prisma.taxInvoice.count({ where }),
    ]);

    return {
      items: rows.map((r) => ({
        id: r.id,
        type: r.type,
        internalNo: r.internalNo,
        status: r.status,
        display: displayStatus(r),
        environment: r.environment,
        invoiceNo: r.invcNo,
        scuReceiptNo: r.receiptNo,
        createdAt: r.createdAt,
        acceptedAt: r.acceptedAt,
        attempts: r.attemptCount,
        lastAttemptAt: r.lastAttemptAt,
        lastErrorCode: r.lastErrorCode,
        lastErrorMessage: r.lastErrorMessage,
        nextAttemptAt: r.job?.nextAttemptAt ?? null,
        jobStatus: r.job?.status ?? null,
        saleId: r.sale.id,
        total: r.sale.total,
        cashier: r.sale.cashier.name,
        customerPin: r.customerPin,
      })),
      meta: {
        total,
        page: q.page,
        limit: q.limit,
        pages: Math.ceil(total / q.limit),
      },
    };
  }

  async invoiceDetail(id: string) {
    const inv = await this.prisma.taxInvoice.findUnique({
      where: { id },
      include: {
        job: true,
        events: { orderBy: { createdAt: 'asc' } },
        sale: {
          select: {
            id: true,
            receiptNumber: true,
            total: true,
            createdAt: true,
            cashier: { select: { name: true } },
          },
        },
      },
    });
    if (!inv) throw new NotFoundException('Invoice not found');
    return { ...inv, display: displayStatus(inv) };
  }

  // ---------- controlled actions (managers) ----------

  // Refreshes catalogue fields only. Amounts and tax class are what was actually charged, so they never change.
  private async rebuildPayload(inv: TaxInvoice): Promise<SalesPayload> {
    if (inv.type === 'CREDIT_NOTE') {
      const orig = await this.prisma.taxInvoice.findUniqueOrThrow({
        where: { id: inv.originalInvoiceId! },
      });
      return buildCreditNotePayload(
        orig.payload as unknown as SalesPayload,
        orig.invcNo!,
        inv.internalNo,
        new Date(),
      );
    }
    const old = inv.payload as unknown as SalesPayload;
    const sale = await this.prisma.sale.findUniqueOrThrow({
      where: { id: inv.saleId },
      include: {
        items: { include: { product: true } },
        payments: true,
        cashier: { select: { id: true, name: true } },
      },
    });
    const [store, rates] = await Promise.all([
      this.settings.get(),
      this.taxRates(),
    ]);
    return buildSalePayload({
      tin: old.tin,
      bhfId: old.bhfId,
      basis: this.cfg.taxableBasis,
      internalNo: inv.internalNo,
      createdAt: sale.createdAt,
      cashier: sale.cashier,
      store: { name: store.name, address: store.address },
      methods: sale.payments.map((p) => p.method),
      customer: { pin: inv.customerPin, name: inv.customerName },
      rates,
      lines: sale.items.map((i) => ({
        name: i.productName,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        lineTotal: i.lineTotal,
        taxAmount: i.taxAmount,
        taxTyCd: i.taxTyCd, // the class that was charged at the time of sale
        itemCd: etimsItemCode(i.product),
        itemClsCd: i.product.etimsItemClsCd,
        barcode: i.product.barcode,
        pkgUnitCd: i.product.pkgUnitCd,
        qtyUnitCd: i.product.qtyUnitCd,
      })),
    });
  }

  async retry(invoiceId: string, actor: AuthUser, rebuild = false) {
    const inv = await this.prisma.taxInvoice.findUnique({
      where: { id: invoiceId },
      include: { job: true },
    });
    if (!inv || !inv.job) throw new NotFoundException('Invoice not found');
    if (!['REJECTED', 'FAILED', 'UNCERTAIN'].includes(inv.status)) {
      throw new BadRequestException(
        `A ${inv.status.toLowerCase()} invoice cannot be retried`,
      );
    }
    if (rebuild && inv.status === 'UNCERTAIN') {
      throw new BadRequestException(
        'An invoice with an unknown outcome must be resent exactly as it was. Resolve it instead.',
      );
    }
    const payload = rebuild
      ? ((await this.rebuildPayload(inv)) as unknown as Prisma.InputJsonValue)
      : undefined;

    // sentAt is deliberately kept: if the outcome is unknown, the retry reconciles instead of resubmitting
    await this.prisma.$transaction([
      this.prisma.taxInvoice.update({
        where: { id: invoiceId },
        data: {
          ...(payload && { payload }),
          status: inv.status === 'UNCERTAIN' ? 'UNCERTAIN' : 'PENDING',
        },
      }),
      this.prisma.etimsJob.update({
        where: { id: inv.job.id },
        data: {
          status: 'QUEUED',
          attempts: 0,
          nextAttemptAt: new Date(),
          lockedUntil: null,
        },
      }),
      this.prisma.etimsEvent.create({
        data: {
          invoiceId,
          type: rebuild ? 'MANUAL_REBUILD_RETRY' : 'MANUAL_RETRY',
          actorId: actor.id,
          message: `${rebuild ? 'Rebuilt and retried' : 'Retried'} by ${actor.name}`,
          correlationId: inv.job.correlationId,
        },
      }),
    ]);
    return { message: 'Queued for another attempt' };
  }

  // Only invoices that never reached KRA (status FAILED). Rejected and unknown-outcome ones need a human decision.
  async retryFailed(actor: AuthUser) {
    const failed = await this.prisma.taxInvoice.findMany({
      where: { status: 'FAILED' },
      select: { id: true },
      take: 200,
    });
    const ids = failed.map((f) => f.id);
    if (ids.length === 0) return { retried: 0 };
    await this.prisma.$transaction([
      this.prisma.taxInvoice.updateMany({
        where: { id: { in: ids }, status: 'FAILED' },
        data: { status: 'PENDING' },
      }),
      this.prisma.etimsJob.updateMany({
        where: { invoiceId: { in: ids } },
        data: {
          status: 'QUEUED',
          attempts: 0,
          nextAttemptAt: new Date(),
          lockedUntil: null,
        },
      }),
      this.prisma.etimsEvent.createMany({
        data: ids.map((invoiceId) => ({
          invoiceId,
          type: 'MANUAL_RETRY',
          actorId: actor.id,
          message: `Bulk retry by ${actor.name}`,
        })),
      }),
    ]);
    return { retried: ids.length };
  }

  // For an invoice whose outcome is unknown: a person checks KRA's eTIMS portal and tells us what they found
  async resolve(invoiceId: string, dto: ResolveInvoiceDto, actor: AuthUser) {
    const inv = await this.prisma.taxInvoice.findUnique({
      where: { id: invoiceId },
      include: { job: true },
    });
    if (!inv || !inv.job) throw new NotFoundException('Invoice not found');
    if (inv.status !== 'UNCERTAIN')
      throw new BadRequestException(
        'Only an invoice with an unknown outcome can be resolved this way',
      );

    if (dto.action === 'CONFIRM_FILED') {
      if (actor.role !== Role.ADMIN) {
        throw new ForbiddenException(
          "Only an administrator can enter KRA's official data by hand",
        );
      }
      const p = inv.payload as unknown as SalesPayload;
      const data = {
        curRcptNo: dto.scuReceiptNo!,
        totRcptNo: dto.scuTotalReceiptNo!,
        intrlData: dto.internalData!,
        rcptSign: dto.signature!,
        sdcDateTime: dto.sdcDateTime!,
        sdcId: dto.sdcId,
        mrcNo: dto.mrcNo,
      };
      await this.prisma.$transaction([
        this.prisma.taxInvoice.update({
          where: { id: invoiceId },
          data: {
            status: 'ACCEPTED',
            receiptNo: data.curRcptNo,
            totalReceiptNo: data.totRcptNo,
            intrlData: data.intrlData,
            rcptSign: data.rcptSign,
            sdcId: data.sdcId ?? null,
            mrcNo: data.mrcNo ?? null,
            sdcDateTime: data.sdcDateTime,
            qrPayload: this.provider.buildQrPayload({
              tin: p.tin,
              bhfId: p.bhfId,
              data,
            }),
            acceptedAt: new Date(),
            manuallyResolvedAt: new Date(),
            manuallyResolvedById: actor.id,
            lastErrorCode: null,
            lastErrorMessage: null,
          },
        }),
        this.prisma.etimsJob.update({
          where: { id: inv.job.id },
          data: { status: 'DONE', lockedUntil: null, lastError: null },
        }),
        this.prisma.etimsEvent.create({
          data: {
            invoiceId,
            type: 'MANUALLY_CONFIRMED_FILED',
            actorId: actor.id,
            message: dto.note,
            data: { scuReceiptNo: data.curRcptNo },
          },
        }),
      ]);
      return { message: 'Recorded as filed' };
    }

    // KRA does not have it: send again as a fresh submission, with the same invoice number
    await this.prisma.$transaction([
      this.prisma.taxInvoice.update({
        where: { id: invoiceId },
        data: { status: 'PENDING' },
      }),
      this.prisma.etimsJob.update({
        where: { id: inv.job.id },
        data: {
          status: 'QUEUED',
          sentAt: null,
          attempts: 0,
          nextAttemptAt: new Date(),
          lockedUntil: null,
        },
      }),
      this.prisma.etimsEvent.create({
        data: {
          invoiceId,
          type: 'MANUALLY_CONFIRMED_NOT_FILED',
          actorId: actor.id,
          message: dto.note,
        },
      }),
    ]);
    return { message: 'Queued to be sent again' };
  }

  // ---------- VAT classes ----------

  taxTypes() {
    return this.prisma.taxType.findMany({ orderBy: { code: 'asc' } });
  }

  async updateTaxRate(code: TaxTypeCode, rate: number, actor: AuthUser) {
    const before = await this.prisma.taxType.findUnique({ where: { code } });
    if (!before) throw new NotFoundException('Unknown tax class');
    await this.prisma.$transaction(async (tx) => {
      await tx.taxType.update({
        where: { code },
        data: { rate, updatedById: actor.id },
      });
      await tx.product.updateMany({
        where: { taxTyCd: code },
        data: { taxRate: rate },
      }); // keep the legacy copy in step
      await audit(tx, {
        entity: 'TaxType',
        entityId: code,
        action: 'RATE_CHANGED',
        before: { rate: before.rate.toString() },
        after: { rate: String(rate) },
        actorId: actor.id,
      });
    });
    return { code, rate };
  }

  async taxReview(q: TaxReviewQueryDto) {
    const where: Prisma.ProductWhereInput = {
      isActive: true,
      ...(q.all ? {} : { taxConfirmed: false }),
      ...(q.search?.trim() && {
        OR: [
          { name: { contains: q.search.trim(), mode: 'insensitive' } },
          { sku: { contains: q.search.trim(), mode: 'insensitive' } },
        ],
      }),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: (q.page - 1) * q.limit,
        take: q.limit,
        select: {
          id: true,
          sku: true,
          name: true,
          price: true,
          taxTyCd: true,
          taxRate: true,
          taxConfirmed: true,
        },
      }),
      this.prisma.product.count({ where }),
    ]);
    return {
      items,
      meta: {
        total,
        page: q.page,
        limit: q.limit,
        pages: Math.ceil(total / q.limit),
      },
    };
  }

  // "I have reviewed these and the class shown is right"
  async confirmTax(productIds: string[], actor: AuthUser) {
    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds }, taxConfirmed: false },
      select: { id: true, taxTyCd: true },
    });
    if (products.length === 0) return { confirmed: 0 };
    await this.prisma.$transaction(async (tx) => {
      await tx.product.updateMany({
        where: { id: { in: products.map((p) => p.id) } },
        data: { taxConfirmed: true },
      });
      await tx.auditLog.createMany({
        data: products.map((p) => ({
          entity: 'Product',
          entityId: p.id,
          action: 'TAX_CLASS_CONFIRMED',
          after: { taxTyCd: p.taxTyCd },
          actorId: actor.id,
        })),
      });
    });
    return { confirmed: products.length };
  }

  // Called after an accepted invoice is printed. The next print will be labelled COPY.
  async markPrinted(saleId: string, actor: AuthUser) {
    await this.statusForSale(saleId, actor); // enforces "cashiers only touch their own sales"
    const inv = await this.prisma.taxInvoice.findUnique({
      where: { saleId_type: { saleId, type: 'SALE' } },
    });
    const res = await this.prisma.taxInvoice.updateMany({
      where: { saleId, type: 'SALE', status: 'ACCEPTED' },
      data: { officialPrintCount: { increment: 1 } },
    });
    if (!inv || res.count === 0) {
      throw new BadRequestException(
        'Only an accepted tax invoice can be marked as printed',
      );
    }
    await this.prisma.etimsEvent.create({
      data: {
        invoiceId: inv.id,
        type: 'PRINTED',
        actorId: actor.id,
        message: `Printed by ${actor.name}`,
      },
    });
    return { printed: true };
  }
}
