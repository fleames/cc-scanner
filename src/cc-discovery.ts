import { logger } from './logger';

const CC_CDN = 'https://data.commoncrawl.org';
const GRAPH_BASE = `${CC_CDN}/projects/hyperlinkgraph`;

export interface CcRelease {
  name: string;
  verticesUrl: string;
  edgesUrl: string;
  level: 'domain' | 'host';
}

/**
 * Generates plausible CC release names from newest to oldest.
 * CC crawls run roughly every 4-8 weeks. We probe the typical week numbers
 * rather than trying to list the S3 bucket (listing is not publicly allowed).
 */
function generateCandidates(): string[] {
  const candidates: string[] = [];
  const now = new Date();
  const currentYear = now.getFullYear();

  // CC uses these approximate week numbers across a year
  const weeks = [51, 46, 42, 38, 33, 26, 22, 18, 13, 10, 5, 1];

  // Check current year and 2 previous years, newest first
  for (let year = currentYear; year >= currentYear - 2; year--) {
    for (const week of weeks) {
      candidates.push(`cc-main-${year}-${String(week).padStart(2, '0')}`);
    }
  }

  return candidates;
}

/**
 * Probes for graph files for a given release name and level.
 * CC has used different filename conventions across releases — tries all known patterns.
 * Uses HEAD requests so no data is downloaded.
 */
async function probeFiles(
  releaseName: string,
  level: 'domain' | 'host',
): Promise<{ verticesUrl: string; edgesUrl: string } | null> {
  const base = `${GRAPH_BASE}/${releaseName}/${level}`;

  // Known filename patterns CC has used across different releases
  const verticesPatterns = [
    `${releaseName}-${level}-vertices.txt.gz`,
    `cc-main-${level}-vertices.txt.gz`,
    `${level}-vertices.txt.gz`,
    `vertices.txt.gz`,
  ];

  for (const vFile of verticesPatterns) {
    const verticesUrl = `${base}/${vFile}`;
    try {
      const res = await fetch(verticesUrl, { method: 'HEAD' });
      if (!res.ok) continue;

      // Found vertices — construct edges URL using same naming convention
      const eFile = vFile.replace('vertices', 'edges');
      const edgesUrl = `${base}/${eFile}`;

      // Verify edges file also exists
      const eRes = await fetch(edgesUrl, { method: 'HEAD' });
      if (!eRes.ok) continue;

      return { verticesUrl, edgesUrl };
    } catch {
      // Network error on this probe — try next pattern
    }
  }

  return null;
}

/**
 * Returns the latest CC release that has graph files, by probing known URL patterns.
 * Prefers domain-level (eTLD+1 aggregated); falls back to host-level.
 */
export async function getLatestRelease(): Promise<CcRelease | null> {
  logger.info('Discovering latest CC release (probing known URL patterns)...');

  const candidates = generateCandidates();
  logger.debug(`Probing ${candidates.length} candidate release names`);

  for (const name of candidates) {
    logger.debug(`Probing ${name}...`);

    // Try domain-level first
    const domainFiles = await probeFiles(name, 'domain');
    if (domainFiles) {
      logger.info(`Found domain-level graph: ${name}`, domainFiles);
      return { name, ...domainFiles, level: 'domain' };
    }

    // Fall back to host-level
    const hostFiles = await probeFiles(name, 'host');
    if (hostFiles) {
      logger.info(`Found host-level graph: ${name}`, hostFiles);
      return { name, ...hostFiles, level: 'host' };
    }
  }

  logger.warn('No CC release found after probing all candidates');
  return null;
}
