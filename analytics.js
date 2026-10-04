const path = require('path');
let geoip = null;
try {
    geoip = require('geoip-lite');
} catch (_) {
    try {
        geoip = require('/root/netflix/node_modules/geoip-lite');
    } catch (_) {}
}

const COUNTRY_NAMES = {
    'DZ': 'Algeria', 'SA': 'Saudi Arabia', 'EG': 'Egypt', 'MA': 'Morocco',
    'TN': 'Tunisia', 'FR': 'France', 'US': 'United States', 'GB': 'United Kingdom',
    'DE': 'Germany', 'ES': 'Spain', 'IT': 'Italy', 'TR': 'Turkey',
    'AE': 'United Arab Emirates', 'QA': 'Qatar', 'KW': 'Kuwait', 'OM': 'Oman',
    'BH': 'Bahrain', 'JO': 'Jordan', 'LB': 'Lebanon', 'IQ': 'Iraq',
    'SY': 'Syria', 'PS': 'Palestine', 'YE': 'Yemen', 'SD': 'Sudan',
    'LY': 'Libya', 'MR': 'Mauritania', 'SO': 'Somalia', 'CA': 'Canada',
    'BR': 'Brazil', 'MX': 'Mexico', 'RU': 'Russia', 'CN': 'China',
    'JP': 'Japan', 'KR': 'South Korea', 'IN': 'India', 'ID': 'Indonesia',
    'PK': 'Pakistan', 'BD': 'Bangladesh', 'NG': 'Nigeria', 'ZA': 'South Africa',
    'NL': 'Netherlands', 'BE': 'Belgium', 'SE': 'Sweden', 'NO': 'Norway',
    'CH': 'Switzerland', 'AT': 'Austria', 'PL': 'Poland', 'GR': 'Greece',
    'PT': 'Portugal', 'RO': 'Romania', 'IE': 'Ireland', 'AU': 'Australia',
    'NZ': 'New Zealand', 'SG': 'Singapore', 'MY': 'Malaysia', 'TH': 'Thailand',
    'VN': 'Vietnam', 'PH': 'Philippines', 'AR': 'Argentina', 'CO': 'Colombia',
    'CL': 'Chile', 'PE': 'Peru', 'VE': 'Venezuela'
};

// In-Memory Active Sessions (Last 2 minutes)
const activeSessions = new Map();
const ACTIVE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

// Prune inactive sessions every 30 seconds
setInterval(() => {
    const now = Date.now();
    for (const [id, sess] of activeSessions.entries()) {
        if (now - sess.lastSeen > ACTIVE_THRESHOLD_MS) {
            activeSessions.delete(id);
        }
    }
}, 30 * 1000);

function getClientIp(req) {
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return cf.split(',')[0].trim();
    const xReal = req.headers['x-real-ip'];
    if (xReal) return xReal.split(',')[0].trim();
    const xForwarded = req.headers['x-forwarded-for'];
    if (xForwarded) return xForwarded.split(',')[0].trim();
    return req.ip || req.socket.remoteAddress || '127.0.0.1';
}

function resolveCountry(ip, req) {
    // 1. Cloudflare header
    const cfCountry = req && req.headers ? req.headers['cf-ipcountry'] : null;
    if (cfCountry && cfCountry.length === 2 && cfCountry !== 'XX' && cfCountry !== 'T1') {
        const code = cfCountry.toUpperCase();
        return {
            code,
            name: COUNTRY_NAMES[code] || code,
            city: ''
        };
    }

    // 2. Local / Private IP check
    if (!ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.16.')) {
        return { code: 'DZ', name: 'Algeria (Dev/Local)', city: 'Local' };
    }

    // 3. GeoIP lookup
    if (geoip) {
        try {
            const geo = geoip.lookup(ip);
            if (geo && geo.country) {
                const code = geo.country.toUpperCase();
                return {
                    code,
                    name: COUNTRY_NAMES[code] || code,
                    city: geo.city || ''
                };
            }
        } catch (_) {}
    }

    return { code: 'UN', name: 'Unknown', city: '' };
}

