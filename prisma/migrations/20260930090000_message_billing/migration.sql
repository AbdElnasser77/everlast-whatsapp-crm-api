-- Keeps Meta's billing verdict and failure reason on each outbound message,
-- taken from the status webhook (pricing block and errors[0]). Additive and
-- nullable: older messages simply have no billing data.

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "billable" BOOLEAN,
ADD COLUMN     "errorCode" INTEGER,
ADD COLUMN     "errorTitle" TEXT,
ADD COLUMN     "pricingCategory" TEXT,
ADD COLUMN     "pricingType" TEXT;
