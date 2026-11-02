import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CashMovement,
  CashMovementType,
  CashShift,
  Prisma,
  Role,
} from '@prisma/client';
import { AuthUser } from '../auth/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import {
  AcknowledgeDto,
  CloseShiftDto,
  ListShiftsDto,
  MovementDto,
  OpenShiftDto,
} from './dto/cash.dto';

const D = (v: Prisma.Decimal | number | string | null | undefined) =>
  new Prisma.Decimal(v ?? 0);

export type Figures = {
  sales: { count: number; total: string };
  voided: { count: number; total: string };
  byMethod: Record<string, { count: number; amount: string }>;
  openingFloat: string;
  cashSales: string;
  cashIn: string;
  paidOut: string;
  cashDrops: string;
  expectedCash: string;
};

type ShiftWithCashier = CashShift & { cashier: { name: string } };

function tzOffsetMinutes(tz: string, at: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return Math.round(
    (Date.UTC(
      g('year'),
      g('month') - 1,
      g('day'),
      g('hour'),
      g('minute'),
      g('second'),
    ) -
      at.getTime()) /
      60_000,
  );
}

function dayRange(date: string, tz: string) {
  const from = new Date(
    Date.parse(`${date}T00:00:00Z`) -
      tzOffsetMinutes(tz, new Date(`${date}T12:00:00Z`)) * 60_000,
  );
  return { from, to: new Date(from.getTime() + 86_400_000) };
}

