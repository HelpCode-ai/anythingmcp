# MOTIS for the Deutsche Bahn connector

The `deutsche-bahn` adapter talks to a [MOTIS](https://github.com/motis-project/motis)
instance (MIT) instead of scraping bahn.de. This directory builds one that is
ready to run: the official MOTIS binary plus an entrypoint that downloads the
open German train timetable, imports it, polls a GTFS-RT feed for live delays
and cancellations, and re-imports the static feed once a week.

## Why not db-rest / bahn.de

Until v0.8.1 the connector went through `db-rest` (db-vendo-client), which
calls Deutsche Bahn's undocumented web and app endpoints. Deutsche Bahn blocks
datacenter IP ranges, so from a hosted server every call failed (HTTP 500 /
`OPS_BLOCKED`), and the library's own README now describes those endpoints
as very unreliable and recommends a self-hosted MOTIS. Open data does not get
blocked.

## What it serves

| piece | source | licence |
|---|---|---|
| Long-distance trains (ICE, IC, EC, ECE, EN, railjet, night trains) | [gtfs.de `de_fv`](https://gtfs.de/en/feeds/de_fv/) | CC BY 4.0 |
| Regional trains and S-Bahn | [gtfs.de `de_rv`](https://gtfs.de/en/feeds/de_rv/) | CC BY 4.0 |
| Live delays, platform changes, cancellations, service alerts | [gtfs.de GTFS-RT](https://gtfs.de/en/realtime/) `realtime-free.pb` | CC BY-SA 4.0 |

The free static feeds cover the next 30 days and are re-downloaded every
`MOTIS_REFRESH_DAYS` (default 7). Buses, trams and ferries are deliberately
left out: adding them (`de_full`, 280 MB) takes the import from one second and
under 400 MB of RAM to about 7 GB.

Attribution: gtfs.de asks that data users name **DELFI e.V.** as the source;
the connector's instructions and the adapter's `docsUrl` do.

## Running it

Cloud (`docker-compose.cloud.yml`) runs it as the `motis` service and points
the app at it with `MOTIS_INTERNAL_URL=http://motis:8080`. Self-host:

```bash
# in .env
COMPOSE_PROFILES=motis
MOTIS_INTERNAL_URL=http://motis:8080
SSRF_ALLOWED_HOSTS=motis
docker compose up -d
```

When `MOTIS_INTERNAL_URL` is set the adapter's `MOTIS_URL` is filled in
automatically at import and hidden from the install form. Without it, the
install form asks for the URL of a MOTIS instance you run elsewhere.

`http://localhost:8080/` serves the MOTIS UI once the import is done; the
connector uses `/api/v1/geocode`, `/api/v1/stoptimes` and `/api/v1/plan`.

## Environment

| variable | default | meaning |
|---|---|---|
| `MOTIS_REFRESH_DAYS` | `7` | re-download and re-import the static feeds after this many days |
| `MOTIS_REFRESH_CHECK_SECONDS` | `3600` | how often the running container checks whether a refresh is due |
| `MOTIS_GTFS_FV_URL` | gtfs.de `fv_free/latest.zip` | long-distance feed |
| `MOTIS_GTFS_RV_URL` | gtfs.de `rv_free/latest.zip` | regional feed |
| `MOTIS_GTFS_RT_URL` | gtfs.de `realtime-free.pb` | GTFS-RT feed polled every 120 s |
| `MOTIS_DATA_DIR` | `/data` | volume with feeds, imported data and the refresh stamp |

gtfs.de also sells complete feeds with extended route types (so an ICE reports
`HIGHSPEED_RAIL` rather than `REGIONAL_RAIL`) and no 30-day limit; point the
URL variables at those and nothing else changes.

## Not Transitous

[Transitous](https://transitous.org) runs the same stack as a public service
and is a good way to try the API, but its policy forbids commercial use and
asks for a User-Agent naming the app and a contact. The adapter therefore
never defaults to it; if you qualify, entering `https://api.transitous.org` as
`MOTIS_URL` works.
