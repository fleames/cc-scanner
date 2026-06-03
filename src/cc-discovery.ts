import { logger } from './logger';

const CC_S3_BASE = 'https://data.commoncrawl.org';
const GRAPH_PREFIX = 'projects/hyperlinkgraph/';

interface CcRelease {
  name: string;       // e.g. "cc-main-2024-22"
  verticesUrl: string;
  edgesUrl: string;
}

/**
 * Lists all available CC hyperlinkgraph releases by querying the public S3 bucket.
 */
async function listReleases(): Promise<string[]> {
  const url = `${CC_S3_BASE}/?prefix=${GRAPH_PREFIX}&delimiter=/`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to list CC releases: ${res.status}`);
  const xml = await res.text();

  // Extract prefix values from <Prefix>...</Prefix> tags inside <CommonPrefixes>
  const matches = xml.matchAll(/<CommonPrefixes>[\s\S]*?<Prefix>(.*?)<\/Prefix>[\s\S]*?<\/CommonPrefixes>/g);
  const releases: string[] = [];
  for (const match of matches) {
    const prefix = match[1]; // e.g. "projects/hyperlinkgraph/cc-main-2024-22/"
    const name = prefix.replace(GRAPH_PREFIX, '').replace(/\/$/, '');
    if (name.startsWith('cc-main-')) {
      releases.push(name);
    }
  }

  return releases.sort(); // alphabetical = chronological for cc-main-YYYY-WW naming
}

/**
 * Given a release name, finds the domain-level vertices and edges file URLs.
 * CC file naming has varied across releases — this probes for the actual files.
 */
async function findDomainFiles(releaseName: string): Promise<{ verticesUrl: string; edgesUrl: string } | null> {
  const domainPrefix = `${GRAPH_PREFIX}${releaseName}/domain/`;
  const url = `${CC_S3_BASE}/?prefix=${domainPrefix}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const xml = await res.text();

  // Extract all Key values (file paths)
  const keys: string[] = [];
  for (const match of xml.matchAll(/<Key>(.*?)<\/Key>/g)) {
    keys.push(match[1]);
  }

  if (keys.length === 0) return null;

  const verticesKey = keys.find(k => k.includes('vertices') && k.endsWith('.txt.gz'));
  const edgesKey    = keys.find(k => k.includes('edges')    && k.endsWith('.txt.gz'));

  if (!verticesKey || !edgesKey) return null;

  return {
    verticesUrl: `${CC_S3_BASE}/${verticesKey}`,
    edgesUrl:    `${CC_S3_BASE}/${edgesKey}`,
  };
}

/**
 * Returns the latest CC release that has domain-level graph files.
 * Checks the last N releases to handle gaps (some releases may not have domain graphs).
 */
export async function getLatestRelease(): Promise<CcRelease | null> {
  logger.info('Discovering latest CC release...');
  const releases = await listReleases();

  if (releases.length === 0) {
    logger.warn('No CC releases found');
    return null;
  }

  logger.info(`Found ${releases.length} CC releases, checking latest...`);

  // Check the last 5 releases newest-first to find one with domain files
  for (const name of releases.slice(-5).reverse()) {
    logger.debug(`Checking domain files for ${name}`);
    const files = await findDomainFiles(name);
    if (files) {
      logger.info(`Latest CC release with domain graph: ${name}`, files);
      return { name, ...files };
    }
  }

  logger.warn('No CC release with domain-level graph files found');
  return null;
}
