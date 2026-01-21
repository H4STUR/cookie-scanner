# Cookie Scanner API

A backend service that analyzes cookies, local storage, and tracking mechanisms on websites for privacy compliance (GDPR/CCPA).

## Features

- **Cookie Analysis**: Detects and classifies cookies as essential, functional, analytics, or marketing
- **Storage Scanning**: Analyzes localStorage and sessionStorage
- **Tracker Detection**: Identifies Google Analytics (GA4), Facebook Pixel, DoubleClick, Matomo/Piwik
- **Privacy Scoring**: Generates A-F privacy grade with compliance recommendations
- **Cookie Banner Handling**: Auto-accepts consent dialogs for accurate scanning
- **Third-Party Tracking**: Logs all external domains contacted during page load

## Installation

```bash
npm install
```

## Usage

### Development

```bash
npm run dev
```

### Production

```bash
npm start
```

### Docker

```bash
docker build -t cookie-scanner .
docker run -p 3000:3000 cookie-scanner
```

## API Endpoints

### `POST /api/scan`

Scan a website for cookies and tracking.

**Request:**
```json
{
  "url": "https://example.com"
}
```

**Response:**
```json
{
  "success": true,
  "url": "https://example.com",
  "scannedAt": "2024-01-15T10:30:00.000Z",
  "cookies": [
    {
      "name": "_ga",
      "domain": ".example.com",
      "type": "analytics",
      "isFirstParty": true,
      "secure": true,
      "httpOnly": false,
      "description": "Google Analytics - Main tracking cookie"
    }
  ],
  "storage": {
    "localStorage": [],
    "sessionStorage": []
  },
  "stats": {
    "total": 5,
    "firstParty": 3,
    "thirdParty": 2,
    "byType": {
      "essential": 1,
      "functional": 1,
      "analytics": 2,
      "marketing": 1
    }
  },
  "privacyAnalysis": {
    "score": 75,
    "grade": "C",
    "issues": ["..."],
    "recommendations": ["..."],
    "compliance": {
      "gdpr": { "compliant": true, "issues": [] },
      "ccpa": { "compliant": true, "issues": [] }
    }
  },
  "gaDetected": {
    "hasGtag": true,
    "hasDataLayer": true,
    "hasGA4": true
  }
}
```

### `GET /api/health`

Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### `GET /`

Service info and available endpoints.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |

## License

MIT
