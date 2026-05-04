require('dotenv').config();
const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const pino = require('pino');

const log = pino({ level: process.env.LOG_LEVEL || 'info' });
const app = express();
const PORT = process.env.PORT || 12777;
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET;
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_SCANS || '3');
const SCAN_TIMEOUT_MS = parseInt(process.env.SCAN_TIMEOUT_MS || '45000');

app.use(cors());
app.use(express.json());

// --- Auth ---

function requireInternalSecret(req, res, next) {
    if (!INTERNAL_SECRET) return next();
    if (req.headers['x-internal-secret'] !== INTERNAL_SECRET) {
        return res.status(401).json({
            success: false,
            error: { code: 'UNAUTHORIZED', message: 'Invalid or missing internal secret' }
        });
    }
    next();
}

// --- Concurrency & browser tracking for graceful shutdown ---

let activeScanCount = 0;
const openBrowsers = new Set();

async function shutdown() {
    log.info('shutting down, closing open browsers');
    await Promise.all([...openBrowsers].map(b => b.close().catch(() => {})));
    process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// --- Endpoints ---

app.post('/api/scan', requireInternalSecret, async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ success: false, error: { code: 'MISSING_URL', message: 'URL is required' } });
    }

    let parsedUrl;
    try {
        parsedUrl = new URL(url);
    } catch {
        return res.status(400).json({ success: false, error: { code: 'INVALID_URL', message: 'Invalid URL format' } });
    }

    if (activeScanCount >= MAX_CONCURRENT) {
        return res.status(429).json({
            success: false,
            error: { code: 'CAPACITY', message: 'Too many concurrent scans. Try again shortly.' }
        });
    }

    activeScanCount++;
    const startTime = Date.now();
    let browser;

    try {
        log.info({ url }, 'scan started');

        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        });
        openBrowsers.add(browser);

        const scanPromise = runScan(browser, url, parsedUrl);
        scanPromise.catch(() => {}); // suppress unhandled rejection if timeout wins the race

        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('SCAN_TIMEOUT')), SCAN_TIMEOUT_MS)
        );

        const result = await Promise.race([scanPromise, timeoutPromise]);
        const scanDurationMs = Date.now() - startTime;

        log.info({ url, scanDurationMs, cookieCount: result.cookies.length }, 'scan completed');

        res.json({
            success: true,
            meta: { url, scannedAt: new Date().toISOString(), scanDurationMs },
            ...result
        });

    } catch (error) {
        const scanDurationMs = Date.now() - startTime;
        const isTimeout = error.message === 'SCAN_TIMEOUT';
        log.error({ url, scanDurationMs, err: error.message }, 'scan failed');

        const status = isTimeout ? 504 : 500;
        const code = isTimeout ? 'SCAN_TIMEOUT' : 'SCAN_FAILED';
        const message = isTimeout
            ? `Scan timed out after ${SCAN_TIMEOUT_MS / 1000}s`
            : 'Failed to scan website';

        res.status(status).json({ success: false, error: { code, message } });

    } finally {
        activeScanCount--;
        if (browser) {
            openBrowsers.delete(browser);
            browser.close().catch(() => {});
        }
    }
});

app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        activeScanCount,
        capacity: MAX_CONCURRENT
    });
});

app.get('/', (req, res) => {
    res.json({
        ok: true,
        service: 'cookie-scanner-api',
        endpoints: ['GET /api/health', 'POST /api/scan'],
    });
});

// --- Core scan logic ---

