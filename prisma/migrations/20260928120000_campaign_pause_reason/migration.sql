-- Records why a campaign is PAUSED, so the scheduler can auto-resume the ones
-- it paused for quiet hours and never one a person paused. Nullable: existing
-- paused campaigns stay null, which is treated like MANUAL (not auto-resumed).

-- CreateEnum
CREATE TYPE "CampaignPauseReason" AS ENUM ('MANUAL', 'QUIET_HOURS', 'NUMBER_INACTIVE');

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "pauseReason" "CampaignPauseReason";

-- CreateIndex
CREATE INDEX "Campaign_status_pauseReason_idx" ON "Campaign"("status", "pauseReason");
