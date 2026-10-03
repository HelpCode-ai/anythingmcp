-- Connector OAuth authorizations in flight. They used to live in an in-memory
-- map, which lost every pending consent on a restart or blue/green deploy and
-- never recorded more than which user started the flow. See the model comment.
CREATE TABLE "connector_oauth_attempts" (
    "id" TEXT NOT NULL,
    "state_hash" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "connector_id" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "return_to" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connector_oauth_attempts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "connector_oauth_attempts_state_hash_key" ON "connector_oauth_attempts"("state_hash");
CREATE INDEX "connector_oauth_attempts_expires_at_idx" ON "connector_oauth_attempts"("expires_at");
