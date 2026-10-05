-- Multi-business (multi-tenancy).
--
-- Every tenant-owned table gains businessId, every relation BETWEEN tenant-owned
-- tables becomes a composite foreign key over (id, businessId), and the patient
-- uniques (phone, chartNumber) become per-business. See the Business model in
-- schema.prisma for the three-layer isolation design; this migration is layer 1,
-- the one that holds even if the application layers are bypassed.
--
-- Every pre-existing row is adopted into a bootstrap business with id 1. The
-- businessId columns default to 1 ONLY so the current application code keeps
-- working unchanged; the defaults are dropped once businessId is stamped
-- explicitly on every write, after which an insert with no business fails here
-- rather than silently joining business 1.
--
-- Verified before writing: the database held 1 user, 1 template, 1 WhatsApp
-- number and 11 audit rows, and nothing else — so adoption is exact.


-- DropForeignKey
ALTER TABLE "Campaign" DROP CONSTRAINT "Campaign_templateId_fkey";

-- DropForeignKey
ALTER TABLE "Campaign" DROP CONSTRAINT "Campaign_whatsappNumberId_fkey";

-- DropForeignKey
ALTER TABLE "Conversation" DROP CONSTRAINT "Conversation_customerId_fkey";

-- DropForeignKey
ALTER TABLE "Conversation" DROP CONSTRAINT "Conversation_whatsappNumberId_fkey";

-- DropForeignKey
ALTER TABLE "CustomerOptOut" DROP CONSTRAINT "CustomerOptOut_customerId_fkey";

-- DropForeignKey
ALTER TABLE "CustomerOptOut" DROP CONSTRAINT "CustomerOptOut_whatsappNumberId_fkey";

-- DropForeignKey
ALTER TABLE "ListMember" DROP CONSTRAINT "ListMember_customerId_fkey";

-- DropForeignKey
ALTER TABLE "ListMember" DROP CONSTRAINT "ListMember_listId_fkey";

-- DropIndex
DROP INDEX "Customer_chartNumber_key";

-- DropIndex
DROP INDEX "Customer_phone_key";

-- DropIndex
DROP INDEX "MediaAsset_mediaType_idx";

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "businessId" INTEGER;

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "businessId" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "ContactList" ADD COLUMN     "businessId" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "businessId" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "businessId" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "CustomerOptOut" ADD COLUMN     "businessId" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "ListMember" ADD COLUMN     "businessId" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "MediaAsset" ADD COLUMN     "businessId" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "Segment" ADD COLUMN     "businessId" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "Template" ADD COLUMN     "businessId" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "WhatsAppNumber" ADD COLUMN     "businessId" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "Business" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Business_pkey" PRIMARY KEY ("id")
);

-- Bootstrap business. Inserted with an explicit id so the column defaults above
-- have something to reference, then the sequence is moved past it — otherwise
-- the first business created through the app would collide with id 1.
INSERT INTO "Business" ("id", "name", "slug", "updatedAt")
VALUES (1, 'Everlast Wellness', 'everlast', CURRENT_TIMESTAMP);
SELECT setval(pg_get_serial_sequence('"Business"', 'id'), (SELECT MAX("id") FROM "Business"));


-- CreateTable
CREATE TABLE "UserBusiness" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "businessId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserBusiness_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Business_slug_key" ON "Business"("slug");

-- CreateIndex
CREATE INDEX "UserBusiness_businessId_idx" ON "UserBusiness"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "UserBusiness_userId_businessId_key" ON "UserBusiness"("userId", "businessId");

-- CreateIndex
CREATE INDEX "AuditLog_businessId_createdAt_idx" ON "AuditLog"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "Campaign_businessId_idx" ON "Campaign"("businessId");

-- CreateIndex
CREATE INDEX "ContactList_businessId_idx" ON "ContactList"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "ContactList_id_businessId_key" ON "ContactList"("id", "businessId");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_id_businessId_key" ON "Conversation"("id", "businessId");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_businessId_phone_key" ON "Customer"("businessId", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_businessId_chartNumber_key" ON "Customer"("businessId", "chartNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_id_businessId_key" ON "Customer"("id", "businessId");

-- CreateIndex
CREATE INDEX "MediaAsset_businessId_mediaType_idx" ON "MediaAsset"("businessId", "mediaType");

-- CreateIndex
CREATE INDEX "Segment_businessId_idx" ON "Segment"("businessId");

-- CreateIndex
CREATE INDEX "Template_businessId_idx" ON "Template"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "Template_id_businessId_key" ON "Template"("id", "businessId");

-- CreateIndex
CREATE INDEX "WhatsAppNumber_businessId_idx" ON "WhatsAppNumber"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppNumber_id_businessId_key" ON "WhatsAppNumber"("id", "businessId");

-- AddForeignKey
ALTER TABLE "UserBusiness" ADD CONSTRAINT "UserBusiness_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserBusiness" ADD CONSTRAINT "UserBusiness_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppNumber" ADD CONSTRAINT "WhatsAppNumber_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerOptOut" ADD CONSTRAINT "CustomerOptOut_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerOptOut" ADD CONSTRAINT "CustomerOptOut_customerId_businessId_fkey" FOREIGN KEY ("customerId", "businessId") REFERENCES "Customer"("id", "businessId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerOptOut" ADD CONSTRAINT "CustomerOptOut_whatsappNumberId_businessId_fkey" FOREIGN KEY ("whatsappNumberId", "businessId") REFERENCES "WhatsAppNumber"("id", "businessId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactList" ADD CONSTRAINT "ContactList_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Segment" ADD CONSTRAINT "Segment_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListMember" ADD CONSTRAINT "ListMember_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListMember" ADD CONSTRAINT "ListMember_listId_businessId_fkey" FOREIGN KEY ("listId", "businessId") REFERENCES "ContactList"("id", "businessId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListMember" ADD CONSTRAINT "ListMember_customerId_businessId_fkey" FOREIGN KEY ("customerId", "businessId") REFERENCES "Customer"("id", "businessId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_customerId_businessId_fkey" FOREIGN KEY ("customerId", "businessId") REFERENCES "Customer"("id", "businessId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_whatsappNumberId_businessId_fkey" FOREIGN KEY ("whatsappNumberId", "businessId") REFERENCES "WhatsAppNumber"("id", "businessId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Template" ADD CONSTRAINT "Template_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_templateId_businessId_fkey" FOREIGN KEY ("templateId", "businessId") REFERENCES "Template"("id", "businessId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_whatsappNumberId_businessId_fkey" FOREIGN KEY ("whatsappNumberId", "businessId") REFERENCES "WhatsAppNumber"("id", "businessId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Runs last, once UserBusiness and every foreign key exist.
--
-- Every existing user becomes a member of the bootstrap business. (Promotion of
-- the admin to OWNER is deliberately NOT done here: the role guards do not know
-- about OWNER yet, so promoting now would lock that account out of every admin
-- screen. It happens with the role changes.)
INSERT INTO "UserBusiness" ("userId", "businessId")
SELECT "id", 1 FROM "User";

-- Audit rows predate tenancy; they all happened in the bootstrap business.
UPDATE "AuditLog" SET "businessId" = 1 WHERE "businessId" IS NULL;

-- One default number PER BUSINESS, replacing the single global default. Hand
-- written for the same reason as before: Prisma cannot express a partial unique
-- index, and `prisma db push` would silently drop this one.
DROP INDEX IF EXISTS "WhatsAppNumber_single_default";
CREATE UNIQUE INDEX "WhatsAppNumber_single_default_per_business"
  ON "WhatsAppNumber" ("businessId") WHERE "isDefault";