async function runScan(browser, url, parsedUrl) {
    const page = await browser.newPage();
    await page.setDefaultNavigationTimeout(30000);
    await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    const requestedDomains = new Set();
    await page.setRequestInterception(true);
    page.on('request', (request) => {
        try { requestedDomains.add(new URL(request.url()).hostname); } catch {}
        request.continue();
    });

    await page.goto(url, { waitUntil: ['domcontentloaded', 'networkidle2'], timeout: 30000 });

    await page.evaluate(() => {
        const texts = ['Accept', 'Accept all', 'I agree', 'Akceptuj', 'Zaakceptuj', 'Zgadzam', 'Akceptuję'];
        const btns = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"]'));
        const target = btns.find(b => texts.some(t => (b.textContent || '').trim().toLowerCase().includes(t.toLowerCase())));
        if (target) target.click();
    });

    await new Promise(resolve => setTimeout(resolve, 5000));

    const trackers = await detectTrackers(page, requestedDomains);
    const rawCookies = await page.cookies();
    const cookies = rawCookies.map(cookie => normalizeCookie(cookie, parsedUrl.hostname));

    const storage = await page.evaluate(() => ({
        localStorage: Object.keys(localStorage).length,
        sessionStorage: Object.keys(sessionStorage).length,
    }));

    const stats = buildStats(cookies, storage);
    const privacyAnalysis = generatePrivacyAnalysis(stats, cookies);

    return { cookies, trackers, storage, stats, privacyAnalysis };
}

// --- Cookie normalization ---

function normalizeCookie(cookie, mainHostname) {
    const cookieDomain = cookie.domain.replace(/^\./, '');
    const isFirstParty = mainHostname.endsWith(cookieDomain) || cookieDomain.endsWith(mainHostname);

    let duration = 'Session';
    let expiresAt = null;
    let durationDays = null;

    if (cookie.expires && cookie.expires !== -1) {
        expiresAt = new Date(cookie.expires * 1000).toISOString();
        durationDays = Math.round((cookie.expires * 1000 - Date.now()) / (1000 * 60 * 60 * 24));
        duration = formatDuration(durationDays);
    }

    return {
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path,
        category: categorizeCookie(cookie.name, cookie.domain),
        description: describeCookie(cookie.name, cookie.domain),
        isFirstParty,
        duration,
        durationDays,
        expiresAt,
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        sameSite: cookie.sameSite || 'None',
        isSession: !cookie.expires || cookie.expires === -1,
    };
}

function formatDuration(days) {
    if (days <= 1) return '1 day';
    if (days <= 7) return `${days} days`;
    if (days <= 31) return `${Math.round(days / 7)} weeks`;
    if (days <= 365) return `${Math.round(days / 30)} months`;
    const years = Math.round(days / 365);
    return years === 1 ? '1 year' : `${years} years`;
}

// --- Tracker detection ---

async function detectTrackers(page, requestedDomains) {
    const trackers = [];

    const js = await page.evaluate(() => ({
        hasGtag: typeof window.gtag === 'function',
        hasDataLayer: Array.isArray(window.dataLayer) && window.dataLayer.length > 0,
        hasFbq: typeof window.fbq === 'function',
        hasHotjar: typeof window.hj === 'function',
        hasIntercom: typeof window.Intercom === 'function',
        hasMatomo: typeof window.Matomo !== 'undefined' || typeof window._paq !== 'undefined',
        hasMixpanel: typeof window.mixpanel !== 'undefined',
        hasClarity: typeof window.clarity === 'function',
    }));

    if (js.hasGtag || js.hasDataLayer) trackers.push({ name: 'Google Analytics / GTM', type: 'analytics', domain: 'google-analytics.com' });
    if (js.hasFbq)      trackers.push({ name: 'Meta (Facebook) Pixel', type: 'marketing',  domain: 'facebook.com' });
    if (js.hasHotjar)   trackers.push({ name: 'Hotjar',                 type: 'analytics', domain: 'hotjar.com' });
    if (js.hasIntercom) trackers.push({ name: 'Intercom',               type: 'functional', domain: 'intercom.io' });
    if (js.hasMatomo)   trackers.push({ name: 'Matomo',                 type: 'analytics', domain: 'matomo.org' });
    if (js.hasMixpanel) trackers.push({ name: 'Mixpanel',               type: 'analytics', domain: 'mixpanel.com' });
    if (js.hasClarity)  trackers.push({ name: 'Microsoft Clarity',      type: 'analytics', domain: 'clarity.ms' });

    const networkTrackers = [
        { match: 'doubleclick.net',           name: 'Google DoubleClick',      type: 'marketing' },
        { match: 'adservice.google.com',      name: 'Google Ads',              type: 'marketing' },
        { match: 'googlesyndication.com',     name: 'Google AdSense',          type: 'marketing' },
        { match: 'snap.licdn.com',            name: 'LinkedIn Insight Tag',    type: 'marketing' },
        { match: 'ct.pinterest.com',          name: 'Pinterest Tag',           type: 'marketing' },
        { match: 'static.ads-twitter.com',    name: 'Twitter/X Pixel',         type: 'marketing' },
        { match: 'analytics.tiktok.com',      name: 'TikTok Pixel',            type: 'marketing' },
        { match: 'sc-static.net',             name: 'Snapchat Pixel',          type: 'marketing' },
    ];

    for (const domain of requestedDomains) {
        for (const tracker of networkTrackers) {
            if (domain.includes(tracker.match) && !trackers.find(t => t.name === tracker.name)) {
                trackers.push({ name: tracker.name, type: tracker.type, domain });
            }
        }
    }

    return trackers;
}

