-- CreateTable
CREATE TABLE "oauth_clients" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_secret" TEXT,
    "client_name" TEXT NOT NULL,
    "client_description" TEXT,
    "logo_uri" TEXT,
    "client_uri" TEXT,
    "developer_name" TEXT,
    "developer_email" TEXT,
    "redirect_uris" TEXT[],
    "grant_types" TEXT[],
    "response_types" TEXT[],
    "token_endpoint_auth_method" TEXT NOT NULL DEFAULT 'none',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "oauth_clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_authorization_codes" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "redirect_uri" TEXT NOT NULL,
    "code_challenge" TEXT NOT NULL,
    "code_challenge_method" TEXT NOT NULL,
    "resource" TEXT,
    "scope" TEXT,
    "expires_at" INTEGER NOT NULL,
    "user_profile_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_authorization_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_sessions" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "client_id" TEXT,
    "redirect_uri" TEXT,
    "code_challenge" TEXT,
    "code_challenge_method" TEXT,
    "oauth_state" TEXT,
    "scope" TEXT,
    "resource" TEXT,
    "expires_at" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_user_profiles" (
    "id" TEXT NOT NULL,
    "profile_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT,
    "display_name" TEXT,
    "avatar_url" TEXT,
    "raw" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "oauth_user_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "oauth_clients_client_id_key" ON "oauth_clients"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_authorization_codes_code_key" ON "oauth_authorization_codes"("code");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_sessions_session_id_key" ON "oauth_sessions"("session_id");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_user_profiles_profile_id_key" ON "oauth_user_profiles"("profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_user_profiles_provider_external_id_key" ON "oauth_user_profiles"("provider", "external_id");
