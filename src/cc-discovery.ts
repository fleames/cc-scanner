import { logger } from './logger';

// S3 REST API endpoint — required for bucket listing (CloudFront doesn't support it)
const CC_S3_API  = 'https://commoncrawl.s3.amazonaws.com';
// CloudFront CDN — faster for actual file downloads
const CC_CDN     = 'https://data.commoncrawl.org';
const GRAPH_PREFIX = 'projects/hyperlinkgraph/';

export interface CcRelease {
  name: string;
  verticesUrl: string;
  edgesUrl: string;
  level: 'domain' | 'host';
}

/**
 * Lists all available CC hyperlinkgraph releases via the S3 REST API.
 */
async function listReleases(): Promise<string[]> {
  const url = `${CC_S3_API}/?prefix=${GRAPH_PREFIX}&delimiter=/`;
  logger.debug('Listing CC releases', { url });

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to list CC releases: ${res.status}`);
  const xml = await res.text();

  logger.debug('CC S3 listing raw (first 800 chars)', { xml: xml.slice(0, 800) });

  const releases: string[] = [];

  // S3 XML can nest <Prefix> inside <CommonPrefixes> — match both formats
  for (const match of xml.matchAll(/<Prefix>(projects\/hyperlinkgraph\/[^<]+)<\/Prefix>/g)) {
    const prefix = match[1];
    const name = prefix.replace(GRAPH_PREFIX, '').replace(/\/$/, '');
    if (name.startsWith('cc-main-') && name !== '') {
      releases.push(name);
    }
  }

  logger.info(`Found ${releases.length} CC releases`, { releases: releases.slice(-5) });
  return [...new Set(releases)].sort();
}

/**
 * Finds graph files for a release at a given level (domain or host).
 * Uses S3 API for listing, CDN URL for the actual download links.
 */
async function findGraphFiles(
  releaseName: string,
  level: 'domain' | 'host',
): Promise<{ verticesUrl: string; edgesUrl: string } | null> {
  const prefix = `${GRAPH_PREFIX}${releaseName}/${level}/`;
  const url    = `${CC_S3_API}/?prefix=${prefix}`;

  const res = await fetch(url);
  if (!res.ok) return null;
  const xml = await res.text();

  const keys: string[] = [];
  for (const match of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) {
    keys.push(match[1]);
  }

  logger.debug(`${releaseName}/${level} files`, { keys });

  const verticesKey = keys.find(k => k.includes('vertices') && k.endsWith('.txt.gz'));
  const edgesKey    = keys.find(k => k.includes('edges')    && k.endsWith('.txt.gz'));

  if (!verticesKey || !edgesKey) return null;

  return {
    verticesUrl: `${CC_CDN}/${verticesKey}`,
    edgesUrl:    `${CC_CDN}/${edgesKey}`,
  };
}

/**
 * Returns the latest CC release that has graph files.
 * Prefers domain-level (eTLD+1 aggregated); falls back to host-level.
 * Checks the last 8 releases newest-first to handle gaps.
 */
export async function getLatestRelease(): Promise<CcRelease | null> {
  logger.info('Discovering latest CC release...');
  const releases = await listReleases();

  if (releases.length === 0) {
    logger.warn('No CC releases found in S3 listing');
    return null;
  }

  for (const name of releases.slice(-8).reverse()) {
    // Try domain-level first
    const domainFiles = await findGraphFiles(name, 'domain');
    if (domainFiles) {
      logger.info(`Using domain-level graph: ${name}`, domainFiles);
      return { name, ...domainFiles, level: 'domain' };
    }

    // Fall back to host-level (processor normalises hostnames to domains)
    const hostFiles = await findGraphFiles(name, 'host');
    if (hostFiles) {
      logger.info(`Using host-level graph (no domain-level available): ${name}`, hostFiles);
      return { name, ...hostFiles, level: 'host' };
    }
  }

  logger.warn('No CC release with graph files found after checking last 8 releases');
  return null;
}
