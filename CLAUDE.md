# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Cookie Scanner Backend - A Node.js/Express API that uses Puppeteer to analyze cookies, local storage, and tracking mechanisms on websites for privacy compliance checking (GDPR/CCPA).

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

**Single-file backend**: The entire application lives in `cookie-scanner-backend.js` (~400 lines).

### API Endpoints
- `POST /api/scan` - Main scanning endpoint. Accepts `{ url: string }`, launches headless Chrome, navigates to URL, accepts cookie banners, extracts cookies/storage, returns privacy analysis
- `GET /api/health` - Health check returning `{ status: 'ok', timestamp }`
- `GET /` - Service info and available endpoints

### Core Flow
1. Puppeteer launches headless Chromium
2. Request interception tracks all third-party domains
3. Page navigates to target URL
4. Auto-clicks cookie consent buttons (OneTrust, "Accept all", Polish variants)
5. Extracts cookies, localStorage, sessionStorage
6. Classifies cookies (essential/functional/analytics/marketing)
7. Detects tracking (Google Analytics, Facebook Pixel, DoubleClick, Matomo)
8. Generates privacy score (A-F grade) and compliance recommendations

### Key Functions
- `categorizeCookie(name, domain)` - Classifies cookies by purpose
- `describeCookie(name, domain)` - Human-readable descriptions for known cookies
- `generatePrivacyAnalysis(stats, cookies)` - Calculates privacy score and GDPR/CCPA compliance

## Technology Stack
- Node.js 20 / Express 4.18
- Puppeteer 24.34 (headless Chromium)
- Docker (Node 20-slim with Chromium dependencies)

## Environment
- `PORT` - Server port (default: 3000)