function parseDevice(ua) {
    if (!ua) return { device: 'Desktop', browser: 'Chrome', os: 'Windows' };
    
    let device = 'Desktop';
    if (/tablet|ipad|playbook|silk/i.test(ua)) device = 'Tablet';
    else if (/mobile|iphone|ipod|android|blackberry|mini|windows\sce|palm/i.test(ua)) device = 'Mobile';

    let os = 'Other';
    if (/windows/i.test(ua)) os = 'Windows';
    else if (/android/i.test(ua)) os = 'Android';
    else if (/iphone|ipad|ipod/i.test(ua)) os = 'iOS';
    else if (/macintosh|mac\s*os/i.test(ua)) os = 'macOS';
    else if (/linux/i.test(ua)) os = 'Linux';

    let browser = 'Other';
    if (/telegram/i.test(ua)) browser = 'Telegram';
    else if (/edg/i.test(ua)) browser = 'Edge';
    else if (/chrome|crios/i.test(ua)) browser = 'Chrome';
    else if (/firefox|fxios/i.test(ua)) browser = 'Firefox';
    else if (/safari/i.test(ua)) browser = 'Safari';
    else if (/opera|opr/i.test(ua)) browser = 'Opera';

    return { device, os, browser };
}

function isBot(ua) {
    if (!ua) return false;
    return /bot|crawler|spider|scraper|curl|wget|python|axios|headless|uptime|monitoring/i.test(ua);
}

class AnalyticsService {
    constructor(db) {
        this.db = db;
    }

    // Record incoming visit or page view
    async recordVisit(req, pathOverride = null) {
        const ua = req.headers['user-agent'] || '';
        if (isBot(ua)) return null;

        const ip = getClientIp(req);
        const { code: countryCode, name: countryName, city } = resolveCountry(ip, req);
        const { device, os, browser } = parseDevice(ua);
        const path = pathOverride || req.path || '/';
        const referrer = req.headers['referer'] || req.headers['referrer'] || '';
        const now = Date.now();

        // Generate or extract session key (based on IP + User-Agent for seamless cross-tab tracking)
        const sessionId = req.body && req.body.sessionId 
            ? req.body.sessionId 
            : `${ip.replace(/[^a-zA-Z0-9]/g, '_')}_${device}_${os}`;

        // 1. Update in-memory real-time session
        activeSessions.set(sessionId, {
            sessionId,
            ip: ip.length > 15 ? ip.slice(0, 15) : ip,
            countryCode,
            countryName,
            city,
            device,
            os,
            browser,
            path,
            lastSeen: now,
            firstSeen: activeSessions.has(sessionId) ? activeSessions.get(sessionId).firstSeen : now
        });

        // 2. Persist / update in SQLite database
        try {
            await this.db.run(`
                INSERT INTO visitors (
                    session_id, ip, country_code, country_name, city,
                    device, browser, os, path, referrer, visit_count, created_at, last_seen
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                ON CONFLICT(session_id) DO UPDATE SET
                    last_seen = CURRENT_TIMESTAMP,
                    visit_count = visitors.visit_count + 1,
                    path = excluded.path,
                    referrer = CASE WHEN excluded.referrer != '' THEN excluded.referrer ELSE visitors.referrer END
            `, [sessionId, ip, countryCode, countryName, city, device, browser, os, path, referrer]);
        } catch (err) {
            // Silently handle if table not ready yet
        }

        return { sessionId, countryCode, countryName, device, browser };
    }

    // Ping heartbeat from client to stay online
    recordPing(req) {
        const ip = getClientIp(req);
        const ua = req.headers['user-agent'] || '';
        const { device, os, browser } = parseDevice(ua);
        const path = (req.body && req.body.path) || '/';
        const sessionId = (req.body && req.body.sessionId) || `${ip.replace(/[^a-zA-Z0-9]/g, '_')}_${device}_${os}`;
        const now = Date.now();

        if (activeSessions.has(sessionId)) {
            const sess = activeSessions.get(sessionId);
            sess.lastSeen = now;
            sess.path = path;
        } else {
            const { code: countryCode, name: countryName, city } = resolveCountry(ip, req);
            activeSessions.set(sessionId, {
                sessionId,
                ip,
                countryCode,
                countryName,
                city,
                device,
                os,
                browser,
                path,
                lastSeen: now,
                firstSeen: now
            });
        }

        // Fast update SQLite last_seen
        this.db.run(`UPDATE visitors SET last_seen = CURRENT_TIMESTAMP, path = ? WHERE session_id = ?`, [path, sessionId]).catch(() => {});
        return { success: true };
    }

