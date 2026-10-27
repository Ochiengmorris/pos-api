import { BadRequestException, Injectable } from '@nestjs/common';
import {
  Prisma,
  Product,
  StockMovementType,
  TaxTypeCode,
} from '@prisma/client';
import { parse } from 'csv-parse/sync';
import { audit } from '../../audit/audit';
import { AuthUser } from '../../auth/decorators/current-user.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import type { ImportQueryDto } from './import.dto';

type Field =
  | 'sku'
  | 'barcode'
  | 'name'
  | 'category'
  | 'price'
  | 'cost'
  | 'vatClass'
  | 'vatRate'
  | 'reorder'
  | 'stock';

// Column names we recognise (case and punctuation are ignored)
const ALIASES: Record<Field, string[]> = {
  sku: ['sku', 'code', 'item code', 'product code', 'itemcode'],
  barcode: ['barcode', 'bar code', 'ean', 'upc'],
  name: ['name', 'product', 'product name', 'description', 'item', 'item name'],
  category: ['category', 'department', 'group'],
  price: ['price', 'selling price', 'retail price', 'sell price', 'unit price'],
  cost: ['cost', 'cost price', 'buying price', 'purchase price'],
  vatClass: ['vat class', 'tax class', 'vat code', 'tax type'],
  vatRate: ['vat rate', 'tax rate', 'vat %', 'vat percent'],
  reorder: ['reorder level', 'reorder', 'min stock', 'minimum stock'],
  stock: ['stock', 'opening stock', 'quantity', 'qty', 'on hand'],
};