// --- Stats ---

function buildStats(cookies, storage) {
    return {
        total: cookies.length,
        firstParty: cookies.filter(c => c.isFirstParty).length,
        thirdParty: cookies.filter(c => !c.isFirstParty).length,
        secure: cookies.filter(c => c.secure).length,
        httpOnly: cookies.filter(c => c.httpOnly).length,
        session: cookies.filter(c => c.isSession).length,
        persistent: cookies.filter(c => !c.isSession).length,
        byCategory: {
            essential: cookies.filter(c => c.category === 'essential').length,
            functional: cookies.filter(c => c.category === 'functional').length,
            analytics: cookies.filter(c => c.category === 'analytics').length,
            marketing: cookies.filter(c => c.category === 'marketing').length,
        },
        storage,
    };
}

// --- Cookie classification ---

function categorizeCookie(name, domain) {
    const n = name.toLowerCase();
    const d = domain.toLowerCase();

    if (n.match(/session|sess|csrf|xsrf|auth|token|login|user|security/)) return 'essential';
    if (n.match(/_ga|_gid|_gat|analytics|matomo|_pk|visitor|clicky/))     return 'analytics';
    if (d.match(/google-analytics|matomo|piwik|mixpanel|segment/))         return 'analytics';
    if (n.match(/_fb|fbp|fr|_gcl|ads|doubleclick|ide|test_cookie|conversion/)) return 'marketing';
    if (d.match(/facebook|doubleclick|google.*ads|adsense|adwords|advertising|twitter|linkedin.*ads/)) return 'marketing';
    if (n.match(/lang|locale|currency|theme|preference|settings|consent|cookie|gdpr|ccpa/)) return 'functional';

    return 'functional';
}

