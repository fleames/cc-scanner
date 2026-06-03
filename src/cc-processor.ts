import { createGunzip } from 'zlib';
import { createInterface } from 'readline';
import { Readable } from 'stream';
import { config } from './config';
import { logger } from './logger';
import { getPageRanks } from './openpagerank';

export interface DomainResult {
  domain: string;
  referringDomains: Array<{ sourceDomain: string; linkCount: number }>;
  totalReferringDomains: number;
  openPageRank?: number;
}

/**
 * Streams a gzip-compressed HTTP URL line by line.
 * Calls onLine for each non-empty line. Logs progress every N lines.
 */
// 45-minute timeout — edges file is 2–5 GB and takes several minutes to download
const DOWNLOAD_TIMEOUT_MS = 45 * 60 * 1000;

async function streamGzipLines(
  url: string,
  label: string,
  onLine: (line: string) => void,
): Promise<number> {
  logger.info(`Downloading ${label}...`, { url });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`Fetch failed for ${label}: ${String(err)}`);
  }
  clearTimeout(timer);

  if (!res.ok) throw new Error(`Failed to fetch ${label}: ${res.status}`);
  if (!res.body) throw new Error(`No response body for ${label}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nodeStream = Readable.fromWeb(res.body as any);
  const gunzip    = createGunzip();
  const rl        = createInterface({ input: nodeStream.pipe(gunzip), crlfDelay: Infinity });

  let lines = 0;
  for await (const line of rl) {
    if (!line) continue;
    onLine(line);
    lines++;
    if (lines % 5_000_000 === 0) {
      logger.info(`  ${label}: ${(lines / 1_000_000).toFixed(1)}M lines processed`);
    }
  }

  logger.info(`Finished ${label}`, { totalLines: lines });
  return lines;
}

/**
 * Normalises a domain string:
 * - Strips www. prefix
 * - Lowercase
 * This ensures "www.example.com" matches "example.com" in watched list.
 */
function normaliseDomain(d: string): string {
  return d.toLowerCase().replace(/^www\./, '');
}

/**
 * Main processing pipeline.
 *
 * Algorithm (3-pass streaming — no disk storage of raw files):
 *   Pass 1: Stream vertices → build targetIdToName for watched domains
 *   Pass 2: Stream edges    → collect edges where target is a watched domain
 *   Pass 3: Stream vertices → resolve source IDs to domain names
 *   Final:  Aggregate, enrich with PageRank, return results
 */
export async function processRelease(
  verticesUrl: string,
  edgesUrl: string,
  watchedDomains: string[],
): Promise<DomainResult[]> {
  if (watchedDomains.length === 0) {
    logger.warn('No watched domains — nothing to process');
    return [];
  }

  // Normalise watched domains for matching
  const watchedSet = new Set(watchedDomains.map(normaliseDomain));
  logger.info(`Processing CC graph for ${watchedSet.size} unique domains`);

  // ── Pass 1: Vertices → targetIdToName ─────────────────────────────────────
  logger.info('Pass 1/3: Loading target vertices...');

  // Map from vertexId (number) → original watched domain
  const targetIdToName = new Map<number, string>();

  await streamGzipLines(verticesUrl, 'vertices (pass 1)', (line) => {
    const tab = line.indexOf('\t');
    if (tab < 0) return;
    const id     = parseInt(line.slice(0, tab), 10);
    const domain = normaliseDomain(line.slice(tab + 1));
    if (watchedSet.has(domain)) {
      targetIdToName.set(id, domain);
    }
  });

  logger.info(`Pass 1 complete: matched ${targetIdToName.size}/${watchedSet.size} target domains`);

  if (targetIdToName.size === 0) {
    logger.warn('None of the watched domains found in CC vertices — no data to extract');
    return [];
  }

  const targetIds = new Set(targetIdToName.keys());

  // ── Pass 2: Edges → collect source→target pairs ────────────────────────────
  logger.info('Pass 2/3: Scanning edges...');

  // edgesByTarget: targetId → Map<sourceId, linkCount>
  const edgesByTarget = new Map<number, Map<number, number>>();
  const pendingSourceIds = new Set<number>();

  await streamGzipLines(edgesUrl, 'edges', (line) => {
    const tab = line.indexOf('\t');
    if (tab < 0) return;
    const sourceId = parseInt(line.slice(0, tab), 10);
    const targetId = parseInt(line.slice(tab + 1), 10);

    if (!targetIds.has(targetId)) return;

    // Don't count self-links
    if (sourceId === targetId) return;

    pendingSourceIds.add(sourceId);

    let sourceMap = edgesByTarget.get(targetId);
    if (!sourceMap) {
      sourceMap = new Map();
      edgesByTarget.set(targetId, sourceMap);
    }
    sourceMap.set(sourceId, (sourceMap.get(sourceId) ?? 0) + 1);
  });

  logger.info(`Pass 2 complete`, {
    targetDomainsWithEdges: edgesByTarget.size,
    uniqueSourceIds: pendingSourceIds.size,
  });

  // ── Pass 3: Vertices → resolve source IDs ─────────────────────────────────
  logger.info('Pass 3/3: Resolving source domain names...');

  const sourceIdToName = new Map<number, string>();

  await streamGzipLines(verticesUrl, 'vertices (pass 3)', (line) => {
    const tab = line.indexOf('\t');
    if (tab < 0) return;
    const id = parseInt(line.slice(0, tab), 10);
    if (pendingSourceIds.has(id)) {
      sourceIdToName.set(id, normaliseDomain(line.slice(tab + 1)));
    }
  });

  logger.info(`Pass 3 complete: resolved ${sourceIdToName.size}/${pendingSourceIds.size} source IDs`);

  // ── Aggregate results ──────────────────────────────────────────────────────
  logger.info('Aggregating results...');

  const rawResults: Array<{ domain: string; sources: Map<string, number> }> = [];

  for (const [targetId, sourceMap] of edgesByTarget) {
    const targetDomain = targetIdToName.get(targetId);
    if (!targetDomain) continue;

    // Aggregate link counts by source domain name
    const bySourceDomain = new Map<string, number>();
    for (const [sourceId, count] of sourceMap) {
      const sourceDomain = sourceIdToName.get(sourceId);
      if (!sourceDomain || sourceDomain === targetDomain) continue;
      bySourceDomain.set(sourceDomain, (bySourceDomain.get(sourceDomain) ?? 0) + count);
    }

    rawResults.push({ domain: targetDomain, sources: bySourceDomain });
  }

  // ── Open PageRank enrichment ───────────────────────────────────────────────
  const targetDomains = rawResults.map(r => r.domain);
  const pageRanks     = await getPageRanks(targetDomains);

  if (pageRanks.size > 0) {
    logger.info(`PageRank enriched ${pageRanks.size} domains`);
  }

  // ── Build final output ────────────────────────────────────────────────────
  const results: DomainResult[] = rawResults.map(({ domain, sources }) => {
    // Sort by link count descending, take top N
    const sorted = [...sources.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, config.topDomainsLimit)
      .map(([sourceDomain, linkCount]) => ({ sourceDomain, linkCount }));

    return {
      domain,
      referringDomains: sorted,
      totalReferringDomains: sources.size,
      openPageRank: pageRanks.get(domain),
    };
  });

  logger.info(`Processing complete`, {
    domainsWithData: results.length,
    totalReferringDomainPairs: results.reduce((s, r) => s + r.totalReferringDomains, 0),
  });

  return results;
}
