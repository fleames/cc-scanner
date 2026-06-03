import { config } from './config';
import { logger } from './logger';

interface OprEntry {
  domain: string;
  page_rank_decimal: number;
  page_rank_integer: number;
  rank: string;
  error: string;
}

interface OprResponse {
  response: OprEntry[];
}

/**
 * Fetches Open PageRank scores for up to 100 domains per call.
 * Returns a Map<domain, pageRankDecimal>.
 * If no API key is configured, returns an empty map (gracefully skips enrichment).
 */
export async function getPageRanks(domains: string[]): Promise<Map<string, number>> {
  if (!config.oprApiKey || domains.length === 0) return new Map();

  const results = new Map<string, number>();
  const BATCH = 100;

  for (let i = 0; i < domains.length; i += BATCH) {
    const batch = domains.slice(i, i + BATCH);
    const params = new URLSearchParams();
    batch.forEach((d, idx) => params.set(`domains[${idx}]`, d));

    try {
      const res = await fetch(`https://openpagerank.com/api/v1.0/getPageRank?${params}`, {
        headers: { 'API-OPR': config.oprApiKey },
      });

      if (!res.ok) {
        logger.warn('Open PageRank API error', { status: res.status });
        continue;
      }

      const data = (await res.json()) as OprResponse;
      for (const entry of data.response ?? []) {
        if (!entry.error && entry.page_rank_decimal != null) {
          results.set(entry.domain, entry.page_rank_decimal);
        }
      }
    } catch (err) {
      logger.warn('Open PageRank request failed', { error: String(err) });
    }

    // Respect rate limit — small delay between batches
    if (i + BATCH < domains.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  return results;
}
