-- AlterTable
ALTER TABLE "SaleItem" ADD COLUMN     "taxRate" DECIMAL(5,2) NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "Sale_status_createdAt_idx" ON "Sale"("status", "createdAt");
