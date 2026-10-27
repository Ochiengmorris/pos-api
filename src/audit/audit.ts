import { Prisma } from '@prisma/client';

export type AuditEntry = {
  entity: string;
  entityId: string;
  action: string;
  before?: unknown;
  after?: unknown;
  actorId?: string | null;
};

export function audit(db: Prisma.TransactionClient, e: AuditEntry) {
  return db.auditLog.create({
    data: {
      entity: e.entity,
      entityId: e.entityId,
      action: e.action,
      before: (e.before ?? undefined) as Prisma.InputJsonValue | undefined,
      after: (e.after ?? undefined) as Prisma.InputJsonValue | undefined,
      actorId: e.actorId ?? null,
    },
  });
}
