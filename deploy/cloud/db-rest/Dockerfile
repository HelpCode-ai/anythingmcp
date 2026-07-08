# Custom db-rest image for AnythingMCP Cloud.
#
# Two reasons this exists instead of using derhuerst/db-rest:6 directly:
#
#  1. Freshness — bump db-vendo-client to the latest patch so we track
#     Deutsche Bahn's frequently-changing upstream endpoints/hosts.
#  2. Egress proxy — db-vendo-client already honours HTTPS_PROXY (it builds an
#     https-proxy-agent from it). The cloud sets HTTPS_PROXY=$CONNECTOR_PROXY_URL
#     on this container so all upstream DB calls exit through the Zyte
#     web-unblocker, defeating Deutsche Bahn's Akamai block of datacenter IPs
#     (the `int.bahn.de` / `app.services-bahn.de` 403 / OPS_BLOCKED responses).
#
# No source changes — just a dependency bump on top of the upstream image.
FROM docker.io/derhuerst/db-rest:6
USER root
WORKDIR /app
RUN npm install db-vendo-client@6.10.12 --no-audit --no-fund
