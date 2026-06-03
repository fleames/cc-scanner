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

function normaliseDomain(d: string): string {
  return d.toLowerCase().trim()
    .replace(/^https?:\/\//, '')  // strip protocol
    .replace(/\/.*$/, '')          // strip path
    .replace(/^www\./, '')         // strip www
    .replace(/[:\s].*$/, '');      // strip port or whitespace
}

/**
 * CC domain graph stores domains in reversed notation: com.example → example.com
 * Reverse the labels back to normal order.
 */
function unreverse(d: string): string {
  return d.split('.').reverse().join('.');
}

const KNOWN_TLDS = new Set(['com', 'org', 'net', 'edu', 'gov', 'io', 'co', 'uk',
  'de', 'fr', 'nl', 'ru', 'jp', 'cn', 'br', 'au', 'ca', 'it', 'es', 'pl']);

/**
 * Heuristic: if >50% of sample domain first-labels are known TLDs,
 * the file uses reversed notation (com.example instead of example.com).
 */
function detectReversedFormat(sampleLines: string[]): boolean {
  let reversed = 0;
  let total = 0;
  for (const line of sampleLines) {
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const domain = parts[1].trim().toLowerCase();
    const firstLabel = domain.split('.')[0];
    if (KNOWN_TLDS.has(firstLabel)) reversed++;
    total++;
  }
  return total > 0 && reversed / total > 0.5;
}

/**
 * Loads CC domain rank scores for our watched domains from the ranks file.
 * Ranks file format: id TAB domain TAB rank_score  (or id TAB domain, rank in separate col)
 * Falls back gracefully — rank data is optional enrichment.
 *
 * CC rank scores are harmonic centrality values; higher = more authoritative.
 * We normalise to a 0–100 scale by mapping against the max observed score.
 */
async function loadRanks(
  ranksUrl: string,
  targetDomains: Set<string>,
  isReversed: boolean,
): Promise<Map<string, number>> {
  const ranks = new Map<string, number>();
  let maxRank = 0;

  try {
    const raw = new Map<string, number>();

    await streamGzipLines(ranksUrl, 'ranks', (line) => {
      // Format varies: "id\tdomain\tscore" or "id\tdomain" with score elsewhere
      const parts = line.split('\t');
      if (parts.length < 2) return;

      // Last column is the score; second-to-last is the domain
      // ranks format: id TAB domain TAB score  (always take col[1] and col[2])
      if (parts.length < 3) return;
      const score  = parseFloat(parts[2]);
      const raw    = normaliseDomain(parts[1]);
      const domain = isReversed ? normaliseDomain(unreverse(raw)) : raw;

      if (!targetDomains.has(domain) || isNaN(score)) return;

      raw.set(domain, score);
      if (score > maxRank) maxRank = score;
    });

    // Normalise to 0–100 scale
    if (maxRank > 0) {
      for (const [domain, score] of raw) {
        ranks.set(domain, Math.round((score / maxRank) * 100 * 10) / 10);
      }
    }

    logger.info(`Ranks loaded for ${ranks.size} target domains`);
  } catch (err) {
    logger.warn('Could not load CC ranks file — skipping rank enrichment', {
      error: String(err),
    });
  }

  return ranks;
}

/**
 * Main processing pipeline.
 *
 * Algorithm (3-pass streaming — no disk storage of raw files):
 *   Pass 1: Stream vertices → build targetIdToName for watched domains
 *   Pass 2: Stream edges    → collect edges where target is a watched domain
 *   Pass 3: Stream vertices → resolve source IDs to domain names
 *   Ranks:  Stream ranks    → get CC authority scores for target domains
 *   Final:  Aggregate, optionally enrich with Open PageRank, return results
 */
export async function processRelease(
  verticesUrl: string,
  edgesUrl: string,
  watchedDomains: string[],
  ranksUrl?: string,
): Promise<DomainResult[]> {
  if (watchedDomains.length === 0) {
    logger.warn('No watched domains — nothing to process');
    return [];
  }

  const watchedSet = new Set(watchedDomains.map(normaliseDomain));
  logger.info(`Processing CC graph for ${watchedSet.size} unique domains`);

  // ── Pass 1: Vertices → targetIdToName ─────────────────────────────────────
  logger.info('Pass 1/3: Loading target vertices...');
  const targetIdToName = new Map<number, string>();
  const sampleLines: string[] = [];

  await streamGzipLines(verticesUrl, 'vertices (pass 1)', (line) => {
    if (sampleLines.length < 10) sampleLines.push(line);

    // Format: id TAB domain TAB extra_columns...
    // Always split and take column [1] as the domain
    const parts = line.split('\t');
    if (parts.length < 2) return;
    const id  = parseInt(parts[0], 10);
    const raw = normaliseDomain(parts[1]);

    if (watchedSet.has(raw)) {
      targetIdToName.set(id, raw);
    } else {
      const flipped = normaliseDomain(unreverse(raw));
      if (watchedSet.has(flipped)) targetIdToName.set(id, flipped);
    }
  });

  // Detect storage format from samples so pass 3 applies consistently
  const isReversed = detectReversedFormat(sampleLines);
  logger.info(`Vertices format: ${isReversed ? 'reversed (com.example)' : 'normal (example.com)'}`,
    { sample: sampleLines.slice(0, 3) });
  logger.info(`WatchedSet contents`, { watchedDomains: [...watchedSet].slice(0, 10) });

  logger.info(`Pass 1 complete: matched ${targetIdToName.size}/${watchedSet.size} target domains`);

  if (targetIdToName.size === 0) {
    logger.warn('None of the watched domains found in CC vertices — no data to extract');
    return [];
  }

  const targetIds = new Set(targetIdToName.keys());

  // ── Pass 2: Edges → collect source→target pairs ────────────────────────────
  logger.info('Pass 2/3: Scanning edges...');
  const edgesByTarget  = new Map<number, Map<number, number>>();
  const pendingSourceIds = new Set<number>();

  await streamGzipLines(edgesUrl, 'edges', (line) => {
    const tab = line.indexOf('\t');
    if (tab < 0) return;
    const sourceId = parseInt(line.slice(0, tab), 10);
    const targetId = parseInt(line.slice(tab + 1), 10);

    if (!targetIds.has(targetId) || sourceId === targetId) return;

    pendingSourceIds.add(sourceId);
    let sm = edgesByTarget.get(targetId);
    if (!sm) { sm = new Map(); edgesByTarget.set(targetId, sm); }
    sm.set(sourceId, (sm.get(sourceId) ?? 0) + 1);
  });

  logger.info(`Pass 2 complete`, {
    targetDomainsWithEdges: edgesByTarget.size,
    uniqueSourceIds: pendingSourceIds.size,
  });

  // ── Pass 3: Vertices → resolve source IDs ─────────────────────────────────
  logger.info('Pass 3/3: Resolving source domain names...');
  const sourceIdToName = new Map<number, string>();

  await streamGzipLines(verticesUrl, 'vertices (pass 3)', (line) => {
    const parts = line.split('\t');
    if (parts.length < 2) return;
    const id = parseInt(parts[0], 10);
    if (!pendingSourceIds.has(id)) return;
    const raw = normaliseDomain(parts[1]);
    sourceIdToName.set(id, isReversed ? normaliseDomain(unreverse(raw)) : raw);
  });

  logger.info(`Pass 3 complete: resolved ${sourceIdToName.size}/${pendingSourceIds.size} source IDs`);

  // ── Aggregate ──────────────────────────────────────────────────────────────
  logger.info('Aggregating results...');
  const rawResults: Array<{ domain: string; sources: Map<string, number> }> = [];

  for (const [targetId, sourceMap] of edgesByTarget) {
    const targetDomain = targetIdToName.get(targetId);
    if (!targetDomain) continue;

    const bySource = new Map<string, number>();
    for (const [sourceId, count] of sourceMap) {
      const src = sourceIdToName.get(sourceId);
      if (!src || src === targetDomain) continue;
      bySource.set(src, (bySource.get(src) ?? 0) + count);
    }
    rawResults.push({ domain: targetDomain, sources: bySource });
  }

  // ── Rank enrichment: CC ranks file first, Open PageRank as fallback ────────
  const targetDomainNames = rawResults.map(r => r.domain);
  let ccRanks = new Map<string, number>();
  let oprRanks = new Map<string, number>();

  if (ranksUrl) {
    ccRanks = await loadRanks(ranksUrl, new Set(targetDomainNames), isReversed);
  }

  // Only call Open PageRank API for domains the CC ranks file didn't cover
  const needsOpr = targetDomainNames.filter(d => !ccRanks.has(d));
  if (needsOpr.length > 0) {
    oprRanks = await getPageRanks(needsOpr);
    if (oprRanks.size > 0) logger.info(`OPR enriched ${oprRanks.size} domains`);
  }

  // ── Build final output ────────────────────────────────────────────────────
  const results: DomainResult[] = rawResults.map(({ domain, sources }) => {
    const sorted = [...sources.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, config.topDomainsLimit)
      .map(([sourceDomain, linkCount]) => ({ sourceDomain, linkCount }));

    return {
      domain,
      referringDomains: sorted,
      totalReferringDomains: sources.size,
      openPageRank: ccRanks.get(domain) ?? oprRanks.get(domain),
    };
  });

  logger.info(`Processing complete`, {
    domainsWithData: results.length,
    totalReferringDomainPairs: results.reduce((s, r) => s + r.totalReferringDomains, 0),
  });

  return results;
}
