require('dotenv').config();
const express = require('express');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const proxy = require('./proxy');
const db = require('./db');

db.init();

// AES Key - loaded from DB on startup so tokens survive restarts
let AES_KEY = '';
async function initAesKey() {
    return new Promise((resolve) => {
        db.get("SELECT value FROM settings WHERE key = 'aes_session_key'", [], (err, row) => {
            if (row && row.value && row.value.length === 64) {
                AES_KEY = row.value;
                console.log('[AES] Loaded persistent AES key from DB');
            } else {
                AES_KEY = crypto.randomBytes(32).toString('hex');
                db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('aes_session_key', ?)", [AES_KEY]);
                console.log('[AES] Generated and saved new AES key to DB');
            }
            resolve();
        });
    });
}

function aesDecrypt(payload) {
    try {
        const key = Buffer.from(AES_KEY, 'hex');
        const iv  = Buffer.from(payload.iv, 'hex');
        const tag = Buffer.from(payload.tag, 'hex');
        const enc = Buffer.from(payload.data, 'hex');
        const dec = crypto.createDecipheriv('aes-256-gcm', key, iv);
        dec.setAuthTag(tag);
        return JSON.parse(dec.update(enc) + dec.final('utf8'));
    } catch (err) {
        console.error('[Decryption Error]', err.message);
        return null;
    }
}

// Encrypt a token payload into NETVXL_<hex> format
function aesEncryptToken(obj) {
    const key = Buffer.from(AES_KEY, 'hex');
    const iv  = crypto.randomBytes(12);
    const enc = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([enc.update(JSON.stringify(obj)), enc.final()]);
    const tag  = enc.getAuthTag();
    const combined = Buffer.concat([iv, tag, data]);
    return 'NETVXL_' + combined.toString('hex');
}

// Decrypt a NETVXL_ token back to its payload object
function aesDecryptToken(token) {
    try {
        if (!token || !token.startsWith('NETVXL_')) return null;
        const buf = Buffer.from(token.slice(7), 'hex');
        const iv   = buf.slice(0, 12);
        const tag  = buf.slice(12, 28);
        const data = buf.slice(28);
        const key  = Buffer.from(AES_KEY, 'hex');
        const dec  = crypto.createDecipheriv('aes-256-gcm', key, iv);
        dec.setAuthTag(tag);
        return JSON.parse(dec.update(data) + dec.final('utf8'));
    } catch {
        return null;
    }
}

const app = express();
const PORT = process.env.PORT || 3000;

// Security & Headers Middleware
app.disable('x-powered-by');
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
});

// Basic Rate Limiter for Sensitive API Endpoints
const rateLimitMap = new Map();
app.use('/api/', (req, res, next) => {
    // Exempt admin API endpoints from rate limiting to support bulk operations
    if (req.path.startsWith('/vxl') || req.originalUrl.includes('/api/vxl/')) {
        return next();
    }

    const ip = req.ip || req.headers['x-forwarded-for'] || '127.0.0.1';
    const now = Date.now();
    const windowMs = 60 * 1000; // 1 minute window
    const maxRequests = 80; // max requests per window

    let record = rateLimitMap.get(ip);
    if (!record || (now - record.startTime > windowMs)) {
        record = { count: 1, startTime: now };
    } else {
        record.count++;
    }
    rateLimitMap.set(ip, record);

    if (record.count > maxRequests) {
        return res.status(429).json({ error: "Too many requests. Please wait a moment and try again." });
    }
    next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Initialize database tables
db.createTables().catch(err => console.error("[DB] Table creation failed:", err.message));

const cookieStore = require('./cookieStore');
cookieStore.init();


// Helper to decode JS string escape sequences
function decodeJsEscapes(str) {
    if (!str) return str;
    let s = str.replace(/\\x([0-9A-Fa-f]{2})/g, (_, hex) => {
        return String.fromCharCode(parseInt(hex, 16));
    });
    s = s.replace(/\\u([0-9A-Fa-f]{4})/g, (_, hex) => {
        return String.fromCharCode(parseInt(hex, 16));
    });
    return s;
}

// Helper to make HTTPS requests
function makeRequest(url, options = {}, postData = null) {
    return new Promise((resolve, reject) => {
        if (proxy.isProxyEnabled()) {
            const agent = proxy.buildAgent(proxy.getProxyUrl());
            if (agent) {
                options.agent = agent;
            }
        }
        const req = https.request(url, options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                clearTimeout(hardTimer);
                resolve({
                    statusCode: res.statusCode,
                    headers: res.headers,
                    data: data
                });
            });
        });

        // Abort the connection if it hangs over 8 seconds under any conditions
        const hardTimer = setTimeout(() => {
            req.destroy();
            reject(new Error("Connection timeout reached"));
        }, 8000);

        req.on('error', (err) => { 
            clearTimeout(hardTimer);
            reject(err); 
        });
        if (postData) { req.write(postData); }
        req.end();
    });
}

function activateTV(cookieText, tvCode) {
    return new Promise(async (resolve, reject) => {
        try {
            const netflixIdMatch = cookieText.match(/(?<!\w)NetflixId=([^;,\s]+)/);
            const secureNetflixIdMatch = cookieText.match(/(?<!\w)SecureNetflixId=([^;,\s]+)/);
            
            const nid = netflixIdMatch ? netflixIdMatch[1] : '';
            const snid = secureNetflixIdMatch ? secureNetflixIdMatch[1] : '';
            
            if (!nid) return reject(new Error("NetflixId cookie not found in account session."));

            const cookieHeader = `NetflixId=${nid}; SecureNetflixId=${snid}`;
            
            console.log(`[API TV] Fetching rendezvous page for verification...`);
            const getRes = await makeRequest('https://www.netflix.com/tv2', {
                method: 'GET',
                headers: {
                    'Cookie': cookieHeader,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9'
                }
            });

            if (getRes.statusCode !== 200) {
                return reject(new Error(`Netflix GET /tv2 returned status ${getRes.statusCode}`));
            }

            let authURL = '';
            const matchAuth = getRes.data.match(/"authURL"\s*:\s*"([^"]+)"/) || getRes.data.match(/name="authURL"\s+value="([^"]+)"/);
            if (matchAuth) {
                authURL = decodeJsEscapes(matchAuth[1]);
            } else {
                return reject(new Error("Failed to extract verification token (authURL)."));
            }

            const setCookies = getRes.headers['set-cookie'] || [];
            let flwssn = '';
            setCookies.forEach(sc => {
                const m = sc.match(/flwssn=([^;]+)/);
                if (m) flwssn = m[1];
            });

            const postCookies = `${cookieHeader}${flwssn ? '; flwssn=' + flwssn : ''}`;
            const payload = `flow=websiteSignUp&authURL=${encodeURIComponent(authURL)}&flowMode=enterTvLoginRendezvousCode&withFields=tvLoginRendezvousCode%2CisTvUrl2&code=${tvCode}&tvLoginRendezvousCode=${tvCode}&isTvUrl2=true&action=nextAction`;
            
            console.log(`[API TV] Submitting TV rendezvous code: ${tvCode}`);
            const postRes = await makeRequest('https://www.netflix.com/tv2', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Cookie': postCookies,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Origin': 'https://www.netflix.com',
                    'Referer': 'https://www.netflix.com/tv2',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
                }
            }, payload);

            const hasTvError = postRes.data.includes('failed_to_retrieve_tv_login_rendezvous_code') ||
                               postRes.data.includes('enterTvLoginRendezvousCode') ||
                               postRes.data.includes('incorrect_code') ||
                               postRes.data.includes('invalid_code') ||
                               postRes.data.includes('"errorCode"');

            const isSuccess = (postRes.statusCode === 302 || 
                              (postRes.headers.location && (postRes.headers.location.includes('success') || postRes.headers.location.includes('tv2'))) || 
                              postRes.data.includes('witcherSuccess') || 
                              postRes.data.includes('loginCodeSuccess') || 
                              postRes.data.includes('tvSuccess')) && !hasTvError;

            if (isSuccess) {
                console.log(`[API TV] Rendezvous code ${tvCode} accepted.`);
                resolve(true);
            } else {
                console.warn(`[API TV] Rendezvous code ${tvCode} rejected by Netflix.`);
                reject(new Error("The TV screen code is invalid or has expired. Please check your TV screen and enter it again."));
            }
        } catch(err) {
            reject(err);
        }
    });
}

// Netflix iOS API Constants
const API_URL = "https://ios.prod.ftl.netflix.com/iosui/user/15.48";
const QUERY_PARAMS = {
    appVersion: "15.48.1",
    config: '{"gamesInTrailersEnabled":"false","isTrailersEvidenceEnabled":"false","cdsMyListSortEnabled":"true","kidsBillboardEnabled":"true","addHorizontalBoxArtToVideoSummariesEnabled":"false","skOverlayTestEnabled":"false","homeFeedTestTVMovieListsEnabled":"false","baselineOnIpadEnabled":"true","trailersVideoIdLoggingFixEnabled":"true","postPlayPreviewsEnabled":"false","bypassContextualAssetsEnabled":"false","roarEnabled":"false","useSeason1AltLabelEnabled":"false","disableCDSSearchPaginationSectionKinds":["searchVideoCarousel"],"cdsSearchHorizontalPaginationEnabled":"true","searchPreQueryGamesEnabled":"true","kidsMyListEnabled":"true","billboardEnabled":"true","useCDSGalleryEnabled":"true","contentWarningEnabled":"true","videosInPopularGamesEnabled":"true","avifFormatEnabled":"false","sharksEnabled":"true"}',
    device_type: "NFAPPL-02-",
    esn: "NFAPPL-02-IPHONE8%3D1-PXA-02026U9VV5O8AUKEAEO8PUJETCGDD4PQRI9DEB3MDLEMD0EACM4CS78LMD334MN3MQ3NMJ8SU9O9MVGS6BJCURM1PH1MUTGDPF4S4200",
    idiom: "phone",
    iosVersion: "15.8.5",
    isTablet: "false",
    languages: "en-US",
    locale: "en-US",
    maxDeviceWidth: "375",
    model: "saget",
    modelType: "IPHONE8-1",
    odpAware: "true",
    path: '["account","token","default"]',
    pathFormat: "graph",
    pixelDensity: "2.0",
    progressive: "false",
    responseFormat: "json",
};

const BASE_HEADERS = {
    "User-Agent": "Argo/15.48.1 (iPhone; iOS 15.8.5; Scale/2.00)",
    "x-netflix.request.attempt": "1",
    "x-netflix.request.client.user.guid": "A4CS633D7VCBPE2GPK2HL4EKOE",
    "x-netflix.context.profile-guid": "A4CS633D7VCBPE2GPK2HL4EKOE",
    "x-netflix.request.routing": '{"path":"/nq/mobile/nqios/~15.48.0/user","control_tag":"iosui_argo"}',
    "x-netflix.context.app-version": "15.48.1",
    "x-netflix.argo.translated": "true",
    "x-netflix.context.form-factor": "phone",
    "x-netflix.context.sdk-version": "2012.4",
    "x-netflix.client.appversion": "15.48.1",
    "x-netflix.context.max-device-width": "375",
    "x-netflix.context.ab-tests": "",
    "x-netflix.tracing.cl.useractionid": "4DC655F2-9C3C-4343-8229-CA1B003C3053",
    "x-netflix.client.type": "argo",
    "x-netflix.client.ftl.esn": "NFAPPL-02-IPHONE8=1-PXA-02026U9VV5O8AUKEAEO8PUJETCGDD4PQRI9DEB3MDLEMD0EACM4CS78LMD334MN3MQ3NMJ8SU9O9MVGS6BJCURM1PH1MUTGDPF4S4200",
    "x-netflix.context.locales": "en-US",
    "x-netflix.context.top-level-uuid": "90AFE39F-ADF1-4D8A-B33E-528730990FE3",
    "x-netflix.client.iosversion": "15.8.5",
    "accept-language": "en-US;q=1",
    "x-netflix.argo.abtests": "",
    "x-netflix.context.os-version": "15.8.5",
    "x-netflix.request.client.context": '{"appState":"foreground"}',
    "x-netflix.context.ui-flavor": "argo",
    "x-netflix.argo.nfnsm": "9",
    "x-netflix.context.pixel-density": "2.0",
    "x-netflix.request.toplevel.uuid": "90AFE39F-ADF1-4D8A-B33E-528730990FE3",
    "x-netflix.request.client.timezoneid": "Asia/Dhaka",
};

