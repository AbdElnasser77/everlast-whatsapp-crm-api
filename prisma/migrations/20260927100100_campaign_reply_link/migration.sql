-- Links a campaign reply to the campaign it answers.
--
-- Message.campaignRecipientId: set on the inbound message that answers a
-- campaign. CampaignRecipient.repliedAt: when that recipient first replied
-- (what "Replied" counts). CampaignRecipient.messageId becomes a real foreign
-- key to the message the campaign sent; it was a bare integer. Checked before
-- writing: no recipient pointed at a missing message.

-- AlterTable
ALTER TABLE "CampaignRecipient" ADD COLUMN     "repliedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "campaignRecipientId" INTEGER;

-- CreateIndex
CREATE INDEX "CampaignRecipient_customerId_sentAt_idx" ON "CampaignRecipient"("customerId", "sentAt");

-- CreateIndex
CREATE INDEX "CampaignRecipient_messageId_idx" ON "CampaignRecipient"("messageId");

-- CreateIndex
CREATE INDEX "Message_campaignRecipientId_idx" ON "Message"("campaignRecipientId");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_campaignRecipientId_fkey" FOREIGN KEY ("campaignRecipientId") REFERENCES "CampaignRecipient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

