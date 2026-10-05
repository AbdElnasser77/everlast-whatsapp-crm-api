-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'MARKETING', 'AGENT');

-- CreateEnum
CREATE TYPE "SenderType" AS ENUM ('CUSTOMER', 'AGENT');

-- CreateEnum
CREATE TYPE "MessageType" AS ENUM ('TEXT', 'IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT', 'INTERACTIVE', 'STICKER');

-- CreateEnum
CREATE TYPE "TemplateCategory" AS ENUM ('GENERAL', 'RE_ENGAGEMENT', 'CAMPAIGN');

-- CreateEnum
CREATE TYPE "TemplateHeaderType" AS ENUM ('NONE', 'TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT');

-- CreateEnum
CREATE TYPE "TemplateApprovalStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('PENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED');

-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('OPEN', 'PENDING', 'RESOLVED');

-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('ONLINE', 'OFFLINE', 'ON_BREAK');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'SCHEDULED', 'RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CampaignRecipientStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE');

-- CreateEnum
CREATE TYPE "MediaAssetType" AS ENUM ('IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT');

-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "name" TEXT,
    "username" VARCHAR(20) NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'AGENT',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "status" "AgentStatus" NOT NULL DEFAULT 'OFFLINE',
    "lastActiveAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaAsset" (
    "id" SERIAL NOT NULL,
    "url" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "mediaType" "MediaAssetType" NOT NULL,
    "format" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "filename" TEXT,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" SERIAL NOT NULL,
    "chartNumber" TEXT,
    "name" TEXT,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "nationality" TEXT,
    "gender" "Gender",
    "dateOfBirth" DATE,
    "joinDate" DATE,
    "departments" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT,
    "optedOut" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactList" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContactList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Segment" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "definition" JSONB NOT NULL,
    "excludeOptedOut" BOOLEAN NOT NULL DEFAULT true,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Segment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListMember" (
    "id" SERIAL NOT NULL,
    "listId" INTEGER NOT NULL,
    "customerId" INTEGER NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ListMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" SERIAL NOT NULL,
    "customerId" INTEGER NOT NULL,
    "assignedAgentId" INTEGER,
    "status" "ConversationStatus" NOT NULL DEFAULT 'OPEN',
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "lastMessage" TEXT,
    "lastMessageAt" TIMESTAMP(3),
    "lastSenderType" "SenderType",
    "lastCustomerMessageAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" SERIAL NOT NULL,
    "conversationId" INTEGER NOT NULL,
    "senderType" "SenderType" NOT NULL,
    "senderId" INTEGER,
    "content" TEXT NOT NULL,
    "messageType" "MessageType" NOT NULL DEFAULT 'TEXT',
    "whatsappMessageId" TEXT,
    "mediaId" TEXT,
    "mediaUrl" TEXT,
    "status" "MessageStatus",
    "reactions" JSONB,
    "quotedMessageId" INTEGER,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Template" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "metaTemplateName" TEXT,
    "metaTemplateId" TEXT,
    "category" "TemplateCategory" NOT NULL DEFAULT 'GENERAL',
    "approvalStatus" "TemplateApprovalStatus" NOT NULL DEFAULT 'DRAFT',
    "rejectionReason" TEXT,
    "language" TEXT NOT NULL DEFAULT 'en_US',
    "headerType" "TemplateHeaderType" NOT NULL DEFAULT 'NONE',
    "header" TEXT,
    "headerMediaUrl" TEXT,
    "body" TEXT NOT NULL,
    "footer" TEXT,
    "buttons" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "templateId" INTEGER NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "scheduledAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "totalRecipients" INTEGER NOT NULL DEFAULT 0,
    "segmentId" INTEGER,
    "audienceSnapshot" JSONB,
    "createdById" INTEGER NOT NULL,
    "submittedById" INTEGER,
    "submittedAt" TIMESTAMP(3),
    "reviewedById" INTEGER,
    "reviewedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignRecipient" (
    "id" SERIAL NOT NULL,
    "campaignId" INTEGER NOT NULL,
    "customerId" INTEGER NOT NULL,
    "status" "CampaignRecipientStatus" NOT NULL DEFAULT 'PENDING',
    "messageId" INTEGER,
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" SERIAL NOT NULL,
    "action" TEXT NOT NULL,
    "actorId" INTEGER,
    "actorUsername" TEXT,
    "targetType" TEXT NOT NULL,
    "targetId" INTEGER NOT NULL,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE INDEX "MediaAsset_mediaType_idx" ON "MediaAsset"("mediaType");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_chartNumber_key" ON "Customer"("chartNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_phone_key" ON "Customer"("phone");

-- CreateIndex
CREATE INDEX "Segment_createdById_idx" ON "Segment"("createdById");

-- CreateIndex
CREATE INDEX "ListMember_customerId_idx" ON "ListMember"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "ListMember_listId_customerId_key" ON "ListMember"("listId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_customerId_key" ON "Conversation"("customerId");

-- CreateIndex
CREATE INDEX "Conversation_lastMessageAt_lastSenderType_status_idx" ON "Conversation"("lastMessageAt", "lastSenderType", "status");

-- CreateIndex
CREATE INDEX "Conversation_assignedAgentId_status_idx" ON "Conversation"("assignedAgentId", "status");

-- CreateIndex
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_whatsappMessageId_idx" ON "Message"("whatsappMessageId");

-- CreateIndex
CREATE INDEX "Message_senderType_createdAt_idx" ON "Message"("senderType", "createdAt");

-- CreateIndex
CREATE INDEX "Campaign_status_idx" ON "Campaign"("status");

-- CreateIndex
CREATE INDEX "CampaignRecipient_campaignId_idx" ON "CampaignRecipient"("campaignId");

-- CreateIndex
CREATE INDEX "AuditLog_targetType_targetId_idx" ON "AuditLog"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_idx" ON "AuditLog"("actorId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactList" ADD CONSTRAINT "ContactList_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Segment" ADD CONSTRAINT "Segment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListMember" ADD CONSTRAINT "ListMember_listId_fkey" FOREIGN KEY ("listId") REFERENCES "ContactList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListMember" ADD CONSTRAINT "ListMember_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_assignedAgentId_fkey" FOREIGN KEY ("assignedAgentId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_quotedMessageId_fkey" FOREIGN KEY ("quotedMessageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "Template"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "Segment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

