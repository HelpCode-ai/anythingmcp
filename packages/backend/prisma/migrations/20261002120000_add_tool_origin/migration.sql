-- Which tools a catalog update may touch: "catalog" (installed or synced from
-- an adapter) or "user" (written by hand). A full catalog resync used to
-- retire every tool not in the catalog, including tools a user had added to a
-- catalog connector themselves.
--
-- Added without a default first, so existing rows stay NULL rather than all
-- becoming "user"; then the clear cases are backfilled. Rows left NULL (tools
-- added to a catalog connector after its install) are decided at runtime
-- against the adapter's tool names.
ALTER TABLE "mcp_tools" ADD COLUMN "origin" TEXT;
ALTER TABLE "mcp_tools" ALTER COLUMN "origin" SET DEFAULT 'user';

-- Tools created with a catalog connector's install.
UPDATE "mcp_tools" t SET "origin" = 'catalog'
FROM "connectors" c
WHERE t."connector_id" = c."id"
  AND c."config"->>'adapterSlug' IS NOT NULL
  AND t."created_at" <= c."created_at" + interval '10 minutes';

-- Every tool of a connector that is not from the catalog is the user's.
UPDATE "mcp_tools" t SET "origin" = 'user'
FROM "connectors" c
WHERE t."connector_id" = c."id"
  AND c."config"->>'adapterSlug' IS NULL
  AND t."origin" IS NULL;
