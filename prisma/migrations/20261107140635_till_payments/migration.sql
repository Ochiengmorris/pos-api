-- CreateEnum
CREATE TYPE "TillPaymentStatus" AS ENUM ('UNCLAIMED', 'CLAIMED', 'MATCHED_STK', 'IGNORED');

-- CreateTable
CREATE TABLE "TillPayment" (
    "id" TEXT NOT NULL,
    "transId" TEXT NOT NULL,
    "transTime" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "shortCode" TEXT NOT NULL,
    "billRef" TEXT,
    "payerName" TEXT,
    "payerPhone" TEXT,
    "rawPayload" JSONB NOT NULL,
    "status" "TillPaymentStatus" NOT NULL DEFAULT 'UNCLAIMED',
    "reservedById" TEXT,
    "reservedUntil" TIMESTAMP(3),
    "claimedById" TEXT,
    "claimedAt" TIMESTAMP(3),
    "saleId" TEXT,
    "ignoredById" TEXT,
    "ignoredReason" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TillPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TillPayment_transId_key" ON "TillPayment"("transId");

-- CreateIndex
CREATE INDEX "TillPayment_status_createdAt_idx" ON "TillPayment"("status", "createdAt");

-- CreateIndex
CREATE INDEX "TillPayment_transTime_idx" ON "TillPayment"("transTime");
