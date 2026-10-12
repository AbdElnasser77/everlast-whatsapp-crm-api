-- Idempotent sends: the browser's id for each message a person sends, unique
-- so a double click or retry can never send it twice. Additive (nullable).

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "clientMessageId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Message_clientMessageId_key" ON "Message"("clientMessageId");
