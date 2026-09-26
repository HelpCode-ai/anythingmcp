#!/usr/bin/env bash
# One-command local install: writes .env, starts AnythingMCP with Docker,
# creates the first admin, installs this repository's connector(s) and an MCP
# API key, then prints how to connect Claude, Cursor or VS Code.
#
#   ./scripts/install.sh
#
# Safe to re-run: it keeps an existing .env and reuses the admin account and
# API key it created the first time. Needs Docker 24+, openssl and Node 18+.
set -euo pipefail

cd "$(dirname "$0")/.."
API="http://localhost:${BACKEND_PORT:-4000}"
UI="http://localhost:${FRONTEND_PORT:-3000}"

manifest() { node -e 'const m=require("./satellite.json");const v=eval(process.argv[1]);process.stdout.write(v==null?"":String(v))' "$1"; }
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s||"{}");const v=eval(process.argv[1]);process.stdout.write(v==null?"":String(v))})' "$1"; }
getenv() { grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2- || true; }
setenv() {
  if grep -qE "^$1=" .env; then
    node -e 'const fs=require("fs");const [k,v]=process.argv.slice(1);fs.writeFileSync(".env",fs.readFileSync(".env","utf8").replace(new RegExp("^"+k+"=.*$","m"),()=>k+"="+v))' "$1" "$2"
  else
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
}

# 1. Secrets and credentials file ------------------------------------------------
if [ ! -f .env ]; then
  cp .env.example .env
  setenv JWT_SECRET "$(openssl rand -hex 32)"
  setenv ENCRYPTION_KEY "$(openssl rand -hex 32)"
  setenv AMCP_ADMIN_EMAIL "admin@example.com"
  setenv AMCP_ADMIN_PASSWORD "Amcp-$(openssl rand -hex 12)!"
  chmod 600 .env
  echo "Wrote .env with fresh secrets. Keep it: ENCRYPTION_KEY decrypts your stored credentials."
fi

# 2. Start the stack ----------------------------------------------------------------
echo "Starting AnythingMCP (first pull takes a minute)..."
docker compose up -d --wait

# 3. First admin, or log in if it already exists -------------------------------------
EMAIL="$(getenv AMCP_ADMIN_EMAIL)"; PASSWORD="$(getenv AMCP_ADMIN_PASSWORD)"
# Node scripts are single-quoted on purpose: macOS ships bash 3.2, which
# brace-expands {a:1,b:2} inside nested "$( … )" quotes.
BODY=$(node -e 'console.log(JSON.stringify({email:process.argv[1],password:process.argv[2],name:"Admin",acceptTerms:true}))' "$EMAIL" "$PASSWORD")
LOGIN=$(node -e 'console.log(JSON.stringify({email:process.argv[1],password:process.argv[2]}))' "$EMAIL" "$PASSWORD")
CODE=$(curl -s -o /tmp/amcp-auth.json -w '%{http_code}' -H 'content-type: application/json' -d "$BODY" "$API/api/auth/register")
if [ "$CODE" != "201" ] && [ "$CODE" != "200" ]; then
  CODE=$(curl -s -o /tmp/amcp-auth.json -w '%{http_code}' -H 'content-type: application/json' -d "$LOGIN" "$API/api/auth/login")
  [ "$CODE" = "200" ] || [ "$CODE" = "201" ] || { echo "Could not register or log in ($CODE): $(cat /tmp/amcp-auth.json)"; exit 1; }
fi
TOKEN=$(json 'j.accessToken' < /tmp/amcp-auth.json)
rm -f /tmp/amcp-auth.json
AUTH=(-H "Authorization: Bearer $TOKEN" -H 'content-type: application/json')

