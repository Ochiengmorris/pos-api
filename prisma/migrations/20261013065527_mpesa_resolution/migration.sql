-- CreateEnum
CREATE TYPE "MpesaResolution" AS ENUM ('REFUNDED', 'WRITTEN_OFF');

-- AlterTable
ALTER TABLE "MpesaPayment" ADD COLUMN     "resolution" "MpesaResolution",
ADD COLUMN     "resolutionNote" TEXT,
ADD COLUMN     "resolvedAt" TIMESTAMP(3),
ADD COLUMN     "resolvedById" TEXT;
