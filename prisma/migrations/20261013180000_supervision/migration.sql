-- CreateEnum
CREATE TYPE "ConversationOutcome" AS ENUM ('BOOKED', 'NOT_INTERESTED', 'FOLLOW_UP', 'NO_ANSWER');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('BOOKED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'SUPERVISOR';

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "awaitingReplySince" TIMESTAMP(3),
ADD COLUMN     "followUpAt" TIMESTAMP(3),
ADD COLUMN     "lastAgentReplyAt" TIMESTAMP(3),
ADD COLUMN     "outcome" "ConversationOutcome",
ADD COLUMN     "outcomeAt" TIMESTAMP(3),
ADD COLUMN     "outcomeById" INTEGER;

-- CreateTable
CREATE TABLE "Booking" (
    "id" SERIAL NOT NULL,
    "conversationId" INTEGER NOT NULL,
    "customerId" INTEGER NOT NULL,
    "whatsappNumberId" INTEGER NOT NULL,
    "createdById" INTEGER,
    "appointmentAt" TIMESTAMP(3) NOT NULL,
    "service" TEXT,
    "note" TEXT,
    "status" "BookingStatus" NOT NULL DEFAULT 'BOOKED',
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationNote" (
    "id" SERIAL NOT NULL,
    "conversationId" INTEGER NOT NULL,
    "authorId" INTEGER,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Booking_customerId_appointmentAt_idx" ON "Booking"("customerId", "appointmentAt");

-- CreateIndex
CREATE INDEX "Booking_createdAt_idx" ON "Booking"("createdAt");

-- CreateIndex
CREATE INDEX "Booking_appointmentAt_idx" ON "Booking"("appointmentAt");

-- CreateIndex
CREATE INDEX "ConversationNote_conversationId_createdAt_idx" ON "ConversationNote"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "Conversation_awaitingReplySince_idx" ON "Conversation"("awaitingReplySince");

-- CreateIndex
CREATE INDEX "Conversation_outcome_followUpAt_idx" ON "Conversation"("outcome", "followUpAt");

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_outcomeById_fkey" FOREIGN KEY ("outcomeById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationNote" ADD CONSTRAINT "ConversationNote_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationNote" ADD CONSTRAINT "ConversationNote_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Backfill: chats where the patient spoke last and nobody has answered yet.
UPDATE "Conversation" SET "awaitingReplySince" = "lastCustomerMessageAt"
WHERE "lastSenderType" = 'CUSTOMER' AND "status" <> 'RESOLVED' AND "lastCustomerMessageAt" IS NOT NULL;

-- Backfill: the last time a staff member replied in each chat.
UPDATE "Conversation" c SET "lastAgentReplyAt" = m.last
FROM (SELECT "conversationId", MAX("createdAt") AS last FROM "Message" WHERE "senderType" = 'AGENT' AND "senderId" IS NOT NULL GROUP BY "conversationId") m
WHERE m."conversationId" = c.id;
