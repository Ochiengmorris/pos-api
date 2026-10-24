import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { EtimsJob, Prisma, TaxInvoice } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EtimsConfig } from './etims.config';
import {
  ETIMS_PROVIDER,
  type ETimsProvider,
  type SalesPayload,
  type SubmitResult,
} from './etims.types';
import { EtimsAlerts } from './etims.alert';

const cut = (s: string, n = 500) => s.slice(0, n);

@Injectable()
export class EtimsWorker {
  private readonly logger = new Logger(EtimsWorker.name);
  private busy = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: EtimsConfig,
    private readonly alerts: EtimsAlerts,
    @Inject(ETIMS_PROVIDER) private readonly provider: ETimsProvider,
  ) {}

  @Interval(5000)
  async scheduled() {
    if (this.cfg.enabled && this.cfg.workerOn) await this.tick();
  }

  // Handles due jobs one at a time, oldest first, so invoice numbers go out in order
  async tick(limit = 20) {
    if (this.busy) return;
    this.busy = true;
    try {
      for (let i = 0; i < limit; i++) {
        const id = await this.claim();
        if (!id) break;
        try {
          await this.process(id);
        } catch (e) {
          this.logger.error(
            `eTIMS job ${id} crashed: ${(e as Error).stack ?? e}`,
          );
          await this.prisma.etimsJob.update({
            where: { id },
            data: {
              status: 'RETRY',
              nextAttemptAt: new Date(Date.now() + 60_000),
              lockedUntil: null,
              lastError: cut(String(e)),
            },
          });
        }
      }
    } finally {
      this.busy = false;
    }
  }

  // Takes one job. SKIP LOCKED plus a lease means two server instances never process the same job,
  // and a job abandoned by a crash becomes available again when its lease runs out.
  private async claim(): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE "EtimsJob"
      SET status = 'RUNNING', "lockedUntil" = now() + interval '2 minutes', "updatedAt" = now()
      WHERE id = (
        SELECT id FROM "EtimsJob"
        WHERE (status IN ('QUEUED', 'RETRY') AND "nextAttemptAt" <= now())
           OR (status = 'RUNNING' AND "lockedUntil" < now())
        ORDER BY "createdAt" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id`;
    return rows[0]?.id ?? null;
  }

  private async process(jobId: string) {
    const job = await this.prisma.etimsJob.findUniqueOrThrow({
      where: { id: jobId },
      include: { invoice: true },
    });
    const inv = job.invoice;

    if (inv.status === 'ACCEPTED' || inv.status === 'CANCELLED') {
      await this.prisma.etimsJob.update({
        where: { id: job.id },
        data: {
          status: inv.status === 'ACCEPTED' ? 'DONE' : 'CANCELLED',
          lockedUntil: null,
        },
      });
      return;
    }

    // 1. The KRA invoice number is assigned now, at first transmission (never at sale time)
    const invcNo = inv.invcNo ?? (await this.allocateNumber(inv.id));
    if (invcNo === null) {
      await this.prisma.etimsJob.update({
        where: { id: job.id },
        data: { status: 'CANCELLED', lockedUntil: null },
      }); // voided in the meantime
      return;
    }
    const payload: SalesPayload = {
      ...(inv.payload as unknown as SalesPayload),
      invcNo,
    };

    // 2. Check it locally first
    const problems = this.provider.validateInvoicePayload(payload);
    if (problems.length)
      return this.reject(job, inv, 'LOCAL_VALIDATION', problems.join('; '));

    // 3. Record that a request is about to go out. If we crash or time out after this point,
    //    the next attempt knows the outcome is unknown and reconciles instead of resubmitting.
    const wasSent = job.sentAt !== null;
    const attempts = await this.prisma.$transaction(async (tx) => {
      const j = await tx.etimsJob.update({
        where: { id: job.id },
        data: { attempts: { increment: 1 }, sentAt: job.sentAt ?? new Date() },
      });
      await tx.taxInvoice.update({
        where: { id: inv.id },
        data: {
          attemptCount: { increment: 1 },
          lastAttemptAt: new Date(),
          submittedAt: inv.submittedAt ?? new Date(),
        },
      });
      await tx.etimsEvent.create({
        data: {
          invoiceId: inv.id,
          type: wasSent ? 'RECONCILE_ATTEMPT' : 'SUBMIT_ATTEMPT',
          correlationId: job.correlationId,
        },
      });
      return j.attempts;
    });

    // 4. Talk to KRA
    let result: SubmitResult;
    try {
      result = wasSent
        ? await this.provider.reconcileInvoice(payload)
        : await this.provider.submitInvoice(payload);
    } catch (e) {
      result = {
        outcome: 'UNCERTAIN',
        message: `Unexpected error: ${(e as Error).message}`,
      };
    }

    // 5. Record exactly what happened
    switch (result.outcome) {
      case 'ACCEPTED':
        return this.accept(job, inv, payload, result.data);
      case 'REJECTED':
        return this.reject(job, inv, result.code, result.message);
      default:
        return this.scheduleRetry(job, inv, attempts, wasSent, result);
    }
  }

  // Gap-free numbering: allocate under a row lock, only for an invoice that is still pending
  private async allocateNumber(invoiceId: string): Promise<number | null> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        { status: string; invcNo: number | null }[]
      >`
        SELECT status::text AS status, "invcNo" FROM "TaxInvoice" WHERE id = ${invoiceId} FOR UPDATE`;
      const row = rows[0];
      if (!row || row.status !== 'PENDING') return null;
      if (row.invcNo !== null) return row.invcNo;

      const first = this.cfg.firstInvoiceNo;
      const [seq] = await tx.$queryRaw<{ invcNo: number }[]>`
        INSERT INTO "EtimsSequence" (tin, "bhfId", "nextNo")
        VALUES (${this.cfg.tin || 'A123456789Z'}, ${this.cfg.bhfId}, ${first + 1})
        ON CONFLICT (tin, "bhfId") DO UPDATE SET "nextNo" = "EtimsSequence"."nextNo" + 1
        RETURNING "nextNo" - 1 AS "invcNo"`;

      await tx.taxInvoice.update({
        where: { id: invoiceId },
        data: { invcNo: seq.invcNo },
      });
      await tx.etimsEvent.create({
        data: {
          invoiceId,
          type: 'NUMBER_ASSIGNED',
          message: `Invoice number ${seq.invcNo}`,
        },
      });
      return seq.invcNo;
    });
  }

  private async accept(
    job: EtimsJob,
    inv: TaxInvoice,
    payload: SalesPayload,
    data: NonNullable<Extract<SubmitResult, { outcome: 'ACCEPTED' }>['data']>,
  ) {
    const qr = this.provider.buildQrPayload({
      tin: payload.tin,
      bhfId: payload.bhfId,
      data,
    });
    await this.prisma.$transaction([
      this.prisma.taxInvoice.update({
        where: { id: inv.id },
        data: {
          status: 'ACCEPTED',
          receiptNo: data.curRcptNo,
          totalReceiptNo: data.totRcptNo,
          intrlData: data.intrlData,
          rcptSign: data.rcptSign,
          sdcId: data.sdcId ?? null,
          mrcNo: data.mrcNo ?? null,
          sdcDateTime: data.sdcDateTime,
          qrPayload: qr,
          acceptedAt: new Date(),
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      }),
      this.prisma.etimsJob.update({
        where: { id: job.id },
        data: { status: 'DONE', lockedUntil: null, lastError: null },
      }),
      this.prisma.etimsEvent.create({
        data: {
          invoiceId: inv.id,
          type: 'ACCEPTED',
          message: `Accepted by ${this.provider.kind} (${this.provider.environment})`,
          correlationId: job.correlationId,
          data: { receiptNo: data.curRcptNo },
        },
      }),
    ]);
  }

  private async reject(
    job: EtimsJob,
    inv: TaxInvoice,
    code: string,
    message: string,
  ) {
    await this.prisma.$transaction([
      this.prisma.taxInvoice.update({
        where: { id: inv.id },
        data: {
          status: 'REJECTED',
          lastErrorCode: code,
          lastErrorMessage: cut(message),
        },
      }),
      this.prisma.etimsJob.update({
        where: { id: job.id },
        data: {
          status: 'FAILED',
          lockedUntil: null,
          lastError: cut(`${code}: ${message}`),
        },
      }),
      this.prisma.etimsEvent.create({
        data: {
          invoiceId: inv.id,
          type: 'REJECTED',
          message: cut(`${code}: ${message}`),
          correlationId: job.correlationId,
        },
      }),
    ]);
    this.logger.error(
      `eTIMS invoice ${inv.internalNo} was rejected (${code}): ${message}`,
    );
    await this.alerts.invoiceNeedsAttention(
      inv,
      'REJECTED',
      `${code}: ${message}`,
    );
  }

  // Exponential backoff with jitter: 30s, 1m, 2m, 4m ... capped at 1 hour
  private async scheduleRetry(
    job: EtimsJob,
    inv: TaxInvoice,
    attempts: number,
    wasSent: boolean,
    result: Extract<SubmitResult, { outcome: 'RETRYABLE' | 'UNCERTAIN' }>,
  ) {
    const uncertain = result.outcome === 'UNCERTAIN' || wasSent; // once unknown, stays unknown until KRA confirms
    const exhausted = attempts >= this.cfg.maxAttempts;
    const delay = Math.min(30_000 * 2 ** (attempts - 1), 3_600_000);
    const next = new Date(Date.now() + delay * (1 + Math.random() * 0.2));
    const note = cut(
      `${result.code ? `${result.code}: ` : ''}${result.message}`,
    );

    await this.prisma.$transaction([
      this.prisma.taxInvoice.update({
        where: { id: inv.id },
        data: {
          status: uncertain ? 'UNCERTAIN' : exhausted ? 'FAILED' : 'PENDING',
          lastErrorCode: result.code ?? null,
          lastErrorMessage: note,
        },
      }),
      this.prisma.etimsJob.update({
        where: { id: job.id },
        data: exhausted
          ? {
              status: uncertain ? 'UNCERTAIN' : 'FAILED',
              lockedUntil: null,
              lastError: note,
            }
          : {
              status: 'RETRY',
              nextAttemptAt: next,
              lockedUntil: null,
              lastError: note,
              sentAt: uncertain ? (job.sentAt ?? new Date()) : null,
            },
      }),
      this.prisma.etimsEvent.create({
        data: {
          invoiceId: inv.id,
          type: exhausted ? 'GAVE_UP' : 'RETRY_SCHEDULED',
          message: note,
          correlationId: job.correlationId,
          data: {
            attempts,
            uncertain,
            next: exhausted ? null : next.toISOString(),
          },
        },
      }),
    ]);
    if (exhausted)
      await this.alerts.invoiceNeedsAttention(inv, 'GAVE_UP', note);
    else if (attempts === 3)
      await this.alerts.invoiceNeedsAttention(inv, 'REPEATED_FAILURES', note);
  }
}
