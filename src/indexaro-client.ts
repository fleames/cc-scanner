import { config } from './config';
import { logger } from './logger';

interface DomainsResponse {
  domains: string[];
  lastCrawlId: string | null;
  count: number;
}

interface ReferringDomain {
  sourceDomain: string;
  linkCount: number;
}

interface DomainResult {
  domain: string;
  referringDomains: ReferringDomain[];
  totalReferringDomains: number;
  openPageRank?: number;
}

const HEADERS = {
  'Authorization': `Bearer ${config.internalSecret}`,
  'Content-Type': 'application/json',
};

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `${config.indexaroUrl}${path}`;
  const res = await fetch(url, { ...options, headers: { ...HEADERS, ...options?.headers } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Indexaro API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

export async function getWatchedDomains(): Promise<DomainsResponse> {
  return request<DomainsResponse>('/api/v1/internal/cc/domains');
}

export async function markRunStarted(crawlId: string): Promise<void> {
  await request('/api/v1/internal/cc/backlinks', {
    method: 'PATCH',
    body: JSON.stringify({ crawlId, status: 'RUNNING' }),
  });
}

export async function markRunFailed(crawlId: string, errorMessage: string): Promise<void> {
  await request('/api/v1/internal/cc/backlinks', {
    method: 'PATCH',
    body: JSON.stringify({ crawlId, status: 'FAILED', errorMessage }),
  });
}

export async function pushBacklinks(crawlId: string, results: DomainResult[]): Promise<void> {
  if (results.length === 0) return;

  // Send in batches of 50 domains at a time
  const BATCH = 50;
  for (let i = 0; i < results.length; i += BATCH) {
    const batch = results.slice(i, i + BATCH);
    await request('/api/v1/internal/cc/backlinks', {
      method: 'POST',
      body: JSON.stringify({ crawlId, results: batch }),
    });
    logger.info(`Pushed batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(results.length / BATCH)}`, {
      domains: batch.length,
    });
  }
}