function mergeCookies(oldCookieText, setCookieHeaders) {
    if (!setCookieHeaders || setCookieHeaders.length === 0) return oldCookieText;
    const dict = {};
    (oldCookieText || '').split(/[;\n]/).forEach(pair => {
        const idx = pair.indexOf('=');
        if (idx < 1) return;
        const k = pair.slice(0, idx).trim();
        const v = pair.slice(idx + 1).trim();
        if (k) dict[k] = v;
    });
    setCookieHeaders.forEach(header => {
        const parts = header.split(';');
        if (parts.length > 0) {
            const pair = parts[0];
            const idx = pair.indexOf('=');
            if (idx > 0) {
                const k = pair.slice(0, idx).trim();
                const v = pair.slice(idx + 1).trim();
                if (k && !['path', 'domain', 'expires', 'maxage', 'samesite', 'secure', 'httponly'].includes(k.toLowerCase())) {
                    dict[k] = v;
                }
            }
        }
    });
    return Object.entries(dict).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function generateNFToken(cookieText) {
    const match = cookieText.match(/(?<!\w)NetflixId=([^;,\s]+)/);
    const netflixId = match ? decodeURIComponent(match[1].replace(/^"|"$/g, '')) : null;
    if (!netflixId) throw new Error("NetflixId cookie key not found.");

    const urlObj = new URL(API_URL);
    Object.entries(QUERY_PARAMS).forEach(([k, v]) => {
        urlObj.searchParams.set(k, v);
    });

    const headers = { ...BASE_HEADERS };
    headers["Cookie"] = `NetflixId=${netflixId}`;

    const response = await makeRequest(urlObj.toString(), { method: 'GET', headers });
    if (response.statusCode !== 200) {
        throw new Error(`Netflix iOS API HTTP ${response.statusCode}`);
    }

    const data = JSON.parse(response.data);
    const tokenData = data?.value?.account?.token?.default || {};
    const token = tokenData.token;
    let expires = tokenData.expires;

    if (!token) throw new Error("No NFToken returned from Netflix API.");

    if (expires && String(expires).length === 13) {
        expires = Math.floor(expires / 1000);
    }

    const setCookies = response.headers['set-cookie'] || [];
    const updatedCookieText = mergeCookies(cookieText, setCookies);

    return {
        token: token,
        expires: expires ? new Date(expires * 1000).toISOString() : 'Unknown',
        updatedCookieText: updatedCookieText
    };
}

// ================= AUTOMATED COOKIE HEALTH CHECK SCHEDULER =================
let autoCheckTimer = null;

function checkSingleCDKExpiry(cdk) {
    return new Promise((resolve) => {
        if (!cdk || cdk.status !== 'active' || !cdk.duration_days) {
            return resolve(cdk);
        }
        db.get("SELECT MIN(activated_at) as first_active FROM activations WHERE cdk_key = ?", [cdk.key], (err, act) => {
            if (act && act.first_active) {
                const firstActiveDate = new Date(act.first_active);
                const expiryTime = firstActiveDate.getTime() + (cdk.duration_days * 24 * 60 * 60 * 1000);
                if (Date.now() > expiryTime) {
                    console.log(`[CDK Expiry] Key ${cdk.key} has expired. Updating database.`);
                    db.serialize(() => {
                        db.run("UPDATE cdks SET status = 'expired' WHERE key = ?", [cdk.key]);
                        const email = cdk.cookie_email || cdk.bound_cookie_email;
                        if (email) {
                            cookieStore.adjustActiveUsers(email, -1);
                        }
                    });
                    const expiredCdk = { ...cdk, status: 'expired' };
                    return resolve(expiredCdk);
                }
            }
            resolve(cdk);
        });
    });
}

function checkAndCleanExpiredCDKs() {
    return new Promise((resolve) => {
        db.all("SELECT * FROM cdks WHERE status = 'active'", [], async (err, activeKeys) => {
            if (err || !activeKeys) return resolve();
            for (const cdk of activeKeys) {
                await checkSingleCDKExpiry(cdk);
            }
            resolve();
        });
    });
}

async function runAutoCookieCheck() {
    console.log(`[AUTO-CHECK] Running scheduled cookie health check...`);
    await checkAndCleanExpiredCDKs();

    const cookies = cookieStore.getAllCookies();
    if (!cookies.length) {
        console.log(`[AUTO-CHECK] No cookies found to check.`);
        return;
    }

    let activeCount = 0;
    let expiredCount = 0;
    const now = new Date().toISOString();

    for (const cookie of cookies) {
        try {
            const dict = {};
            (cookie.cookie_text || '').split(/[;\n]/).forEach(pair => {
                const idx = pair.indexOf('=');
                if (idx < 1) return;
                const k = pair.slice(0, idx).trim();
                const v = pair.slice(idx + 1).trim();
                if (k) dict[k] = v;
            });

            // 1) Validate Netflix Web Account (membership status & active paid plan)
            const check = await getAccountInfo(dict);
            if (!check || !check.valid) {
                throw new Error("Account is not an active member or plan is invalid.");
            }

            // 2) Validate NFToken generation via iOS API
            const tokenInfo = await generateNFToken(check.updatedCookieText || cookie.cookie_text);

            activeCount++;
            cookie.status = 'Active';
            cookie.plan = check.plan || cookie.plan;
            cookie.country = check.country || cookie.country;
            cookie.next_billing_date = check.billing || cookie.next_billing_date;
            cookie.last_checked = now;
            if (tokenInfo && tokenInfo.updatedCookieText) {
                cookie.cookie_text = tokenInfo.updatedCookieText;
            }
        } catch (err) {
            expiredCount++;
            cookie.status = 'Expired';
            cookie.last_checked = now;
            db.handleCookieExpiration(cookie.email).catch(() => {});
        }
        cookieStore.saveCookie(cookie.email, cookie);
    }
    console.log(`[AUTO-CHECK COMPLETE] Verified ${cookies.length} cookies. Active: ${activeCount} | Expired: ${expiredCount}`);
}

function setupAutoCheckScheduler(hours) {
    if (autoCheckTimer) {
        clearInterval(autoCheckTimer);
        autoCheckTimer = null;
    }
    const hrs = parseInt(hours) || 0;
    if (hrs < 1 || hrs > 24) {
        console.log(`[AUTO-CHECK] Periodic check disabled or set to 0.`);
        return;
    }
    const ms = hrs * 60 * 60 * 1000;
    console.log(`[AUTO-CHECK] Scheduled automatic check every ${hrs} hour(s).`);
    autoCheckTimer = setInterval(runAutoCookieCheck, ms);
}

// Load auto-check interval on startup
db.get("SELECT value FROM settings WHERE key = 'auto_check_hours'", [], (err, row) => {
    if (row && row.value) {
        setupAutoCheckScheduler(row.value);
    }
});

function saveShortRedirect(token, cookieEmail = null) {
    return new Promise((resolve, reject) => {
        const code = crypto.randomBytes(3).toString('hex').toUpperCase(); // Generates a unique 6-character code
        db.run(
            "INSERT INTO redirects (code, token, cookie_email, created_at) VALUES (?, ?, ?, ?)",
            [code, token, cookieEmail, new Date().toISOString()],
            err => {
                if (err) reject(err);
                else resolve(code);
            }
        );
    });
}

// ================= API ENDPOINTS =================

// System Status Endpoint
app.get('/api/status', (req, res) => {
    const active = cookieStore.getAllCookies().filter(c => c.status === 'Active' && (c.active_users || 0) < (c.max_users || 5));
    return res.json({ status: active.length > 0 ? 'ACTIVE' : 'MAINTENANCE' });
});

// Vxl API: Import Selected Cookies after preview check
app.post('/api/vxl/import-cookies', (req, res) => {
    const { cookies, warrantyType = '1_month', maxUsers = 5 } = req.body;
    if (!cookies || !Array.isArray(cookies)) {
        return res.status(400).json({ error: "No cookies data provided." });
    }

    let added = 0;
    let replaced = 0;

    const seenInBatch = new Set();
    const duplicates = [];

    for (const c of cookies) {
        if (!c.email || !c.cookie_text) continue;

        const emailKey = c.email.toLowerCase().trim();

        // Detect within-batch duplicates (same email uploaded twice)
        if (seenInBatch.has(emailKey)) {
            duplicates.push({ email: c.email, type: 'batch_duplicate' });
            continue;
        }
        seenInBatch.add(emailKey);

        const existing = cookieStore.getCookie(c.email);
        if (existing) {
            existing.cookie_text = c.cookie_text;
            existing.plan = c.plan || 'Premium';
            existing.country = c.country || 'US';
            existing.next_billing_date = c.billing || 'Unknown';
            existing.status = 'Active';
            if (warrantyType) existing.warranty_type = warrantyType;
            if (maxUsers !== undefined) existing.max_users = parseInt(maxUsers);
            existing.last_checked = new Date().toISOString();
            cookieStore.saveCookie(c.email, existing);
            replaced++;
            duplicates.push({ email: c.email, type: 'already_exists' });
        } else {
            cookieStore.saveCookie(c.email, {
                email: c.email,
                plan: c.plan || 'Premium',
                country: c.country || 'US',
                next_billing_date: c.billing || 'Unknown',
                cookie_text: c.cookie_text,
                max_users: maxUsers !== undefined ? parseInt(maxUsers) : 5,
                active_users: 0,
                status: 'Active',
                warranty_type: warrantyType || '1_month',
                last_checked: new Date().toISOString()
            });
            added++;
        }
    }

    if (added > 0 || replaced > 0) {
        try {
            const { triggerCookiesUpdateBroadcast } = require('./bot.js');
            triggerCookiesUpdateBroadcast().catch(err => console.error('[Import Broadcast Error]', err));
        } catch (err) {
            console.error('[Import Broadcast Import Error]', err.message);
        }
    }

    return res.json({ success: true, added, replaced, duplicates });
});

// Vxl API: List All Cookies
app.get('/api/vxl/cookies', (req, res) => {
    const cookies = cookieStore.getAllCookies();
    return res.json({ success: true, cookies: cookies || [] });
});

// Vxl API: Check & Validate All Cookies (Health Check) or Upload & Import Cookies
app.post('/api/vxl/check-cookies', async (req, res) => {
    const { fileContent, zipData, warrantyType, maxUsers, preview = false } = req.body;
    
    let rawContent = fileContent || "";
    if (zipData) {
        try {
            const zipBuffer = Buffer.from(zipData, 'base64');
            const zip = new AdmZip(zipBuffer);
            const entries = zip.getEntries();
            entries.forEach(entry => {
                if (!entry.isDirectory && (entry.entryName.endsWith('.txt') || entry.entryName.endsWith('.json'))) {
                    rawContent += zip.readAsText(entry) + "\n\n";
                }
            });
        } catch (zipErr) {
            return res.status(400).json({ error: "Failed to extract ZIP file: " + zipErr.message });
        }
    }
    
    // Helper helper: Decode JS escape strings
    const decodeEsc = (s) => {
        if(!s) return s;
        return s.replace(/\\x([0-9A-Fa-f]{2})/g,(_,h)=>String.fromCharCode(parseInt(h,16)))
                .replace(/\\u([0-9A-Fa-f]{4})/g,(_,h)=>String.fromCharCode(parseInt(h,16)));
    };

    // Helper helper: Parse Cookies
    const parseCookies = (raw) => {
        if(!raw||raw.length<10) return {};
        const result={};
        const TARGETS=['NetflixId','SecureNetflixId','nfvdid','OptanonConsent','gsid'];
        try {
            const p=JSON.parse(raw);
            const list=Array.isArray(p)?p:p.cookies?p.cookies:typeof p==='object'?[p]:null;
            if(list){
                list.forEach(c=>{const n=c.name||c.Name||c.key;const v=c.value||c.Value;if(n&&v)result[n]=decodeEsc(String(v).replace(/^"|"$/g,''));});
                if(Object.keys(result).length) return result;
            }
        } catch(_){}
        let tsv=0;
        raw.split(/\r?\n/).forEach(line=>{
            const t=line.trim();
            if(!t||t.startsWith('#')||t.startsWith('//'))return;
            let p=t.split('\t');
            if(p.length<7) p=t.split(/\s{2,}/);
            if(p.length<7) p=t.split(/\s+/);
            if(p.length>=7){
                const name = p[5].trim();
                const val = p[6].trim();
                if(name && val) {
                    result[name] = decodeEsc(val.replace(/^"|"$/g,''));
                    tsv++;
                }
            }
        });
        if(tsv) return result;
        raw.split(/[;\n]/).forEach(pair=>{const i=pair.indexOf('=');if(i<1)return;const k=pair.slice(0,i).trim();const v=pair.slice(i+1).trim().replace(/^"|"$/g,'');if(k)result[k]=decodeEsc(v);});
        if(result['NetflixId']) return result;
        TARGETS.forEach(k=>{const m=raw.match(new RegExp(k+'["\']?\\s*[:=]\\s*["\']?([^"\'\\s;,\\}\\]]+)','i'));if(m&&m[1])result[k]=decodeEsc(m[1].replace(/^"|"$/g,'').split('\\n')[0]);});
        return result;
    };

    // Helper helper: getAccountInfo
    const getAccountInfo = async (dict) => {
        const cookieStr=Object.entries(dict).map(([k,v])=>`${k}=${v}`).join('; ');
        let r=await proxy.httpGet('https://www.netflix.com/account',{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0','Cookie':cookieStr,'Accept-Language':'en-US,en;q=0.9'});
        
        let allSetCookies = [];
        if (r.headers && r.headers['set-cookie']) {
            allSetCookies.push(...r.headers['set-cookie']);
        }
        
        if ((r.code === 301 || r.code === 302) && r.headers) {
            const loc = r.headers['location'] || r.headers['Location'] || '';
            const isInvalidLoc = loc.includes('/login') || loc.includes('Netflix_Logon') || loc.includes('/signup') || loc.includes('/youraccount/payment') || loc.includes('/simplemember') || loc.includes('/hold') || loc.includes('/orderfinal');
            if (isInvalidLoc) {
                return {valid:false};
            }
            const targetUrl = loc.startsWith('http') ? loc : `https://www.netflix.com${loc}`;
            r = await proxy.httpGet(targetUrl, {'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0','Cookie':cookieStr,'Accept-Language':'en-US,en;q=0.9'});
            if (r.headers && r.headers['set-cookie']) {
                allSetCookies.push(...r.headers['set-cookie']);
            }
        }
        if(r.code===302 || r.body.includes('/login') || r.body.includes('/signup') || r.body.includes('Netflix_Logon')) return {valid:false};
        const h=r.body;

        const statusMatch = h.match(/"membershipStatus"\s*:\s*"([^"]+)"/i);
        if (statusMatch && statusMatch[1] !== 'CURRENT_MEMBER') {
            return {valid:false};
        }

        // ── Deep paywall / payment-required detection ──
        const paywallKeywords = [
            // Payment hold
            '"membershipStatus":"FORMER_MEMBER"',
            '"membershipStatus":"NEVER_MEMBER"',
            '"membershipStatus":"ACCOUNT_HOLD"',
            '"membershipStatus":"SUSPENDED"',
            '"membershipStatus":"OFFBOARDED"',
            '"membershipStatus":"DEFERRED"',
            '"membershipStatus":"PAUSED"',
            '"membershipStatus":"PAYMENT_ERROR"',
            // English
            'Restart your membership', 'Restart Membership',
            'Update payment', 'Update payment method',
            'Your account is on hold', 'Account on hold', 'Account is on hold',
            'Billing problem', 'Billing issue',
            'Finish sign-up', 'Finish Sign-up', 'Complete sign-up',
            'Choose the plan that\'s right for you', 'Pick your plan',
            'Watch anywhere', 'Start watching', 'Start your membership',
            'Ready to watch', 'Get started', 'Join today',
            'Watch on your TV', 'Watch on any device',
            // Arabic
            'إعادة تشغيل عضويتك', 'أعد تشغيل عضويتك',
            'العضوية متوقفة', 'مشكلة في الدفع',
            'تحديث طريقة الدفع', 'حسابك معلق',
            'إكمال التسجيل', 'اختر الخطة',
            // French
            'Recommencer l\'abonnement', 'Recommencer votre abonnement',
            'Mettre à jour le paiement', 'Votre compte est suspendu',
            // Spanish
            'Renovar suscripción', 'Reiniciar suscripción', 'Vuelve a suscribirte',
            'Completa tu registro', 'Actualizar método de pago',
            // Portuguese
            'Retomar assinatura', 'Atualizar pagamento',
            // Turkish
            'Üyeliği yeniden başlat', 'Ödemeyi güncelle',
            // Chinese
            '重新开始会员资格', '更新付款方式',
            // Russian
            'Возобновить подписку', 'Обновить способ оплаты',
        ];

        // Check if page body contains paywall indicators
        const paywallFound = paywallKeywords.some(kw => h.includes(kw));
        
        // Also detect Netflix watch-to-pay splash pages (landing pages for non-members)
        const isLandingPage = (
            (h.includes('data-uia="hero"') || h.includes('class="hero"')) &&
            h.includes('data-uia="login"')
        );
        
        // Detect plan picker / payment required page
        const isPaywallPage = (
            h.includes('/payment/') ||
            h.includes('/simplemember') ||
            h.includes('/youraccount/payment') ||
            h.includes('payment-picker') ||
            h.includes('planselection') ||
            h.includes('choose-plan') ||
            h.includes('/planselection') ||
            h.includes('pricingPage') ||
            h.includes('data-uia="plan-row"')
        );

        if (paywallFound || isLandingPage || isPaywallPage) {
            return { valid: false, reason: 'paywall' };
        }

        const em=h.match(/"emailAddress"\s*:\s*"([^"]+)"/i);
        const pm=h.match(/"localizedPlanName"[^}]*"value"\s*:\s*"([^"]+)"/i)||h.match(/"planName"\s*:\s*"([^"]+)"/i);
        const planName = pm ? decodeEsc(pm[1]) : 'Unknown';

        const streamsMatch = h.match(/"maxStreams"[^}]*"value"\s*:\s*(\d+)/i);
        const qualityMatch = h.match(/"videoQuality"[^}]*"value"\s*:\s*"([^"]+)"/i);
        const maxStreams = streamsMatch ? parseInt(streamsMatch[1]) : null;
        const videoQuality = qualityMatch ? qualityMatch[1].toUpperCase() : '';

        let planKey = 'Unknown';
        if (maxStreams === 4 || videoQuality === 'UHD' || videoQuality === '4K') {
            planKey = 'Premium';
        } else if (maxStreams === 2 || videoQuality === 'FHD') {
            planKey = 'Standard';
        } else if (maxStreams === 1 || videoQuality === 'HD' || videoQuality === 'SD') {
            planKey = 'Basic';
        } else {
            const planLower = planName.toLowerCase();
            if (planLower.includes('premium') || planLower.includes('مميز') || planLower.includes('المميزة') || planLower.includes('cao cấp') || planLower.includes('özel') || planLower.includes('uhd') || planLower.includes('4k') || planLower.includes('gold')) {
                planKey = 'Premium';
            } else if (planLower.includes('standard') || planLower.includes('standart') || planLower.includes('قياسي') || planLower.includes('القياسية') || planLower.includes('têu chuẩn') || planLower.includes('estándar') || planLower.includes('estandar') || planLower.includes('padrão') || planLower.includes('padrao') || planLower.includes('fhd')) {
                planKey = 'Standard';
            } else if (planLower.includes('basic') || planLower.includes('básico') || planLower.includes('basico') || planLower.includes('أساسي') || planLower.includes('الأساسية') || planLower.includes('cơ bản') || planLower.includes('temel') || planLower.includes('essentiel') || planLower.includes('sd') || planLower.includes('hd')) {
                planKey = 'Basic';
            }
        }

        if (planKey === 'Unknown' && !em) return {valid:false};

        const countryMatch = h.match(/"countryOfSignup"\s*:\s*"([^"]+)"/i) ||
                             h.match(/"signupCountry"\s*:\s*"([^"]+)"/i) ||
                             h.match(/"currentCountryOfRegistration"\s*:\s*"([^"]+)"/i) ||
                             h.match(/"countryOfRegistration"\s*:\s*"([^"]+)"/i) ||
                             h.match(/"accountCountry"\s*:\s*"([^"]+)"/i) ||
                             h.match(/"billingCountry"\s*:\s*"([^"]+)"/i);
        const country = countryMatch ? countryMatch[1].toUpperCase() : 'Unknown';

        let billingDate = 'Unknown';
        const formattedDateMatch = h.match(/"nextBillingDate"[^}]*"value"\s*:\s*"([^"]+)"/i) ||
                                   h.match(/"formattedNextBillingDate"\s*:\s*"([^"]+)"/i) ||
                                   h.match(/"nextBillingDate"\s*:\s*"([^"]+)"/i);
        if (formattedDateMatch && formattedDateMatch[1] !== 'null') {
            billingDate = decodeEsc(formattedDateMatch[1]);
        } else {
            const cancelMatch = h.match(/"cancelDate"\s*:\s*"([^"T]+)T/i) || h.match(/"cancelDate"\s*:\s*"([^"]+)"/i);
            if (cancelMatch && cancelMatch[1] && cancelMatch[1] !== 'null') {
                const rawDate = cancelMatch[1];
                const dateParts = rawDate.split('T')[0].split('-');
                if (dateParts.length === 3) {
                    const year = dateParts[0];
                    const monthNum = parseInt(dateParts[1]);
                    const day = parseInt(dateParts[2]);
                    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
                    billingDate = `Cancelled: ${day} ${months[monthNum - 1]} ${year}`;
                } else {
                    billingDate = `Cancelled: ${rawDate}`;
                }
            } else {
                const partnerMatch = h.match(/"partnerDisplayName"\s*:\s*"([^"]+)"/i);
                if (partnerMatch && partnerMatch[1] && partnerMatch[1] !== 'null') {
                    billingDate = `Partner: ${decodeEsc(partnerMatch[1])}`;
                }
            }
        }
        
        const updatedCookieStr = mergeCookies(cookieStr, allSetCookies);
        
        return {
            valid: true,
            email: em ? decodeEsc(em[1]) : 'Unknown',
            plan: planKey,
            country: country,
            billing: billingDate,
            updatedCookieText: updatedCookieStr
        };
    };

    if (rawContent) {
        // COOKIE FILE UPLOAD MODE
        let blocks = [rawContent];
        try {
            const p = JSON.parse(rawContent);
            if (Array.isArray(p) && Array.isArray(p[0])) {
                blocks = p.map(b => JSON.stringify(b));
            }
        } catch (_) {}

        if (blocks.length === 1) {
            const multi = rawContent.split(/\n\s*\n/).filter(b => /netflixid/i.test(b));
            if (multi.length > 1) blocks = multi;
        }

        let added = 0, replaced = 0, expired = 0, failed = 0;
        const results = [];

        for (const block of blocks) {
            const dict = parseCookies(block);
            if (!dict['NetflixId']) {
                const key = Object.keys(dict).find(k => k.toLowerCase() === 'netflixid');
                if (key) dict['NetflixId'] = dict[key];
            }
            if (!dict['NetflixId']) {
                failed++;
                continue;
            }

            try {
                const check = await getAccountInfo(dict);
                const cookieStr = Object.entries(dict).map(([k, v]) => `${k}=${v}`).join('; ');
                
                if (check.valid) {
                    if (preview) {
                        results.push({
                            email: check.email,
                            plan: check.plan,
                            country: check.country,
                            billing: check.billing,
                            cookie_text: cookieStr,
                            status: 'Active'
                        });
                        added++;
                    } else {
                        const existing = cookieStore.getCookie(check.email);
                        if (existing) {
                            existing.cookie_text = cookieStr;
                            existing.plan = check.plan;
                            existing.country = check.country;
                            existing.next_billing_date = check.billing;
                            existing.status = 'Active';
                            if (warrantyType) existing.warranty_type = warrantyType;
                            if (maxUsers !== undefined) existing.max_users = parseInt(maxUsers);
                            existing.last_checked = new Date().toISOString();
                            cookieStore.saveCookie(check.email, existing);
                            replaced++;
                        } else {
                            cookieStore.saveCookie(check.email, {
                                email: check.email,
                                plan: check.plan,
                                country: check.country,
                                next_billing_date: check.billing,
                                cookie_text: cookieStr,
                                max_users: maxUsers !== undefined ? parseInt(maxUsers) : 5,
                                active_users: 0,
                                status: 'Active',
                                warranty_type: warrantyType || '1_month',
                                last_checked: new Date().toISOString()
                            });
                            added++;
                        }
                        results.push({ email: check.email, status: 'Active' });
                    }
                } else {
                    expired++;
                    if (preview) {
                        const em = block.match(/"emailAddress"\s*:\s*"([^"]+)"/i);
                        results.push({
                            email: em ? decodeEsc(em[1]) : 'Unknown',
                            status: check.reason === 'paywall' ? 'Paywall' : 'Expired',
                            reason: check.reason || 'invalid',
                            plan: 'Unknown',
                            country: 'Unknown',
                            billing: 'Unknown',
                            cookie_text: cookieStr
                        });
                    }
                }
            } catch (err) {
                failed++;
            }
        }

        return res.json({
            success: true,
            preview,
            summary: {
                total: blocks.length,
                active: added + replaced,
                expired: expired + failed
            },
            cookies: results
        });
    } else {
        // HEALTH CHECK MODE (Existing cookies check)
        let cookies = cookieStore.getAllCookies();
        const { target } = req.body;
        if (target === 'expired') {
            cookies = cookies.filter(c => c.status !== 'Active');
        } else if (target === 'active') {
            cookies = cookies.filter(c => c.status === 'Active');
        }
        if (cookies.length === 0) {
            return res.json({ success: true, summary: { total: 0, active: 0, expired: 0 }, cookies: [] });
        }

        let activeCount = 0;
        let expiredCount = 0;
        const results = [];

        for (const cookie of cookies) {
            const now = new Date().toISOString();
            try {
                const dict = {};
                (cookie.cookie_text || '').split(/[;\n]/).forEach(pair => {
                    const idx = pair.indexOf('=');
                    if (idx < 1) return;
                    const k = pair.slice(0, idx).trim();
                    const v = pair.slice(idx + 1).trim();
                    if (k) dict[k] = v;
                });

                // 1) Validate Web Account Membership & Plan Status
                const check = await getAccountInfo(dict);
                if (!check || !check.valid) {
                    throw new Error("Invalid account membership or plan");
                }

                // 2) Validate NFToken Generation
                const tokenInfo = await generateNFToken(check.updatedCookieText || cookie.cookie_text);

                activeCount++;
                cookie.status = 'Active';
                cookie.plan = check.plan;
                cookie.country = check.country;
                cookie.next_billing_date = check.billing;
                if (tokenInfo && tokenInfo.updatedCookieText) {
                    cookie.cookie_text = tokenInfo.updatedCookieText;
                }
            } catch (checkErr) {
                expiredCount++;
                cookie.status = 'Expired';
                db.handleCookieExpiration(cookie.email).catch(() => {});
            }
            cookie.last_checked = now;
            cookieStore.saveCookie(cookie.email, cookie);
            results.push(cookie);
        }

        return res.json({
            success: true,
            summary: {
                total: cookies.length,
                active: activeCount,
                expired: expiredCount
            },
            cookies: results
        });
    }
});

