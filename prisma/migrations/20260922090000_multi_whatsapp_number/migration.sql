-- Multi-WhatsApp-number support.
--
-- Ordering matters. The old `Conversation_customerId_key` unique index is what
-- makes a second conversation for the same customer impossible, so it must be
-- DROPPED before the new composite unique is created — the reverse order leaves
-- a window in which a legitimate second-number conversation is still rejected.
--
-- Backfill notes for a database that is NOT empty:
--   * Conversation and Campaign are assumed empty here (verified before writing
--     this migration). If they are not, add the three columns as NULLABLE, run
--     `UPDATE ... SET "whatsappNumberId" = <bootstrap id>`, and only then SET NOT
--     NULL. The FK additions at the bottom must follow the backfill either way.
--   * Template.wabaId is handled below with a temporary DEFAULT, because rows
--     already exist.

-- ---------------------------------------------------------------------------
-- New tables
-- ---------------------------------------------------------------------------

CREATE TABLE "WhatsAppNumber" (
    "id" SERIAL NOT NULL,
    "label" TEXT NOT NULL,
    "phoneNumberId" TEXT NOT NULL,
    "wabaId" TEXT NOT NULL,
    "displayPhoneNumber" TEXT,
    "tokenEnvKey" TEXT NOT NULL,
    "appId" TEXT,
    "sendConcurrency" INTEGER NOT NULL DEFAULT 5,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppNumber_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CustomerOptOut" (
    "id" SERIAL NOT NULL,
    "customerId" INTEGER NOT NULL,
    "whatsappNumberId" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "optedOutAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerOptOut_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WhatsAppNumber_phoneNumberId_key" ON "WhatsAppNumber"("phoneNumberId");
CREATE INDEX "WhatsAppNumber_wabaId_idx" ON "WhatsAppNumber"("wabaId");
CREATE INDEX "WhatsAppNumber_isActive_idx" ON "WhatsAppNumber"("isActive");

-- At most one default number. Prisma 5 cannot express a partial unique index in
-- schema.prisma, so this is hand-written and has no @@unique counterpart there.
-- It is a backstop: the admin controller also flips isDefault inside a
-- transaction. Do not replace this migration with `prisma db push`, which would
-- silently drop it.
CREATE UNIQUE INDEX "WhatsAppNumber_single_default" ON "WhatsAppNumber"("isDefault") WHERE "isDefault";

CREATE INDEX "CustomerOptOut_whatsappNumberId_idx" ON "CustomerOptOut"("whatsappNumberId");
CREATE UNIQUE INDEX "CustomerOptOut_customerId_whatsappNumberId_key" ON "CustomerOptOut"("customerId", "whatsappNumberId");

-- ---------------------------------------------------------------------------
-- Template: WABA scoping
-- ---------------------------------------------------------------------------

-- Rows already exist, so the column cannot go straight to NOT NULL. The empty
-- string is a deliberate tombstone: such a template matches no real WABA and so
-- is invisible everywhere until adopted. `npm run seed:numbers` claims any
-- wabaId = '' template for the default number's WABA.
ALTER TABLE "Template" ADD COLUMN "wabaId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Template" ALTER COLUMN "wabaId" DROP DEFAULT;

CREATE INDEX "Template_wabaId_isActive_idx" ON "Template"("wabaId", "isActive");
CREATE UNIQUE INDEX "Template_wabaId_metaTemplateName_key" ON "Template"("wabaId", "metaTemplateName");

-- ---------------------------------------------------------------------------
-- Conversation: one thread per (customer, number)
-- ---------------------------------------------------------------------------

ALTER TABLE "Conversation" ADD COLUMN "whatsappNumberId" INTEGER NOT NULL;

-- Drop the 1:1 constraint FIRST (see header note).
DROP INDEX "Conversation_customerId_key";
DROP INDEX "Conversation_lastMessageAt_lastSenderType_status_idx";
DROP INDEX "Conversation_assignedAgentId_status_idx";

CREATE UNIQUE INDEX "Conversation_customerId_whatsappNumberId_key" ON "Conversation"("customerId", "whatsappNumberId");
CREATE INDEX "Conversation_whatsappNumberId_lastMessageAt_lastSenderType__idx" ON "Conversation"("whatsappNumberId", "lastMessageAt", "lastSenderType", "status");
CREATE INDEX "Conversation_whatsappNumberId_assignedAgentId_status_idx" ON "Conversation"("whatsappNumberId", "assignedAgentId", "status");
CREATE INDEX "Conversation_whatsappNumberId_status_idx" ON "Conversation"("whatsappNumberId", "status");

-- ---------------------------------------------------------------------------
-- Campaign: which line it sends from
-- ---------------------------------------------------------------------------

ALTER TABLE "Campaign" ADD COLUMN "whatsappNumberId" INTEGER NOT NULL;

DROP INDEX "Campaign_status_idx";
CREATE INDEX "Campaign_whatsappNumberId_status_idx" ON "Campaign"("whatsappNumberId", "status");

-- ---------------------------------------------------------------------------
-- Foreign keys
-- ---------------------------------------------------------------------------

ALTER TABLE "CustomerOptOut" ADD CONSTRAINT "CustomerOptOut_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerOptOut" ADD CONSTRAINT "CustomerOptOut_whatsappNumberId_fkey" FOREIGN KEY ("whatsappNumberId") REFERENCES "WhatsAppNumber"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_whatsappNumberId_fkey" FOREIGN KEY ("whatsappNumberId") REFERENCES "WhatsAppNumber"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_whatsappNumberId_fkey" FOREIGN KEY ("whatsappNumberId") REFERENCES "WhatsAppNumber"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
