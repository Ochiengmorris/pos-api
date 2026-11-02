import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, Role, StockMovementType } from '@prisma/client';
import { audit } from '../audit/audit';
import { AuthUser } from '../auth/decorators/current-user.decorator';
import { csvText } from '../common/csv';
import { PrismaService } from '../prisma/prisma.service';
import {
  ApplyCountDto,
  CreateCountDto,
  LinesQueryDto,
  SaveEntriesDto,
} from './dto/stock-count.dto';

const ADJUSTMENT = (StockMovementType as Record<string, StockMovementType>)
  .ADJUSTMENT; // change here if your enum names it differently

@Injectable()
export class StockCountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private get approvalValue(): number {
    const raw = Number(process.env.STOCK_COUNT_APPROVAL_VALUE);
    return Number.isFinite(raw) && raw >= 0 ? raw : 5000; // keep your existing default
  }

  private async get(id: string) {
    const c = await this.prisma.stockCount.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('Count not found');
    return c;
  }

  private async open(id: string) {
    const c = await this.get(id);
    if (c.status !== 'OPEN')
      throw new BadRequestException(
        `This count is ${c.status.toLowerCase()} and can no longer be changed`,
      );
    return c;
  }

  async create(dto: CreateCountDto, actor: AuthUser) {
    const open = await this.prisma.stockCount.findFirst({
      where: { status: 'OPEN' },
    });
    if (open)
      throw new ConflictException(
        `Count #${open.number} is still open. Apply or cancel it first.`,
      );
    let scopeName = 'Whole shop';
    if (dto.categoryId) {
      const cat = await this.prisma.category.findUnique({
        where: { id: dto.categoryId },
      });
      if (!cat) throw new NotFoundException('Category not found');
      scopeName = cat.name;
    }
    return this.prisma.stockCount.create({
      data: {
        name: dto.name?.trim() || scopeName,
        categoryId: dto.categoryId ?? null,
        note: dto.note?.trim() || null,
        createdById: actor.id,
      },
    });
  }

  async list() {
    const [counts, cats] = await Promise.all([
      this.prisma.stockCount.findMany({
        orderBy: { createdAt: 'desc' },
        take: 50,
        include: { _count: { select: { lines: true } } },
      }),
      this.prisma.category.findMany({ select: { id: true, name: true } }),
    ]);
    const names = new Map(cats.map((c) => [c.id, c.name]));
    return counts.map((c) => ({
      id: c.id,
      number: c.number,
      name: c.name,
      status: c.status,
      categoryName: c.categoryId ? (names.get(c.categoryId) ?? null) : null,
      createdAt: c.createdAt,
      appliedAt: c.appliedAt,
      lines: c._count.lines,
    }));
  }

  async detail(id: string) {
    const count = await this.get(id);
    const [lines, scope, cat] = await Promise.all([
      this.prisma.stockCountLine.findMany({
        where: { countId: id },
        select: {
          countedQty: true,
          systemQty: true,
          product: { select: { costPrice: true } },
        },
      }),
      this.prisma.product.count({
        where: {
          isActive: true,
          ...(count.categoryId && { categoryId: count.categoryId }),
        },
      }),
      count.categoryId
        ? this.prisma.category.findUnique({
            where: { id: count.categoryId },
            select: { name: true },
          })
        : null,
    ]);

    let matched = 0,
      shortLines = 0,
      overLines = 0,
      shortUnits = 0,
      overUnits = 0;
    let shortValue = new Prisma.Decimal(0);
    let overValue = new Prisma.Decimal(0);
    for (const l of lines) {
      const d = l.countedQty - l.systemQty;
      if (d === 0) matched++;
      else if (d < 0) {
        shortLines++;
        shortUnits += -d;
        shortValue = shortValue.add(l.product.costPrice.mul(-d));
      } else {
        overLines++;
        overUnits += d;
        overValue = overValue.add(l.product.costPrice.mul(d));
      }
    }
    return {
      id: count.id,
      number: count.number,
      name: count.name,
      status: count.status,
      categoryId: count.categoryId,
      categoryName: cat?.name ?? null,
      note: count.note,
      createdAt: count.createdAt,
      appliedAt: count.appliedAt,
      totals: {
        products: scope,
        counted: lines.length,
        uncounted: Math.max(0, scope - lines.length),
        matched,
        shortLines,
        overLines,
        shortUnits,
        overUnits,
        netUnits: overUnits - shortUnits,
        shortValue: shortValue.toFixed(2),
        overValue: overValue.toFixed(2),
        netValue: overValue.sub(shortValue).toFixed(2),
      },
      needsApproval: shortValue.add(overValue).gt(this.approvalValue),
      approvalValue: this.approvalValue,
    };
  }

  // The scan box: an exact barcode wins, then SKU or name
  async find(id: string, raw: string) {
    const count = await this.open(id);
    const s = raw.trim();
    const scope: Prisma.ProductWhereInput = {
      isActive: true,
      ...(count.categoryId && { categoryId: count.categoryId }),
    };
    const sel = { id: true, sku: true, barcode: true, name: true } as const;

    let items = await this.prisma.product.findMany({
      where: { ...scope, barcode: s },
      select: sel,
      take: 1,
    });
    let exact = items.length === 1;
    if (!exact) {
      items = await this.prisma.product.findMany({
        where: {
          ...scope,
          OR: [
            { sku: { equals: s, mode: 'insensitive' } },
            { name: { contains: s, mode: 'insensitive' } },
          ],
        },
        select: sel,
        orderBy: { name: 'asc' },
        take: 10,
      });
      exact =
        items.length === 1 && items[0].sku.toLowerCase() === s.toLowerCase();
    }
    let outOfScope = false;
    if (items.length === 0 && count.categoryId) {
      outOfScope =
        (await this.prisma.product.count({
          where: {
            isActive: true,
            OR: [{ barcode: s }, { sku: { equals: s, mode: 'insensitive' } }],
          },
        })) > 0;
    }
    const counted = new Map(
      (
        await this.prisma.stockCountLine.findMany({
          where: { countId: id, productId: { in: items.map((i) => i.id) } },
          select: { productId: true, countedQty: true },
        })
      ).map((l) => [l.productId, l.countedQty]),
    );
    return {
      items: items.map((i) => ({ ...i, counted: counted.get(i.id) ?? null })),
      exact,
      outOfScope,
    };
  }

  async saveEntries(id: string, dto: SaveEntriesDto, actor: AuthUser) {
    const count = await this.open(id);
    const latest = new Map(dto.entries.map((e) => [e.productId, e.countedQty])); // if a product repeats, the last one wins
    const products = await this.prisma.product.findMany({
      where: { id: { in: [...latest.keys()] }, isActive: true },
      select: { id: true, name: true, stockQty: true, categoryId: true },
    });
    const byId = new Map(products.map((p) => [p.id, p]));
    for (const productId of latest.keys()) {
      const p = byId.get(productId);
      if (!p)
        throw new BadRequestException(
          'One of the products is unknown or inactive',
        );
      if (count.categoryId && p.categoryId !== count.categoryId)
        throw new BadRequestException(
          `${p.name} is not in this count's category`,
        );
    }
    await this.prisma.$transaction(
      [...latest].map(([productId, countedQty]) =>
        this.prisma.stockCountLine.upsert({
          where: { countId_productId: { countId: id, productId } },
          create: {
            countId: id,
            productId,
            countedQty,
            systemQty: byId.get(productId)!.stockQty,
            countedById: actor.id,
          },
          // a recount takes a fresh snapshot of what the system shows now
          update: {
            countedQty,
            systemQty: byId.get(productId)!.stockQty,
            countedAt: new Date(),
            countedById: actor.id,
          },
        }),
      ),
    );
    return { saved: latest.size };
  }

  async removeEntry(id: string, productId: string) {
    await this.open(id);
    await this.prisma.stockCountLine.deleteMany({
      where: { countId: id, productId },
    });
    return { removed: true };
  }

  async lines(id: string, q: LinesQueryDto) {
    const count = await this.get(id);
    const s = q.search?.trim();
    const productSearch: Prisma.ProductWhereInput | undefined = s
      ? {
          OR: [
            { name: { contains: s, mode: 'insensitive' } },
            { sku: { contains: s, mode: 'insensitive' } },
            { barcode: { contains: s } },
          ],
        }
      : undefined;
    const skip = (q.page - 1) * q.limit;
    const meta = (total: number) => ({
      total,
      page: q.page,
      limit: q.limit,
      pages: Math.ceil(total / q.limit),
    });

    if (q.filter === 'uncounted') {
      const where: Prisma.ProductWhereInput = {
        isActive: true,
        ...(count.categoryId && { categoryId: count.categoryId }),
        countLines: { none: { countId: id } },
        ...productSearch,
      };
      const [rows, total] = await this.prisma.$transaction([
        this.prisma.product.findMany({
          where,
          orderBy: { name: 'asc' },
          skip,
          take: q.limit,
          select: {
            id: true,
            sku: true,
            barcode: true,
            name: true,
            stockQty: true,
          },
        }),
        this.prisma.product.count({ where }),
      ]);
      return {
        items: rows.map((p) => ({
          productId: p.id,
          sku: p.sku,
          barcode: p.barcode,
          name: p.name,
          systemQty: p.stockQty,
          countedQty: null,
          difference: null,
          valueDiff: null,
          countedAt: null,
        })),
        meta: meta(total),
      };
    }

    const where: Prisma.StockCountLineWhereInput = {
      countId: id,
      ...(q.filter === 'differences' && {
        OR: [
          {
            countedQty: {
              lt: this.prisma.stockCountLine.fields.systemQty,
            },
          },
          {
            countedQty: {
              gt: this.prisma.stockCountLine.fields.systemQty,
            },
          },
        ],
      }),
      ...(productSearch && { product: productSearch }),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.stockCountLine.findMany({
        where,
        orderBy: { countedAt: 'desc' },
        skip,
        take: q.limit,
        include: {
          product: {
            select: { sku: true, barcode: true, name: true, costPrice: true },
          },
        },
      }),
      this.prisma.stockCountLine.count({ where }),
    ]);
    return {
      items: rows.map((l) => {
        const d = l.countedQty - l.systemQty;
        return {
          productId: l.productId,
          sku: l.product.sku,
          barcode: l.product.barcode,
          name: l.product.name,
          systemQty: l.systemQty,
          countedQty: l.countedQty,
          difference: d,
          valueDiff: l.product.costPrice.mul(d).toFixed(2),
          countedAt: l.countedAt,
        };
      }),
      meta: meta(total),
    };
  }

  async cancel(id: string, actor: AuthUser) {
    const r = await this.prisma.stockCount.updateMany({
      where: { id, status: 'OPEN' },
      data: {
        status: 'CANCELLED',
        appliedAt: new Date(),
        appliedById: actor.id,
      },
    });
    if (r.count === 0) {
      await this.get(id);
      throw new BadRequestException('Only an open count can be cancelled');
    }
    return { cancelled: true };
  }

  // One transaction: either every adjustment lands, or none does
  async apply(id: string, dto: ApplyCountDto, actor: AuthUser) {
    return this.prisma.$transaction(
      async (tx) => {
        const claimed = await tx.stockCount.updateMany({
          where: { id, status: 'OPEN' },
          data: {
            status: 'APPLIED',
            appliedAt: new Date(),
            appliedById: actor.id,
          },
        });
        if (claimed.count === 0) {
          await this.get(id);
          throw new BadRequestException(
            'This count has already been applied or cancelled',
          );
        }
        const count = await tx.stockCount.findUniqueOrThrow({ where: { id } });
        const lines = await tx.stockCountLine.findMany({
          where: { countId: id },
          include: { product: { select: { name: true, costPrice: true } } },
        });
        if (lines.length === 0)
          throw new BadRequestException('Nothing has been counted yet');

        const changes = lines
          .map((l) => ({ l, delta: l.countedQty - l.systemQty }))
          .filter((c) => c.delta !== 0);
        const absValue = changes.reduce(
          (sum, c) => sum.add(c.l.product.costPrice.mul(Math.abs(c.delta))),
          new Prisma.Decimal(0),
        );
        if (absValue.gt(this.approvalValue) && actor.role !== Role.ADMIN) {
          throw new ForbiddenException(
            `The total difference is KSh ${absValue.toFixed(2)} at cost. An administrator must apply counts above KSh ${this.approvalValue}.`,
          );
        }

        const conflicts: string[] = [];
        for (const { l, delta } of changes) {
          const r =
            delta > 0
              ? await tx.product.updateMany({
                  where: { id: l.productId },
                  data: { stockQty: { increment: delta } },
                })
              : await tx.product.updateMany({
                  where: { id: l.productId, stockQty: { gte: -delta } },
                  data: { stockQty: { decrement: -delta } },
                });
          if (r.count === 0) conflicts.push(l.product.name);
        }
        if (conflicts.length) {
          throw new BadRequestException(
            `Stock changed since these were counted, so the adjustment would go below zero: ${conflicts.slice(0, 10).join(', ')}. Recount them and apply again.`,
          );
        }

        const reason =
          `Stock count #${count.number}${dto.note?.trim() ? `: ${dto.note.trim()}` : ''}`.slice(
            0,
            200,
          );
        if (changes.length) {
          await tx.stockMovement.createMany({
            data: changes.map(({ l, delta }) => ({
              productId: l.productId,
              type: ADJUSTMENT,
              quantity: delta,
              reason,
              userId: actor.id,
            })),
          });
        }
        const netUnits = changes.reduce((n, c) => n + c.delta, 0);
        await audit(tx, {
          entity: 'StockCount',
          entityId: id,
          action: 'STOCK_COUNT_APPLIED',
          after: {
            number: count.number,
            adjusted: changes.length,
            matched: lines.length - changes.length,
            netUnits,
            valueAtCost: absValue.toFixed(2),
          },
          actorId: actor.id,
        });
        return {
          adjusted: changes.length,
          matched: lines.length - changes.length,
          netUnits,
        };
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
  }

  async exportCsv(id: string) {
    await this.get(id);
    const lines = await this.prisma.stockCountLine.findMany({
      where: { countId: id },
      include: {
        product: {
          select: {
            sku: true,
            barcode: true,
            name: true,
            costPrice: true,
            category: { select: { name: true } },
          },
        },
      },
      orderBy: { product: { name: 'asc' } },
    });
    return csvText([
      [
        'sku',
        'barcode',
        'name',
        'category',
        'system_qty',
        'counted_qty',
        'difference',
        'value_at_cost',
      ],
      ...lines.map((l) => {
        const d = l.countedQty - l.systemQty;
        return [
          l.product.sku,
          l.product.barcode,
          l.product.name,
          l.product.category?.name ?? null,
          l.systemQty,
          l.countedQty,
          d,
          l.product.costPrice.mul(d).toFixed(2),
        ];
      }),
    ]);
  }
}