// Vxl API: Parse Upload and extract raw ZIP/text into individual cookie blocks
app.post('/api/vxl/parse-upload', (req, res) => {
    const { fileContent, zipData } = req.body;
    let rawContent = fileContent || "";
    if (zipData) {
        try {
            const zipBuffer = Buffer.from(zipData, 'base64');
            const zip = new AdmZip(zipBuffer);
            const entries = zip.getEntries();
            entries.forEach(entry => {
                if (!entry.isDirectory && (entry.entryName.endsWith('.txt') || entry.entryName.endsWith('.json'))) {
                    rawContent += zip.readAsText(entry) + "\n\n";
                }
            });
        } catch (zipErr) {
            return res.status(400).json({ error: "Failed to extract ZIP: " + zipErr.message });
        }
    }

    if (!rawContent) {
        return res.json({ success: true, blocks: [] });
    }

    let blocks = [rawContent];
    try {
        const p = JSON.parse(rawContent);
        if (Array.isArray(p)) {
            if (Array.isArray(p[0])) {
                blocks = p.map(b => JSON.stringify(b));
            }
        }
    } catch (_) {}

    if (blocks.length === 1) {
        const multi = rawContent.split(/\n\s*\n/).filter(b => /netflixid/i.test(b));
        if (multi.length > 1) blocks = multi;
    }

    // Filter empty blocks
    blocks = blocks.map(b => b.trim()).filter(b => b.length > 10);
    return res.json({ success: true, blocks });
});

