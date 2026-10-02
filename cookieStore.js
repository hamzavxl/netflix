/**
 * cookieStore.js — Folder-based Cookie Database for NETVXL
 * Stores cookies as JSON files: cookies/<pool_type>/<email>.json
 */

const fs   = require('fs');
const path = require('path');

const COOKIES_DIR = path.join(__dirname, 'cookies');
const POOLS = ['no_warranty', '7_days', '1_month', '2_months', '3_months', '6_months', '1_year'];

// Initialize directory structure
function init() {
    if (!fs.existsSync(COOKIES_DIR)) {
        fs.mkdirSync(COOKIES_DIR);
    }
    POOLS.forEach(pool => {
        const p = path.join(COOKIES_DIR, pool);
        if (!fs.existsSync(p)) {
            fs.mkdirSync(p);
        }
    });
}

// Helper to find file path by email
function findFilePath(email) {
    if (!email) return null;
    const safeEmail = email.toLowerCase().replace(/[^a-z0-9@._-]/g, '_');
    for (const pool of POOLS) {
        const file = path.join(COOKIES_DIR, pool, `${safeEmail}.json`);
        if (fs.existsSync(file)) {
            return { file, pool };
        }
    }
    return null;
}

// Get all cookies across all pools
function getAllCookies() {
    const list = [];
    POOLS.forEach(pool => {
        const dir = path.join(COOKIES_DIR, pool);
        if (!fs.existsSync(dir)) return;
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
        files.forEach(f => {
            try {
                const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
                // inject pool & email from filename if missing
                data.warranty_type = pool;
                if (!data.email) data.email = f.replace('.json', '');
                list.push(data);
            } catch (_) {}
        });
    });
    return list;
}

// Get single cookie by email
function getCookie(email) {
    const found = findFilePath(email);
    if (!found) return null;
    try {
        const data = JSON.parse(fs.readFileSync(found.file, 'utf8'));
        data.warranty_type = found.pool;
        return data;
    } catch (_) {
        return null;
    }
}

// Save or Update cookie
function saveCookie(email, data) {
    if (!email) return false;
    const safeEmail = email.toLowerCase().replace(/[^a-z0-9@._-]/g, '_');
    const pool = data.warranty_type || '1_month';
    
    // Ensure pools are valid
    if (!POOLS.includes(pool)) return false;

    // Check if cookie exists in another pool and delete it there first (to move it)
    const existing = findFilePath(email);
    if (existing && existing.pool !== pool) {
        try { fs.unlinkSync(existing.file); } catch(_) {}
    }

    const file = path.join(COOKIES_DIR, pool, `${safeEmail}.json`);
    const payload = {
        email:             email.toLowerCase(),
        plan:              data.plan || 'Premium',
        country:           data.country || 'Unknown',
        next_billing_date: data.next_billing_date || 'Unknown',
        cookie_text:       data.cookie_text || '',
        max_users:         parseInt(data.max_users) ?? 5,
        active_users:      parseInt(data.active_users) || 0,
        status:            data.status || 'Active',
        last_checked:      data.last_checked || new Date().toISOString()
    };

    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
    return true;
}

// Delete cookie file
function deleteCookie(email) {
    const found = findFilePath(email);
    if (!found) return false;
    try {
        fs.unlinkSync(found.file);
        return true;
    } catch (_) {
        return false;
    }
}

// Delete all cookies across all pools
function deleteAllCookies() {
    const list = getAllCookies();
    let count = 0;
    list.forEach(c => {
        if (deleteCookie(c.email)) count++;
    });
    return count;
}

// Update max users limit on all cookies
function updateMaxUsersAll(max) {
    const cookies = getAllCookies();
    cookies.forEach(c => {
        c.max_users = max;
        saveCookie(c.email, c);
    });
}

