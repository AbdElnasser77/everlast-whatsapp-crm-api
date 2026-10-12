-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "CampaignPauseReason" ADD VALUE 'RATE_LIMIT';
ALTER TYPE "CampaignPauseReason" ADD VALUE 'CONNECTION';
ALTER TYPE "CampaignPauseReason" ADD VALUE 'TEMPLATE_UNAVAILABLE';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TemplateApprovalStatus" ADD VALUE 'PAUSED';
ALTER TYPE "TemplateApprovalStatus" ADD VALUE 'DISABLED';

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "resumeAt" TIMESTAMP(3),
ADD COLUMN     "skippedCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Template" ADD COLUMN     "metaCategory" TEXT;

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" SERIAL NOT NULL,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WebhookEvent_processedAt_receivedAt_idx" ON "WebhookEvent"("processedAt", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Message_whatsappMessageId_key" ON "Message"("whatsappMessageId");


-- Backfill the new skipped count for existing campaigns.
UPDATE "Campaign" c
SET "skippedCount" = x.n
FROM (SELECT "campaignId", COUNT(*)::int AS n FROM "CampaignRecipient" WHERE status = 'SKIPPED' GROUP BY "campaignId") x
WHERE x."campaignId" = c.id;
