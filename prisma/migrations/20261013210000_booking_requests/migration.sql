-- CreateEnum
CREATE TYPE "BookingRequestStatus" AS ENUM ('NEW', 'IN_PROGRESS', 'BOOKED', 'NOT_BOOKED');

-- CreateEnum
CREATE TYPE "BookingRequestSource" AS ENUM ('FLOW', 'AGENT');

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "campaignId" INTEGER,
ADD COLUMN     "doctor" TEXT,
ADD COLUMN     "dok32Ref" TEXT,
ADD COLUMN     "requestId" INTEGER;

-- CreateTable
CREATE TABLE "BookingRequest" (
    "id" SERIAL NOT NULL,
    "conversationId" INTEGER NOT NULL,
    "customerId" INTEGER NOT NULL,
    "whatsappNumberId" INTEGER NOT NULL,
    "source" "BookingRequestSource" NOT NULL,
    "campaignId" INTEGER,
    "flowRunId" INTEGER,
    "requested" JSONB NOT NULL DEFAULT '{}',
    "note" TEXT,
    "status" "BookingRequestStatus" NOT NULL DEFAULT 'NEW',
    "claimedById" INTEGER,
    "claimedAt" TIMESTAMP(3),
    "handledById" INTEGER,
    "handledAt" TIMESTAMP(3),
    "notBookedReason" TEXT,
    "notBookedNote" TEXT,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BookingRequest_flowRunId_key" ON "BookingRequest"("flowRunId");

-- CreateIndex
CREATE INDEX "BookingRequest_whatsappNumberId_status_createdAt_idx" ON "BookingRequest"("whatsappNumberId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "BookingRequest_status_createdAt_idx" ON "BookingRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "BookingRequest_conversationId_idx" ON "BookingRequest"("conversationId");

-- CreateIndex
CREATE INDEX "BookingRequest_campaignId_idx" ON "BookingRequest"("campaignId");

-- CreateIndex
CREATE INDEX "Booking_requestId_idx" ON "Booking"("requestId");

-- CreateIndex
CREATE INDEX "Booking_campaignId_idx" ON "Booking"("campaignId");

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "BookingRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingRequest" ADD CONSTRAINT "BookingRequest_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingRequest" ADD CONSTRAINT "BookingRequest_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingRequest" ADD CONSTRAINT "BookingRequest_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingRequest" ADD CONSTRAINT "BookingRequest_claimedById_fkey" FOREIGN KEY ("claimedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingRequest" ADD CONSTRAINT "BookingRequest_handledById_fkey" FOREIGN KEY ("handledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

