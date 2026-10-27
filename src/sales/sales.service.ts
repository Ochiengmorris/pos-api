import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PaymentMethod,
  PaymentStatus,
  Prisma,
  Role,
  SaleStatus,
  StockMovementType,
  MpesaStatus,
} from '@prisma/client';
import { AuthUser } from '../auth/decorators/current-user.decorator';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSaleDto } from './dto/create-sale.dto';
import { ListSalesDto } from './dto/list-sales.dto';
import { VoidSaleDto } from './dto/void-sale.dto';
import { priceLine } from './pricing';
import { SettingsService } from '../settings/settings.service';
import { displayStatus, EtimsService } from '../etims/etims.service';

const D = (v: Prisma.Decimal | string | number) => new Prisma.Decimal(v);

const saleInclude = {
  items: true,
  payments: true,
  cashier: { select: { id: true, name: true } },
  customer: { select: { id: true, name: true, phone: true } },
  taxInvoices: { select: { type: true, status: true, environment: true } },
} satisfies Prisma.SaleInclude;

@Injectable()
export class SalesService {
  private readonly prefix: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly config: ConfigService,
    private readonly settings: SettingsService,
    private readonly etims: EtimsService,
  ) {
    this.prefix = this.config.get<string>('RECEIPT_PREFIX', 'RCP');
  }

  // ---------- receipt number helpers ----------

  private formatReceipt(n: number) {
    return `${this.prefix}-${String(n).padStart(6, '0')}`;
  }

  // Accepts "RCP-000123", "000123" or "123"
  private parseReceipt(input: string): number | undefined {
    const m = input.trim().match(/^(?:[A-Za-z]+-)?0*(\d{1,9})$/);
    return m ? Number(m[1]) : undefined;
  }

  // Adds the prefixed receipt number and the eTIMS status, and hides cost from cashiers
  private present<
    S extends {
      receiptNumber: number;
      items: { unitCost?: unknown }[];
      taxInvoices?: { type: string; status: string; environment: string }[];
    },
  >(sale: S, actor: AuthUser) {
    const items =
      actor.role === Role.CASHIER
        ? sale.items.map(({ unitCost, ...rest }) => rest)
        : sale.items;
    const { taxInvoices, ...rest } = sale; // the raw invoice rows stay out of the response
    const invoice = taxInvoices?.find((t) => t.type === 'SALE') ?? null;
    return {
      ...rest,
      items,
      receiptNo: this.formatReceipt(sale.receiptNumber),
      etims: displayStatus(invoice),
    };
  }

  // ---------- checkout ----------

  async create(dto: CreateSaleDto, actor: AuthUser) {
    const replay = await this.findReplay(dto.clientRequestId, actor);
    if (replay) return this.present(replay, actor);

    try {
      const sale = await this.prisma.$transaction(
        (tx) => this.createInTx(tx, dto, actor),
        { timeout: 15000 },
      );
      return this.present(sale, actor);
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        const target = String(e.meta?.target ?? '');
        if (target.includes('clientRequestId')) {
          // Two identical requests raced: return the winner
          const winner = await this.findReplay(dto.clientRequestId, actor);
          if (winner) return this.present(winner, actor);
        }
        if (target.includes('reference')) {
          throw new ConflictException(
            'That payment reference has already been used',
          );
        }
      }
      throw e;
    }
  }

  private async findReplay(
    clientRequestId: string | undefined,
    actor: AuthUser,
  ) {
    if (!clientRequestId) return null;
    const existing = await this.prisma.sale.findUnique({
      where: { clientRequestId },
      include: saleInclude,
    });
    if (existing && existing.cashierId !== actor.id) {
      throw new ConflictException('Request id already used');
    }
    return existing;
  }

  private async createInTx(
    tx: Prisma.TransactionClient,
    dto: CreateSaleDto,
    actor: AuthUser,
  ) {
    // 1. Merge duplicate lines; sort ids so concurrent sales lock rows in the same order
    const qtyById = new Map<string, number>();
    for (const i of dto.items) {
      qtyById.set(i.productId, (qtyById.get(i.productId) ?? 0) + i.quantity);
    }
    const ids = [...qtyById.keys()].sort();

    const products = await tx.product.findMany({
      where: { id: { in: ids }, isActive: true },
    });
    if (products.length !== ids.length) {
      const found = new Set(products.map((p) => p.id));
      const missing = ids.filter((id) => !found.has(id));
      throw new BadRequestException(
        `Unknown or inactive product: ${missing.join(', ')}`,
      );
    }
    const byId = new Map(products.map((p) => [p.id, p]));

    if (dto.customerId) {
      const customer = await tx.customer.findUnique({
        where: { id: dto.customerId },
      });
      if (!customer) throw new NotFoundException('Customer not found');
    }

    const rates = await this.etims.taxRates(tx); // Map<TaxTypeCode, Decimal>

    // 2. Price the lines. Shelf prices are VAT-inclusive: extract tax from them.
    let total = D(0);
    let taxTotal = D(0);
    const lines = ids.map((id) => {
      const p = byId.get(id)!;
      const quantity = qtyById.get(id)!;
      const rate = rates.get(p.taxTyCd) ?? D(0);
      const { lineTotal, taxAmount } = priceLine(p.price, rate, quantity);
      total = total.add(lineTotal);
      taxTotal = taxTotal.add(taxAmount);
      return {
        productId: id,
        productName: p.name,
        quantity,
        unitPrice: p.price,
        unitCost: p.costPrice,
        taxRate: rate,
        taxTyCd: p.taxTyCd, // new: snapshot of the class at the time of sale
        taxAmount,
        lineTotal,
      };
    });
    const subtotal = total.sub(taxTotal); // net of VAT

    // 3. Validate payments against the total
    const mpesaIds = dto.payments
      .map((p) => p.mpesaPaymentId)
      .filter((x): x is string => !!x);
    const mpesaRecords = new Map(
      (await tx.mpesaPayment.findMany({ where: { id: { in: mpesaIds } } })).map(
        (r) => [r.id, r],
      ),
    );
    const allowManual =
      this.config.get('MPESA_ALLOW_MANUAL_REFERENCE', 'false') === 'true';

    const payments = dto.payments.map((p) => {
      const amount = D(p.amount);

      if (p.method === PaymentMethod.CASH) {
        const tendered = p.tendered != null ? D(p.tendered) : amount;
        if (tendered.lt(amount)) {
          throw new BadRequestException(
            'Cash tendered is less than the cash amount',
          );
        }
        return {
          method: p.method,
          status: PaymentStatus.SUCCESS,
          amount,
          tendered,
          change: tendered.sub(amount),
          reference: null,
        };
      }

      if (p.method === PaymentMethod.MPESA && p.mpesaPaymentId) {
        const rec = mpesaRecords.get(p.mpesaPaymentId);
        if (!rec) throw new NotFoundException('M-Pesa payment not found');
        if (rec.status !== MpesaStatus.SUCCESS) {
          throw new BadRequestException(
            `M-Pesa payment is ${rec.status.toLowerCase()}, not confirmed`,
          );
        }
        if (rec.saleId)
          throw new ConflictException('M-Pesa payment already used on a sale');
        if (rec.resolution)
          throw new ConflictException(
            'That M-Pesa payment was already resolved by a manager',
          );
        if (!rec.amount.eq(amount)) {
          throw new BadRequestException(
            `M-Pesa payment was for KSh ${rec.amount.toFixed(0)}, not ${amount.toFixed(2)}`,
          );
        }
        if (actor.role === Role.CASHIER && rec.cashierId !== actor.id) {
          throw new BadRequestException(
            'That M-Pesa payment was requested by another cashier',
          );
        }
        return {
          method: p.method,
          status: PaymentStatus.SUCCESS,
          amount,
          reference: rec.receipt,
        };
      }

      if (p.method === PaymentMethod.MPESA && !allowManual) {
        throw new BadRequestException(
          'M-Pesa payments must come from an STK request (mpesaPaymentId)',
        );
      }

      // Manual reference: CARD, or MPESA when MPESA_ALLOW_MANUAL_REFERENCE=true
      if (!p.reference?.trim()) {
        throw new BadRequestException(`${p.method} payments need a reference`);
      }
      if (p.tendered != null) {
        throw new BadRequestException('"tendered" only applies to cash');
      }
      return {
        method: p.method,
        status: PaymentStatus.SUCCESS,
        amount,
        reference: p.reference.trim().toUpperCase(),
      };
    });

    const paid = payments.reduce((s, p) => s.add(p.amount), D(0));
    if (!paid.eq(total)) {
      throw new BadRequestException(
        `Payments (${paid.toFixed(2)}) must add up to the sale total (${total.toFixed(2)})`,
      );
    }

    // 4. Create the sale. Receipt number comes from the DB sequence.
    const sale = await tx.sale.create({
      data: {
        cashierId: actor.id,
        customerId: dto.customerId,
        clientRequestId: dto.clientRequestId,
        subtotal,
        taxTotal,
        total,
        items: { create: lines },
        payments: { create: payments },
      },
    });

    // 4b. Claim each STK payment. Fails if another request got there first.
    for (const p of dto.payments) {
      if (!p.mpesaPaymentId) continue;
      const claimed = await tx.mpesaPayment.updateMany({
        where: {
          id: p.mpesaPaymentId,
          saleId: null,
          resolution: null,
          status: MpesaStatus.SUCCESS,
        },
        data: { saleId: sale.id },
      });
      if (claimed.count !== 1) {
        throw new ConflictException('M-Pesa payment already used on a sale');
      }
    }

    // 5. Deduct stock. Throws (and rolls everything back) if any line is short.
    for (const line of lines) {
      await this.inventory.applyChange(tx, {
        productId: line.productId,
        delta: -line.quantity,
        type: StockMovementType.SALE,
        reason: 'Sale',
        userId: actor.id,
        saleId: sale.id,
      });
    }

    await this.etims.enqueueSaleInvoice(tx, {
      saleId: sale.id,
      internalNo: this.formatReceipt(sale.receiptNumber),
      createdAt: sale.createdAt,
      cashier: { id: actor.id, name: actor.name },
      methods: dto.payments.map((p) => p.method),
      customerPin: dto.customerPin,
      customerName: dto.customerName,
      lines: lines.map((l) => ({
        productId: l.productId,
        name: l.productName,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        lineTotal: l.lineTotal,
        taxAmount: l.taxAmount,
        taxTyCd: l.taxTyCd,
      })),
      products: new Map(products.map((p) => [p.id, p])),
      rates,
    });

    return tx.sale.findUniqueOrThrow({
      where: { id: sale.id },
      include: saleInclude,
    });
  }

  // ---------- reads ----------

  async findAll(q: ListSalesDto, actor: AuthUser) {
    const receiptNumber = q.receipt
      ? (this.parseReceipt(q.receipt) ?? -1)
      : undefined;

    const where: Prisma.SaleWhereInput = {
      ...(actor.role === Role.CASHIER
        ? { cashierId: actor.id }
        : q.cashierId && { cashierId: q.cashierId }),
      ...(q.status && { status: q.status }),
      ...(receiptNumber !== undefined && { receiptNumber }),
      ...((q.from || q.to) && {
        createdAt: {
          ...(q.from && { gte: new Date(q.from) }),
          ...(q.to && { lte: new Date(q.to) }),
        },
      }),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.sale.findMany({
        where,
        include: saleInclude,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
      this.prisma.sale.count({ where }),
    ]);

    return {
      items: items.map((s) => this.present(s, actor)),
      meta: {
        total,
        page: q.page,
        limit: q.limit,
        pages: Math.ceil(total / q.limit),
      },
    };
  }

  async findOne(id: string, actor: AuthUser) {
    const sale = await this.prisma.sale.findUnique({
      where: { id },
      include: saleInclude,
    });
    // Cashiers get a 404 for other people's sales, so nothing leaks
    if (!sale || (actor.role === Role.CASHIER && sale.cashierId !== actor.id)) {
      throw new NotFoundException('Sale not found');
    }
    return this.present(sale, actor);
  }

  async receipt(id: string, actor: AuthUser) {
    const [sale, store, inv] = await Promise.all([
      this.findOne(id, actor), // also enforces "cashiers only see their own sales"
      this.settings.get(),
      this.prisma.taxInvoice.findUnique({
        where: { saleId_type: { saleId: id, type: 'SALE' } },
      }),
    ]);

    // VAT by tax class, so exempt, zero-rated and non-VAT lines are visible, not hidden inside one total
    const groups = new Map<
      string,
      {
        code: string;
        rate: Prisma.Decimal;
        gross: Prisma.Decimal;
        vat: Prisma.Decimal;
      }
    >();
    for (const i of sale.items) {
      const g = groups.get(i.taxTyCd) ?? {
        code: i.taxTyCd,
        rate: i.taxRate,
        gross: D(0),
        vat: D(0),
      };
      g.gross = g.gross.add(i.lineTotal);
      g.vat = g.vat.add(i.taxAmount);
      groups.set(i.taxTyCd, g);
    }
    const taxBreakdown = [...groups.values()]
      .sort((a, b) => a.code.localeCompare(b.code))
      .map((g) => ({
        code: g.code,
        rate: g.rate.toString(),
        net: g.gross.sub(g.vat).toFixed(2),
        vat: g.vat.toFixed(2),
        gross: g.gross.toFixed(2),
      }));

    // KRA's identifiers are only ever shown once KRA has actually confirmed the invoice
    const confirmed = inv?.status === 'ACCEPTED';
    const etims = inv
      ? {
          status: displayStatus(inv),
          environment: inv.environment,
          tin: (inv.payload as { tin?: string } | null)?.tin ?? null,
          invoiceNo: confirmed ? inv.invcNo : null,
          scuReceiptNo: confirmed ? inv.receiptNo : null,
          scuTotalReceiptNo: confirmed ? inv.totalReceiptNo : null,
          sdcId: confirmed ? inv.sdcId : null,
          mrcNo: confirmed ? inv.mrcNo : null,
          sdcDateTime: confirmed ? inv.sdcDateTime : null,
          internalData: confirmed ? inv.intrlData : null,
          signature: confirmed ? inv.rcptSign : null,
          qrPayload: confirmed ? inv.qrPayload : null,
          acceptedAt: inv.acceptedAt,
          copy: inv.officialPrintCount, // earlier official prints; above 0 means this print is a COPY
        }
      : null;

    return {
      saleId: sale.id,
      store: {
        name: store.name,
        address: store.address,
        phone: store.phone,
        taxPin: store.taxPin,
        footer: store.receiptFooter,
      },
      receiptNo: sale.receiptNo,
      date: sale.createdAt,
      status: sale.status,
      cashier: sale.cashier.name,
      customer: sale.customer?.name ?? inv?.customerName ?? null,
      customerPin: inv?.customerPin ?? null,
      items: sale.items.map((i) => ({
        name: i.productName,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        lineTotal: i.lineTotal,
        taxTyCd: i.taxTyCd,
      })),
      taxBreakdown,
      subtotal: sale.subtotal, // net of VAT
      taxTotal: sale.taxTotal,
      total: sale.total,
      payments: sale.payments.map((p) => ({
        method: p.method,
        amount: p.amount,
        reference: p.reference,
        tendered: p.tendered,
      })),
      changeDue: sale.payments.reduce((s, p) => s.add(p.change ?? 0), D(0)),
      etims,
    };
  }
  // ---------- void ----------

  async voidSale(id: string, dto: VoidSaleDto, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      // Atomic claim: only one request can flip COMPLETED -> VOIDED
      const claimed = await tx.sale.updateMany({
        where: { id, status: SaleStatus.COMPLETED },
        data: {
          status: SaleStatus.VOIDED,
          voidedAt: new Date(),
          voidReason: dto.reason.trim(),
          voidedById: actor.id,
        },
      });

      if (claimed.count === 0) {
        const sale = await tx.sale.findUnique({
          where: { id },
          select: { status: true },
        });
        if (!sale) throw new NotFoundException('Sale not found');
        throw new BadRequestException(
          `Sale is already ${sale.status.toLowerCase()}`,
        );
      }

      await this.etims.onSaleVoided(tx, id, actor);

      const items = await tx.saleItem.findMany({
        where: { saleId: id },
        orderBy: { productId: 'asc' },
      });
      for (const item of items) {
        await this.inventory.applyChange(tx, {
          productId: item.productId,
          delta: item.quantity,
          type: StockMovementType.RETURN,
          reason: `Void: ${dto.reason.trim()}`,
          userId: actor.id,
          saleId: id,
        });
      }
    });

    return this.findOne(id, actor);
  }
}
