-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "leadSource" TEXT;

-- AlterTable
ALTER TABLE "BookingRequest" ADD COLUMN     "leadSource" TEXT,
ADD COLUMN     "sourceConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "sourceConfirmedById" INTEGER,
ADD COLUMN     "sourceNote" TEXT,
ADD COLUMN     "sourceStatus" TEXT,
ADD COLUMN     "suggestedCampaignId" INTEGER;

-- AddForeignKey
ALTER TABLE "BookingRequest" ADD CONSTRAINT "BookingRequest_suggestedCampaignId_fkey" FOREIGN KEY ("suggestedCampaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Existing requests. Ones the booking flow made from a campaign are proven.
UPDATE "BookingRequest" SET "leadSource" = 'CAMPAIGN', "sourceStatus" = 'AUTOMATIC'
WHERE "source" = 'FLOW' AND "campaignId" IS NOT NULL;

-- Ones credited by the old 7-day guess are only a suggestion now: not counted
-- for the campaign until an agent confirms.
UPDATE "BookingRequest" SET "suggestedCampaignId" = "campaignId", "campaignId" = NULL, "sourceStatus" = 'SUGGESTED'
WHERE "source" = 'AGENT' AND "campaignId" IS NOT NULL;

-- Appointments follow their request.
UPDATE "Booking" b SET "campaignId" = r."campaignId", "leadSource" = r."leadSource"
FROM "BookingRequest" r WHERE b."requestId" = r.id;
