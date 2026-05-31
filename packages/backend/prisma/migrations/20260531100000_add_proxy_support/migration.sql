-- Per-tool proxy/unblocker preference. Seeded from the adapter spec on
-- import; user-toggleable in the UI. No effect when CONNECTOR_PROXY_URL
-- is unset.
ALTER TABLE "mcp_tools"
  ADD COLUMN "use_proxy" BOOLEAN NOT NULL DEFAULT false;

-- Per-workspace hourly cap on proxy-routed tool calls (cloud only).
-- null = use the PROXY_RATE_LIMIT_DEFAULT env (default 100). Editable
-- only by a service admin directly in the DB.
ALTER TABLE "organizations"
  ADD COLUMN "proxy_rate_limit" INTEGER;
