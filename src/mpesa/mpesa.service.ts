import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MpesaPayment, MpesaStatus, Prisma, Role } from '@prisma/client';
import { timingSafeEqual } from 'crypto';
import { AuthUser } from '../auth/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { InitiateStkDto } from './dto/initiate-stk.dto';
import { MpesaClient } from './mpesa.client';
import { normalizeKenyanPhone } from './phone.util';
import { ResolveMpesaDto } from './dto/resolve-mpesa.dto';

const ACK = { ResultCode: 0, ResultDesc: 'Accepted' };

@Injectable()
export class MpesaService {
  private readonly logger = new Logger(MpesaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: MpesaClient,
    private readonly config: ConfigService,
  ) {}

  private present(r: MpesaPayment) {
    return {
      id: r.id,
      status: r.status,
      phone: r.phone,
      amount: r.amount,
      receipt: r.receipt,
      message: r.resultDesc,
      saleId: r.saleId,
      createdAt: r.createdAt,
    };
  }

  private fail(id: string, message: string) {
    return this.prisma.mpesaPayment.update({
      where: { id },
      data: { status: MpesaStatus.FAILED, resultDesc: message },
    });
  }

  // ---------- 1. start a payment ----------

  async initiate(dto: InitiateStkDto, actor: AuthUser) {
    if (!this.client.isConfigured()) {
      throw new ServiceUnavailableException('M-Pesa is not configured');
    }
    const phone = normalizeKenyanPhone(dto.phone);

    // Double-click protection: reuse a fresh identical pending request
    const recent = await this.prisma.mpesaPayment.findFirst({
      where: {
        cashierId: actor.id,
        phone,
        amount: dto.amount,
        status: MpesaStatus.PENDING,
        createdAt: { gte: new Date(Date.now() - 90_000) },
      },
    });
    if (recent) return this.present(recent);

    // Record first, so we never lose track of a request we sent
    const record = await this.prisma.mpesaPayment.create({
      data: { cashierId: actor.id, phone, amount: dto.amount },
    });

    const base = this.config
      .getOrThrow<string>('MPESA_CALLBACK_BASE_URL')
      .replace(/\/$/, '');
    const secret = this.config.getOrThrow<string>('MPESA_CALLBACK_SECRET');

    let res;
    try {
      res = await this.client.stkPush({
        phone,
        amount: dto.amount,
        callbackUrl: `${base}/api/v1/payments/hooks/stk/${secret}`,
      });
    } catch (e) {
      this.logger.error(`STK push failed to send: ${(e as Error).message}`);
      await this.fail(record.id, 'Could not reach M-Pesa');
      throw new BadGatewayException(
        'Could not reach M-Pesa. Check with the customer before retrying.',
      );
    }

    if (
      !res.ok ||
      res.json.ResponseCode !== '0' ||
      !res.json.CheckoutRequestID
    ) {
      const msg =
        res.json.errorMessage ??
        res.json.ResponseDescription ??
        'M-Pesa rejected the request';
      await this.fail(record.id, msg);
      throw new BadGatewayException(msg);
    }

    const updated = await this.prisma.mpesaPayment.update({
      where: { id: record.id },
      data: {
        merchantRequestId: res.json.MerchantRequestID,
        checkoutRequestId: res.json.CheckoutRequestID,
      },
    });
    return this.present(updated);
  }

  // ---------- 2. status (the frontend polls this) ----------

  async getStatus(id: string, actor: AuthUser) {
    let rec = await this.prisma.mpesaPayment.findUnique({ where: { id } });
    if (!rec || (actor.role === Role.CASHIER && rec.cashierId !== actor.id)) {
      throw new NotFoundException('M-Pesa payment not found');
    }
    if (rec.status === MpesaStatus.PENDING && rec.checkoutRequestId) {
      rec = await this.refresh(rec);
    }
    return this.present(rec);
  }

  // Ask Daraja directly. This is the recovery path when a callback is late or lost.
  private async refresh(rec: MpesaPayment): Promise<MpesaPayment> {
    const age = Date.now() - rec.createdAt.getTime();
    const sinceCheck = rec.lastCheckedAt
      ? Date.now() - rec.lastCheckedAt.getTime()
      : Infinity;
    if (age < 15_000 || sinceCheck < 10_000) return rec; // give the callback a chance first

    await this.prisma.mpesaPayment.update({
      where: { id: rec.id },
      data: { lastCheckedAt: new Date() },
    });

    try {
      const { json } = await this.client.stkQuery(rec.checkoutRequestId!);
      if (json.ResultCode === undefined) return rec; // still processing
      return this.settle(rec.id, Number(json.ResultCode), json.ResultDesc);
    } catch (e) {
      this.logger.warn(
        `STK query failed for ${rec.id}: ${(e as Error).message}`,
      );
      return rec;
    }
  }

