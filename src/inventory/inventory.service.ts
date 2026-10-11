import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, StockMovementType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AdjustDto } from './dto/adjust.dto';
import { CountDto } from './dto/count.dto';
import { ListMovementsDto } from './dto/list-movements.dto';
import { RestockDto } from './dto/restock.dto';

type Tx = Prisma.TransactionClient;

type ChangeParams = {
  productId: string;
  delta: number; // signed
  type: StockMovementType;
  reason?: string;
  userId?: string;
  saleId?: string;
};

@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The single place stock changes. Call inside a transaction.
   * Step 6 (sales) reuses this.
   *
   * For decreases, the WHERE clause includes stockQty >= amount, so the
   * database itself refuses to go negative even under concurrent requests.
   */
  async applyChange(tx: Tx, p: ChangeParams) {
    if (p.delta === 0) throw new BadRequestException('Quantity cannot be zero');

    const result = await tx.product.updateMany({
      where: {
        id: p.productId,
        ...(p.delta < 0 && { stockQty: { gte: -p.delta } }),
      },
      data: { stockQty: { increment: p.delta } },
    });

    if (result.count === 0) {
      const product = await tx.product.findUnique({
        where: { id: p.productId },
        select: { name: true, stockQty: true },
      });
      if (!product) throw new NotFoundException('Product not found');
      throw new BadRequestException(
        `Insufficient stock for ${product.name}: ${product.stockQty} available`,
      );
    }

    return tx.stockMovement.create({
      data: {
        productId: p.productId,
        type: p.type,
        quantity: p.delta,
        reason: p.reason,
        userId: p.userId,
        saleId: p.saleId,
      },
    });
  }

  private async withProduct(productId: string) {
    return this.prisma.product.findUniqueOrThrow({
      where: { id: productId },
      select: {
        id: true,
        name: true,
        sku: true,
        stockQty: true,
        reorderLevel: true,
      },
    });
  }

  async restock(dto: RestockDto, userId: string) {
    await this.prisma.$transaction((tx) =>
      this.applyChange(tx, {
        productId: dto.productId,
        delta: dto.quantity,
        type: StockMovementType.PURCHASE,
        reason: dto.reason ?? 'Restock',
        userId,
      }),
    );
    return this.withProduct(dto.productId);
  }

  async adjust(dto: AdjustDto, userId: string) {
    await this.prisma.$transaction((tx) =>
      this.applyChange(tx, {
        productId: dto.productId,
        delta: dto.quantity,
        type: StockMovementType.ADJUSTMENT,
        reason: dto.reason,
        userId,
      }),
    );
    return this.withProduct(dto.productId);
  }

  // Physical count: set stock to what was counted, recording the difference
  async count(dto: CountDto, userId: string) {
    await this.prisma.$transaction(async (tx) => {
      // Lock the row so the delta is computed against a stable value
      const rows = await tx.$queryRaw<{ stockQty: number }[]>`
        SELECT "stockQty" FROM "Product" WHERE id = ${dto.productId} FOR UPDATE`;
      if (!rows.length) throw new NotFoundException('Product not found');

      const delta = dto.countedQty - rows[0].stockQty;
      if (delta === 0) return; // count matches the system, nothing to record

      await this.applyChange(tx, {
        productId: dto.productId,
        delta,
        type: StockMovementType.ADJUSTMENT,
        reason: dto.reason ?? `Stock count (system had ${rows[0].stockQty})`,
        userId,
      });
    });
    return this.withProduct(dto.productId);
  }

  async movements(query: ListMovementsDto) {
    const where: Prisma.StockMovementWhereInput = {
      ...(query.productId && { productId: query.productId }),
      ...(query.type && { type: query.type }),
      ...((query.from || query.to) && {
        createdAt: {
          ...(query.from && { gte: new Date(query.from) }),
          ...(query.to && { lte: new Date(query.to) }),
        },
      }),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.stockMovement.findMany({
        where,
        include: {
          product: { select: { id: true, name: true, sku: true } },
          user: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.stockMovement.count({ where }),
    ]);

    return {
      items,
      meta: {
        total,
        page: query.page,
        limit: query.limit,
        pages: Math.ceil(total / query.limit),
      },
    };
  }

  // Dashboard numbers. Casts avoid BigInt values, which JSON can't serialize.
  async summary() {
    const [row] = await this.prisma.$queryRaw<
      {
        activeProducts: number;
        totalUnits: number;
        stockValueAtCost: string;
        stockValueAtRetail: string;
        outOfStock: number;
        lowStock: number;
      }[]
    >`
      SELECT
        COUNT(*)::int AS "activeProducts",
        COALESCE(SUM("stockQty"), 0)::int AS "totalUnits",
        COALESCE(SUM("stockQty" * "costPrice"), 0)::text AS "stockValueAtCost",
        COALESCE(SUM("stockQty" * "price"), 0)::text AS "stockValueAtRetail",
        COUNT(*) FILTER (WHERE "stockQty" = 0)::int AS "outOfStock",
        COUNT(*) FILTER (WHERE "stockQty" > 0 AND "stockQty" <= "reorderLevel")::int AS "lowStock"
      FROM "Product"
      WHERE "isActive" = true`;
    return row;
  }
}
