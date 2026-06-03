# CC Scanner

Free backlink intelligence powered by [Common Crawl](https://commoncrawl.org).

Streams Common Crawl's domain-level link graph, extracts backlink data for domains you care about, and pushes the results to any HTTP endpoint. No paid APIs. No scraping.

## How it works

Common Crawl publishes a pre-computed domain-level link graph with every monthly crawl — every `source_domain → target_domain` edge found across billions of crawled pages. This scanner:

1. Fetches your list of watched domains from your API
2. Discovers the latest CC graph release on S3
3. Streams the vertices and edges files (2–5 GB compressed) in three passes — no disk writes
4. Filters for edges where the target is one of your domains
5. Optionally enriches with [Open PageRank](https://openpagerank.com) scores (free API)
6. POSTs the results back to your API in batches

A full run takes 15–30 minutes. The scanner checks for new releases on a cron schedule and skips runs where the latest release is already processed.

## Requirements

- Node.js 18+
- 4 GB RAM minimum (peak usage ~300–600 MB at typical scale)
- A server with good bandwidth (downloads ~3–6 GB per run)
- Two HTTP endpoints on your platform (see [API contract](#api-contract))

Tested on Oracle Cloud Always Free (4 ARM CPU, 24 GB RAM) and Hetzner CX22 (4 GB RAM, x86).

## Setup

```bash
git clone https://github.com/your-org/cc-scanner
cd cc-scanner
npm install
cp .env.example .env
nano .env   # fill in required values
npm start
```

On first start the scanner runs immediately, then fires on the configured cron schedule.

## Configuration

| Variable | Required | Description |
|---|---|---|
| `INDEXARO_URL` | Yes | Base URL of your platform (no trailing slash) |
| `CC_INTERNAL_SECRET` | Yes | Shared secret — must match your API's expected value |
| `OPR_API_KEY` | No | [Open PageRank](https://openpagerank.com) API key for authority scores |
| `TOP_DOMAINS_LIMIT` | No | Max referring domains to store per target (default: 100) |
| `CRON_SCHEDULE` | No | Cron expression for recurring checks (default: `0 4 * * 1`) |

## API contract

The scanner calls two endpoints on your platform.

### `GET /api/v1/internal/cc/domains`

Returns the list of domains to extract backlinks for, and the last processed crawl ID (so the scanner can skip already-processed releases).

**Auth:** `Authorization: Bearer <CC_INTERNAL_SECRET>`

**Response:**
```json
{
  "domains": ["example.com", "mysite.com"],
  "lastCrawlId": "cc-main-2024-22",
  "count": 2
}
```

### `POST /api/v1/internal/cc/backlinks`

Receives the extracted backlink data in batches.

**Auth:** `Authorization: Bearer <CC_INTERNAL_SECRET>`

**Body:**
```json
{
  "crawlId": "cc-main-2024-22",
  "results": [
    {
      "domain": "example.com",
      "referringDomains": [
        { "sourceDomain": "producthunt.com", "linkCount": 3 },
        { "sourceDomain": "github.com", "linkCount": 1 }
      ],
      "totalReferringDomains": 847,
      "openPageRank": 3.4
    }
  ]
}
```

### `PATCH /api/v1/internal/cc/backlinks`

Updates the crawl run status (RUNNING / FAILED).

**Body:** `{ "crawlId": "...", "status": "RUNNING" | "FAILED", "errorMessage": "..." }`

## Production deployment (PM2)

```bash
npm install -g pm2
pm2 start "npm start" --name cc-scanner
pm2 save
pm2 startup   # follow the printed command to enable on boot
```

## Data source

Backlink data comes from Common Crawl's [host and domain-level web graphs](https://commoncrawl.org/blog/host-and-domain-level-web-graphs). These are released periodically (roughly quarterly) and represent domain-to-domain link relationships extracted from billions of crawled pages.

Coverage is approximately 40–60% of the web — less complete than commercial tools like Ahrefs or Majestic, but completely free and with no ToS concerns.

## License

MIT
