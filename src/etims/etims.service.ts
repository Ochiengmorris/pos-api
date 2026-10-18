import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { PaymentMethod, Prisma, Role, TaxTypeCode } from '@prisma/client';
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

  // ---------- manual retry (managers) ----------

  async retry(invoiceId: string, actor: AuthUser) {
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
    // sentAt is deliberately kept: if the outcome is unknown, the retry reconciles instead of resubmitting
    await this.prisma.$transaction([
      this.prisma.etimsJob.update({
        where: { id: inv.job.id },
        data: {
          status: 'QUEUED',
          nextAttemptAt: new Date(),
          lockedUntil: null,
        },
      }),
      this.prisma.etimsEvent.create({
        data: {
          invoiceId,
          type: 'MANUAL_RETRY',
          actorId: actor.id,
          message: `Retry requested by ${actor.name}`,
          correlationId: inv.job.correlationId,
        },
      }),
    ]);
    return { message: 'Queued for another attempt' };
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