const MAX_ROWS = 20_000;
const REPORT_ROWS = 300;
const norm = (h: string) =>
  h
    .toLowerCase()
    .replace(/[_\-.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const keyOf = (s: string) => s.toUpperCase();

function chunks<T>(a: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

function money(raw: string): Prisma.Decimal | null {
  let s = raw.replace(/ksh|kes|\s/gi, '');
  s = /^\d+,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, ''); // "12,50" is a decimal comma, "1,250" a thousands comma
  return /^\d+(\.\d{1,2})?$/.test(s) ? new Prisma.Decimal(s) : null;
}

const classFromLetter = (raw: string): TaxTypeCode | null => {
  const m = /^([A-Ea-e])(?![A-Za-z])/.exec(raw.trim());
  return m ? (m[1].toUpperCase() as TaxTypeCode) : null;
};

const classFromRate = (raw: string): TaxTypeCode | null => {
  const n = Number(raw.replace('%', '').trim());
  return n === 16 ? 'B' : n === 8 ? 'E' : n === 0 ? 'A' : null;
};

type Parsed = {
  row: number; // the header is row 1, so the first product is row 2
  sku: string;
  barcode?: string;
  name?: string;
  category?: string;
  price?: Prisma.Decimal;
  cost?: Prisma.Decimal;
  vatClass?: TaxTypeCode; // given explicitly in the file: trusted
  vatRate?: TaxTypeCode; // inferred from a rate column: needs review
  reorder?: number;
  stock?: number;
  errors: string[];
  warnings: string[];
};

export type RowResult = {
  row: number;
  sku: string;
  name: string;
  action: 'create' | 'update' | 'skip' | 'error';
  errors: string[];
  warnings: string[];
};

export type ImportReport = {
  dryRun: boolean;
  applied: boolean;
  columns: string[];
  unknownColumns: string[];
  totals: {
    rows: number;
    create: number;
    update: number;
    skip: number;
    error: number;
  };
  newCategories: string[];
  notices: string[];
  rows: RowResult[]; // rows with a problem or a warning, capped
  truncated: boolean;
};

type Plan = {
  results: RowResult[];
  creates: Parsed[];
  updates: { p: Parsed; ex: Product }[];
  newCategories: string[];
  notices: string[];
};

@Injectable()
export class ProductImportService {
  constructor(private readonly prisma: PrismaService) {}

  async run(
    file: { buffer: Buffer; originalname: string },
    q: ImportQueryDto,
    actor: AuthUser,
  ): Promise<ImportReport> {
    const { cols, records, unknown } = this.readTable(file.buffer);
    const parsed = this.parseRows(records, cols);
    const plan = await this.plan(parsed, cols, q);

    const totals = {
      rows: parsed.length,
      create: plan.creates.length,
      update: plan.updates.length,
      skip: plan.results.filter((r) => r.action === 'skip').length,
      error: plan.results.filter((r) => r.action === 'error').length,
    };
    const flagged = plan.results.filter(
      (r) => r.errors.length || r.warnings.length,
    );
    const report: ImportReport = {
      dryRun: q.dryRun,
      applied: false,
      columns: [...cols.keys()],
      unknownColumns: unknown,
      totals,
      newCategories: plan.newCategories,
      notices: plan.notices,
      rows: flagged.slice(0, REPORT_ROWS),
      truncated: flagged.length > REPORT_ROWS,
    };
    if (unknown.length)
      report.notices.unshift(
        `These columns were not recognised and were ignored: ${unknown.join(', ')}.`,
      );
    if (q.dryRun) return report;

    if (totals.error > 0 && !q.skipInvalid) {
      report.notices.unshift(
        'Nothing was imported. Fix the errors, or choose to skip the rows that have errors.',
      );
      return report;
    }
    if (totals.create + totals.update === 0) {
      report.notices.unshift('There was nothing to import.');
      return report;
    }

    const rates = new Map(
      (await this.prisma.taxType.findMany()).map((r) => [r.code, r.rate]),
    );
    if (rates.size === 0)
      throw new BadRequestException(
        'Tax classes are not set up yet. Open the eTIMS screen once, then try again.',
      );
    await this.apply(plan, rates, file.originalname, actor);
    report.applied = true;
    return report;
  }

  // ---------- reading the file ----------

  private readTable(buf: Buffer) {
    const text = buf.toString('utf8');
    const head = text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] ?? '';
    // Excel in some regions saves with semicolons or tabs
    const delimiter = [',', ';', '\t']
      .map((d) => ({ d, n: head.split(d).length }))
      .sort((a, b) => b.n - a.n)[0].d;

    let records: string[][];
    try {
      records = parse(text, {
        delimiter,
        bom: true,
        skip_empty_lines: true,
        relax_column_count: true,
        trim: true,
      });
    } catch (e) {
      throw new BadRequestException(
        `The file could not be read as CSV: ${(e as Error).message}`,
      );
    }
    if (records.length < 2)
      throw new BadRequestException('The file has no product rows.');
    if (records.length - 1 > MAX_ROWS)
      throw new BadRequestException(
        `Too many rows: the limit is ${MAX_ROWS} per file.`,
      );

    const alias = new Map<string, Field>();
    (Object.entries(ALIASES) as [Field, string[]][]).forEach(([f, list]) =>
      list.forEach((a) => alias.set(a, f)),
    );
    const cols = new Map<Field, number>();
    const unknown: string[] = [];
    records[0].forEach((h, i) => {
      const f = alias.get(norm(h));
      if (f && !cols.has(f)) cols.set(f, i);
      else if (h) unknown.push(h);
    });
    if (!cols.has('sku') && !cols.has('barcode')) {
      throw new BadRequestException(
        'The file needs a "sku" or a "barcode" column to identify each product.',
      );
    }
    return { cols, records: records.slice(1), unknown };
  }

  private parseRows(records: string[][], cols: Map<Field, number>): Parsed[] {
    return records.map((r, i) => {
      const p: Parsed = { row: i + 2, sku: '', errors: [], warnings: [] };
      const get = (f: Field) => {
        const idx = cols.get(f);
        const v = idx === undefined ? '' : (r[idx] ?? '').trim();
        return v === '' ? undefined : v;
      };

      const barcode = get('barcode');
      if (barcode) {
        if (/e\+\d+/i.test(barcode))
          p.errors.push(
            'This barcode looks like Excel turned it into scientific notation. Format the column as Text, then save the file again.',
          );
        else if (!/^[A-Za-z0-9-]{3,20}$/.test(barcode))
          p.errors.push('Barcode must be 3 to 20 letters, digits or dashes');
        else p.barcode = barcode;
      }

      const sku = get('sku') ?? barcode;
      if (!sku) p.errors.push('Needs a SKU or a barcode');
      else if (sku.length > 50)
        p.errors.push('SKU is longer than 50 characters');
      else p.sku = sku;

      const name = get('name');
      if (name) {
        if (name.length < 2 || name.length > 200)
          p.errors.push('Name must be 2 to 200 characters');
        else p.name = name;
      }
      p.category = get('category')?.slice(0, 80);

      const price = get('price');
      if (price) {
        const d = money(price);
        if (!d) p.errors.push('Price must look like 70 or 70.50');
        else p.price = d;
      }
      const cost = get('cost');
      if (cost) {
        const d = money(cost);
        if (!d) p.errors.push('Cost must look like 50 or 50.25');
        else p.cost = d;
      }

      const vc = get('vatClass');
      if (vc) {
        const c = classFromLetter(vc);
        if (!c) p.errors.push('VAT class must be A, B, C, D or E');
        else p.vatClass = c;
      }
      const vr = get('vatRate');
      if (vr) {
        const c = classFromRate(vr);
        if (!c)
          p.errors.push(
            'VAT rate must be 0, 8 or 16. Use vat_class for anything else.',
          );
        else p.vatRate = c;
      }

      const reorder = get('reorder');
      if (reorder) {
        if (!/^\d{1,6}$/.test(reorder))
          p.errors.push('Reorder level must be a whole number');
        else p.reorder = Number(reorder);
      }
      const stock = get('stock');
      if (stock) {
        if (!/^\d{1,7}$/.test(stock))
          p.errors.push('Stock must be a whole number (0 or more)');
        else p.stock = Number(stock);
      }
      return p;
    });
  }

  // ---------- deciding what would happen ----------

  private async plan(
    parsed: Parsed[],
    cols: Map<Field, number>,
    q: ImportQueryDto,
  ): Promise<Plan> {
    // 1. duplicates inside the file: the first row wins
    const seenSku = new Map<string, number>();
    const seenBarcode = new Map<string, { row: number; sku: string }>();
    for (const p of parsed) {
      if (!p.sku) continue;
      const k = keyOf(p.sku);
      const first = seenSku.get(k);
      if (first) p.errors.push(`Same SKU as row ${first}`);
      else seenSku.set(k, p.row);
      if (p.barcode) {
        const b = seenBarcode.get(p.barcode);
        if (b && keyOf(b.sku) !== k)
          p.errors.push(`Same barcode as row ${b.row}`);
        else if (!b) seenBarcode.set(p.barcode, { row: p.row, sku: p.sku });
      }
    }

    // 2. what already exists
    const existing = new Map<string, Product>();
    for (const chunk of chunks([...seenSku.keys()], 1000)) {
      const ids = await this.prisma.$queryRaw<
        { id: string }[]
      >`SELECT id FROM "Product" WHERE upper(sku) = ANY(${chunk}::text[])`;
      const found = await this.prisma.product.findMany({
        where: { id: { in: ids.map((i) => i.id) } },
      });
      found.forEach((pr) => existing.set(keyOf(pr.sku), pr));
    }
    const barcodeOwner = new Map<string, { id: string; sku: string }>();
    for (const chunk of chunks([...seenBarcode.keys()], 1000)) {
      const found = await this.prisma.product.findMany({
        where: { barcode: { in: chunk } },
        select: { id: true, sku: true, barcode: true },
      });
      found.forEach(
        (f) =>
          f.barcode && barcodeOwner.set(f.barcode, { id: f.id, sku: f.sku }),
      );
    }
    const knownCategories = new Set(
      (await this.prisma.category.findMany({ select: { name: true } })).map(
        (c) => c.name.toLowerCase(),
      ),
    );

    // 3. decide, row by row
    const results: RowResult[] = [];
    const creates: Parsed[] = [];
    const updates: Plan['updates'] = [];
    const count = {
      noCost: 0,
      noVat: 0,
      zeroGuess: 0,
      belowCost: 0,
      ignoredStock: 0,
    };

    const push = (p: Parsed, action: RowResult['action']) =>
      results.push({
        row: p.row,
        sku: p.sku,
        name: p.name ?? '',
        action,
        errors: p.errors,
        warnings: p.warnings,
      });

    for (const p of parsed) {
      const ex = p.sku ? existing.get(keyOf(p.sku)) : undefined;

      if (p.errors.length === 0 && p.barcode) {
        const owner = barcodeOwner.get(p.barcode);
        if (owner && (!ex || owner.id !== ex.id))
          p.errors.push(`Barcode already belongs to ${owner.sku}`);
      }
      if (p.errors.length) {
        push(p, 'error');
        continue;
      }

      if (ex) {
        if (!q.updateExisting) {
          p.warnings.push('Already exists, left unchanged');
          p.name ??= ex.name;
          push(p, 'skip');
          continue;
        }
        if (p.stock !== undefined) {
          p.warnings.push(
            'Stock is not changed for existing products. Use Inventory.',
          );
          count.ignoredStock++;
        }
        if (p.vatRate && !p.vatClass)
          p.warnings.push('VAT is only changed by a vat_class column');
        p.name ??= ex.name;
        updates.push({ p, ex });
        push(p, 'update');
        continue;
      }

      if (!p.name) p.errors.push('Name is required for a new product');
      if (!p.price) p.errors.push('Price is required for a new product');
      if (p.errors.length) {
        push(p, 'error');
        continue;
      }
      if (!p.cost) {
        p.warnings.push('No cost price');
        count.noCost++;
      } else if (p.price!.lt(p.cost)) {
        p.warnings.push('Price is below cost');
        count.belowCost++;
      }
      if (p.price!.isZero()) p.warnings.push('Price is 0');
      if (!p.vatClass && !p.vatRate) {
        p.warnings.push(
          'No VAT information: set to B (16%) and marked for review',
        );
        count.noVat++;
      } else if (!p.vatClass && p.vatRate === 'A') {
        p.warnings.push('0% was set to A (exempt) and marked for review');
        count.zeroGuess++;
      }
      creates.push(p);
      push(p, 'create');
    }

    // categories that do not exist yet (first spelling wins)
    const newCategories: string[] = [];
    const queued = new Set<string>();
    for (const p of [...creates, ...updates.map((u) => u.p)]) {
      if (!p.category) continue;
      const k = p.category.toLowerCase();
      if (!knownCategories.has(k) && !queued.has(k)) {
        queued.add(k);
        newCategories.push(p.category);
      }
    }

    const notices: string[] = [];
    if (count.noVat)
      notices.push(
        `${count.noVat} new products had no VAT information and are set to B (16%). Review them in the eTIMS screen, because exempt or zero-rated goods would otherwise be taxed.`,
      );
    if (count.zeroGuess)
      notices.push(
        `${count.zeroGuess} new products at 0% VAT were set to A (exempt) as a placeholder. They may be zero-rated (C) or non-VAT (D). Check with your accountant.`,
      );
    if (count.noCost)
      notices.push(
        `${count.noCost} new products have no cost price, so profit reports will look better than reality until costs are filled in.`,
      );
    if (count.belowCost)
      notices.push(`${count.belowCost} new products are priced below cost.`);
    if (count.ignoredStock)
      notices.push(
        `The stock column was ignored for ${count.ignoredStock} existing products. Change stock from the Inventory screen.`,
      );
    if (!cols.has('vatClass') && !cols.has('vatRate') && creates.length)
      notices.push(
        'The file has no VAT column. Add vat_class (A to E) to avoid the review step.',
      );

    return { results, creates, updates, newCategories, notices };
  }

  // ---------- doing it (one transaction: all or nothing) ----------

  private async apply(
    plan: Plan,
    rates: Map<TaxTypeCode, Prisma.Decimal>,
    filename: string,
    actor: AuthUser,
  ) {
    await this.prisma.$transaction(
      async (tx) => {
        const catId = new Map(
          (await tx.category.findMany()).map((c) => [
            c.name.toLowerCase(),
            c.id,
          ]),
        );
        for (const name of plan.newCategories) {
          const c = await tx.category.create({ data: { name } });
          catId.set(name.toLowerCase(), c.id);
        }
        const cid = (name?: string) =>
          name ? catId.get(name.toLowerCase()) : undefined;

        for (const part of chunks(plan.creates, 500)) {
          await tx.product.createMany({
            data: part.map((p) => {
              const code = p.vatClass ?? p.vatRate ?? 'B';
              return {
                sku: p.sku,
                barcode: p.barcode ?? null,
                name: p.name!,
                categoryId: cid(p.category) ?? null,
                price: p.price!,
                costPrice: p.cost ?? 0,
                taxTyCd: code,
                taxRate: rates.get(code) ?? 0,
                taxConfirmed: !!p.vatClass, // only an explicit class counts as reviewed
                reorderLevel: p.reorder ?? 5,
                stockQty: p.stock ?? 0,
              };
            }),
          });
          // the opening quantity is recorded in the stock ledger, like any other stock change
          const stocked = part.filter((p) => (p.stock ?? 0) > 0);
          if (stocked.length) {
            const ids = await tx.product.findMany({
              where: { sku: { in: stocked.map((p) => p.sku) } },
              select: { id: true, sku: true },
            });
            const bySku = new Map(ids.map((i) => [i.sku, i.id]));
            await tx.stockMovement.createMany({
              data: stocked.map((p) => ({
                productId: bySku.get(p.sku)!,
                type: StockMovementType.PURCHASE,
                quantity: p.stock!,
                reason: 'Opening stock (CSV import)',
                userId: actor.id,
              })),
            });
          }
        }

        for (const { p, ex } of plan.updates) {
          const code = p.vatClass;
          await tx.product.update({
            where: { id: ex.id },
            data: {
              ...(p.name && { name: p.name }),
              ...(p.barcode && { barcode: p.barcode }),
              ...(p.category && { categoryId: cid(p.category) }),
              ...(p.price && { price: p.price }),
              ...(p.cost && { costPrice: p.cost }),
              ...(p.reorder !== undefined && { reorderLevel: p.reorder }),
              ...(code && {
                taxTyCd: code,
                taxRate: rates.get(code) ?? 0,
                taxConfirmed: true,
              }),
            },
          });
          if (code && code !== ex.taxTyCd) {
            await audit(tx, {
              entity: 'Product',
              entityId: ex.id,
              action: 'TAX_CLASS_CHANGED',
              before: { taxTyCd: ex.taxTyCd },
              after: { taxTyCd: code },
              actorId: actor.id,
            });
          }
        }

        await audit(tx, {
          entity: 'ProductImport',
          entityId: filename.slice(0, 100),
          action: 'PRODUCT_IMPORT',
          after: {
            created: plan.creates.length,
            updated: plan.updates.length,
            newCategories: plan.newCategories.length,
          },
          actorId: actor.id,
        });
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
  }

  // ---------- export ----------

  async exportCsv(): Promise<string> {
    const products = await this.prisma.product.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      include: { category: { select: { name: true } } },
    });
    const cell = (v: string | number | null) => {
      let s = v === null ? '' : String(v);
      if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stops a product name running as an Excel formula
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = [
      [
        'sku',
        'barcode',
        'name',
        'category',
        'price',
        'cost',
        'vat_class',
        'reorder_level',
        'stock',
      ],
      ...products.map((p) => [
        p.sku,
        p.barcode,
        p.name,
        p.category?.name ?? null,
        p.price.toString(),
        p.costPrice.toString(),
        p.taxTyCd,
        p.reorderLevel,
        p.stockQty,
      ]),
    ];
    return '\uFEFF' + rows.map((r) => r.map(cell).join(',')).join('\r\n');
  }
}