  // Only ever moves a payment out of PENDING, so duplicates and replays are harmless
  private async settle(
    id: string,
    code: number,
    desc?: string,
    receipt?: string,
  ) {
    const status =
      code === 0
        ? MpesaStatus.SUCCESS
        : code === 1032
          ? MpesaStatus.CANCELLED // customer cancelled
          : code === 1037
            ? MpesaStatus.TIMEOUT // customer didn't respond
            : MpesaStatus.FAILED; // wrong PIN, insufficient funds, etc.

    await this.prisma.mpesaPayment.updateMany({
      where: { id, status: MpesaStatus.PENDING },
      data: {
        status,
        resultCode: code,
        resultDesc: desc,
        ...(receipt && { receipt }),
      },
    });
    return this.prisma.mpesaPayment.findUniqueOrThrow({ where: { id } });
  }

  // ---------- 3. Daraja's callback ----------

  private secretOk(given: string) {
    const expected = Buffer.from(
      this.config.get<string>('MPESA_CALLBACK_SECRET', ''),
    );
    const actual = Buffer.from(given);
    return (
      expected.length > 0 &&
      expected.length === actual.length &&
      timingSafeEqual(expected, actual)
    );
  }

  async handleCallback(secret: string, body: any) {
    if (!this.secretOk(secret)) throw new ForbiddenException();

    const cb = body?.Body?.stkCallback;
    if (!cb?.CheckoutRequestID) {
      this.logger.warn('Callback without CheckoutRequestID ignored');
      return ACK;
    }

    const rec = await this.prisma.mpesaPayment.findUnique({
      where: { checkoutRequestId: String(cb.CheckoutRequestID) },
    });
    if (!rec) {
      // Money may have moved for a request we have no record of: leave a trail
      this.logger.error(`Unmatched M-Pesa callback: ${JSON.stringify(cb)}`);
      return ACK;
    }

    const code = Number(cb.ResultCode);
    let receipt: string | undefined;

    if (code === 0) {
      const items: { Name: string; Value?: unknown }[] =
        cb.CallbackMetadata?.Item ?? [];
      const get = (name: string) => items.find((i) => i.Name === name)?.Value;

      const paid = get('Amount');
      if (paid == null || !new Prisma.Decimal(String(paid)).eq(rec.amount)) {
        this.logger.error(
          `Callback amount mismatch for ${rec.id}: got ${paid}, expected ${rec.amount}`,
        );
        return ACK; // leave PENDING; the status query will settle it
      }
      receipt = get('MpesaReceiptNumber')
        ? String(get('MpesaReceiptNumber'))
        : undefined;
    }

    if (
      code === 0 &&
      rec.status === MpesaStatus.PENDING &&
      this.config.get('MPESA_VERIFY_CALLBACKS', 'false') === 'true'
    ) {
      try {
        const { json } = await this.client.stkQuery(rec.checkoutRequestId!);
        if (Number(json.ResultCode) !== 0) {
          this.logger.error(
            `Callback claimed success for ${rec.id} but Daraja says: ${JSON.stringify(json)}`,
          );
          return ACK; // stays PENDING; the status polling resolves it later
        }
      } catch (e) {
        this.logger.warn(
          `Could not verify callback for ${rec.id}: ${(e as Error).message}`,
        );
        return ACK;
      }
    }

    if (rec.status === MpesaStatus.PENDING) {
      await this.settle(rec.id, code, cb.ResultDesc, receipt);
    } else if (rec.status === MpesaStatus.SUCCESS && !rec.receipt && receipt) {
      // Settled earlier via query (which has no receipt code): backfill it
      await this.prisma.mpesaPayment.update({
        where: { id: rec.id },
        data: { receipt },
      });
    }
    return ACK;
  }

  // ---------- 4. reconciliation ----------

  // Money received but never attached to a sale
  async unclaimed() {
    const items = await this.prisma.mpesaPayment.findMany({
      where: { status: MpesaStatus.SUCCESS, saleId: null, resolution: null },
      include: { cashier: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return items.map((r) => ({ ...this.present(r), cashier: r.cashier }));
  }

  // A manager records what happened to money that arrived without a sale
  async resolve(id: string, dto: ResolveMpesaDto, actor: AuthUser) {
    const res = await this.prisma.mpesaPayment.updateMany({
      where: {
        id,
        status: MpesaStatus.SUCCESS,
        saleId: null,
        resolution: null,
      },
      data: {
        resolution: dto.resolution,
        resolutionNote: dto.note.trim(),
        resolvedAt: new Date(),
        resolvedById: actor.id,
      },
    });
    if (res.count === 0) {
      throw new BadRequestException(
        'Payment not found, already attached to a sale, or already resolved',
      );
    }
    return { message: 'Payment resolved' };
  }

  // Resolve abandoned PENDING requests (browser closed, callback lost)
  @Cron(CronExpression.EVERY_MINUTE)
  async resolveStale() {
    if (!this.client.isConfigured()) return;
    const stale = await this.prisma.mpesaPayment.findMany({
      where: {
        status: MpesaStatus.PENDING,
        checkoutRequestId: { not: null },
        createdAt: { lt: new Date(Date.now() - 90_000) },
      },
      take: 20,
    });
    for (const rec of stale) await this.refresh(rec);
  }
}
