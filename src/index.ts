import cron from 'node-cron';
import { config } from './config';
import { logger } from './logger';
import { getLatestRelease } from './cc-discovery';
import { processRelease } from './cc-processor';
import {
  getWatchedDomains,
  markRunStarted,
  markRunFailed,
  pushBacklinks,
  sendHeartbeat,
} from './indexaro-client';

let isRunning = false;

async function runScan(): Promise<void> {
  if (isRunning) {
    logger.warn('Scan already in progress — skipping this trigger');
    return;
  }
  isRunning = true;

  const startedAt = Date.now();
  logger.info('=== CC Scanner run started ===');

  try {
    // 1. Fetch watched domains + last processed crawl ID
    logger.info('Fetching watched domains from Indexaro...');
    const { domains, lastCrawlId } = await getWatchedDomains();
    logger.info(`Fetched ${domains.length} watched domains`, { lastCrawlId });

    if (domains.length === 0) {
      logger.info('No domains to process — exiting');
      return;
    }

    // 2. Discover latest CC release
    const release = await getLatestRelease();
    if (!release) {
      logger.warn('No CC release available — will retry on next schedule');
      return;
    }

    // 3. Skip if already processed
    if (lastCrawlId === release.name) {
      logger.info(`Release ${release.name} already processed — nothing to do`);
      return;
    }

    logger.info(`New CC release found: ${release.name}`);
    logger.info(`Watched domains sample`, { domains: domains.slice(0, 10) });

    // 4. Mark run as started
    await markRunStarted(release.name);

    // 5. Process the release (3-pass streaming)
    const results = await processRelease(
      release.verticesUrl,
      release.edgesUrl,
      domains,
      release.ranksUrl,
    );

    if (results.length === 0) {
      logger.warn('No results produced — marking as failed');
      await markRunFailed(release.name, 'No matching domains found in CC graph');
      return;
    }

    // 6. Push results to Indexaro
    logger.info(`Pushing ${results.length} domain results to Indexaro...`);
    await pushBacklinks(release.name, results);

    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    logger.info(`=== CC Scanner run complete ===`, {
      crawlId: release.name,
      domainsProcessed: results.length,
      elapsedSeconds: elapsed,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('CC Scanner run failed', { error: msg });

    // Best-effort: try to mark the run as failed if we know the crawl ID
    // (we may not have it if discovery failed)
    try {
      const { lastCrawlId } = await getWatchedDomains();
      if (lastCrawlId) await markRunFailed(lastCrawlId, msg);
    } catch { /* swallow — we're already in error handling */ }
  } finally {
    isRunning = false;
  }
}

const startedAt = Date.now();

async function heartbeat(lastCrawlId: string | null = null) {
  const uptime = Math.floor((Date.now() - startedAt) / 1000);
  try {
    await sendHeartbeat(lastCrawlId, uptime);
    logger.debug('Heartbeat sent', { uptime });
  } catch (err) {
    logger.warn('Heartbeat failed', { error: String(err) });
  }
}

async function main() {
  logger.info('CC Scanner starting', {
    indexaroUrl: config.indexaroUrl,
    cron: config.cronSchedule,
    topDomainsLimit: config.topDomainsLimit,
    oprEnabled: Boolean(config.oprApiKey),
  });

  // Send immediate heartbeat so admin panel shows Online right away
  await heartbeat();

  // Heartbeat every 30 minutes
  setInterval(() => heartbeat(), 30 * 60 * 1000);

  // Run once immediately on startup to catch up if needed
  logger.info('Running initial scan on startup...');
  await runScan();

  // Schedule recurring scans
  if (!cron.validate(config.cronSchedule)) {
    logger.error(`Invalid cron schedule: ${config.cronSchedule}`);
    process.exit(1);
  }

  cron.schedule(config.cronSchedule, () => {
    logger.info('Cron trigger fired');
    runScan().catch(err => logger.error('Unhandled error in runScan', { error: String(err) }));
  });

  logger.info(`Scheduled: ${config.cronSchedule}`);
}

main().catch(err => {
  logger.error('Fatal error during startup', { error: String(err) });
  process.exit(1);
});
