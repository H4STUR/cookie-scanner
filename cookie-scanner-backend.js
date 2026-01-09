const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
// app.use(express.static('public'));

// Cookie scanning endpoint
app.post('/api/scan', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    // Validate URL
    try {
        new URL(url);
    } catch (e) {
        return res.status(400).json({ error: 'Invalid URL format' });
    }

    let browser;
    try {
        console.log(`Starting scan for: ${url}`);
        
        // Launch browser
        browser = await puppeteer.launch({
            headless: 'new',
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu'
                ]
        });

        const page = await browser.newPage();
        
        // Set user agent
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // Enable request interception to track third-party domains
        const requestedDomains = new Set();
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            const requestUrl = new URL(request.url());
            requestedDomains.add(requestUrl.hostname);
            request.continue();
        });

        // Navigate to the page
        await page.goto(url, { waitUntil: ['domcontentloaded', 'networkidle2'], timeout: 60000 });


        // After page.goto(...)
        const possibleButtons = [
        'button#onetrust-accept-btn-handler',
        'button[aria-label*="accept" i]',
        'button:has-text("Accept")',
        'button:has-text("I agree")',
        'button:has-text("Akceptuj")',
        'button:has-text("Zaakceptuj")',
        'button:has-text("Zgadzam")',
        'button:has-text("Accept all")',
        ];

        // Puppeteer doesn't support :has-text(...) selectors,
        // so do it with page.evaluate to click buttons by text:
        await page.evaluate(() => {
        const texts = [
            'Accept', 'Accept all', 'I agree',
            'Akceptuj', 'Zaakceptuj', 'Zgadzam', 'Akceptuję'
        ];

        const btns = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"]'));
        const target = btns.find(b => texts.some(t => (b.textContent || '').trim().toLowerCase().includes(t.toLowerCase())));
        if (target) target.click();
        });

        // Wait a bit for any delayed cookie setting
        await new Promise(resolve => setTimeout(resolve, 10000));

        /**
         * 🔍 GA / GTM detection (runs in page context)
         */
        const gaDetected = await page.evaluate(() => {
        const hasGtag = typeof window.gtag === 'function';
        const hasDataLayer = Array.isArray(window.dataLayer);

        // Typical GA4 via gtag: dataLayer includes ['config', 'G-XXXX']
        const hasGA4 =
            hasDataLayer &&
            window.dataLayer.some(e => Array.isArray(e) && e[0] === 'config');

        // Also helpful: look for common GA cookies by name (JS-visible ones only)
        const jsCookies = document.cookie || '';
        const hasGaCookie = /(^|;\s*)_ga=/.test(jsCookies) || /(^|;\s*)_gid=/.test(jsCookies);

        return {
            hasGtag,
            hasDataLayer,
            hasGA4,
            dataLayerLength: hasDataLayer ? window.dataLayer.length : 0,
            hasGaCookie
        };
        });

        // Get all cookies
        const cookies = await page.cookies();

        
        // Get the main domain
        const mainDomain = new URL(url).hostname;

        // Analyze each cookie
        const analyzedCookies = cookies.map(cookie => {
            const isFirstParty = cookie.domain.includes(mainDomain) || 
                                mainDomain.includes(cookie.domain.replace(/^\./, ''));
            
            return {
                name: cookie.name,
                value: cookie.value,
                domain: cookie.domain,
                path: cookie.path,
                expires: cookie.expires === -1 ? 'Session' : new Date(cookie.expires * 1000).toISOString(),
                expiresTimestamp: cookie.expires,
                size: (cookie.name + cookie.value).length,
                httpOnly: cookie.httpOnly,
                secure: cookie.secure,
                sameSite: cookie.sameSite || 'None',
                session: cookie.session,
                type: categorizeCookie(cookie.name, cookie.domain),
                isFirstParty: isFirstParty,
                description: describeCookie(cookie.name, cookie.domain)
            };
        });

        // Get local storage and session storage data
        const storageData = await page.evaluate(() => {
            return {
                localStorage: Object.keys(localStorage).map(key => ({
                    key,
                    value: localStorage.getItem(key),
                    size: (key + localStorage.getItem(key)).length
                })),
                sessionStorage: Object.keys(sessionStorage).map(key => ({
                    key,
                    value: sessionStorage.getItem(key),
                    size: (key + sessionStorage.getItem(key)).length
                }))
            };
        });

        // Calculate statistics
        const stats = {
            total: analyzedCookies.length,
            firstParty: analyzedCookies.filter(c => c.isFirstParty).length,
            thirdParty: analyzedCookies.filter(c => !c.isFirstParty).length,
            secure: analyzedCookies.filter(c => c.secure).length,
            httpOnly: analyzedCookies.filter(c => c.httpOnly).length,
            session: analyzedCookies.filter(c => c.session).length,
            persistent: analyzedCookies.filter(c => !c.session).length,
            byType: {
                essential: analyzedCookies.filter(c => c.type === 'essential').length,
                functional: analyzedCookies.filter(c => c.type === 'functional').length,
                analytics: analyzedCookies.filter(c => c.type === 'analytics').length,
                marketing: analyzedCookies.filter(c => c.type === 'marketing').length
            },
            localStorage: storageData.localStorage.length,
            sessionStorage: storageData.sessionStorage.length
        };

        // Generate privacy analysis
        const privacyAnalysis = generatePrivacyAnalysis(stats, analyzedCookies);

        // Get unique third-party domains
        const thirdPartyDomains = [...new Set(
            analyzedCookies
                .filter(c => !c.isFirstParty)
                .map(c => c.domain)
        )];

        await browser.close();

        res.json({
        success: true,
        url: url,
        scannedAt: new Date().toISOString(),
        cookies: analyzedCookies,
        storage: storageData,
        stats: stats,
        thirdPartyDomains: thirdPartyDomains,
        privacyAnalysis: privacyAnalysis,
        requestedDomains: [...requestedDomains],
        gaDetected
        });


    } catch (error) {
        console.error('Scan error:', error);
        if (browser) {
            await browser.close();
        }
        res.status(500).json({ 
            error: 'Failed to scan website',
            message: error.message 
        });
    }
});

