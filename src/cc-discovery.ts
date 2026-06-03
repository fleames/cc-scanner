import { logger } from './logger';

const CC_CDN        = 'https://data.commoncrawl.org';
const GRAPHINFO_URL = 'https://index.commoncrawl.org/graphinfo.json';

export interface CcRelease {
  name: string;
  verticesUrl: string;
  edgesUrl: string;
  ranksUrl: string;
  level: 'domain' | 'host';
}

interface GraphInfoEntry {
  id?: string;
  name?: string;
  // CC may add more fields — we only need the release identifier
  [key: string]: unknown;
}

/**
 * Extracts release name from a graphinfo entry.
 * CC may use { id: "..." }, { name: "..." }, or a plain string.
 */
function entryName(entry: GraphInfoEntry | string): string | null {
  if (typeof entry === 'string') return entry;
  return entry.id ?? entry.name ?? null;
}

/**
 * Fetches the official CC graphinfo.json to get the list of available releases.
 * This is the canonical discovery mechanism — no probing or S3 listing needed.
 */
async function fetchReleases(): Promise<string[]> {
  logger.debug('Fetching graphinfo.json', { url: GRAPHINFO_URL });
  const res = await fetch(GRAPHINFO_URL);
  if (!res.ok) throw new Error(`graphinfo.json fetch failed: ${res.status}`);

  const raw = await res.json();
  logger.debug('graphinfo.json raw (truncated)', {
    preview: JSON.stringify(raw).slice(0, 400),
  });

  // Handle both array-of-objects and array-of-strings formats
  const list: Array<GraphInfoEntry | string> = Array.isArray(raw)
    ? raw
    : raw.graphs ?? raw.releases ?? raw.data ?? [];

  // graphinfo.json returns newest first — preserve that order
  const names = list
    .map(entryName)
    .filter((n): n is string => typeof n === 'string' && n.startsWith('cc-main-'));

  logger.info(`Found ${names.length} CC releases`, { latest3: names.slice(0, 3) });
  return names;
}

/**
 * Builds the domain-level file URLs for a given release name.
 * File pattern: {base}/{release}-domain-{type}.txt.gz
 */
function domainUrls(releaseName: string): {
  verticesUrl: string;
  edgesUrl: string;
  ranksUrl: string;
} {
  const base = `${CC_CDN}/projects/hyperlinkgraph/${releaseName}/domain`;
  return {
    verticesUrl: `${base}/${releaseName}-domain-vertices.txt.gz`,
    edgesUrl:    `${base}/${releaseName}-domain-edges.txt.gz`,
    ranksUrl:    `${base}/${releaseName}-domain-ranks.txt.gz`,
  };
}

/**
 * Verifies a release has domain-level graph files by doing a HEAD request
 * on the vertices file.
 */
async function verifyDomainFiles(releaseName: string): Promise<boolean> {
  const { verticesUrl } = domainUrls(releaseName);
  try {
    const res = await fetch(verticesUrl, { method: 'HEAD' });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Returns the latest CC release with domain-level graph files.
 * Uses graphinfo.json for discovery — no S3 listing, no URL probing.
 */
export async function getLatestRelease(): Promise<CcRelease | null> {
  logger.info('Discovering latest CC release via graphinfo.json...');

  const releases = await fetchReleases();
  if (releases.length === 0) {
    logger.warn('graphinfo.json returned no releases');
    return null;
  }

  // graphinfo.json is newest-first — check top 5
  for (const name of releases.slice(0, 5)) {
    logger.debug(`Verifying domain files for ${name}`);
    const ok = await verifyDomainFiles(name);
    if (ok) {
      const urls = domainUrls(name);
      logger.info(`Using CC release: ${name}`, urls);
      return { name, ...urls, level: 'domain' };
    }
    logger.debug(`No domain files found for ${name}, trying older release`);
  }

  logger.warn('No domain-level graph files found in latest 5 releases');
  return null;
}
