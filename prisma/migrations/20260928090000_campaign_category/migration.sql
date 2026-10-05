-- Adds a business category to Campaign: why it was sent (promotion, seasonal,
-- event...). Separate from Template.category, which is the message type and
-- drives Meta billing. Additive only: existing campaigns become OTHER.

-- CreateEnum
CREATE TYPE "CampaignCategory" AS ENUM ('PROMOTION', 'SEASONAL', 'EVENT', 'AWARENESS', 'FOLLOW_UP', 'ANNOUNCEMENT', 'OTHER');

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "category" "CampaignCategory" NOT NULL DEFAULT 'OTHER';

-- CreateIndex
CREATE INDEX "Campaign_whatsappNumberId_category_idx" ON "Campaign"("whatsappNumberId", "category");