# 4. Install the connector(s) --------------------------------------------------------
SETUP_TYPE=$(manifest 'm.setup.type')
if [ "$SETUP_TYPE" = "soap" ]; then
  NAME=$(manifest 'm.setup.name'); BASE=$(manifest 'm.setup.baseUrl'); WSDL=$(manifest 'm.setup.wsdl')
  EXISTING=$(curl -s "${AUTH[@]}" "$API/api/connectors" | json "(Array.isArray(j)?j:j.items||j.data||[]).find(c=>c.name==='$NAME')?.id")
  if [ -z "$EXISTING" ]; then
    CREATE=$(node -e 'console.log(JSON.stringify({name:process.argv[1],type:"SOAP",baseUrl:process.argv[2],specUrl:process.argv[3]}))' "$NAME" "$BASE" "$WSDL")
    ID=$(curl -s "${AUTH[@]}" -d "$CREATE" "$API/api/connectors" | json 'j.id')
    [ -n "$ID" ] || { echo "Could not create the SOAP connector."; exit 1; }
    IMPORT=$(node -e 'console.log(JSON.stringify({source:"wsdl",url:process.argv[1]}))' "$WSDL")
    RES=$(curl -s "${AUTH[@]}" -d "$IMPORT" "$API/api/connectors/$ID/import")
    ERR=$(printf '%s' "$RES" | json 'j.error')
    [ -z "$ERR" ] || { echo "WSDL import failed: $ERR"; exit 1; }
    echo "SOAP connector created: $(printf '%s' "$RES" | json '(j.created ?? (j.tools||[]).length)') tools imported from $WSDL"
  else
    echo "SOAP connector '$NAME' already exists."
  fi
else
  INSTALLED=$(curl -s "${AUTH[@]}" "$API/api/connectors" | json '(Array.isArray(j)?j:j.items||[]).map(c=>c.config&&c.config.adapterSlug).filter(Boolean).join(" ")')
  for SLUG in $(manifest "m.adapters.map(a=>a.slug).join(' ')"); do
    case " $INSTALLED " in *" $SLUG "*) echo "$SLUG: already installed."; continue ;; esac
    VARS=$(manifest "m.adapters.find(a=>a.slug==='$SLUG').requiredEnvVars.join(' ')")
    MISSING=""; CREDS="{}"
    for V in $VARS; do
      VAL="$(getenv "$V")"
      if [ -z "$VAL" ]; then MISSING="$MISSING $V"; else
        CREDS=$(node -e 'const o=JSON.parse(process.argv[1]);o[process.argv[2]]=process.argv[3];console.log(JSON.stringify(o))' "$CREDS" "$V" "$VAL")
      fi
    done
    if [ -n "$MISSING" ]; then
      echo "Skipping $SLUG: set$MISSING in .env and re-run, or install it in the UI: $UI/connectors/store?install=$SLUG"
      continue
    fi
    RES=$(curl -s "${AUTH[@]}" -d "{\"credentials\":$CREDS}" "$API/api/adapters/$SLUG/import")
    echo "$SLUG: $(printf '%s' "$RES" | json "j.toolsCreated!=null ? j.toolsCreated+' tools installed'+(j.probe&&j.probe.ok===false?' (test call failed: check the credentials)':'') : (j.message||'import failed')")"
  done
fi

# 5. MCP API key ----------------------------------------------------------------------
if [ -z "$(getenv MCP_API_KEY)" ]; then
  KEY=$(curl -s "${AUTH[@]}" -d '{"name":"local install"}' "$API/api/mcp-keys" | json 'j.key')
  [ -n "$KEY" ] || { echo "Could not create an MCP API key."; exit 1; }
  setenv MCP_API_KEY "$KEY"
  setenv MCP_URL "$API/mcp"
fi
KEY="$(getenv MCP_API_KEY)"

cat <<DONE

AnythingMCP is running.
  Web UI      $UI   (login: $EMAIL / password in .env)
  MCP server  $API/mcp
  API key     stored in .env as MCP_API_KEY

Connect Claude Code:
  claude mcp add --transport http $(manifest 'm.repo') $API/mcp --header "X-API-Key: $KEY"

Check it end to end:
  npm install && node scripts/smoke.mjs
DONE
