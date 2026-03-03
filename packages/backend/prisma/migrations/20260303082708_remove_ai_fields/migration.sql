/*
  Warnings:

  - You are about to drop the column `ai_api_key` on the `users` table. All the data in the column will be lost.
  - You are about to drop the column `ai_model` on the `users` table. All the data in the column will be lost.
  - You are about to drop the column `ai_provider` on the `users` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "users" DROP COLUMN "ai_api_key",
DROP COLUMN "ai_model",
DROP COLUMN "ai_provider";
