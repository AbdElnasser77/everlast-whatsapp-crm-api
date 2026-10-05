-- Pause (instead of failing everyone) when Meta refuses a campaign send for an
-- account-wide reason, and keep a readable reason for the pause. Additive.

-- AlterEnum
ALTER TYPE "CampaignPauseReason" ADD VALUE 'SEND_ERROR';

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "pauseDetail" TEXT;