// Vxl API: Check & Validate Single Cookie Health
app.post('/api/vxl/check-cookie', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required.' });
    
    const cookie = cookieStore.getCookie(email);
    if (!cookie) return res.status(404).json({ error: 'Cookie not found.' });

    const now = new Date().toISOString();
    try {
        const dict = {};
        (cookie.cookie_text || '').split(/[;\n]/).forEach(pair => {
            const idx = pair.indexOf('=');
            if (idx < 1) return;
            const k = pair.slice(0, idx).trim();
            const v = pair.slice(idx + 1).trim();
            if (k) dict[k] = v;
        });

        // 1) Validate Web Account Membership & Plan Status
        const check = await getAccountInfo(dict);
        if (!check || !check.valid) {
            throw new Error("Invalid account membership or plan");
        }

        // 2) Validate NFToken Generation
        const tokenInfo = await generateNFToken(check.updatedCookieText || cookie.cookie_text);

        cookie.status = 'Active';
        cookie.plan = check.plan;
        cookie.country = check.country;
        cookie.next_billing_date = check.billing;
        cookie.last_checked = now;
        if (tokenInfo && tokenInfo.updatedCookieText) {
            cookie.cookie_text = tokenInfo.updatedCookieText;
        }
        cookieStore.saveCookie(email, cookie);
        return res.json({ success: true, valid: true, cookie });
    } catch (checkErr) {
        cookie.status = 'Expired';
        cookie.last_checked = now;
        cookieStore.saveCookie(email, cookie);
        db.handleCookieExpiration(email).catch(() => {});
        return res.json({ success: true, valid: false, error: checkErr.message, cookie });
    }
});

// Vxl API: List All CDKs
app.get('/api/vxl/cdks', (req, res) => {
    db.all("SELECT c.*, (SELECT MIN(activated_at) FROM activations WHERE cdk_key = c.key) as activated_at FROM cdks c ORDER BY c.created_at DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: "Database error." });
        return res.json({ success: true, cdks: rows || [] });
    });
});

// Vxl API: Create CDK Keys (Supports Type 1: Random Allocation & Type 2: Specific Cookie Assignment)
app.post('/api/vxl/create-cdk', async (req, res) => {
    const { planType = 'Premium', count = 1, maxUsers = 1, warrantyType = '1_month', boundCookieEmail = null } = req.body;
    const qty = Math.min(Math.max(parseInt(count) || 1, 1), 50);
    const keysCreated = [];

    // Helper helper: Map warranty to days
    const poolDays = (pool) => {
        if (pool === '7_days') return 7;
        if (pool === '1_month') return 30;
        if (pool === '2_months') return 60;
        if (pool === '3_months') return 90;
        if (pool === '6_months') return 180;
        if (pool === '1_year') return 365;
        return 0; // no_warranty
    };

    // Verify stock & validate active cookies first
    let activeCookiesWithSlots = [];
    try {
        const cookies = cookieStore.getAllCookies().filter(c =>
            c.status === 'Active' &&
            c.warranty_type === warrantyType && // Filter by target warranty pool stock!
            (!planType || (c.plan && (c.plan.toLowerCase().includes(planType.toLowerCase()) || 
                                      (planType.toLowerCase() === 'premium' && c.plan.includes('مميز')))))
        );

        for (const c of cookies) {
            const reservedCount = await new Promise((resolve) => {
                db.get("SELECT COUNT(*) as count FROM cdks WHERE status = 'unused' AND (bound_cookie_email = ? OR cookie_email = ?)", [c.email, c.email], (err, row) => {
                    resolve(row ? row.count : 0);
                });
            });
            const freeSlots = Math.max(0, (c.max_users || 5) - (c.active_users || 0) - reservedCount);
            if (freeSlots > 0) {
                activeCookiesWithSlots.push({
                    email: c.email,
                    availableSlots: freeSlots
                });
            }
        }
    } catch (err) {
        return res.status(500).json({ error: "Failed to verify available stock: " + err.message });
    }

    const unassignedUnusedRow = await new Promise((resolve) => {
        db.get("SELECT COUNT(*) as count FROM cdks WHERE status = 'unused' AND plan_type = ? AND warranty_type = ? AND bound_cookie_email IS NULL AND cookie_email IS NULL", [planType, warrantyType], (err, row) => {
            resolve(row ? row.count : 0);
        });
    });
    const totalRawSlots = activeCookiesWithSlots.reduce((acc, curr) => acc + curr.availableSlots, 0);
    const availableSlots = Math.max(0, totalRawSlots - (unassignedUnusedRow || 0));

    if (availableSlots < qty) {
        return res.status(400).json({ 
            error: `Insufficient active account stock in this pool. Required slots: ${qty}, Available slots: ${availableSlots}. Please upload more active cookies first.` 
        });
    }

    db.serialize(() => {
        const stmt = db.prepare("INSERT INTO cdks (key, status, plan_type, warranty_type, duration_days, max_users, active_users, created_at, bound_cookie_email) VALUES (?, 'unused', ?, ?, ?, ?, 0, ?, ?)");
        const now = new Date().toISOString();
        const days = poolDays(warrantyType);

        let candidateIdx = 0;
        for (let i = 0; i < qty; i++) {
            const part1 = crypto.randomBytes(3).toString('hex').toUpperCase();
            const part2 = crypto.randomBytes(3).toString('hex').toUpperCase();
            const key = `NETVXL-${part1}-${part2}`;
            
            let assignedEmail = boundCookieEmail || null;
            if (!boundCookieEmail && activeCookiesWithSlots.length > 0) {
                let attempts = 0;
                while (attempts < activeCookiesWithSlots.length) {
                    const current = activeCookiesWithSlots[candidateIdx];
                    if (current.availableSlots > 0) {
                        assignedEmail = current.email;
                        current.availableSlots--;
                        candidateIdx = (candidateIdx + 1) % activeCookiesWithSlots.length;
                        break;
                    }
                    candidateIdx = (candidateIdx + 1) % activeCookiesWithSlots.length;
                    attempts++;
                }
            }

            stmt.run([key, planType, warrantyType, days, parseInt(maxUsers) || 1, now, assignedEmail]);
            keysCreated.push(key);
        }
        stmt.finalize((err) => {
            if (err) return res.status(500).json({ error: "Failed to save keys to database." });
            return res.json({ success: true, created: keysCreated.length, keys: keysCreated });
        });
    });
});

