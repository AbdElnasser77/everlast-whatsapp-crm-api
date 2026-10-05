-- When Meta last approved or rejected a template, for the "approved since your
-- last visit" badge. Nullable and additive.

-- AlterTable
ALTER TABLE "Template" ADD COLUMN     "statusChangedAt" TIMESTAMP(3);