// Helper function to categorize cookies
function categorizeCookie(name, domain) {
    const nameLower = name.toLowerCase();
    const domainLower = domain.toLowerCase();

    // Essential cookies
    if (nameLower.match(/session|sess|csrf|xsrf|auth|token|login|user|security/)) {
        return 'essential';
    }

    // Analytics cookies
    if (nameLower.match(/_ga|_gid|_gat|analytics|matomo|_pk|visitor|clicky/)) {
        return 'analytics';
    }
    if (domainLower.match(/google-analytics|matomo|piwik|mixpanel|segment/)) {
        return 'analytics';
    }

    // Marketing/Advertising cookies
    if (nameLower.match(/_fb|fbp|fr|_gcl|ads|doubleclick|ide|test_cookie|conversion/)) {
        return 'marketing';
    }
    if (domainLower.match(/facebook|doubleclick|google.*ads|adsense|adwords|advertising|twitter|linkedin.*ads/)) {
        return 'marketing';
    }

    // Functional cookies
    if (nameLower.match(/lang|locale|currency|theme|preference|settings|consent|cookie|gdpr|ccpa/)) {
        return 'functional';
    }

    // Default to functional
    return 'functional';
}

// Helper function to describe cookies
function describeCookie(name, domain) {
    const nameLower = name.toLowerCase();
    const domainLower = domain.toLowerCase();

    // Common cookie descriptions
    const descriptions = {
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
        'consent': 'Cookie consent preference'
    };

    if (descriptions[nameLower]) {
        return descriptions[nameLower];
    }

    // Generic descriptions based on patterns
    if (nameLower.includes('session')) return 'Session management';
    if (nameLower.includes('auth')) return 'Authentication';
    if (nameLower.includes('token')) return 'Security token';
    if (nameLower.includes('preference') || nameLower.includes('settings')) return 'User preferences';
    if (nameLower.includes('lang') || nameLower.includes('locale')) return 'Language preference';
    if (nameLower.includes('consent') || nameLower.includes('gdpr')) return 'Cookie consent tracking';
    
    if (domainLower.includes('google')) return 'Google service cookie';
    if (domainLower.includes('facebook')) return 'Facebook tracking';
    if (domainLower.includes('youtube')) return 'YouTube functionality';
    if (domainLower.includes('twitter')) return 'Twitter integration';

    return 'Website functionality cookie';
}

