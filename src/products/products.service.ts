import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Role, StockMovementType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/decorators/current-user.decorator';
import { CreateProductDto } from './dto/create-product.dto';
import { ListProductsDto } from './dto/list-products.dto';
import { UpdateProductDto } from './dto/update-product.dto';

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  // Cashiers don't see cost price
  private shape<T extends { costPrice?: unknown }>(
    product: T,
    actor: AuthUser,
  ) {
    if (actor.role === Role.CASHIER) {
      const { costPrice, ...rest } = product;
      return rest;
    }
    return product;
  }

  private async assertUnique(
    sku?: string,
    barcode?: string,
    excludeId?: string,
  ) {
    const or: Prisma.ProductWhereInput[] = [];
    if (sku) or.push({ sku });
    if (barcode) or.push({ barcode });
    if (!or.length) return;

    const clash = await this.prisma.product.findFirst({
      where: { OR: or, ...(excludeId && { NOT: { id: excludeId } }) },
      select: { sku: true, barcode: true },
    });
    if (clash) {
      const field = clash.sku === sku ? 'SKU' : 'Barcode';
      throw new ConflictException(`${field} already in use`);
    }
  }

  private async assertCategory(categoryId?: string) {
    if (!categoryId) return;
    const found = await this.prisma.category.findUnique({
      where: { id: categoryId },
    });
    if (!found) throw new NotFoundException('Category not found');
  }

  async create(dto: CreateProductDto, actor: AuthUser) {
    const sku = dto.sku.trim();
    const barcode = dto.barcode?.trim() || undefined;
    await this.assertUnique(sku, barcode);
    await this.assertCategory(dto.categoryId);

    const { initialStock = 0, ...rest } = dto;

    return this.prisma.$transaction(async (tx) => {
      const product = await tx.product.create({
        data: {
          ...rest,
          sku,
          barcode,
          name: dto.name.trim(),
          stockQty: initialStock,
        },
        include: { category: true },
      });

      if (initialStock > 0) {
        await tx.stockMovement.create({
          data: {
            productId: product.id,
            type: StockMovementType.PURCHASE,
            quantity: initialStock,
            reason: 'Opening stock',
            userId: actor.id,
          },
        });
      }
      return product;
    });
  }

  async findAll(query: ListProductsDto, actor: AuthUser) {
    const where: Prisma.ProductWhereInput = {
      ...(!query.includeInactive && { isActive: true }),
      ...(query.categoryId && { categoryId: query.categoryId }),
      ...(query.search && {
        OR: [
          { name: { contains: query.search, mode: 'insensitive' } },
          { sku: { contains: query.search, mode: 'insensitive' } },
          { barcode: { contains: query.search } },
        ],
      }),
    };

    // Low stock needs a column-to-column comparison, which Prisma's
    // where input can't express, so we filter by raw ids.
    if (query.lowStock) {
      const ids = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Product"
        WHERE "isActive" = true AND "stockQty" <= "reorderLevel"`;
      where.id = { in: ids.map((r) => r.id) };
    }

    const [items, total] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where,
        include: { category: true },
        orderBy: { name: 'asc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.product.count({ where }),
    ]);

    return {
      items: items.map((p) => this.shape(p, actor)),
      meta: {
        total,
        page: query.page,
        limit: query.limit,
        pages: Math.ceil(total / query.limit),
      },
    };
  }

  async findOne(id: string, actor: AuthUser) {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: { category: true },
    });
    if (!product) throw new NotFoundException('Product not found');
    return this.shape(product, actor);
  }

  // Scanner endpoint: exact match on barcode, falling back to SKU
  async findByCode(code: string, actor: AuthUser) {
    const product = await this.prisma.product.findFirst({
      where: {
        isActive: true,
        OR: [{ barcode: code }, { sku: code }],
      },
      include: { category: true },
    });
    if (!product) throw new NotFoundException('No product matches that code');
    return this.shape(product, actor);
  }

  async update(id: string, dto: UpdateProductDto) {
    const existing = await this.prisma.product.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Product not found');

    const sku = dto.sku?.trim();
    const barcode = dto.barcode?.trim();
    await this.assertUnique(sku, barcode, id);
    await this.assertCategory(dto.categoryId);

    return this.prisma.product.update({
      where: { id },
      data: {
        ...dto,
        ...(sku && { sku }),
        ...(barcode && { barcode }),
        ...(dto.name && { name: dto.name.trim() }),
      },
      include: { category: true },
    });
  }
}
