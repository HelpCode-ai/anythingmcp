# MOTIS routing engine for the Deutsche Bahn connector.
#
# The connector used to go through db-rest / db-vendo-client, which scrapes
# bahn.de. Deutsche Bahn blocks datacenter IPs and the library's own README now
# calls those endpoints "very unreliable" and recommends a self-hosted MOTIS.
# This image is that: the official MOTIS binary plus an entrypoint that pulls
# the open GTFS timetable for Germany's trains from gtfs.de (CC BY 4.0), runs
# the import, keeps a GTFS-RT feed polled for live delays and cancellations,
# and re-imports the static feed once a week so it never runs off the end of
# the 30-day window the free feeds cover.
#
# Trains only (long-distance + regional/S-Bahn, ~12 MB of GTFS): the import
# takes about a second and peaks under 400 MB. The full Germany feed with every
# bus and tram is 280 MB and peaks at 7 GB on import, which would not fit next
# to the app on an 8 GB host. See README.md for the feed URLs and how to swap
# them.
FROM ghcr.io/motis-project/motis:2.11.3

USER root
COPY config.yml /motis-config/config.yml
COPY entrypoint.sh /entrypoint.sh
RUN chmod 0755 /entrypoint.sh && mkdir -p /data && chown motis:motis /data

USER motis
WORKDIR /data
EXPOSE 8080
# The first boot downloads and imports the feeds before the server listens;
# the compose healthchecks give that a longer start_period.
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:8080/ || exit 1
ENTRYPOINT ["/entrypoint.sh"]
CMD []
