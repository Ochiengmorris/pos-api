/*
  Warnings:

  - A unique constraint covering the columns `[method,reference]` on the table `Payment` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[clientRequestId]` on the table `Sale` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "Payment_reference_idx";

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "change" DECIMAL(12,2),
ADD COLUMN     "tendered" DECIMAL(12,2);

-- AlterTable
ALTER TABLE "Sale" ADD COLUMN     "clientRequestId" TEXT,
ADD COLUMN     "voidReason" TEXT,
ADD COLUMN     "voidedAt" TIMESTAMP(3),
ADD COLUMN     "voidedById" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Payment_method_reference_key" ON "Payment"("method", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "Sale_clientRequestId_key" ON "Sale"("clientRequestId");
