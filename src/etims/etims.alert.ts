import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { EtimsConfig } from './etims.config';

@Injectable()
export class EtimsAlerts {
  private readonly logger = new Logger(EtimsAlerts.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: EtimsConfig,
  ) {}

  // One alert per invoice per reason: a problem is reported once, not every few seconds
  async invoiceNeedsAttention(
    inv: { id: string; internalNo: string },
    reason: string,
    detail: string,
  ) {
    const already = await this.prisma.etimsEvent.findFirst({
      where: {
        invoiceId: inv.id,
        type: 'ALERT',
        message: { startsWith: reason },
      },
      select: { id: true },
    });
    if (already) return;
    await this.prisma.etimsEvent.create({
      data: {
        invoiceId: inv.id,
        type: 'ALERT',
        message: `${reason}: ${detail}`,
      },
    });
    await this.send(
      `eTIMS: invoice ${inv.internalNo} needs attention (${reason}). ${detail}`,
    );
  }

  @Interval(300_000)
  async checkStuck() {
    if (!this.cfg.enabled || !this.cfg.workerOn) return;
    const stuck = await this.prisma.taxInvoice.findMany({
      where: {
        status: 'PENDING',
        createdAt: {
          lt: new Date(Date.now() - this.cfg.stuckMinutes * 60_000),
        },
      },
      select: { id: true, internalNo: true },
      take: 50,
    });
    for (const inv of stuck) {
      await this.invoiceNeedsAttention(
        inv,
        'STUCK',
        `Still not sent to KRA after ${this.cfg.stuckMinutes} minutes.`,
      );
    }
  }

  private async send(text: string) {
    this.logger.error(text);
    const url = this.cfg.alertWebhookUrl;
    if (!url) return;
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (e) {
      this.logger.warn(
        `Could not deliver the alert to the webhook: ${(e as Error).message}`,
      ); // an alert must never break the worker
    }
  }
}
