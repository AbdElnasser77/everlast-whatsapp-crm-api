-- AlterEnum
ALTER TYPE "CampaignPauseReason" ADD VALUE 'QUALITY';

-- AlterTable
ALTER TABLE "WhatsAppNumber" ADD COLUMN     "metaStatus" TEXT,
ADD COLUMN     "qualityCheckedAt" TIMESTAMP(3),
ADD COLUMN     "qualityRating" TEXT;

-- CreateTable
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" INTEGER,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
);

