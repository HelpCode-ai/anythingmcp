-- CreateTable
CREATE TABLE "licenses" (
    "id" TEXT NOT NULL,
    "license_key" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'community',
    "status" TEXT NOT NULL DEFAULT 'active',
    "features" JSONB,
    "expires_at" TIMESTAMP(3),
    "activated_at" TIMESTAMP(3),
    "instance_id" TEXT,
    "last_verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "licenses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "licenses_license_key_key" ON "licenses"("license_key");