// Allocate a working cookie matching Plan & Pool
async function isCookieEligible(cookie, planType) {
    const db = require('./db');
    if (cookie.status !== 'Active') return false;
    if ((cookie.active_users || 0) >= (cookie.max_users || 5)) return false;
    
    const isTVReq = planType && planType.toUpperCase() === 'TV';
    if (isTVReq) {
        const planLower = (cookie.plan || '').toLowerCase();
        const isPremiumOrStandard = planLower.includes('premium') || planLower.includes('standard') || 
                                    planLower.includes('مميز') || planLower.includes('قياسي') ||
                                    planLower.includes('özel') || planLower.includes('standart');
        if (!isPremiumOrStandard) return false;
        
        try {
            const tvCountRow = await db.get(
                "SELECT COUNT(*) as count FROM cdks WHERE (cookie_email = ? OR bound_cookie_email = ?) AND (used_device = 'Smart TV' OR plan_type = 'TV') AND (status = 'active' OR status = 'expired')",
                [cookie.email, cookie.email]
            );
            const tvCount = tvCountRow ? tvCountRow.count : 0;
            if (tvCount >= 2) return false;
        } catch (err) {
            console.error("[CookieStore] Error counting TV slots:", err.message);
            return false;
        }
    } else {
        if (planType && cookie.plan && !cookie.plan.toLowerCase().includes(planType.toLowerCase()) &&
            !(planType.toLowerCase() === 'premium' && cookie.plan.toLowerCase().includes('مميز'))) {
            return false;
        }
    }
    return true;
}

async function findAndValidateCookie(planType, warrantyType, validateFn) {
    const db = require('./db');
    const pool = warrantyType || '1_month';
    
    let all = getAllCookies().filter(c => c.warranty_type === pool);
    if (all.length === 0) {
        all = getAllCookies();
    }
    const eligible = [];
    for (const c of all) {
        if (await isCookieEligible(c, planType)) {
            eligible.push(c);
        }
    }

    // Shuffle candidates to distribute load randomly among accounts with the same usage count
    for (let i = eligible.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [eligible[i], eligible[j]] = [eligible[j], eligible[i]];
    }
    // Sort by active_users ascending to load-balance
    eligible.sort((a, b) => (a.active_users || 0) - (b.active_users || 0));

    for (const cookie of eligible) {
        if (validateFn) {
            try {
                const tokenInfo = await validateFn(cookie.cookie_text);
                if (tokenInfo && tokenInfo.updatedCookieText) {
                    cookie.cookie_text = tokenInfo.updatedCookieText;
                }
                return { cookie, tokenInfo };
            } catch (err) {
                // Mark as expired
                console.warn(`[CookieStore] Account ${cookie.email} failed validation: ${err.message}. Marking Expired.`);
                cookie.status = 'Expired';
                saveCookie(cookie.email, cookie);
                db.handleCookieExpiration(cookie.email).catch(() => {});
            }
        } else {
            return { cookie };
        }
    }

    // Fallback: Any active eligible cookie anywhere
    const allCookies = getAllCookies();
    const finalFb = [];
    for (const c of allCookies) {
        if (await isCookieEligible(c, planType)) {
            finalFb.push(c);
        }
    }
    for (let i = finalFb.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [finalFb[i], finalFb[j]] = [finalFb[j], finalFb[i]];
    }
    finalFb.sort((a, b) => (a.active_users || 0) - (b.active_users || 0));
    for (const cookie of finalFb) {
        if (validateFn) {
            try {
                const tokenInfo = await validateFn(cookie.cookie_text);
                if (tokenInfo && tokenInfo.updatedCookieText) {
                    cookie.cookie_text = tokenInfo.updatedCookieText;
                }
                return { cookie, tokenInfo };
            } catch (_) {}
        } else {
            return { cookie };
        }
    }

    return null;
}

// Adjust active users count
function adjustActiveUsers(email, offset) {
    const cookie = getCookie(email);
    if (!cookie) return false;
    cookie.active_users = Math.max(0, (cookie.active_users || 0) + offset);
    saveCookie(email, cookie);
    return true;
}

// Reset active users slots to 0 on all cookies
function resetActiveUsersAll() {
    const cookies = getAllCookies();
    cookies.forEach(c => {
        c.active_users = 0;
        saveCookie(c.email, c);
    });
}

module.exports = {
    init,
    getAllCookies,
    getCookie,
    saveCookie,
    deleteCookie,
    deleteAllCookies,
    updateMaxUsersAll,
    findAndValidateCookie,
    adjustActiveUsers,
    isCookieEligible,
    resetActiveUsersAll,
    POOLS
};