function describeCookie(name, domain) {
    const n = name.toLowerCase();
    const d = domain.toLowerCase();

    const known = {
        'session': 'Session identifier for maintaining user state',
        'sessionid': 'Session identifier for maintaining user state',
        'phpsessid': 'PHP session identifier',
        'jsessionid': 'Java session identifier',
        'asp.net_sessionid': 'ASP.NET session identifier',
        'csrf': 'Cross-Site Request Forgery protection token',
        'xsrf-token': 'Cross-Site Request Forgery protection token',
        '_ga': 'Google Analytics - Main tracking cookie',
        '_gid': 'Google Analytics - Session tracking',
        '_gat': 'Google Analytics - Request throttling',
        '_fbp': 'Facebook Pixel - Browser identifier',
        'fr': 'Facebook - Advertising and analytics',
        'ide': 'Google DoubleClick - Advertising identifier',
        'test_cookie': 'Google DoubleClick - Check if cookies are enabled',
        '_gcl_au': 'Google AdSense - Advertising performance',
        'laravel_session': 'Laravel framework session cookie',
        'remember_web': 'Laravel remember me functionality',
        'locale': 'User language preference',
        'theme': 'User theme preference',
        'consent': 'Cookie consent preference',
    };

    if (known[n]) return known[n];

    if (n.includes('session'))                          return 'Session management';
    if (n.includes('auth'))                             return 'Authentication';
    if (n.includes('token'))                            return 'Security token';
    if (n.includes('preference') || n.includes('settings')) return 'User preferences';
    if (n.includes('lang') || n.includes('locale'))    return 'Language preference';
    if (n.includes('consent') || n.includes('gdpr'))   return 'Cookie consent tracking';

    if (d.includes('google'))    return 'Google service cookie';
    if (d.includes('facebook'))  return 'Facebook tracking';
    if (d.includes('youtube'))   return 'YouTube functionality';
    if (d.includes('twitter'))   return 'Twitter integration';

    return 'Website functionality cookie';
}

// --- Privacy analysis ---

function generatePrivacyAnalysis(stats, cookies) {
    const analysis = {
        score: 0,
        grade: '',
        issues: [],
        recommendations: [],
        compliance: {
            gdpr: { compliant: true, issues: [] },
            ccpa: { compliant: true, issues: [] }
        }
    };

    let score = 100;

    const secureRatio = stats.total > 0 ? (stats.secure / stats.total) * 100 : 100;
    if (secureRatio < 80) {
        analysis.issues.push(`Only ${Math.round(secureRatio)}% of cookies have the Secure flag`);
        analysis.recommendations.push('Enable Secure flag on all cookies to prevent transmission over unsecured connections');
        score -= 15;
    }

    const httpOnlyRatio = stats.total > 0 ? (stats.httpOnly / stats.total) * 100 : 100;
    if (httpOnlyRatio < 50) {
        analysis.issues.push('Many cookies are accessible via JavaScript, increasing XSS risk');
        analysis.recommendations.push('Enable HttpOnly flag on session and authentication cookies');
        score -= 10;
    }

    if (stats.total > 0 && stats.thirdParty / stats.total > 0.5) {
        analysis.issues.push(`High number of third-party cookies (${stats.thirdParty}/${stats.total})`);
        analysis.recommendations.push('Review third-party cookie usage and consider privacy-friendly alternatives');
        score -= 10;
    }

    if (stats.byCategory.marketing > 5) {
        analysis.issues.push(`${stats.byCategory.marketing} marketing/tracking cookies detected`);
        analysis.recommendations.push('Ensure proper consent is obtained before setting marketing cookies');
        score -= 5;
    }

    if (stats.byCategory.marketing > 0 || stats.byCategory.analytics > 0) {
        analysis.compliance.gdpr.compliant = false;
        analysis.compliance.gdpr.issues.push('Non-essential cookies present — requires explicit user consent under GDPR');
        analysis.recommendations.push('Implement a cookie consent banner compliant with GDPR');
    }

    const longLivedCookies = cookies.filter(c => c.durationDays !== null && c.durationDays > 365);
    if (longLivedCookies.length > 0) {
        analysis.issues.push(`${longLivedCookies.length} cookies expire after more than 1 year`);
        analysis.recommendations.push('Review cookie expiration times and minimize data retention periods');
        score -= 5;
    }

    analysis.score = Math.max(0, Math.min(100, score));

    if (analysis.score >= 90)      analysis.grade = 'A';
    else if (analysis.score >= 80) analysis.grade = 'B';
    else if (analysis.score >= 70) analysis.grade = 'C';
    else if (analysis.score >= 60) analysis.grade = 'D';
    else                           analysis.grade = 'F';

    return analysis;
}

// --- Start ---

const server = app.listen(PORT, () => {
    log.info({ port: PORT }, 'cookie-scanner-api started');
});
