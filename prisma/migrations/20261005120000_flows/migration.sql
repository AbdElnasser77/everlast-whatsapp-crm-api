-- Flows: saved campaign automations (Flow), one customer's pass through one
-- (FlowRun), a BOT sender for automated messages, and Campaign.flowId. Additive.

-- CreateEnum
CREATE TYPE "FlowRunStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'HANDED_OFF', 'STOPPED', 'EXPIRED', 'FAILED');

-- AlterEnum
ALTER TYPE "SenderType" ADD VALUE 'BOT';

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "flowId" INTEGER;

-- CreateTable
CREATE TABLE "Flow" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "graph" JSONB NOT NULL,
    "createdById" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Flow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FlowRun" (
    "id" SERIAL NOT NULL,
    "flowId" INTEGER NOT NULL,
    "conversationId" INTEGER NOT NULL,
    "customerId" INTEGER NOT NULL,
    "campaignId" INTEGER,
    "status" "FlowRunStatus" NOT NULL DEFAULT 'ACTIVE',
    "currentNodeId" TEXT,
    "data" JSONB NOT NULL DEFAULT '{}',
    "lastError" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "FlowRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FlowRun_conversationId_status_idx" ON "FlowRun"("conversationId", "status");

-- CreateIndex
CREATE INDEX "FlowRun_flowId_startedAt_idx" ON "FlowRun"("flowId", "startedAt");

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "Flow"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Flow" ADD CONSTRAINT "Flow_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FlowRun" ADD CONSTRAINT "FlowRun_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "Flow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FlowRun" ADD CONSTRAINT "FlowRun_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FlowRun" ADD CONSTRAINT "FlowRun_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FlowRun" ADD CONSTRAINT "FlowRun_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

