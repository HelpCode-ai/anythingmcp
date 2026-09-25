import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { extractEntity } from './static/entity-extraction';
import { fkCandidate } from './static/fk-inference';
import { deriveSlug, KgStaticService } from './kg-static.service';
import { extractFieldNames, extractIdentifiers, hashValue } from './identifier';

const MAX_INVOCATIONS_PER_RUN = 2000;
const MAX_PAIRS_PER_HASH = 6; // cap fan-out per shared value

/** Invocations read per page. Only ids and timestamps; payloads load separately. */
const PAGE_SIZE = 100;
/**
 * JSON bytes loaded into memory at once. A payload parses into several times
 * its JSON size as JS objects, so this, not the row count, is what bounds the
 * heap: 100 rows of a 3 MB bulk export took the cloud backend past its 4 GB
 * heap on 24 Sep 2026.
 */
const PAYLOAD_BATCH_BYTES = 8 * 1024 * 1024;
/** An invocation whose output JSON is larger than this contributes its input only. */
const MAX_OUTPUT_BYTES = 6 * 1024 * 1024;
/**
 * Stored jsonb is TOAST-compressed, often 5-10x for repetitive bulk exports,
 * so its stored size says little about what it costs to load. Values stored
 * above this are measured exactly (Postgres renders them to count); smaller
 * ones are estimated at COMPRESSION_ALLOWANCE times their stored size.
 */
const MEASURE_ABOVE_STORED_BYTES = 64 * 1024;
const COMPRESSION_ALLOWANCE = 8;
/** Occurrence rows read back per correlate pass. */
const MAX_CORRELATE_ROWS = 20_000;
/**
 * Rows per insert and hashes per correlate query, with the event loop handed
 * back in between.
 */
const WRITE_CHUNK = 1000;

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

interface PageRow {
  id: string;
  connectorId: string | null;
  createdAt: Date;
  intent: string | null;
  tool: { name: string } | null;
}

interface ValueRow {
  organizationId: string;
  connectorId: string;
  valueHash: string;
  entity: string;
  field: string;
  direction: string;
}

/**
 * Observational KG layer: learns relationships from real tool_invocations.
 *
 *   produces_consumes — a value that a tool OUTPUT also appears as another
 *                       tool's INPUT (data flow; valuable even single-connector).
 *   same_identity     — the same value seen across two connectors (suggested,
 *                       low confidence, awaits manual confirmation).
 *
 * PII-safe: only HMAC'd (per-org) identifier hashes are stored in kg_value_seen,
 * never raw values. Tenant isolation is application-layer (every query carries
 * organizationId). Idempotent + incremental via per-connector watermark.
 */
