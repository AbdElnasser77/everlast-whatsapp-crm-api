-- Carousel templates: 2-10 swipeable cards stored on the template. Additive.

-- AlterTable
ALTER TABLE "Template" ADD COLUMN     "cards" JSONB;
