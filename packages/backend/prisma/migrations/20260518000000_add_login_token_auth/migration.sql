-- Add LOGIN_TOKEN to AuthType enum
ALTER TYPE "AuthType" ADD VALUE 'LOGIN_TOKEN';

-- CreateTable
CREATE TABLE "connector_auth_cache" (
    "id" TEXT NOT NULL,
    "connector_id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "metadata" JSONB,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connector_auth_cache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "connector_auth_cache_connector_id_key" ON "connector_auth_cache"("connector_id");

-- AddForeignKey
ALTER TABLE "connector_auth_cache" ADD CONSTRAINT "connector_auth_cache_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
