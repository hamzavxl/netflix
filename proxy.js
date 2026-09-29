/**
 * proxy.js — Smart Proxy Manager for NETVXL Bot
 * Supports: HTTP, HTTPS, SOCKS5 proxies
 * Features: Auto-fallback to local IP after max failures + admin notification
 */

const https  = require('https');
const http   = require('http');

let HttpsProxyAgent = null;
let SocksProxyAgent = null;
try { HttpsProxyAgent = require('https-proxy-agent').HttpsProxyAgent; } catch (_) {}
try { SocksProxyAgent = require('socks-proxy-agent').SocksProxyAgent; } catch (_) {}

// ── State (in-memory, synced with DB on load) ─────────────────
let _proxyUrl     = null;   // e.g. "http://user:pass@1.2.3.4:8080"
let _proxyEnabled = false;
let _failCount    = 0;
let _maxRetries   = 3;
let _notifyFn     = null;   // async fn(msg) — called when proxy falls back

const PROXY_TIMEOUT_MS = 6000;
const IP_CHECK_URLS = [
    'https://api.ipify.org?format=json',
    'https://httpbin.org/ip',
    'https://ifconfig.me/ip',
];

// ── Init (call once with DB settings) ────────────────────────
function init({ proxyUrl, proxyEnabled, maxRetries, notifyFn }) {
    _proxyUrl     = proxyUrl     || null;
    _proxyEnabled = !!proxyEnabled;
    _maxRetries   = maxRetries   || 3;
    _notifyFn     = notifyFn     || null;
    _failCount    = 0;
}

// Update individual settings after init
function setProxyUrl(url)         { _proxyUrl     = url; _failCount = 0; }
function setProxyEnabled(enabled) { _proxyEnabled = !!enabled; _failCount = 0; }
function setMaxRetries(n)         { _maxRetries   = n; }
function setNotifyFn(fn)          { _notifyFn     = fn; }
function getProxyUrl()            { return _proxyUrl; }
function isProxyEnabled()         { return _proxyEnabled && !!_proxyUrl; }
function getFailCount()           { return _failCount; }

// ── Agent builder ─────────────────────────────────────────────
function buildAgent(proxyUrl) {
    if (!proxyUrl) return null;
    try {
        const u = new URL(proxyUrl);
        const proto = u.protocol.replace(':', '').toLowerCase();
        if ((proto === 'socks5' || proto === 'socks4') && SocksProxyAgent) {
            return new SocksProxyAgent(proxyUrl);
        }
        if (HttpsProxyAgent) {
            return new HttpsProxyAgent(proxyUrl);
        }
    } catch (_) {}
    return null;
}

// ── Core HTTP GET ─────────────────────────────────────────────
function rawGet(url, headers = {}, agent = null) {
    return new Promise((resolve, reject) => {
        const parsed  = new URL(url);
        const isHttps = parsed.protocol === 'https:';
        const lib     = isHttps ? https : http;

        const opts = {
            hostname: parsed.hostname,
            port:     parsed.port || (isHttps ? 443 : 80),
            path:     parsed.pathname + (parsed.search || ''),
            method:   'GET',
            headers:  { ...headers, 'Host': parsed.hostname }
        };
        if (agent) opts.agent = agent;

        const req = lib.request(opts, res => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => {
                clearTimeout(hardTimer);
                resolve({ code: res.statusCode, headers: res.headers, body });
            });
        });

        // Strict hard timeout wrapper to abort connection hangs under all conditions
        const hardTimer = setTimeout(() => {
            req.destroy();
            reject(new Error('Hard timeout reached'));
        }, PROXY_TIMEOUT_MS);

        req.on('error', err => {
            clearTimeout(hardTimer);
            reject(err);
        });

        req.end();
    });
}