    // Get aggregated analytics for admin dashboard
    async getAnalytics() {
        const now = Date.now();
        const liveVisitors = [];
        
        for (const [id, sess] of activeSessions.entries()) {
            const diffSec = Math.floor((now - sess.lastSeen) / 1000);
            if (diffSec <= (ACTIVE_THRESHOLD_MS / 1000)) {
                liveVisitors.push({
                    countryCode: sess.countryCode,
                    countryName: sess.countryName,
                    city: sess.city,
                    device: sess.device,
                    browser: sess.browser,
                    os: sess.os,
                    path: sess.path,
                    activeSecondsAgo: Math.max(0, diffSec)
                });
            }
        }

        // Sort live visitors by most recently active
        liveVisitors.sort((a, b) => a.activeSecondsAgo - b.activeSecondsAgo);
        const liveNow = liveVisitors.length;

        // DB Aggregations
        let totalVisits = 0;
        let uniqueVisitors = 0;
        let countryBreakdown = [];
        let deviceStats = { Mobile: 0, Desktop: 0, Tablet: 0 };
        let recentVisitors = [];

        try {
            const rowTotals = await this.db.get(`
                SELECT 
                    COUNT(*) as unique_count,
                    COALESCE(SUM(visit_count), 0) as total_visits
                FROM visitors
            `);
            if (rowTotals) {
                uniqueVisitors = rowTotals.unique_count || 0;
                totalVisits = rowTotals.total_visits || 0;
            }

            // Country Breakdown
            const countries = await this.db.all(`
                SELECT 
                    country_code,
                    country_name,
                    COUNT(*) as unique_count,
                    SUM(visit_count) as total_visits
                FROM visitors
                GROUP BY country_code
                ORDER BY unique_count DESC, total_visits DESC
                LIMIT 15
            `);

            if (countries && countries.length > 0) {
                const totalCountryVisitors = countries.reduce((acc, c) => acc + c.unique_count, 0) || 1;
                countryBreakdown = countries.map(c => ({
                    code: c.country_code,
                    name: c.country_name || COUNTRY_NAMES[c.country_code] || c.country_code,
                    count: c.unique_count,
                    totalVisits: c.total_visits,
                    percentage: parseFloat(((c.unique_count / totalCountryVisitors) * 100).toFixed(1))
                }));
            }

            // Device Breakdown
            const devices = await this.db.all(`
                SELECT device, COUNT(*) as count FROM visitors GROUP BY device
            `);
            if (devices) {
                devices.forEach(d => {
                    if (d.device && deviceStats[d.device] !== undefined) {
                        deviceStats[d.device] = d.count;
                    }
                });
            }

            // Recent 20 Visitors
            const recent = await this.db.all(`
                SELECT country_code, country_name, city, device, browser, os, path, visit_count, last_seen
                FROM visitors
                ORDER BY last_seen DESC
                LIMIT 20
            `);
            if (recent) {
                recentVisitors = recent.map(r => ({
                    code: r.country_code,
                    name: r.country_name,
                    city: r.city,
                    device: r.device,
                    browser: r.browser,
                    os: r.os,
                    path: r.path,
                    visits: r.visit_count,
                    lastSeen: r.last_seen
                }));
            }
        } catch (err) {
            console.error('[Analytics DB query error]', err.message);
        }

        const topCountry = countryBreakdown.length > 0 ? countryBreakdown[0] : {
            code: 'DZ',
            name: 'Algeria',
            count: 0,
            percentage: 0
        };

        return {
            success: true,
            liveNow,
            liveVisitors,
            totalVisits,
            uniqueVisitors,
            topCountry,
            countryBreakdown,
            deviceBreakdown: deviceStats,
            recentVisitors
        };
    }
}

module.exports = AnalyticsService;