// Redirection/Masking Endpoint for Shortened Login Links (One-time secure XOR redirect)
app.get('/l/:code', (req, res) => {
    const { code } = req.params;
    if (!code) return res.status(400).send("Invalid or missing code.");
    
    const device = req.query.d;
    const cleanCode = code.trim().toUpperCase();
    
    // Fetch first, delete immediately to ensure absolute one-time use
    db.get("SELECT token, cookie_email FROM redirects WHERE code = ?", [cleanCode], (err, row) => {
        if (err || !row) {
            return res.status(404).send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Link Expired / Already Used</title>
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
                    <style>
                        :root {
                            --bg: #0a0a0a;
                            --surface: rgba(20, 20, 20, 0.6);
                            --border: rgba(229, 9, 20, 0.2);
                            --red: #e50914;
                            --text-1: #f5f5f5;
                            --text-2: #a3a3a3;
                            --font: 'Inter', system-ui, sans-serif;
                        }
                        body {
                            background: var(--bg);
                            color: var(--text-1);
                            font-family: var(--font);
                            display: flex;
                            justify-content: center;
                            align-items: center;
                            height: 100vh;
                            margin: 0;
                            overflow: hidden;
                        }
                        .bg-grid {
                            position: fixed; inset: 0;
                            background-image:
                                linear-gradient(rgba(229,9,20,0.06) 1px, transparent 1px),
                                linear-gradient(90deg, rgba(229,9,20,0.06) 1px, transparent 1px);
                            background-size: 48px 48px;
                            pointer-events: none; z-index: 0;
                        }
                        .blob {
                            position: fixed; border-radius: 50%; filter: blur(120px); pointer-events: none; z-index: 0;
                            width: 400px; height: 400px; background: rgba(229, 9, 20, 0.08); top: -100px; left: -100px;
                        }
                        .container {
                            position: relative;
                            z-index: 10;
                            text-align: center;
                            padding: 40px;
                            border-radius: 16px;
                            background: var(--surface);
                            backdrop-filter: blur(16px);
                            border: 1px solid var(--border);
                            box-shadow: 0 40px 80px -16px rgba(0, 0, 0, 0.8);
                            max-width: 420px;
                            width: 85%;
                            animation: fadeIn 0.6s cubic-bezier(0.16, 1, 0.3, 1);
                        }
                        @keyframes fadeIn {
                            from { opacity: 0; transform: translateY(15px); }
                            to { opacity: 1; transform: translateY(0); }
                        }
                        .logo {
                            width: 60px;
                            height: 60px;
                            margin-bottom: 20px;
                            filter: drop-shadow(0 0 8px rgba(229, 9, 20, 0.6));
                        }
                        .icon {
                            font-size: 48px;
                            margin-bottom: 15px;
                            color: var(--red);
                            animation: bounce 2s infinite ease-in-out;
                        }
                        @keyframes bounce {
                            0%, 100% { transform: translateY(0); }
                            50% { transform: translateY(-8px); }
                        }
                        h2 {
                            font-size: 22px;
                            font-weight: 600;
                            margin: 10px 0;
                            color: #ffffff;
                            letter-spacing: -0.4px;
                        }
                        p {
                            font-size: 14px;
                            color: var(--text-2);
                            line-height: 1.5;
                            margin: 0;
                            font-weight: 300;
                        }
                    </style>
                </head>
                <body>
                    <div class="bg-grid"></div>
                    <div class="blob"></div>
                    <div class="container">
                        <svg class="logo" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M16 4h12l20 56H36L16 4z" fill="#B81D24"/>
                            <path d="M16 4h12v56H16V4z" fill="#E50914"/>
                            <path d="M36 4h12v56H36V4z" fill="#E50914"/>
                        </svg>
                        <div class="icon">⚠️</div>
                        <h2>Link Expired / Already Used</h2>
                        <p>This secure redirection link has already been used or has expired. Please request a new link from the redemption panel.</p>
                    </div>
                </body>
                </html>
            `);
        }
        
        // === IP Lock + Expiry Check ===
        const clientIp = req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : (req.ip || '');
        
        // Check token expiry (3 min window)
        if (row.expires_at && new Date() > new Date(row.expires_at)) {
            db.run("DELETE FROM redirects WHERE code = ?", [cleanCode]);
            return res.status(410).send(`<!DOCTYPE html><html><head><title>Link Expired</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{background:#0a0a0a;color:#f5f5f5;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}</style></head><body><div><h2 style="color:#e50914">⏱ Link Expired</h2><p>This link has expired (3 minute limit). Please generate a new one.</p></div></body></html>`);
        }
        
        // Check IP lock (skip if no IP was stored — backward compatible)
        if (row.locked_ip && clientIp && row.locked_ip !== clientIp) {
            // IP mismatch — could be Burp/proxy interception attempt
            console.log('[Security] IP mismatch on /l/:code - stored:', row.locked_ip, 'current:', clientIp);
            db.run("DELETE FROM redirects WHERE code = ?", [cleanCode]); // burn the token
            return res.status(403).send(`<!DOCTYPE html><html><head><title>Access Denied</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{background:#0a0a0a;color:#f5f5f5;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}</style></head><body><div><h2 style="color:#e50914">🔒 Access Denied</h2><p>Security violation detected. This link has been invalidated.<br><small style="color:#666">Request originated from a different network.</small></p></div></body></html>`);
        }

        // Delete record immediately to prevent second load
        db.run("DELETE FROM redirects WHERE code = ?", [cleanCode]);
        
        let targetUrl = `https://netflix.com/?nftoken=${row.token}`;
        if (device === 'm') {
            targetUrl = `https://netflix.com/unsupported?nftoken=${row.token}`;
        }
        
        // Encrypt the targetUrl using a randomized XOR key
        const key = crypto.randomBytes(8).toString('hex');
        let encoded = '';
        for (let i = 0; i < targetUrl.length; i++) {
            const charCode = targetUrl.charCodeAt(i) ^ key.charCodeAt(i % key.length);
            encoded += charCode.toString(16).padStart(2, '0');
        }
        
        // Serve secure JS loader page with optional TV activation screen
        return res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Securing Connection...</title>
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
                <style>
                    :root {
                        --bg: #0a0a0a;
                        --surface: rgba(20, 20, 20, 0.6);
                        --border: rgba(255, 255, 255, 0.08);
                        --red: #e50914;
                        --green: #10b981;
                        --text-1: #f5f5f5;
                        --text-2: #a3a3a3;
                        --font: 'Inter', system-ui, sans-serif;
                    }
                    body {
                        background: var(--bg);
                        color: var(--text-1);
                        font-family: var(--font);
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        height: 100vh;
                        margin: 0;
                        overflow: hidden;
                    }
                    .bg-grid {
                        position: fixed; inset: 0;
                        background-image:
                            linear-gradient(rgba(229,9,20,0.06) 1px, transparent 1px),
                            linear-gradient(90deg, rgba(229,9,20,0.06) 1px, transparent 1px);
                        background-size: 48px 48px;
                        pointer-events: none; z-index: 0;
                    }
                    .blob {
                        position: fixed; border-radius: 50%; filter: blur(120px); pointer-events: none; z-index: 0;
                        width: 400px; height: 400px; background: rgba(229, 9, 20, 0.08); top: -100px; left: -100px;
                    }
                    .container {
                        position: relative;
                        z-index: 10;
                        text-align: center;
                        padding: 40px;
                        border-radius: 16px;
                        background: var(--surface);
                        backdrop-filter: blur(16px);
                        border: 1px solid var(--border);
                        box-shadow: 0 40px 80px -16px rgba(0, 0, 0, 0.8);
                        max-width: 420px;
                        width: 85%;
                        animation: fadeIn 0.6s cubic-bezier(0.16, 1, 0.3, 1);
                    }
                    @keyframes fadeIn {
                        from { opacity: 0; transform: translateY(15px); }
                        to { opacity: 1; transform: translateY(0); }
                    }
                    .logo {
                        width: 70px;
                        height: 70px;
                        margin-bottom: 25px;
                        animation: pulse 2.5s infinite ease-in-out;
                    }
                    @keyframes pulse {
                        0%, 100% { transform: scale(1); filter: drop-shadow(0 0 5px rgba(229, 9, 20, 0.4)); }
                        50% { transform: scale(1.05); filter: drop-shadow(0 0 15px rgba(229, 9, 20, 0.8)); }
                    }
                    .spinner {
                        border: 3px solid rgba(255, 255, 255, 0.05);
                        width: 45px;
                        height: 45px;
                        border-radius: 50%;
                        border-left-color: var(--red);
                        border-top-color: var(--red);
                        animation: spin 0.8s cubic-bezier(0.5, 0.1, 0.5, 0.9) infinite;
                        margin: 0 auto 20px;
                    }
                    @keyframes spin {
                        0% { transform: rotate(0deg); }
                        100% { transform: rotate(360deg); }
                    }
                    h2 {
                        font-size: 20px;
                        font-weight: 600;
                        margin: 10px 0;
                        color: #ffffff;
                        letter-spacing: -0.3px;
                    }
                    p {
                        font-size: 14px;
                        color: var(--text-2);
                        margin: 0;
                        font-weight: 300;
                    }
                </style>
            </head>
            <body>
                <div class="bg-grid"></div>
                <div class="blob"></div>
                <div class="container">
                    <svg class="logo" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M16 4h12l20 56H36L16 4z" fill="#B81D24"/>
                        <path d="M16 4h12v56H16V4z" fill="#E50914"/>
                        <path d="M36 4h12v56H36V4z" fill="#E50914"/>
                    </svg>
                    <div class="spinner"></div>
                    <h2>Securing connection to your account...</h2>
                    <p>Please wait, redirecting to Netflix.</p>
                </div>
                <iframe src="https://www.netflix.com/clearcookies" style="display:none;"></iframe>
                <script>
                    (function() {
                        var _enc = "${encoded}";
                        var _key = "${key}";
                        var _target = '';
                        for (var i = 0; i < _enc.length; i += 2) {
                            var hex = _enc.substr(i, 2);
                            var charCode = parseInt(hex, 16) ^ _key.charCodeAt((i / 2) % _key.length);
                            _target += String.fromCharCode(charCode);
                        }
                        setTimeout(function() {
                            window.location.href = _target;
                        }, 500);
                    })();
                </script>
            </body>
            </html>
        `);
    });
});

// TV Screen Activation endpoint requested from loader page
app.post('/api/activate-tv-from-redirect', (req, res) => {
    const { email, tvCode } = req.body;
    if (!email || !tvCode) {
        return res.status(400).json({ error: "Missing email or TV code parameters." });
    }
    
    const cookie = cookieStore.getCookie(email);
    if (!cookie || cookie.status !== 'Active') {
        return res.status(400).json({ error: "The account session has expired. Please contact support." });
    }
    
    activateTV(cookie.cookie_text, tvCode)
        .then(() => {
            return res.json({ success: true });
        })
        .catch(err => {
            return res.status(400).json({ error: err.message });
        });
});


// === UA Device Detection ===
function detectDeviceClass(ua) {
    if (!ua) return 'desktop';
    return /Mobile|Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|webOS/i.test(ua) ? 'mobile' : 'desktop';
}
function isBotUA(ua) {
    if (!ua) return false;
    return /TelegramBot|facebookexternalhit|Twitterbot|LinkedInBot|Slackbot|Discordbot|WhatsApp|Googlebot|bingbot|YandexBot|curl|wget|python-requests|axios|node-fetch|Go-http|Java\/|bot|crawler|spider|scraper/i.test(ua);
}

// 1. Check CDK (Verification Step)
app.post('/api/check-cdk', (req, res) => {
    const { key } = req.body;
    if (!key) {
        return res.status(400).json({ error: "Activation key is required." });
    }

    db.get("SELECT * FROM cdks WHERE UPPER(key) = ?", [key.trim().toUpperCase()], async (err, rawCdk) => {
        if (err) {
            return res.status(500).json({ error: "Database error during key check." });
        }
        if (!rawCdk) {
            return res.json({ valid: false, status: 'not_found', error: "Non-existent code / Code does not exist." });
        }
        const cdk = await checkSingleCDKExpiry(rawCdk);
        
        db.get("SELECT MIN(activated_at) as activated_at FROM activations WHERE cdk_key = ?", [cdk.key], async (err2, act) => {
            const activatedAt = act ? act.activated_at : null;
            let expiresAt = null;
            let warrantyDaysLeft = null;
            if (activatedAt && cdk.duration_days) {
                const firstActiveDate = new Date(activatedAt);
                const expiryTime = firstActiveDate.getTime() + (cdk.duration_days * 24 * 60 * 60 * 1000);
                expiresAt = new Date(expiryTime).toISOString();
                warrantyDaysLeft = Math.max(0, Math.ceil((expiryTime - Date.now()) / (24 * 60 * 60 * 1000)));
            }

            if (cdk.status === 'expired' || cdk.status === 'active' || activatedAt) {
                const cookieEmail = cdk.cookie_email || cdk.bound_cookie_email;
                const cookie = cookieStore.getCookie(cookieEmail);
                return res.json({
                    valid: true,
                    status: 'used',
                    planType: (cookie && cookie.plan) ? cookie.plan : cdk.plan_type,
                    usedDevice: cdk.used_device,
                    available: false,
                    error: "This activation code has already been used.",
                    warrantyType: cdk.warranty_type,
                    durationDays: cdk.duration_days,
                    activatedAt,
                    expiresAt,
                    warrantyDaysLeft: warrantyDaysLeft !== null ? warrantyDaysLeft : 0
                });
            } else {
                // CDK is unused. Check if it's bound or random.
                let available = false;
                if (cdk.bound_cookie_email) {
                    const c = cookieStore.getCookie(cdk.bound_cookie_email);
                    available = c && await cookieStore.isCookieEligible(c, cdk.plan_type);
                } else {
                    const cookies = cookieStore.getAllCookies();
                    for (const c of cookies) {
                        if (await cookieStore.isCookieEligible(c, cdk.plan_type)) {
                            available = true;
                            break;
                        }
                    }
                }
                return res.json({
                    valid: true,
                    status: 'unused',
                    planType: cdk.plan_type,
                    available,
                    warrantyType: cdk.warranty_type,
                    durationDays: cdk.duration_days,
                    activatedAt: null,
                    expiresAt: null,
                    warrantyDaysLeft: null
                });
            }
        });
    });
});

// Smart Cookie Allocation supporting Type 1 (Random/Available Active Cookie) & Type 2 (Bound/Specific Cookie)
function allocateCookieForCDK(cdk) {
    return new Promise((resolve, reject) => {
        const boundEmail = cdk.bound_cookie_email;
        if (boundEmail) {
            // Type 2: Bound to a specific Cookie / Account Email
            const cookie = cookieStore.getCookie(boundEmail);
            if (!cookie) {
                return reject(new Error("The specific assigned account for this CDK key is currently inactive or unavailable."));
            }
            cookieStore.isCookieEligible(cookie, cdk.plan_type)
                .then(eligible => {
                    if (!eligible) {
                        return reject(new Error("The assigned account is inactive, full, or has reached its capacity limit."));
                    }
                    generateNFToken(cookie.cookie_text)
                        .then(tokenInfo => {
                            if (tokenInfo && tokenInfo.updatedCookieText) {
                                cookie.cookie_text = tokenInfo.updatedCookieText;
                                cookieStore.saveCookie(cookie.email, cookie);
                            }
                            resolve({ cookie, tokenInfo });
                        })
                        .catch(checkErr => {
                            console.warn(`[API Redeem] Bound Cookie ${cookie.email} failed validation: ${checkErr.message}.`);
                            cookie.status = 'Expired';
                            cookieStore.saveCookie(cookie.email, cookie);
                            db.handleCookieExpiration(cookie.email).catch(() => {});
                            reject(new Error("The specific assigned account for this CDK key has expired."));
                        });
                })
                .catch(reject);
        } else {
            // Type 1: Standard CDK - random / next available active cookie matching warranty pool
            cookieStore.findAndValidateCookie(cdk.plan_type, cdk.warranty_type, generateNFToken)
                .then(result => {
                    resolve(result); // Can be null if none found
                })
                .catch(reject);
        }
    });
}


// 2. Redeem / Activate CDK
app.post('/api/redeem', (req, res) => {
    const { key, tvCode, deviceType } = req.body;
    const ip = req.ip || req.headers['x-forwarded-for'] || '127.0.0.1';
    const userAgent = req.headers['user-agent'] || 'Unknown';
    const deviceClass = detectDeviceClass(userAgent);
    if (isBotUA(userAgent)) {
        return res.status(403).json({ error: 'Automated requests are not allowed.' });
    }

    if (!key) {
        return res.status(400).json({ error: "Redemption key is required." });
    }

    db.get("SELECT * FROM cdks WHERE UPPER(key) = ?", [key.trim().toUpperCase()], async (err, rawCdk) => {
        if (err) {
            return res.status(500).json({ error: "Database error during key lookup." });
        }
        if (!rawCdk) {
            return res.status(404).json({ error: "Invalid activation code." });
        }
        const cdk = await checkSingleCDKExpiry(rawCdk);
        if (cdk.status === 'expired') {
            return res.status(400).json({ error: "This code has already been used." });
        }

        // Check if this IP/UA has already activated this CDK
        db.get("SELECT * FROM activations WHERE cdk_key = ? AND ip = ? AND user_agent = ?", [cdk.key, ip, userAgent], (err, existingActivation) => {
            if (err) {
                return res.status(500).json({ error: "Database error during activation check." });
            }

            if (cdk.status === 'unused') {
                // For TV plan, tvCode is required before we allocate
                if (cdk.plan_type === 'TV' && !tvCode) {
                    return res.status(400).json({ error: "TV screen code is required for TV activation." });
                }
                allocateCookieForCDK(cdk)
                    .then(result => {
                        if (!result) {
                            return res.status(503).json({ error: "All subscription slots are currently occupied. Please contact support." });
                        }

                        const { cookie: allocated, tokenInfo } = result;
                        const usedDevice = tvCode ? 'Smart TV' : (deviceClass === 'mobile' ? 'Phone' : 'PC'); // UA-detected

                        const performBindingAndRespond = () => {
                            saveShortRedirect(tokenInfo.token, allocated.email, ip)
                                .then(shortCode => {
                                    db.serialize(() => {
                                        const nextStatus = (1 >= cdk.max_users) ? 'expired' : 'active';
                                        db.run("UPDATE cdks SET status = ?, cookie_email = ?, active_users = 1, used_device = ? WHERE key = ?", [nextStatus, allocated.email, usedDevice, cdk.key]);
                                        cookieStore.adjustActiveUsers(allocated.email, 1);
                                        db.run("INSERT INTO activations (cdk_key, ip, user_agent, activated_at) VALUES (?, ?, ?, ?)", [cdk.key, ip, userAgent, new Date().toISOString()]);
                                        
                                        const isTV = !!tvCode || cdk.plan_type === 'TV';
                                        const loginUrl = isTV ? null : (deviceType === 'phone'
                                            ? `${req.protocol}://${req.get('host')}/l/${shortCode}?d=m`
                                            : `${req.protocol}://${req.get('host')}/l/${shortCode}`);
                                        return res.json({
                                            success: true,
                                            isTVActivation: isTV,
                                            loginUrl,
                                            tvCode: tvCode ? tvCode.toUpperCase() : undefined,
                                            expires: tokenInfo.expires
                                        });
                                    });
                                })
                                .catch(err => {
                                    return res.status(500).json({ error: "Failed to create redirection code: " + err.message });
                                });
                        };

                        if (tvCode) {
                            // Verify TV code first before key usage
                            activateTV(allocated.cookie_text, tvCode)
                                .then(() => {
                                    performBindingAndRespond();
                                })
                                .catch(tvErr => {
                                    return res.status(400).json({ error: tvErr.message });
                                });
                        } else {
                            performBindingAndRespond();
                        }
                    })
                    .catch(err => {
                        return res.status(400).json({ error: err.message });
                    });
            } else if (cdk.status === 'active') {
                // Key is active. Check device limits.
                // === Device Class Lock ===
                if (cdk.used_device && !existingActivation && cdk.used_device !== 'Smart TV') {
                    const firstClass = (cdk.used_device === 'Phone') ? 'mobile' : 'desktop';
                    if (firstClass !== deviceClass) {
                        const fromDev = cdk.used_device === 'Phone' ? 'Mobile' : 'Desktop';
                        const curDev  = deviceClass === 'mobile' ? 'Mobile' : 'Desktop';
                        return res.status(403).json({
                            error: 'Device mismatch! This CDK was activated on ' + fromDev + '. You are connecting from ' + curDev + '.',
                            deviceLock: true, activatedOn: fromDev, currentDevice: curDev
                        });
                    }
                }
                if (!existingActivation && cdk.active_users >= cdk.max_users) {
                    return res.status(400).json({ error: "Maximum device limit reached for this activation code." });
                }

                // Retrieve bound cookie by email
                const cookieEmail = cdk.cookie_email || cdk.bound_cookie_email;
                const cookie = cookieStore.getCookie(cookieEmail);
                
                const reallocateAndRespond = () => {
                    allocateCookieForCDK(cdk)
                        .then(result => {
                            if (!result) {
                                return res.status(503).json({ error: "The assigned subscription has stopped and no backup slots are available." });
                            }

                            const { cookie: newAllocated, tokenInfo } = result;
                            const performReallocation = () => {
                                saveShortRedirect(tokenInfo.token, newAllocated.email, ip)
                                    .then(shortCode => {
                                        db.serialize(() => {
                                            if (cookie) {
                                                cookieStore.adjustActiveUsers(cookie.email, -1);
                                            }
                                            const newUserCount = existingActivation ? cdk.active_users : cdk.active_users + 1;
                                            const usedDevice = tvCode ? 'Smart TV' : (deviceClass === 'mobile' ? 'Phone' : 'PC'); // UA-detected
                                            const nextStatus = (newUserCount >= cdk.max_users) ? 'expired' : 'active';
                                            db.run("UPDATE cdks SET status = ?, cookie_email = ?, active_users = ?, used_device = COALESCE(used_device, ?) WHERE key = ?", [nextStatus, newAllocated.email, newUserCount, usedDevice, cdk.key]);
                                            cookieStore.adjustActiveUsers(newAllocated.email, 1);
                                            if (!existingActivation) {
                                                db.run("INSERT INTO activations (cdk_key, ip, user_agent, activated_at) VALUES (?, ?, ?, ?)", [cdk.key, ip, userAgent, new Date().toISOString()]);
                                            }

                                            const isTV = !!tvCode || cdk.plan_type === 'TV';
                                            const loginUrl = isTV ? null : (deviceType === 'phone'
                                                ? `${req.protocol}://${req.get('host')}/l/${shortCode}?d=m`
                                                : `${req.protocol}://${req.get('host')}/l/${shortCode}`);
                                            return res.json({
                                                success: true,
                                                isTVActivation: isTV,
                                                loginUrl,
                                                tvCode: tvCode ? tvCode.toUpperCase() : undefined,
                                                expires: tokenInfo.expires
                                            });
                                        });
                                    })
                                    .catch(err => {
                                        return res.status(500).json({ error: "Failed to create redirection code: " + err.message });
                                    });
                            };

                            if (tvCode) {
                                activateTV(newAllocated.cookie_text, tvCode)
                                    .then(() => {
                                        performReallocation();
                                    })
                                    .catch(tvErr => {
                                        return res.status(400).json({ error: tvErr.message });
                                    });
                            } else {
                                performReallocation();
                            }
                        })
                        .catch(err => {
                            return res.status(400).json({ error: err.message });
                        });
                };

                if (!cookie || cookie.status !== 'Active') {
                    reallocateAndRespond();
                } else {
                    // Validate currently bound cookie is actually working
                    generateNFToken(cookie.cookie_text)
                        .then(tokenInfo => {
                            if (tokenInfo && tokenInfo.updatedCookieText) {
                                cookie.cookie_text = tokenInfo.updatedCookieText;
                                cookieStore.saveCookie(cookie.email, cookie);
                            }
                            const performResponse = () => {
                                saveShortRedirect(tokenInfo.token, cookie.email, ip)
                                    .then(shortCode => {
                                        db.serialize(() => {
                                            if (!existingActivation) {
                                                const usedDevice = tvCode ? 'Smart TV' : (deviceClass === 'mobile' ? 'Phone' : 'PC'); // UA-detected
                                                db.run("UPDATE cdks SET active_users = active_users + 1, used_device = COALESCE(used_device, ?) WHERE key = ?", [usedDevice, cdk.key]);
                                                db.run("INSERT INTO activations (cdk_key, ip, user_agent, activated_at) VALUES (?, ?, ?, ?)", [cdk.key, ip, userAgent, new Date().toISOString()]);
                                            }

                                            const isTV = cdk.plan_type === 'TV';
                                            const loginUrl = deviceType === 'phone'
                                                ? `${req.protocol}://${req.get('host')}/l/${shortCode}?d=m`
                                                : `${req.protocol}://${req.get('host')}/l/${shortCode}`;
                                            return res.json({
                                                success: true,
                                                isTVActivation: isTV,
                                                loginUrl,
                                                tvUrl: `https://www.netflix.com/tv8?nftoken=${tokenInfo.token}`,
                                                activateUrl: `https://www.netflix.com/Activate?nftoken=${tokenInfo.token}`,
                                                tvCode: isTV ? (tvCode || '').toUpperCase() : undefined,
                                                expires: tokenInfo.expires
                                            });
                                        });
                                    })
                                    .catch(err => {
                                        return res.status(500).json({ error: "Failed to create redirection code: " + err.message });
                                    });
                            };

                            if (tvCode) {
                                activateTV(cookie.cookie_text, tvCode)
                                    .then(() => {
                                        performResponse();
                                    })
                                    .catch(tvErr => {
                                        return res.status(400).json({ error: tvErr.message });
                                    });
                            } else {
                                performResponse();
                            }
                        })
                        .catch(checkErr => {
                            // Bound cookie is dead! Mark as Expired in db, handle other keys and reallocate
                            console.warn(`[API Redeem] Bound Cookie ${cookie.email} failed validation: ${checkErr.message}. Marking Expired.`);
                            cookie.status = 'Expired';
                            cookieStore.saveCookie(cookie.email, cookie);
                            db.handleCookieExpiration(cookie.email).catch(() => {});
                            reallocateAndRespond();
                        });
                }
            }
        });
    });
});

