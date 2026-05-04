# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Cookie Scanner — a stateless Node.js/Express microservice that uses Puppeteer to scan websites for cookies, local storage, and tracking scripts. Intended as an internal microservice called by a SaaS main app; it does not manage users, API keys, or scan history (all of that lives in the main app).

## Commands

```bash
# Start server (production)
npm start

# Start with auto-reload (development)
npm run dev

# Docker build & run
docker build -t cookie-scanner .
docker run -p 3000:3000 cookie-scanner
```

## Architecture

**Single-file backend**: The entire application lives in `app.js` (~400 lines).

### API Endpoints
- `POST /api/scan` — Main scanning endpoint. Accepts `{ url: string }`, launches headless Chrome, returns structured scan results (see Response Schema below)
- `GET /api/health` — Health check: `{ status, timestamp, activeScanCount, capacity }`
- `GET /` — Service info

### Authentication
Protected by a shared secret: set `INTERNAL_API_SECRET` env var, then pass it as `X-Internal-Secret` header on every request. If the env var is unset, auth is skipped (useful for local dev).

### Concurrency & timeouts
- Max parallel scans: `MAX_CONCURRENT_SCANS` (default `3`). Returns `429` when at capacity.
- Hard scan timeout: `SCAN_TIMEOUT_MS` (default `45000`). Returns `504` on timeout.
- Open browsers are tracked and closed on `SIGTERM`/`SIGINT`.

### Core Flow
1. Puppeteer launches headless Chromium
2. Request interception tracks all requested hostnames
3. Page navigates to target URL (`networkidle2`, 30 s nav timeout)
4. Auto-clicks cookie consent buttons (OneTrust, "Accept all", Polish variants)
5. Waits 5 s for post-consent cookies to settle
6. Detects JS-based trackers (`gtag`, `fbq`, `hj`, etc.) + network-based trackers
7. Extracts and normalises cookies (no values stored — only metadata)
8. Generates privacy score (A–F) and GDPR/CCPA compliance notes

### Response Schema

```jsonc
{
  "success": true,
  "meta": { "url", "scannedAt", "scanDurationMs" },
  "cookies": [
    {
      "name", "domain", "path",
      "category",      // "essential" | "functional" | "analytics" | "marketing"
      "description",   // human-readable purpose
      "isFirstParty",
      "duration",      // "Session" | "1 day" | "2 years" etc.
      "durationDays",  // null for session cookies
      "expiresAt",     // ISO string or null
      "httpOnly", "secure", "sameSite", "isSession"
    }
  ],
  "trackers": [
    { "name", "type", "domain" }
  ],
  "storage": { "localStorage": 5, "sessionStorage": 2 },  // counts only
  "stats": {
    "total", "firstParty", "thirdParty", "secure", "httpOnly", "session", "persistent",
    "byCategory": { "essential", "functional", "analytics", "marketing" },
    "storage": { "localStorage", "sessionStorage" }
  },
  "privacyAnalysis": {
    "score", "grade",          // 0-100, A-F
    "issues", "recommendations",
    "compliance": {
      "gdpr": { "compliant", "issues" },
      "ccpa": { "compliant", "issues" }
    }
  }
}
```

Error responses always have shape `{ "success": false, "error": { "code", "message" } }`.

### Key Functions
- `runScan(browser, url, parsedUrl)` — orchestrates the full page scan
- `normalizeCookie(cookie, mainHostname)` — maps raw Puppeteer cookie to schema
- `detectTrackers(page, requestedDomains)` — JS + network tracker detection
- `categorizeCookie(name, domain)` — classifies cookies by purpose
- `describeCookie(name, domain)` — human-readable descriptions for known cookies
- `generatePrivacyAnalysis(stats, cookies)` — calculates privacy score and compliance

## Technology Stack
- Node.js 20 / Express 4.18
- Puppeteer 24.x (headless Chromium)
- pino (structured JSON logging)
- Docker (Node 20-slim with Chromium dependencies)

## Environment Variables
| Variable | Default | Description |
|---|---|---|
| `PORT` | `12777` | HTTP listen port |
| `INTERNAL_API_SECRET` | *(unset)* | Shared secret for `X-Internal-Secret` header. Unset = auth disabled |
| `MAX_CONCURRENT_SCANS` | `3` | Max parallel Puppeteer browsers |
| `SCAN_TIMEOUT_MS` | `45000` | Hard timeout per scan in ms |
| `LOG_LEVEL` | `info` | pino log level |
