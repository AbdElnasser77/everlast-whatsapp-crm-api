-- Campaign send safety: claim recipients before sending, a send-loop lease,
-- and one row per person per campaign.

ALTER TYPE "CampaignRecipientStatus" ADD VALUE 'SENDING';

ALTER TABLE "CampaignRecipient" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "claimedAt" TIMESTAMP(3);

ALTER TABLE "Campaign" ADD COLUMN "lockedBy" TEXT,
ADD COLUMN "lockedUntil" TIMESTAMP(3);

-- Remove existing duplicates before the unique index. Per (campaign, customer)
-- keep the row that already went somewhere (not PENDING), else the oldest.
DELETE FROM "CampaignRecipient" r
USING (
  SELECT id, ROW_NUMBER() OVER (
           PARTITION BY "campaignId", "customerId"
           ORDER BY (status = 'PENDING') ASC, id ASC
         ) AS rn
  FROM "CampaignRecipient"
) ranked
WHERE r.id = ranked.id AND ranked.rn > 1;

-- A separate statement, so it sees the rows the delete above removed.
UPDATE "Campaign" c
SET "totalRecipients" = x.n
FROM (SELECT "campaignId", COUNT(*)::int AS n FROM "CampaignRecipient" GROUP BY "campaignId") x
WHERE x."campaignId" = c.id AND c."totalRecipients" > x.n;

CREATE UNIQUE INDEX "CampaignRecipient_campaignId_customerId_key" ON "CampaignRecipient"("campaignId", "customerId");