// ── Next.js Vxl Console (static export) ──
const ADMIN_SECRET_PATH = process.env.ADMIN_SECRET_PATH || '/actrl9fdma2';
const ADMIN_STATIC_DIR = path.join(__dirname, 'admin-panel', 'out');

// Serve Next.js static assets (_next/*, images, etc.)
app.use(ADMIN_SECRET_PATH, express.static(ADMIN_STATIC_DIR, { index: false }));

// All /actrl9fdma2/* routes → delegate to Next.js static pages
app.get(`${ADMIN_SECRET_PATH}`, (req, res) => {
    const indexFile = path.join(ADMIN_STATIC_DIR, 'index.html');
    if (require('fs').existsSync(indexFile)) {
        res.sendFile(indexFile);
    } else {
        res.sendFile(path.join(__dirname, 'public', 'adm_sys_78f9a2.html'));
    }
});

app.get(`${ADMIN_SECRET_PATH}/*`, (req, res) => {
    // Strip the base path, map to a file in /out
    const sub = req.path.replace(ADMIN_SECRET_PATH, '').replace(/^\//, '');

    // Fast-fail missing static file requests to avoid serving HTML as JS/CSS
    if (sub.includes('.') || req.path.endsWith('.js') || req.path.endsWith('.css')) {
        return res.status(404).send('Not Found');
    }

    const candidates = [
        path.join(ADMIN_STATIC_DIR, sub),
        path.join(ADMIN_STATIC_DIR, sub, 'index.html'),
        path.join(ADMIN_STATIC_DIR, sub.replace(/\/$/, '') + '.html'),
    ];
    const fs = require('fs');
    const found = candidates.find(f => fs.existsSync(f) && fs.statSync(f).isFile());
    if (found) {
        res.sendFile(found);
    } else {
        // SPA fallback: serve dashboard/index.html
        const fallback = path.join(ADMIN_STATIC_DIR, 'dashboard', 'index.html');
        if (fs.existsSync(fallback)) res.sendFile(fallback);
        else res.sendFile(path.join(__dirname, 'public', 'adm_sys_78f9a2.html'));
    }
});

// ── Vxl Auth & Management APIs (DB-backed) ──
const JWT_SECRET = process.env.JWT_SECRET || 'netvxl_super_secret_jwt_key_2026';

// Middleware to verify Vxl/Partner session token
function verifyVxlToken(req, res, next) {
    const authHeader = req.headers.authorization || req.headers.Authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized: No token provided' });
    }

    const rawToken = authHeader.substring(7); // Remove 'Bearer '

    // Handle encrypted NETVXL_ tokens
    if (rawToken.startsWith('NETVXL_')) {
        const payload = aesDecryptToken(rawToken);
        if (!payload || !payload.username || !payload.hash) {
            return res.status(401).json({ error: 'Unauthorized: Invalid encrypted token' });
        }
        db.get("SELECT * FROM vxl_users WHERE username = ? AND password_hash = ?", [payload.username, payload.hash], (err, user) => {
            if (err || !user) {
                return res.status(401).json({ error: 'Unauthorized: Session expired or invalid' });
            }
            req.user = user;
            next();
        });
        return;
    }

    // Fallback: legacy plain username:hash tokens
    const parts = rawToken.split(':');
    if (parts.length < 2) {
        return res.status(401).json({ error: 'Unauthorized: Invalid token format' });
    }
    const username = parts[0];
    const passHash = parts[1];
    db.get("SELECT * FROM vxl_users WHERE username = ? AND password_hash = ?", [username.trim(), passHash], (err, user) => {
        if (err || !user) {
            return res.status(401).json({ error: 'Unauthorized: Invalid session' });
        }
        req.user = user;
        next();
    });
}

