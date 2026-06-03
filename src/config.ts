import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// Load .env file if present (simple implementation — no dotenv dependency)
const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) {
  const lines = readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !(key in process.env)) process.env[key] = val;
  }
}

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Required env var ${key} is not set`);
  return val;
}

export const config = {
  indexaroUrl:    required('INDEXARO_URL').replace(/\/$/, ''),
  internalSecret: required('CC_INTERNAL_SECRET'),
  oprApiKey:      process.env.OPR_API_KEY ?? '',
  topDomainsLimit: parseInt(process.env.TOP_DOMAINS_LIMIT ?? '100', 10),
  cronSchedule:   process.env.CRON_SCHEDULE ?? '0 4 * * 1',
  tempDir:        process.env.TEMP_DIR ?? '/tmp/cc-scanner',
} as const;
