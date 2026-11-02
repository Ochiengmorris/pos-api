-- CreateEnum
CREATE TYPE "ShiftStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "CashMovementType" AS ENUM ('PAID_OUT', 'CASH_DROP', 'CASH_IN');

-- CreateTable
CREATE TABLE "CashShift" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "cashierId" TEXT NOT NULL,
    "status" "ShiftStatus" NOT NULL DEFAULT 'OPEN',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openingFloat" DECIMAL(12,2) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "expectedCash" DECIMAL(12,2),
    "countedCash" DECIMAL(12,2),
    "variance" DECIMAL(12,2),
    "closeNote" TEXT,
    "closeSummary" JSONB,
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "reviewNote" TEXT,

    CONSTRAINT "CashShift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashMovement" (
    "id" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "type" "CashMovementType" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashMovement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CashShift_number_key" ON "CashShift"("number");

-- CreateIndex
CREATE INDEX "CashShift_cashierId_status_idx" ON "CashShift"("cashierId", "status");

-- CreateIndex
CREATE INDEX "CashShift_openedAt_idx" ON "CashShift"("openedAt");

-- CreateIndex
CREATE INDEX "CashMovement_shiftId_idx" ON "CashMovement"("shiftId");

-- AddForeignKey
ALTER TABLE "CashShift" ADD CONSTRAINT "CashShift_cashierId_fkey" FOREIGN KEY ("cashierId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "CashShift"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "one_open_shift_per_cashier" ON "CashShift" ("cashierId") WHERE "status" = 'OPEN';