// Middleware to restrict partner from user management
function requireVxlOrOwner(req, res, next) {
    if (req.user && (req.user.role === 'vxl' || req.user.role === 'owner')) {
        return next();
    }
    return res.status(403).json({ error: 'Forbidden: Partners cannot manage system users' });
}

// Mount verifyVxlToken middleware on all /api/vxl/ routes except login and pubkey
app.use('/api/vxl/', (req, res, next) => {
    if (req.path === '/login' || req.path === '/pubkey') {
        return next();
    }
    verifyVxlToken(req, res, next);
});

// Seed default vxl in database if table is empty
function seedDefaultAdmin() {
    db.get("SELECT COUNT(*) as cnt FROM vxl_users", [], (err, row) => {
        if (!err && row && row.cnt === 0) {
            const hash = crypto.createHash('sha256').update('Netflix@Admin2024').digest('hex');
            const now = new Date().toISOString();
            db.run("INSERT INTO vxl_users (username, password_hash, role, created_at) VALUES (?, ?, 'owner', ?)", ['vxl', hash, now]);
            console.log('[DB] Default owner created (vxl / Netflix@Admin2024)');
        } else {
            // Guarantee existing default vxl is promoted to owner
            db.run("UPDATE vxl_users SET role = 'owner' WHERE username = 'vxl'");
        }
    });
}
setTimeout(seedDefaultAdmin, 2000);

// Expose AES Key endpoints for encryption support
app.get('/api/vxl/pubkey', (req, res) => {
    res.json({ aesKey: AES_KEY });
});
app.get('/auth/pubkey', (req, res) => {
    res.json({ aesKey: AES_KEY });
});

// Vxl Login
const handleLogin = (req, res) => {
    let body = req.body;
    if (body && body.iv && body.data) {
        body = aesDecrypt(body);
        if (!body) return res.status(400).json({ error: 'Decryption failed' });
    }
    const { username, password } = body || {};
    if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });

    const hash = crypto.createHash('sha256').update(password).digest('hex');
    db.get("SELECT * FROM vxl_users WHERE username = ? AND password_hash = ?", [username.trim(), hash], (err, user) => {
        if (err) return res.status(500).json({ error: 'Database error.' });
        if (!user) return res.status(401).json({ error: 'Incorrect username or password' });

        const now = new Date().toISOString();
        db.run("UPDATE vxl_users SET last_login = ? WHERE id = ?", [now, user.id]);

        // Issue an AES-encrypted opaque session token prefixed with NETVXL_
        const sessionToken = aesEncryptToken({ username: user.username, hash });

        return res.json({
            success: true,
            user: { username: user.username, role: user.role },
            token: sessionToken
        });
    });
};

app.post('/api/vxl/login', handleLogin);
app.post('/auth/login', handleLogin);

// Proxy status endpoint for frontend compatibility check
app.get('/api/proxy/status', (req, res) => {
    return res.json({ success: true, status: 'ACTIVE' });
});

// Vxl API: Delete Expired Cookies
app.delete('/api/vxl/cookies/expired', (req, res) => {
    const cookies = cookieStore.getAllCookies();
    let count = 0;
    cookies.forEach(c => {
        if (c.status !== 'Active') {
            if (cookieStore.deleteCookie(c.email)) {
                db.run("UPDATE cdks SET cookie_email = NULL WHERE cookie_email = ?", [c.email]);
                count++;
            }
        }
    });
    return res.json({ success: true, count });
});

// Vxl API: Delete Active Cookies
app.delete('/api/vxl/cookies/active', (req, res) => {
    const cookies = cookieStore.getAllCookies();
    let count = 0;
    cookies.forEach(c => {
        if (c.status === 'Active') {
            if (cookieStore.deleteCookie(c.email)) {
                db.run("UPDATE cdks SET cookie_email = NULL WHERE cookie_email = ?", [c.email]);
                count++;
            }
        }
    });
    return res.json({ success: true, count });
});

// Vxl API: Reset Slots on All Cookies
app.post('/api/vxl/cookies/reset-slots', (req, res) => {
    cookieStore.resetActiveUsersAll();
    return res.json({ success: true });
});

// Vxl API: Delete All Cookies
app.delete('/api/vxl/cookies', (req, res) => {
    const count = cookieStore.deleteAllCookies();
    db.run("UPDATE cdks SET cookie_email = NULL");
    return res.json({ success: true, count });
});

// Vxl API: Delete Cookie
app.delete('/api/vxl/cookies/:email', (req, res) => {
    const email = decodeURIComponent(req.params.email);
    const success = cookieStore.deleteCookie(email);
    if (success) {
        db.run("UPDATE cdks SET cookie_email = NULL WHERE cookie_email = ?", [email]);
        return res.json({ success: true });
    } else {
        return res.status(404).json({ error: "Cookie not found." });
    }
});