@Injectable()
export class KgObservationalService {
  private readonly logger = new Logger(KgObservationalService.name);
  /**
   * Organizations with an ingest running in this process. Every tool call
   * schedules one (after a 45 s cooldown), and a run over large payloads can
   * outlast the cooldown, so without this guard runs piled up on top of each
   * other until the heap gave out.
   */
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly kgStatic: KgStaticService,
  ) {}

  async ingestOrganization(
    organizationId: string,
  ): Promise<{ invocations: number; edges: number; skipped?: boolean }> {
    if (this.inFlight.has(organizationId)) {
      return { invocations: 0, edges: 0, skipped: true };
    }
    this.inFlight.add(organizationId);
    try {
      return await this.ingest(organizationId);
    } finally {
      this.inFlight.delete(organizationId);
    }
  }

  private async ingest(
    organizationId: string,
  ): Promise<{ invocations: number; edges: number }> {
    if (!(await this.kgStatic.isEnabled(organizationId))) {
      return { invocations: 0, edges: 0 };
    }
    // Per-connector slug + watermark.
    const connectors = await this.prisma.connector.findMany({
      where: { organizationId },
      select: { id: true, tools: { select: { name: true } } },
    });
    if (connectors.length === 0) return { invocations: 0, edges: 0 };
    const slugByConnector = new Map(
      connectors.map((c) => [c.id, deriveSlug(c.tools.map((t) => t.name))]),
    );
    const states = await this.prisma.kgConnectorState.findMany({
      where: { organizationId },
      select: { connectorId: true, lastObservedAt: true },
    });
    const watermark = new Map(states.map((s) => [s.connectorId, s.lastObservedAt]));

    // Each connector is scanned from its OWN watermark. A single global floor
    // meant one connector without a watermark dragged every other connector
    // back to the beginning of time, and the run re-read the same oldest pages
    // on every call without ever reaching new rows.
    const scope = connectors.map((c) => {
      const wm = watermark.get(c.id);
      return wm ? { connectorId: c.id, createdAt: { gt: wm } } : { connectorId: c.id };
    });

    // Existing entities per connector, so we can link a response field name to a
    // known entity (FK rule applied to the response shape, not just values).
    const connectorEntities = new Map<string, Set<string>>();
    for (const r of await this.prisma.kgNode.findMany({
      where: { organizationId },
      select: { connectorId: true, entity: true },
    })) {
      let s = connectorEntities.get(r.connectorId);
      if (!s) {
        s = new Set();
        connectorEntities.set(r.connectorId, s);
      }
      s.add(r.entity);
    }

    let edges = 0;
    // references edges mined from response field names: key -> details.
    const refBumps = new Map<
      string,
      { connectorId: string; from: string; to: string; field: string }
    >();
    // Entities whose tools served the SAME captured user request (intent).
    // intent -> set of `${connectorId}::${entity}`.
    const intentGroups = new Map<string, Set<string>>();

    let processed = 0;
    let after: { createdAt: Date; id: string } | null = null;
    while (processed < MAX_INVOCATIONS_PER_RUN) {
      // Keyset pagination: `skip` over a moving table re-reads or skips rows.
      const page: PageRow[] = await this.prisma.toolInvocation.findMany({
        where: {
          organizationId,
          OR: scope,
          ...(after
            ? {
                AND: [
                  {
                    OR: [
                      { createdAt: { gt: after.createdAt } },
                      { createdAt: after.createdAt, id: { gt: after.id } },
                    ],
                  },
                ],
              }
            : {}),
        },
        select: {
          id: true,
          connectorId: true,
          createdAt: true,
          intent: true,
          tool: { select: { name: true } },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: Math.min(PAGE_SIZE, MAX_INVOCATIONS_PER_RUN - processed),
      });
      if (page.length === 0) break;
      processed += page.length;
      after = { createdAt: page[page.length - 1].createdAt, id: page[page.length - 1].id };

      // Per-page value occurrences, flushed at the end of each page.
      const newHashes = new Set<string>();
      const valueRows: ValueRow[] = [];
      const maxTsByConnector = new Map<string, Date>();

      for await (const { inv, input, output } of this.loadPayloads(page)) {
        const connectorId = inv.connectorId!;
        // Every row read moves the watermark, including tools that map to no
        // entity: skipping those left a connector's watermark where it was, so
        // the same rows were read again on every run.
        const prevMax = maxTsByConnector.get(connectorId);
        if (!prevMax || inv.createdAt > prevMax) {
          maxTsByConnector.set(connectorId, inv.createdAt);
        }

        const slug = slugByConnector.get(connectorId) ?? '';
        const ent = extractEntity(inv.tool?.name ?? '', slug);
        if (!ent) continue;

        const collect = (payload: unknown, direction: 'input' | 'output') => {
          for (const { field, value } of extractIdentifiers(payload)) {
            const valueHash = hashValue(organizationId, value);
            newHashes.add(valueHash);
            valueRows.push({
              organizationId,
              connectorId,
              valueHash,
              entity: ent.entity,
              field,
              direction,
            });
          }
        };
        collect(input, 'input');
        collect(output, 'output');

        // Record which entity served this captured user request, so entities used
        // together for the same intent can be linked below (chat history → graph).
        if (inv.intent) {
          const key = String(inv.intent).toLowerCase().trim().slice(0, 200);
          if (key) {
            let g = intentGroups.get(key);
            if (!g) {
              g = new Set();
              intentGroups.set(key, g);
            }
            g.add(`${connectorId}::${ent.entity}`);
          }
        }

        // Mine the response SHAPE: a field like `customer_id` in the output means
        // this entity references Customer, even with no value coincidence.
        const knownEntities = connectorEntities.get(connectorId);
        if (knownEntities && output !== undefined) {
          for (const field of extractFieldNames(output)) {
            const target = fkCandidate(field);
            if (target && target !== ent.entity && knownEntities.has(target)) {
              const k = `${connectorId}|${ent.entity}|${target}`;
              if (!refBumps.has(k)) {
                refBumps.set(k, { connectorId, from: ent.entity, to: target, field });
              }
            }
          }
        }
      }

      // Flush this page's value occurrences and correlate immediately. correlate
      // reads kgValueSeen (which now includes earlier pages), so cross-page
      // produces_consumes / same_identity links are still found. The unique key
      // keeps a value seen a thousand times as one row.
      for (let i = 0; i < valueRows.length; i += WRITE_CHUNK) {
        await this.insertValueRows(valueRows.slice(i, i + WRITE_CHUNK));
        await yieldToEventLoop();
      }
      const hashes = [...newHashes];
      for (let i = 0; i < hashes.length; i += WRITE_CHUNK) {
        edges += await this.correlate(organizationId, hashes.slice(i, i + WRITE_CHUNK));
        await yieldToEventLoop();
      }

      // Commit progress per page, so a run that dies halfway resumes where it
      // stopped instead of starting over from the first page.
      await this.advanceWatermarks(organizationId, maxTsByConnector);

      if (page.length < PAGE_SIZE) break;
    } // while pages

    // Apply references edges mined from response shapes.
    const refCache = new Map<string, string>();
    for (const b of refBumps.values()) {
      const src = await this.nodeId(refCache, organizationId, b.connectorId, b.from);
      const tgt = await this.nodeId(refCache, organizationId, b.connectorId, b.to);
      if (src && tgt && src !== tgt) {
        await this.bumpEdge(organizationId, src, tgt, 'references', {
          matchKey: b.field,
          base: 0.6,
          cap: 0.9,
          status: 'active',
        });
        edges++;
      }
    }

    // Intent co-occurrence: entities whose tools satisfied the SAME captured
    // user request are related. A weak, suggested signal (awaits confirmation)
    // — this is how the chat history that led to calls extends the graph.
    const coCache = new Map<string, string>();
    for (const members of intentGroups.values()) {
      const list = [...members];
      if (list.length < 2) continue;
      let pairs = 0;
      for (let i = 0; i < list.length && pairs < MAX_PAIRS_PER_HASH; i++) {
        for (let j = i + 1; j < list.length && pairs < MAX_PAIRS_PER_HASH; j++) {
          const [ca, ea] = list[i].split('::');
          const [cb, eb] = list[j].split('::');
          const na = await this.nodeId(coCache, organizationId, ca, ea);
          const nb = await this.nodeId(coCache, organizationId, cb, eb);
          if (!na || !nb || na === nb) continue;
          const [src, tgt] = na < nb ? [na, nb] : [nb, na];
          await this.bumpEdge(organizationId, src, tgt, 'related', {
            base: 0.3,
            cap: 0.7,
            status: 'suggested',
          });
          edges++;
          pairs++;
        }
      }
    }

    this.logger.debug(
      `KG observational ${organizationId}: ${processed} invocations, ${edges} edges`,
    );
    return { invocations: processed, edges };
  }

  /**
   * Yields each page row with its payloads, loading them in batches bounded
   * by stored size rather than by count, and handing the event loop back
   * between rows so health checks and MCP requests keep being answered.
   */
  private async *loadPayloads<T extends { id: string }>(
    page: T[],
  ): AsyncGenerator<{ inv: T; input: unknown; output: unknown }> {
    const ids = page.map((p) => p.id);
    const sizes = await this.prisma.$queryRaw<
      Array<{ id: string; input_bytes: number; output_bytes: number }>
    >`SELECT id,
             (COALESCE(pg_column_size(input), 0) * ${COMPRESSION_ALLOWANCE})::int AS input_bytes,
             (CASE WHEN pg_column_size(output) > ${MEASURE_ABOVE_STORED_BYTES}
                   THEN octet_length(output::text)
                   ELSE COALESCE(pg_column_size(output), 0) * ${COMPRESSION_ALLOWANCE}
              END)::int AS output_bytes
        FROM tool_invocations
       WHERE id = ANY(${ids}::text[])`;
    const sizeById = new Map(sizes.map((r) => [r.id, r]));
    const withOutput = (id: string) =>
      (sizeById.get(id)?.output_bytes ?? 0) <= MAX_OUTPUT_BYTES;

    let batch: T[] = [];
    let batchBytes = 0;
    for (const inv of page) {
      const s = sizeById.get(inv.id);
      const bytes = (s?.input_bytes ?? 0) + (withOutput(inv.id) ? (s?.output_bytes ?? 0) : 0);
      if (batch.length && batchBytes + bytes > PAYLOAD_BATCH_BYTES) {
        yield* this.readBatch(batch, withOutput);
        batch = [];
        batchBytes = 0;
      }
      batch.push(inv);
      batchBytes += bytes;
    }
    if (batch.length) yield* this.readBatch(batch, withOutput);
  }

  private async *readBatch<T extends { id: string }>(
    rows: T[],
    withOutput: (id: string) => boolean,
  ): AsyncGenerator<{ inv: T; input: unknown; output: unknown }> {
    const full = rows.filter((r) => withOutput(r.id)).map((r) => r.id);
    const inputOnly = rows.filter((r) => !withOutput(r.id)).map((r) => r.id);
    const loaded = new Map<string, { input: unknown; output: unknown }>();
    if (full.length) {
      for (const r of await this.prisma.toolInvocation.findMany({
        where: { id: { in: full } },
        select: { id: true, input: true, output: true },
      })) {
        loaded.set(r.id, { input: r.input, output: r.output });
      }
    }
    if (inputOnly.length) {
      this.logger.debug(
        `KG observational: ${inputOnly.length} output(s) over ${MAX_OUTPUT_BYTES} bytes read as input only`,
      );
      for (const r of await this.prisma.toolInvocation.findMany({
        where: { id: { in: inputOnly } },
        select: { id: true, input: true },
      })) {
        loaded.set(r.id, { input: r.input, output: undefined });
      }
    }
    for (const inv of rows) {
      const p = loaded.get(inv.id);
      yield { inv, input: p?.input, output: p?.output };
      await yieldToEventLoop();
    }
  }

  /**
   * One statement with seven array parameters, however many rows. Prisma's
   * createMany compiles a parameter per column per row, synchronously: 1,000
   * rows held the production event loop for 330-630 ms per call.
   */
  private async insertValueRows(rows: ValueRow[]): Promise<void> {
    if (rows.length === 0) return;
    const col = <K extends keyof ValueRow>(k: K) => rows.map((r) => r[k]);
    await this.prisma.$executeRaw`
      INSERT INTO kg_value_seen
        (id, organization_id, connector_id, value_hash, entity, field, direction)
      SELECT * FROM unnest(
        ${rows.map(() => randomUUID())}::text[],
        ${col('organizationId')}::text[],
        ${col('connectorId')}::text[],
        ${col('valueHash')}::text[],
        ${col('entity')}::text[],
        ${col('field')}::text[],
        ${col('direction')}::text[]
      )
      ON CONFLICT (organization_id, connector_id, value_hash, entity, field, direction) DO NOTHING`;
  }

  private async advanceWatermarks(
    organizationId: string,
    maxTsByConnector: Map<string, Date>,
  ): Promise<void> {
    for (const [connectorId, ts] of maxTsByConnector) {
      await this.prisma.kgConnectorState.upsert({
        where: { connectorId },
        create: { organizationId, connectorId, lastObservedAt: ts },
        update: { lastObservedAt: ts },
      });
    }
  }

  /** Correlate value occurrences into produces_consumes + same_identity edges. */
  private async correlate(
    organizationId: string,
    hashes: string[],
  ): Promise<number> {
    const rows = await this.prisma.kgValueSeen.findMany({
      where: { organizationId, valueHash: { in: hashes } },
      select: {
        valueHash: true,
        connectorId: true,
        entity: true,
        field: true,
        direction: true,
      },
      take: MAX_CORRELATE_ROWS,
    });

    // One occurrence per (hash, connector, entity, direction). Rows that differ
    // only in field name describe the same link, and pairing every copy with
    // every other copy is what turned one busy value into thousands of edge
    // writes.
    const byHash = new Map<string, typeof rows>();
    const seen = new Set<string>();
    for (const r of rows) {
      const key = `${r.valueHash}|${r.connectorId}|${r.entity}|${r.direction}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const list = byHash.get(r.valueHash) ?? [];
      list.push(r);
      byHash.set(r.valueHash, list);
    }

    const nodeCache = new Map<string, string>(); // `${connectorId}::${entity}` -> nodeId
    let edgeCount = 0;

    for (const occ of byHash.values()) {
      const producers = occ.filter((o) => o.direction === 'output').slice(0, MAX_PAIRS_PER_HASH);
      const consumers = occ.filter((o) => o.direction === 'input').slice(0, MAX_PAIRS_PER_HASH);

      // produces_consumes: an output value later used as an input.
      for (const p of producers) {
        for (const c of consumers) {
          if (p.connectorId === c.connectorId && p.entity === c.entity) continue;
          const src = await this.nodeId(nodeCache, organizationId, p.connectorId, p.entity);
          const tgt = await this.nodeId(nodeCache, organizationId, c.connectorId, c.entity);
          if (!src || !tgt || src === tgt) continue;
          await this.bumpEdge(organizationId, src, tgt, 'produces_consumes', {
            matchKey: c.field,
            base: 0.55,
            cap: 0.95,
            status: 'active',
          });
          // The data confirms any static FK guess between the same nodes.
          await this.prisma.kgEdge.updateMany({
            where: { organizationId, sourceNodeId: src, targetNodeId: tgt, kind: 'references', source: 'STATIC' },
            data: { source: 'OBSERVED', confidence: 0.8, lastSeenAt: new Date() },
          });
          edgeCount++;
        }
      }

      // same_identity: same value across two distinct connectors.
      const connectors = [...new Set(occ.map((o) => o.connectorId))];
      if (connectors.length >= 2) {
        let pairs = 0;
        for (let i = 0; i < occ.length && pairs < MAX_PAIRS_PER_HASH; i++) {
          for (let j = i + 1; j < occ.length && pairs < MAX_PAIRS_PER_HASH; j++) {
            const a = occ[i];
            const b = occ[j];
            if (a.connectorId === b.connectorId) continue;
            const na = await this.nodeId(nodeCache, organizationId, a.connectorId, a.entity);
            const nb = await this.nodeId(nodeCache, organizationId, b.connectorId, b.entity);
            if (!na || !nb || na === nb) continue;
            const [src, tgt] = na < nb ? [na, nb] : [nb, na];
            await this.bumpEdge(organizationId, src, tgt, 'same_identity', {
              matchKey: a.field === b.field ? a.field : undefined,
              base: 0.2,
              cap: 0.6,
              status: 'suggested',
            });
            edgeCount++;
            pairs++;
          }
        }
      }
    }
    return edgeCount;
  }

  private async nodeId(
    cache: Map<string, string>,
    organizationId: string,
    connectorId: string,
    entity: string,
  ): Promise<string | null> {
    const key = `${connectorId}::${entity}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const node = await this.prisma.kgNode.upsert({
      where: { organizationId_connectorId_entity: { organizationId, connectorId, entity } },
      create: {
        organizationId,
        connectorId,
        entity,
        label: entity.charAt(0).toUpperCase() + entity.slice(1).replace(/_/g, ' '),
        source: 'OBSERVED',
        confidence: 0.4,
      },
      update: {},
      select: { id: true },
    });
    cache.set(key, node.id);
    return node.id;
  }

  private async bumpEdge(
    organizationId: string,
    sourceNodeId: string,
    targetNodeId: string,
    kind: string,
    opts: { matchKey?: string; base: number; cap: number; status: string },
  ): Promise<void> {
    const existing = await this.prisma.kgEdge.findUnique({
      where: {
        organizationId_sourceNodeId_targetNodeId_kind: {
          organizationId,
          sourceNodeId,
          targetNodeId,
          kind,
        },
      },
      select: { id: true, observations: true, isManual: true, status: true },
    });
    if (!existing) {
      await this.prisma.kgEdge.create({
        data: {
          organizationId,
          sourceNodeId,
          targetNodeId,
          kind,
          matchKey: opts.matchKey,
          source: 'OBSERVED',
          confidence: Math.min(opts.cap, opts.base),
          observations: 1,
          status: opts.status,
        },
      });
      return;
    }
    const observations = existing.observations + 1;
    await this.prisma.kgEdge.update({
      where: { id: existing.id },
      data: {
        observations,
        confidence: Math.min(opts.cap, opts.base + 0.05 * (observations - 1)),
        source: 'OBSERVED',
        matchKey: opts.matchKey,
        lastSeenAt: new Date(),
        // Never silently re-open a link the user rejected, nor downgrade a confirmed one.
        ...(existing.isManual || existing.status === 'rejected'
          ? {}
          : { status: opts.status }),
      },
    });
  }
}
