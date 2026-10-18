/*
  Warnings:

  - A unique constraint covering the columns `[etimsSeq]` on the table `Product` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "TaxTypeCode" AS ENUM ('A', 'B', 'C', 'D', 'E');

-- CreateEnum
CREATE TYPE "TaxInvoiceType" AS ENUM ('SALE', 'CREDIT_NOTE');

-- CreateEnum
CREATE TYPE "TaxInvoiceStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'FAILED', 'UNCERTAIN', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EtimsJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'RETRY', 'DONE', 'FAILED', 'UNCERTAIN', 'CANCELLED');

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "etimsItemClsCd" TEXT,
ADD COLUMN     "etimsSeq" SERIAL NOT NULL,
ADD COLUMN     "pkgUnitCd" TEXT NOT NULL DEFAULT 'NT',
ADD COLUMN     "qtyUnitCd" TEXT NOT NULL DEFAULT 'U',
ADD COLUMN     "taxConfirmed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "taxTyCd" "TaxTypeCode" NOT NULL DEFAULT 'B';

-- AlterTable
ALTER TABLE "SaleItem" ADD COLUMN     "taxTyCd" "TaxTypeCode" NOT NULL DEFAULT 'B';

-- CreateTable
CREATE TABLE "TaxType" (
    "code" "TaxTypeCode" NOT NULL,
    "name" TEXT NOT NULL,
    "rate" DECIMAL(5,2) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "TaxType_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "TaxInvoice" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "type" "TaxInvoiceType" NOT NULL DEFAULT 'SALE',
    "internalNo" TEXT NOT NULL,
    "status" "TaxInvoiceStatus" NOT NULL DEFAULT 'PENDING',
    "environment" TEXT NOT NULL,
    "originalInvoiceId" TEXT,
    "invcNo" INTEGER,
    "customerPin" TEXT,
    "customerName" TEXT,
    "payload" JSONB NOT NULL,
    "receiptNo" INTEGER,
    "totalReceiptNo" INTEGER,
    "intrlData" TEXT,
    "rcptSign" TEXT,
    "sdcId" TEXT,
    "mrcNo" TEXT,
    "sdcDateTime" TEXT,
    "qrPayload" TEXT,
    "submittedAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EtimsJob" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "EtimsJobStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedUntil" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "lastError" TEXT,
    "correlationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EtimsJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EtimsEvent" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT,
    "data" JSONB,
    "actorId" TEXT,
    "correlationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EtimsEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EtimsSequence" (
    "tin" TEXT NOT NULL,
    "bhfId" TEXT NOT NULL,
    "nextNo" INTEGER NOT NULL,

    CONSTRAINT "EtimsSequence_pkey" PRIMARY KEY ("tin","bhfId")
);

-- CreateIndex
CREATE UNIQUE INDEX "TaxInvoice_internalNo_key" ON "TaxInvoice"("internalNo");

-- CreateIndex
CREATE INDEX "TaxInvoice_status_createdAt_idx" ON "TaxInvoice"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TaxInvoice_saleId_type_key" ON "TaxInvoice"("saleId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "EtimsJob_invoiceId_key" ON "EtimsJob"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "EtimsJob_idempotencyKey_key" ON "EtimsJob"("idempotencyKey");

-- CreateIndex
CREATE INDEX "EtimsJob_status_nextAttemptAt_idx" ON "EtimsJob"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "EtimsEvent_invoiceId_createdAt_idx" ON "EtimsEvent"("invoiceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Product_etimsSeq_key" ON "Product"("etimsSeq");

-- AddForeignKey
ALTER TABLE "TaxInvoice" ADD CONSTRAINT "TaxInvoice_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EtimsJob" ADD CONSTRAINT "EtimsJob_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "TaxInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EtimsEvent" ADD CONSTRAINT "EtimsEvent_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "TaxInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
