-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "SectionType" ADD VALUE 'STORY_SCROLL';
ALTER TYPE "SectionType" ADD VALUE 'PARALLAX_BANNER';
ALTER TYPE "SectionType" ADD VALUE 'HORIZONTAL_RAIL';
ALTER TYPE "SectionType" ADD VALUE 'PROCESS_STEPS';

-- CreateTable
CREATE TABLE "page_templates" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "suggestedTitle" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "blocks" JSONB NOT NULL DEFAULT '[]',
    "isHidden" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "page_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "page_templates_key_key" ON "page_templates"("key");

-- CreateIndex
CREATE INDEX "page_templates_deletedAt_idx" ON "page_templates"("deletedAt");

-- CreateIndex
CREATE INDEX "page_templates_isHidden_sortOrder_idx" ON "page_templates"("isHidden", "sortOrder");
