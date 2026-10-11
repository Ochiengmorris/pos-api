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

const D = (v: Prisma.Decimal | string | number) => new Prisma.Decimal(v);
const round2 = (d: Prisma.Decimal) =>
  d.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

const saleInclude = {
  items: true,
  payments: true,
  cashier: { select: { id: true, name: true } },
  customer: { select: { id: true, name: true, phone: true } },
} satisfies Prisma.SaleInclude;

@Injectable()
export class SalesService {
  private readonly prefix: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly config: ConfigService,
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

  // Adds the prefixed number, and hides cost from cashiers
  private present<
    S extends { receiptNumber: number; items: { unitCost?: unknown }[] },
  >(sale: S, actor: AuthUser) {
    const items =
      actor.role === Role.CASHIER
        ? sale.items.map(({ unitCost, ...rest }) => rest)
        : sale.items;
    return {
      ...sale,
      items,
      receiptNo: this.formatReceipt(sale.receiptNumber),
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

    // 2. Price the lines. Shelf prices are VAT-inclusive: extract tax from them.
    let total = D(0);
    let taxTotal = D(0);
    const lines = ids.map((id) => {
      const p = byId.get(id)!;
      const quantity = qtyById.get(id)!;
      const lineTotal = round2(p.price.mul(quantity));
      const taxAmount = round2(
        lineTotal.mul(p.taxRate).div(D(100).add(p.taxRate)),
      );
      total = total.add(lineTotal);
      taxTotal = taxTotal.add(taxAmount);
      return {
        productId: id,
        productName: p.name, // snapshots: later edits never rewrite history
        quantity,
        unitPrice: p.price,
        unitCost: p.costPrice,
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
          reference: rec.receipt ?? rec.checkoutRequestId,
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
    const sale = await this.findOne(id, actor);
    return {
      store: {
        name: this.config.get('STORE_NAME', 'My Shop'),
        address: this.config.get('STORE_ADDRESS', ''),
        phone: this.config.get('STORE_PHONE', ''),
        taxPin: this.config.get('STORE_TAX_PIN', ''),
      },
      receiptNo: sale.receiptNo,
      date: sale.createdAt,
      status: sale.status,
      cashier: sale.cashier.name,
      customer: sale.customer?.name ?? null,
      items: sale.items.map((i) => ({
        name: i.productName,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        lineTotal: i.lineTotal,
      })),
      subtotal: sale.subtotal, // excluding VAT
      taxTotal: sale.taxTotal, // VAT included in the total
      total: sale.total,
      payments: sale.payments.map((p) => ({
        method: p.method,
        amount: p.amount,
        reference: p.reference,
        tendered: p.tendered,
      })),
      changeDue: sale.payments.reduce((s, p) => s.add(p.change ?? 0), D(0)),
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