// ── Smart GET with proxy + fallback logic ─────────────────────
async function httpGet(url, headers = {}) {
    if (isProxyEnabled()) {
        const agent = buildAgent(_proxyUrl);
        try {
            const result = await rawGet(url, headers, agent);
            // Success — reset fail count
            if (_failCount > 0) _failCount = 0;
            return result;
        } catch (err) {
            _failCount++;
            console.warn(`[PROXY] Request failed (${_failCount}/${_maxRetries}): ${err.message}`);

            if (_failCount >= _maxRetries) {
                // Disable proxy and notify admin
                _proxyEnabled = false;
                console.error('[PROXY] Max retries reached — falling back to local IP');
                if (_notifyFn) {
                    try {
                        await _notifyFn(
                            `⚠️ *Proxy Failure Alert*\n\n` +
                            `The proxy \`${_proxyUrl}\` has failed *${_failCount}* consecutive times.\n\n` +
                            `🔄 Automatically switched to *Local IP* mode.\n` +
                            `Please update or disable proxy in ⚙️ Settings → 🌐 Proxy.`
                        );
                    } catch (_) {}
                }
            }

            // Fallback to local IP for this request
            return rawGet(url, headers, null);
        }
    }

    // No proxy — use local IP directly
    return rawGet(url, headers, null);
}

// ── IP Check ─────────────────────────────────────────────────
async function checkCurrentIP(useProxy = true) {
    const agent = (useProxy && isProxyEnabled()) ? buildAgent(_proxyUrl) : null;
    for (const url of IP_CHECK_URLS) {
        try {
            const r = await rawGet(url, {}, agent);
            if (r.code === 200) {
                const body = r.body.trim();
                // Try JSON parse first
                try {
                    const json = JSON.parse(body);
                    return json.ip || json.origin || body;
                } catch (_) {
                    return body; // Plain text IP
                }
            }
        } catch (_) {}
    }
    throw new Error('Could not determine IP address');
}

// ── Parse and Normalize Proxy URL ─────────────────────────────
function parseAndNormalizeProxyUrl(str) {
    if (!str) return null;
    let clean = str.trim();

    // Check if it already has a protocol like http://, https://, socks5://, socks4://
    let protocol = 'http:';
    const protoMatch = clean.match(/^([a-zA-Z0-9+.-]+):\/\//);
    if (protoMatch) {
        protocol = protoMatch[1].toLowerCase() + ':';
        clean = clean.slice(protoMatch[0].length);
    }

    const parts = clean.split(':');
    if (parts.length === 4) {
        const host = parts[0];
        const port = parts[1];
        const user = parts[2];
        const pass = parts[3];
        return `${protocol}//${user}:${pass}@${host}:${port}`;
    }
    
    if (parts.length === 2 && !clean.includes('@')) {
        const host = parts[0];
        const port = parts[1];
        return `${protocol}//${host}:${port}`;
    }

    if (clean.includes('@')) {
        return `${protocol}//${clean}`;
    }

    try {
        const u = new URL(str);
        return u.toString();
    } catch (_) {
        return null;
    }
}

// ── Validate proxy URL ────────────────────────────────────────
function validateProxyUrl(str) {
    const normalized = parseAndNormalizeProxyUrl(str);
    if (!normalized) return { valid: false, reason: 'Invalid format' };
    try {
        const u = new URL(normalized);
        const validProtocols = ['http:', 'https:', 'socks5:', 'socks4:'];
        if (!validProtocols.includes(u.protocol)) return { valid: false, reason: `Unsupported protocol: ${u.protocol}` };
        if (!u.hostname) return { valid: false, reason: 'Missing hostname' };
        if (!u.port)     return { valid: false, reason: 'Missing port' };
        return { valid: true, normalized };
    } catch (e) {
        return { valid: false, reason: 'Invalid URL format' };
    }
}

// ── Test proxy connection ─────────────────────────────────────
async function testProxy(proxyUrl) {
    const normalized = parseAndNormalizeProxyUrl(proxyUrl) || proxyUrl;
    const agent = buildAgent(normalized);
    for (const url of IP_CHECK_URLS) {
        try {
            const r = await rawGet(url, {}, agent);
            if (r.code === 200) {
                const body = r.body.trim();
                let ip = body;
                try { ip = JSON.parse(body).ip || JSON.parse(body).origin || body; } catch (_) {}
                return { success: true, ip };
            }
        } catch (e) {
            return { success: false, error: e.message };
        }
    }
    return { success: false, error: 'All IP check services failed' };
}


module.exports = {
    init,
    setProxyUrl,
    setProxyEnabled,
    setMaxRetries,
    setNotifyFn,
    getProxyUrl,
    isProxyEnabled,
    getFailCount,
    httpGet,
    checkCurrentIP,
    validateProxyUrl,
    testProxy,
    buildAgent,
};