@Injectable()
export class CashService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private env(key: string, fallback: string) {
    return process.env[key] ?? this.config.get<string>(key, fallback);
  }

  private num(key: string, fallback: string) {
    return Number(this.env(key, fallback));
  }
  get required() {
    return this.env('CASH_REQUIRE_SHIFT', 'false') === 'true';
  }
  get paidOutLimit() {
    return this.num('CASH_PAID_OUT_LIMIT', '2000');
  }
  get tolerance() {
    return this.num('CASH_VARIANCE_TOLERANCE', '50');
  }
  get staleHours() {
    return this.num('CASH_STALE_SHIFT_HOURS', '18');
  }
  private get tz() {
    return this.config.get<string>('BUSINESS_TZ', 'Africa/Nairobi');
  }
  private isStaff(u: AuthUser) {
    return u.role !== Role.CASHIER;
  }

  // ---------- what the drawer should hold ----------

  async figures(shift: CashShift, until: Date): Promise<Figures> {
    const saleWhere: Prisma.SaleWhereInput = {
      cashierId: shift.cashierId,
      createdAt: { gte: shift.openedAt, lte: until },
      status: { not: 'VOIDED' },
    };
    const [sales, voided, pay, moves] = await Promise.all([
      this.prisma.sale.aggregate({
        where: saleWhere,
        _count: { _all: true },
        _sum: { total: true },
      }),
      this.prisma.sale.aggregate({
        where: { ...saleWhere, status: 'VOIDED' },
        _count: { _all: true },
        _sum: { total: true },
      }),
      this.prisma.payment.groupBy({
        by: ['method'],
        where: { sale: saleWhere },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.cashMovement.groupBy({
        by: ['type'],
        where: { shiftId: shift.id },
        _sum: { amount: true },
      }),
    ]);
    const move = (t: CashMovementType) =>
      D(moves.find((m) => m.type === t)?._sum.amount);
    const cashSales = D(pay.find((p) => p.method === 'CASH')?._sum.amount);
    const expected = D(shift.openingFloat)
      .add(cashSales)
      .add(move('CASH_IN'))
      .sub(move('PAID_OUT'))
      .sub(move('CASH_DROP'));
    return {
      sales: {
        count: sales._count._all,
        total: D(sales._sum.total).toFixed(2),
      },
      voided: {
        count: voided._count._all,
        total: D(voided._sum.total).toFixed(2),
      },
      byMethod: Object.fromEntries(
        pay.map((p) => [
          p.method,
          { count: p._count._all, amount: D(p._sum.amount).toFixed(2) },
        ]),
      ),
      openingFloat: D(shift.openingFloat).toFixed(2),
      cashSales: cashSales.toFixed(2),
      cashIn: move('CASH_IN').toFixed(2),
      paidOut: move('PAID_OUT').toFixed(2),
      cashDrops: move('CASH_DROP').toFixed(2),
      expectedCash: expected.toFixed(2),
    };
  }

  private figuresFor(s: CashShift) {
    return s.status === 'OPEN'
      ? this.figures(s, new Date())
      : Promise.resolve(s.closeSummary as unknown as Figures);
  }

  // ---------- views ----------

  private row(s: ShiftWithCashier, f: Figures) {
    const v = s.variance;
    return {
      id: s.id,
      number: s.number,
      status: s.status,
      cashierId: s.cashierId,
      cashierName: s.cashier.name,
      openedAt: s.openedAt,
      closedAt: s.closedAt,
      openingFloat: D(s.openingFloat).toFixed(2),
      expectedCash: s.expectedCash
        ? D(s.expectedCash).toFixed(2)
        : f.expectedCash,
      countedCash: s.countedCash ? D(s.countedCash).toFixed(2) : null,
      variance: v ? D(v).toFixed(2) : null,
      needsReview:
        s.status === 'CLOSED' &&
        !s.reviewedAt &&
        !!v &&
        D(v).abs().gt(this.tolerance),
      reviewedAt: s.reviewedAt,
      salesCount: f.sales.count,
      cashSales: f.cashSales,
      mpesa: f.byMethod.MPESA?.amount ?? '0.00',
      card: f.byMethod.CARD?.amount ?? '0.00',
      paidOut: f.paidOut,
      drops: f.cashDrops,
    };
  }

  private async view(s: ShiftWithCashier & { movements: CashMovement[] }) {
    const figures = await this.figuresFor(s);
    const users = await this.prisma.user.findMany({
      where: {
        id: { in: [...new Set(s.movements.map((m) => m.createdById))] },
      },
      select: { id: true, name: true },
    });
    const names = new Map(users.map((u) => [u.id, u.name]));
    return {
      ...this.row(s, figures),
      closeNote: s.closeNote,
      reviewNote: s.reviewNote,
      figures,
      movements: s.movements.map((m) => ({
        id: m.id,
        type: m.type,
        amount: D(m.amount).toFixed(2),
        reason: m.reason,
        createdAt: m.createdAt,
        by: names.get(m.createdById) ?? '',
      })),
      tolerance: this.tolerance,
      paidOutLimit: this.paidOutLimit,
    };
  }

  private include = {
    cashier: { select: { name: true } },
    movements: { orderBy: { createdAt: 'asc' as const } },
  };

  async current(user: AuthUser) {
    const s = await this.prisma.cashShift.findFirst({
      where: { cashierId: user.id, status: 'OPEN' },
      include: this.include,
    });
    return {
      required: this.required,
      shift: s ? await this.view(s) : null,
      stale:
        !!s && Date.now() - s.openedAt.getTime() > this.staleHours * 3_600_000,
      tolerance: this.tolerance,
      paidOutLimit: this.paidOutLimit,
    };
  }

  // called by the sales service before a sale is recorded
  async requireOpenShift(userId: string) {
    if (!this.required) return;
    const open = await this.prisma.cashShift.findFirst({
      where: { cashierId: userId, status: 'OPEN' },
      select: { id: true },
    });
    if (!open)
      throw new ConflictException(
        'Open your shift (enter your opening float) before making a sale.',
      );
  }

  // ---------- actions ----------

  async open(user: AuthUser, dto: OpenShiftDto) {
    try {
      const s = await this.prisma.cashShift.create({
        data: { cashierId: user.id, openingFloat: D(dto.openingFloat) },
        include: this.include,
      });
      return this.view(s);
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      )
        throw new ConflictException('You already have an open shift.');
      throw e;
    }
  }

  private async openShift(id: string) {
    const s = await this.prisma.cashShift.findUnique({
      where: { id },
      include: this.include,
    });
    if (!s) throw new NotFoundException('Shift not found');
    if (s.status !== 'OPEN')
      throw new BadRequestException('This shift is already closed');
    return s;
  }

  async addMovement(shiftId: string, dto: MovementDto, actor: AuthUser) {
    const shift = await this.openShift(shiftId);
    const staff = this.isStaff(actor);
    if (!staff && shift.cashierId !== actor.id)
      throw new ForbiddenException('This is not your shift');
    if (dto.type === 'CASH_IN' && !staff)
      throw new ForbiddenException('Only a manager can add cash to a drawer');

    const amount = D(dto.amount);
    const reason =
      dto.reason?.trim() ||
      (dto.type === 'CASH_DROP' ? 'Cash drop to safe' : '');
    if (dto.type !== 'CASH_DROP' && reason.length < 3)
      throw new BadRequestException('Give a reason');
    if (dto.type === 'PAID_OUT' && !staff && amount.gt(this.paidOutLimit)) {
      throw new ForbiddenException(
        `Paid-outs above KSh ${this.paidOutLimit} need a manager. Ask a manager to record it.`,
      );
    }
    if (dto.type !== 'CASH_IN') {
      const inDrawer = (await this.figures(shift, new Date())).expectedCash;
      if (amount.gt(inDrawer))
        throw new BadRequestException(
          `The drawer should only hold KSh ${inDrawer}`,
        );
    }
    await this.prisma.cashMovement.create({
      data: { shiftId, type: dto.type, amount, reason, createdById: actor.id },
    });
    return this.detail(shiftId, actor);
  }

  async close(shiftId: string, dto: CloseShiftDto, actor: AuthUser) {
    const shift = await this.openShift(shiftId);
    const staff = this.isStaff(actor);
    if (!staff && shift.cashierId !== actor.id)
      throw new ForbiddenException('This is not your shift');

    const closedAt = new Date();
    const figs = await this.figures(shift, closedAt);
    const expected = D(figs.expectedCash);
    const counted = D(dto.countedCash);
    const variance = counted.sub(expected);
    const note = dto.note?.trim();

    if (shift.cashierId !== actor.id && (!note || note.length < 5)) {
      throw new BadRequestException(
        "Add a note saying why this shift is being closed on the cashier's behalf",
      );
    }
    if (variance.abs().gt(this.tolerance) && (!note || note.length < 5)) {
      throw new BadRequestException(
        `The drawer is ${variance.lt(0) ? 'short' : 'over'} by KSh ${variance.abs().toFixed(2)}. Add a note explaining the difference.`,
      );
    }
    const r = await this.prisma.cashShift.updateMany({
      where: { id: shiftId, status: 'OPEN' },
      data: {
        status: 'CLOSED',
        closedAt,
        closedById: actor.id,
        expectedCash: expected,
        countedCash: counted,
        variance,
        closeNote: note ?? null,
        closeSummary: figs as unknown as Prisma.InputJsonValue,
      },
    });
    if (r.count === 0)
      throw new ConflictException('This shift was just closed by someone else');
    return this.detail(shiftId, actor);
  }

  async acknowledge(shiftId: string, dto: AcknowledgeDto, actor: AuthUser) {
    const r = await this.prisma.cashShift.updateMany({
      where: { id: shiftId, status: 'CLOSED', reviewedAt: null },
      data: {
        reviewedAt: new Date(),
        reviewedById: actor.id,
        reviewNote: dto.note.trim(),
      },
    });
    if (r.count === 0)
      throw new BadRequestException(
        'Only a closed shift that has not been reviewed can be acknowledged',
      );
    return this.detail(shiftId, actor);
  }

  // ---------- reading ----------

  async detail(id: string, actor: AuthUser) {
    const s = await this.prisma.cashShift.findUnique({
      where: { id },
      include: this.include,
    });
    if (!s) throw new NotFoundException('Shift not found');
    if (!this.isStaff(actor) && s.cashierId !== actor.id)
      throw new ForbiddenException('This is not your shift');
    return this.view(s);
  }

  async list(q: ListShiftsDto, actor: AuthUser) {
    const tol = this.tolerance;
    const where: Prisma.CashShiftWhereInput = {
      ...(this.isStaff(actor)
        ? q.cashierId
          ? { cashierId: q.cashierId }
          : {}
        : { cashierId: actor.id }),
      ...(q.status && { status: q.status }),
      ...((q.from || q.to) && {
        openedAt: {
          ...(q.from && { gte: new Date(q.from) }),
          ...(q.to && { lte: new Date(q.to) }),
        },
      }),
      ...(q.review === 'needed' && {
        status: 'CLOSED',
        reviewedAt: null,
        OR: [{ variance: { gt: tol } }, { variance: { lt: -tol } }],
      }),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.cashShift.findMany({
        where,
        orderBy: { openedAt: 'desc' },
        skip: (q.page - 1) * q.limit,
        take: q.limit,
        include: { cashier: { select: { name: true } } },
      }),
      this.prisma.cashShift.count({ where }),
    ]);
    const rows = await Promise.all(
      items.map(async (s) => this.row(s, await this.figuresFor(s))),
    );
    return {
      items: rows,
      meta: {
        total,
        page: q.page,
        limit: q.limit,
        pages: Math.ceil(total / q.limit),
      },
    };
  }

  // The manager's day: every shift opened that day, plus any older shift that was never closed
  async summary(date?: string) {
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: this.tz,
    }).format(new Date());
    const day = date ?? today;
    const { from, to } = dayRange(day, this.tz);
    const shifts = await this.prisma.cashShift.findMany({
      where: {
        OR: [
          { openedAt: { gte: from, lt: to } },
          { status: 'OPEN', openedAt: { lt: from } },
        ],
      },
      orderBy: { openedAt: 'asc' },
      include: { cashier: { select: { name: true } } },
    });
    const rows = await Promise.all(
      shifts.map(async (s) => this.row(s, await this.figuresFor(s))),
    );
    const add = (pick: (r: (typeof rows)[number]) => string | null) =>
      rows.reduce((a, r) => a.add(D(pick(r))), D(0)).toFixed(2);
    return {
      date: day,
      totals: {
        shifts: rows.length,
        open: rows.filter((r) => r.status === 'OPEN').length,
        cashSales: add((r) => r.cashSales),
        mpesa: add((r) => r.mpesa),
        card: add((r) => r.card),
        paidOut: add((r) => r.paidOut),
        drops: add((r) => r.drops),
        variance: add((r) => r.variance),
        needsReview: rows.filter((r) => r.needsReview).length,
      },
      shifts: rows,
    };
  }
}
