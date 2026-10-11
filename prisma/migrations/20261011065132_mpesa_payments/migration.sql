-- CreateEnum
CREATE TYPE "MpesaStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'CANCELLED', 'TIMEOUT');

-- CreateTable
CREATE TABLE "MpesaPayment" (
    "id" TEXT NOT NULL,
    "cashierId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "status" "MpesaStatus" NOT NULL DEFAULT 'PENDING',
    "merchantRequestId" TEXT,
    "checkoutRequestId" TEXT,
    "receipt" TEXT,
    "resultCode" INTEGER,
    "resultDesc" TEXT,
    "saleId" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MpesaPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MpesaPayment_checkoutRequestId_key" ON "MpesaPayment"("checkoutRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "MpesaPayment_receipt_key" ON "MpesaPayment"("receipt");

-- CreateIndex
CREATE INDEX "MpesaPayment_status_createdAt_idx" ON "MpesaPayment"("status", "createdAt");

-- CreateIndex
CREATE INDEX "MpesaPayment_cashierId_idx" ON "MpesaPayment"("cashierId");

-- CreateIndex
CREATE INDEX "MpesaPayment_saleId_idx" ON "MpesaPayment"("saleId");

-- AddForeignKey
ALTER TABLE "MpesaPayment" ADD CONSTRAINT "MpesaPayment_cashierId_fkey" FOREIGN KEY ("cashierId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MpesaPayment" ADD CONSTRAINT "MpesaPayment_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE SET NULL ON UPDATE CASCADE;