// Vxl API: Edit/Update Cookie
app.post('/api/vxl/cookies/edit', (req, res) => {
    const { oldEmail, email, plan, country, next_billing_date, cookie_text, max_users, active_users, status, warranty_type } = req.body;
    const targetEmail = oldEmail || email;
    if (!targetEmail) {
        return res.status(400).json({ error: "Email is required." });
    }
    
    const existing = cookieStore.getCookie(targetEmail);
    if (!existing) {
        return res.status(404).json({ error: "Cookie not found." });
    }
    
    const updated = {
        email: (email || targetEmail).toLowerCase(),
        plan: plan || existing.plan || 'Premium',
        country: country || existing.country || 'Unknown',
        next_billing_date: next_billing_date !== undefined ? next_billing_date : existing.next_billing_date,
        cookie_text: cookie_text !== undefined ? cookie_text : existing.cookie_text,
        max_users: max_users !== undefined ? parseInt(max_users) : (existing.max_users || 5),
        active_users: active_users !== undefined ? parseInt(active_users) : (existing.active_users || 0),
        status: status || existing.status || 'Active',
        warranty_type: warranty_type || existing.warranty_type || '1_month'
    };
    
    if (oldEmail && oldEmail.toLowerCase() !== updated.email) {
        cookieStore.deleteCookie(oldEmail);
        db.run("UPDATE cdks SET cookie_email = ? WHERE cookie_email = ?", [updated.email, oldEmail]);
    }
    
    const success = cookieStore.saveCookie(updated.email, updated);
    if (success) {
        return res.json({ success: true, cookie: updated });
    } else {
        return res.status(500).json({ error: "Failed to save cookie." });
    }
});

// Vxl API: Delete CDK Keys (supports status, plan and pool query filters)
app.delete('/api/vxl/cdks', (req, res) => {
    const status = req.query.status || req.body?.status;
    const plan = req.query.plan;
    const pool = req.query.pool;
    
    let query = "DELETE FROM cdks";
    let conditions = [];
    let params = [];
    
    if (status === 'expired' || status === 'used') {
        conditions.push("(status = 'expired' OR status = 'active')");
    } else if (status === 'unused') {
        conditions.push("status = 'unused'");
    }
    
    if (plan) {
        conditions.push("plan_type = ?");
        params.push(plan);
    }
    
    if (pool) {
        if (pool === 'warranty') {
            conditions.push("(warranty_type IS NOT NULL AND warranty_type != 'no_warranty')");
        } else {
            conditions.push("warranty_type = ?");
            params.push(pool);
        }
    }
    
    if (conditions.length > 0) {
        query += " WHERE " + conditions.join(" AND ");
    }
    
    db.run(query, params, function(err) {
        if (err) return res.status(500).json({ error: "Database error." });
        return res.json({ success: true, count: this.changes });
    });
});

// Vxl API: Check Expiration of All CDK Keys (Bulk Check)
app.post('/api/vxl/check-cdks', (req, res) => {
    db.all("SELECT * FROM cdks", [], async (err, rows) => {
        if (err) return res.status(500).json({ error: "Database error during bulk check." });
        let checked = 0;
        for (const row of rows) {
            await checkSingleCDKExpiry(row);
            checked++;
        }
        return res.json({ success: true, checked });
    });
});

// Vxl API: Delete CDK Key
const handleDeleteCDK = (req, res) => {
    const key = req.params.key;
    db.run("DELETE FROM cdks WHERE UPPER(key) = ?", [key.trim().toUpperCase()], function(err) {
        if (err) return res.status(500).json({ error: "Database error." });
        return res.json({ success: true });
    });
};
app.delete('/api/vxl/cdks/:key', handleDeleteCDK);
app.delete('/api/proxy/cdks/:key', handleDeleteCDK);

// Change current vxl username / password
app.post('/api/vxl/change-credentials', (req, res) => {
    const { currentUsername, currentPassword, newUsername, newPassword } = req.body;
    if (!currentUsername || !currentPassword || !newPassword) {
        return res.status(400).json({ error: 'Please fill in all required fields' });
    }

    const oldHash = crypto.createHash('sha256').update(currentPassword).digest('hex');
    db.get("SELECT * FROM vxl_users WHERE username = ? AND password_hash = ?", [currentUsername.trim(), oldHash], (err, user) => {
        if (err || !user) return res.status(401).json({ error: 'Current password incorrect' });

        const newHash = crypto.createHash('sha256').update(newPassword).digest('hex');
        
        // Only owner or vxl roles are allowed to change their username
        let targetUsername = currentUsername;
        if ((user.role === 'owner' || user.role === 'vxl') && newUsername) {
            targetUsername = newUsername.trim();
        }

        db.run("UPDATE vxl_users SET username = ?, password_hash = ? WHERE id = ?", [targetUsername, newHash, user.id], (err2) => {
            if (err2) return res.status(400).json({ error: 'Username already exists' });
            return res.json({ success: true, message: 'Account details updated successfully', newUsername: targetUsername });
        });
    });
});

// List all vxl users
app.get('/api/vxl/users', requireVxlOrOwner, (req, res) => {
    db.all("SELECT id, username, role, created_at, last_login FROM vxl_users ORDER BY id ASC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Database error.' });
        return res.json({ success: true, users: rows || [] });
    });
});

// Add new vxl user (with role: vxl / partner / supervisor / owner)
app.post('/api/vxl/users', requireVxlOrOwner, (req, res) => {
    const { username, password, role } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Please input username and password' });

    let validRole = ['vxl', 'partner', 'supervisor'].includes(role) ? role : 'supervisor';
    if (role === 'owner' && req.user.role === 'owner') {
        validRole = 'owner';
    }
    const hash = crypto.createHash('sha256').update(password).digest('hex');
    const now = new Date().toISOString();

    db.run("INSERT INTO vxl_users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)", [username.trim(), hash, validRole, now], (err) => {
        if (err) return res.status(400).json({ error: 'Username already exists' });
        return res.json({ success: true, message: 'User added successfully' });
    });
});

// Delete vxl user
app.delete('/api/vxl/users/:id', requireVxlOrOwner, (req, res) => {
    const id = req.params.id;
    
    // Prevent non-owners from deleting owners
    db.get("SELECT role FROM vxl_users WHERE id = ?", [id], (err, targetUser) => {
        if (targetUser && targetUser.role === 'owner' && req.user.role !== 'owner') {
            return res.status(403).json({ error: 'Forbidden: Only owners can delete other owner accounts' });
        }
        
        db.get("SELECT COUNT(*) as cnt FROM vxl_users", [], (err, row) => {
            if (row && row.cnt <= 1) return res.status(400).json({ error: 'Cannot delete the only account in the system' });
            db.run("DELETE FROM vxl_users WHERE id = ?", [id], (err2) => {
                if (err2) return res.status(500).json({ error: 'Deletion failed' });
                return res.json({ success: true });
            });
        });
    });
});

// Vxl Proxy Config Settings APIs
app.get('/api/vxl/proxy', (req, res) => {
    db.all("SELECT key, value FROM settings WHERE key IN ('proxy_url', 'proxy_enabled')", [], (err, rows) => {
        if (err) return res.status(500).json({ error: "Database error" });
        const settings = {};
        rows.forEach(r => settings[r.key] = r.value);
        return res.json({
            success: true,
            proxyUrl: settings['proxy_url'] || '',
            proxyEnabled: settings['proxy_enabled'] === '1'
        });
    });
});

app.post('/api/vxl/proxy', (req, res) => {
    const { proxyUrl, proxyEnabled } = req.body;
    const enabledVal = proxyEnabled ? '1' : '0';
    
    db.serialize(() => {
        db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('proxy_url', ?)", [proxyUrl || '']);
        db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('proxy_enabled', ?)", [enabledVal], (err) => {
            if (err) return res.status(500).json({ error: "Failed to save settings." });
            
            // Sync in-memory proxy settings
            proxy.setProxyUrl(proxyUrl || null);
            proxy.setProxyEnabled(proxyEnabled);
            
            return res.json({ success: true });
        });
    });
});

// Test proxy connectivity and return current public IP seen by the server
app.post('/api/vxl/test-proxy', async (req, res) => {
    const { proxyUrl, proxyEnabled } = req.body;
    try {
        // Temporarily apply test settings to proxy module
        const savedEnabled = proxy.isEnabled ? proxy.isEnabled() : false;
        const savedUrl = proxy.getUrl ? proxy.getUrl() : '';
        if (proxyEnabled && proxyUrl) {
            proxy.setProxyUrl(proxyUrl);
            proxy.setProxyEnabled(true);
        } else {
            proxy.setProxyEnabled(false);
        }
        const ipData = await proxy.httpGet('https://api.ipify.org?format=json');
        // Restore original proxy state
        proxy.setProxyUrl(savedUrl || null);
        proxy.setProxyEnabled(savedEnabled);
        const parsed = JSON.parse(ipData);
        return res.json({ success: true, ip: parsed.ip });
    } catch (err) {
        return res.json({ success: false, error: err.message });
    }
});

// Vxl stats calculation endpoint (direct backend integration)
app.get('/api/vxl/stats', (req, res) => {
    const cookies = cookieStore.getAllCookies();
    db.all("SELECT * FROM cdks ORDER BY created_at DESC", [], (err, cdks) => {
        if (err) cdks = [];
        
        const totalCookies   = cookies.length;
        const activeCookies  = cookies.filter(c => c.status === 'Active').length;
        const expiredCookies = totalCookies - activeCookies;
        const availableSeats = cookies
            .filter(c => c.status === 'Active')
            .reduce((sum, c) => sum + Math.max(0, (c.max_users || 5) - (c.active_users || 0)), 0);

        const totalCdks   = cdks.length;
        const unusedCdks  = cdks.filter(c => c.status === 'unused').length;
        const activeCdks  = cdks.filter(c => c.status === 'active').length;
        const expiredCdks = cdks.filter(c => c.status === 'expired').length;

        const pools = {};
        cookies.forEach(c => {
            const p = c.warranty_type || 'no_warranty';
            if (!pools[p]) pools[p] = { active: 0, expired: 0 };
            if (c.status === 'Active') pools[p].active++;
            else pools[p].expired++;
        });

        return res.json({
            success: true,
            stats: {
                totalCookies, activeCookies, expiredCookies, availableSeats,
                totalCdks, unusedCdks, activeCdks, expiredCdks, pools
            }
        });
    });
});

// 3. Burn CDK after phone/PC link copy (one-time use)
app.post('/api/burn-cdk', (req, res) => {
    const { key } = req.body;
    if (!key) return res.status(400).json({ error: 'Key required.' });
    db.get("SELECT * FROM cdks WHERE UPPER(key) = ?", [key.trim().toUpperCase()], (err, cdk) => {
        if (err)  return res.status(500).json({ error: 'Database error.' });
        if (!cdk) return res.status(404).json({ error: 'Key not found.' });
        db.run("UPDATE cdks SET status = 'expired' WHERE UPPER(key) = ?", [key.trim().toUpperCase()], function(e) {
            if (e) return res.status(500).json({ error: 'Could not burn key.' });
            return res.json({ success: true, burned: true });
        });
    });
});

// Custom 404 Page Handler for Unknown Routes
app.use((req, res) => {
    res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// Start Express Server after AES key is ready
initAesKey().then(() => {
    app.listen(PORT, () => {
        console.log(`=======================================================`);
        console.log(`Netflix CDK Server running on port ${PORT}`);
        console.log(`Redemption Page: http://localhost:${PORT}/`);
        console.log(`=======================================================`);

        // Auto-start Telegram Bot in the same process
        try {
            require('./bot.js');
        } catch (e) {
            console.error("Failed to start Telegram Bot:", e.message);
        }
    });
});

module.exports = { db };