// Generate privacy analysis
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

    // Check security score
    const securityScore = stats.total > 0 ? (stats.secure / stats.total) * 100 : 100;
    if (securityScore < 80) {
        analysis.issues.push(`Only ${Math.round(securityScore)}% of cookies have the Secure flag`);
        analysis.recommendations.push('Enable Secure flag on all cookies to prevent transmission over unsecured connections');
        score -= 15;
    }

    // Check HttpOnly
    const httpOnlyScore = stats.total > 0 ? (stats.httpOnly / stats.total) * 100 : 100;
    if (httpOnlyScore < 50) {
        analysis.issues.push('Many cookies are accessible via JavaScript, increasing XSS risk');
        analysis.recommendations.push('Enable HttpOnly flag on session and authentication cookies');
        score -= 10;
    }

    // Check third-party cookies
    const thirdPartyRatio = stats.total > 0 ? stats.thirdParty / stats.total : 0;
    if (thirdPartyRatio > 0.5) {
        analysis.issues.push(`High number of third-party cookies (${stats.thirdParty}/${stats.total})`);
        analysis.recommendations.push('Review third-party cookie usage and consider privacy-friendly alternatives');
        score -= 10;
    }

    // Check marketing cookies
    if (stats.byType.marketing > 5) {
        analysis.issues.push(`${stats.byType.marketing} marketing/tracking cookies detected`);
        analysis.recommendations.push('Ensure proper consent is obtained before setting marketing cookies');
        score -= 5;
    }

    // GDPR compliance checks
    const hasMarketingCookies = stats.byType.marketing > 0;
    const hasAnalyticsCookies = stats.byType.analytics > 0;
    
    if (hasMarketingCookies || hasAnalyticsCookies) {
        analysis.compliance.gdpr.issues.push('Requires explicit user consent for non-essential cookies');
        analysis.recommendations.push('Implement a cookie consent banner compliant with GDPR');
    }

    // Check for session duration
    const longSessionCookies = cookies.filter(c => {
        if (c.expiresTimestamp === -1) return false;
        const expiryDate = new Date(c.expiresTimestamp * 1000);
        const now = new Date();
        const daysUntilExpiry = (expiryDate - now) / (1000 * 60 * 60 * 24);
        return daysUntilExpiry > 365;
    });

    if (longSessionCookies.length > 0) {
        analysis.issues.push(`${longSessionCookies.length} cookies expire after more than 1 year`);
        analysis.recommendations.push('Review cookie expiration times and minimize data retention periods');
        score -= 5;
    }

    // Calculate final score
    analysis.score = Math.max(0, Math.min(100, score));
    
    // Assign grade
    if (analysis.score >= 90) analysis.grade = 'A';
    else if (analysis.score >= 80) analysis.grade = 'B';
    else if (analysis.score >= 70) analysis.grade = 'C';
    else if (analysis.score >= 60) analysis.grade = 'D';
    else analysis.grade = 'F';

    return analysis;
}

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.status(200).json({
    ok: true,
    service: 'cookie-scanner-api',
    endpoints: ['GET /api/health', 'POST /api/scan'],
  });
});


app.listen(PORT, () => {
    console.log(`Cookie Scanner API running on http://localhost:${PORT}`);
    console.log(`Test endpoint: POST http://localhost:${PORT}/api/scan`);
});
