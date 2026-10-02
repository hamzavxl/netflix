const sqlite3 = require('sqlite3').verbose();
const path = require('path');

let sqliteDb = null;

// Initialize connection (SQLite only)
function init() {
    console.log("[DB] Connecting to local SQLite database...");
    const dbPath = path.join(__dirname, 'database.sqlite');
    sqliteDb = new sqlite3.Database(dbPath, (err) => {
        if (err) {
            console.error('[DB] SQLite connection error:', err.message);
        } else {
            console.log('[DB]  SQLite connection successful!');
        }
    });
}

// Database helper operations supporting both Promise and Callback style
function get(sql, params = [], callback) {
    if (typeof params === 'function') {
        callback = params;
        params = [];
    }
    const p = new Promise((resolve, reject) => {
        sqliteDb.get(sql, params, (err, row) => {
            if (err) return reject(err);
            resolve(row || null);
        });
    });

    if (callback) {
        p.then(row => callback(null, row)).catch(err => callback(err));
        return;
    }
    return p;
}

function all(sql, params = [], callback) {
    if (typeof params === 'function') {
        callback = params;
        params = [];
    }
    const p = new Promise((resolve, reject) => {
        sqliteDb.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows || []);
        });
    });

    if (callback) {
        p.then(rows => callback(null, rows)).catch(err => callback(err));
        return;
    }
    return p;
}

function run(sql, params = [], callback) {
    if (typeof params === 'function') {
        callback = params;
        params = [];
    }
    const p = new Promise((resolve, reject) => {
        sqliteDb.run(sql, params, function(err) {
            if (err) return reject(err);
            resolve({ changes: this.changes, lastID: this.lastID });
        });
    });

    if (callback) {
        p.then(res => callback(null, res)).catch(err => callback(err));
        return;
    }
    return p;
}

// Serialize wrapper for SQLite
function serialize(callback) {
    sqliteDb.serialize(callback);
}

function prepare(sql, callback) {
    return sqliteDb.prepare(sql, callback);
}

// Create tables schemas
async function createTables() {
    sqliteDb.serialize(() => {
        sqliteDb.run(`CREATE TABLE IF NOT EXISTS cdks (
            key TEXT PRIMARY KEY, 
            status TEXT DEFAULT 'unused',
            cookie_email TEXT, 
            bound_cookie_email TEXT,
            plan_type TEXT DEFAULT 'Premium', 
            warranty_type TEXT DEFAULT '1_month',
            duration_days INTEGER DEFAULT 30, 
            max_users INTEGER DEFAULT 1,
            active_users INTEGER DEFAULT 0, 
            created_at TEXT, 
            used_device TEXT,
            created_by TEXT -- stores chat_id of creator
        )`);
        
        sqliteDb.run(`CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY, 
            value TEXT
        )`);
        
        sqliteDb.run(`CREATE TABLE IF NOT EXISTS activations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cdk_key TEXT, 
            ip TEXT, 
            user_agent TEXT, 
            activated_at TEXT
        )`);
        
        sqliteDb.run(`CREATE TABLE IF NOT EXISTS redirects (
            code TEXT PRIMARY KEY, 
            token TEXT, 
            cookie_email TEXT,
            created_at TEXT
        )`);
        sqliteDb.run("ALTER TABLE redirects ADD COLUMN cookie_email TEXT", () => {});
         sqliteDb.run("ALTER TABLE redirects ADD COLUMN locked_ip TEXT", () => {});
         sqliteDb.run("ALTER TABLE redirects ADD COLUMN expires_at TEXT", () => {});

        sqliteDb.run(`CREATE TABLE IF NOT EXISTS bot_users (
            chat_id TEXT PRIMARY KEY,
            username TEXT,
            role TEXT, -- 'partner' or 'creator'
            added_by TEXT,
            created_at TEXT
        )`);

        sqliteDb.run(`CREATE TABLE IF NOT EXISTS vxl_users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            password_hash TEXT,
            role TEXT DEFAULT 'vxl', -- 'vxl' (المدير الرئيسي), 'partner' (شريك), 'supervisor' (مشرف)
            created_at TEXT,
            last_login TEXT
        )`);

         // Migration to add created_by to cdks if it doesn't exist
         sqliteDb.run("ALTER TABLE cdks ADD COLUMN created_by TEXT", () => {});
         sqliteDb.run("ALTER TABLE cdks ADD COLUMN cookie_email TEXT", () => {});
         sqliteDb.run("ALTER TABLE cdks ADD COLUMN bound_cookie_email TEXT", () => {});

         // Customer referral migrations for bot_users
         sqliteDb.run("ALTER TABLE bot_users ADD COLUMN lang TEXT DEFAULT 'en'", () => {});
         sqliteDb.run("ALTER TABLE bot_users ADD COLUMN points REAL DEFAULT 0.0", () => {});
         sqliteDb.run("ALTER TABLE bot_users ADD COLUMN referrals_count INTEGER DEFAULT 0", () => {});
         sqliteDb.run("ALTER TABLE bot_users ADD COLUMN referred_by TEXT", () => {});
         sqliteDb.run("ALTER TABLE bot_users ADD COLUMN is_member INTEGER DEFAULT 0", () => {});
         sqliteDb.run("ALTER TABLE bot_users ADD COLUMN signup_point_given INTEGER DEFAULT 0", () => {});
         sqliteDb.run("ALTER TABLE bot_users ADD COLUMN join_count INTEGER DEFAULT 0", () => {});
         sqliteDb.run("ALTER TABLE bot_users ADD COLUMN leave_count INTEGER DEFAULT 0", () => {});
         sqliteDb.run("ALTER TABLE activations ADD COLUMN device_class TEXT", () => {});

         sqliteDb.run(`INSERT OR IGNORE INTO settings (key,value) VALUES ('max_users','5')`);
         sqliteDb.run(`INSERT OR IGNORE INTO settings (key,value) VALUES ('auto_check_hours','6')`);
         sqliteDb.run(`INSERT OR IGNORE INTO settings (key,value) VALUES ('lang','en')`);
         sqliteDb.run(`INSERT OR IGNORE INTO settings (key,value) VALUES ('proxy_url','')`);
         sqliteDb.run(`INSERT OR IGNORE INTO settings (key,value) VALUES ('proxy_enabled','0')`);
         sqliteDb.run(`INSERT OR IGNORE INTO settings (key,value) VALUES ('proxy_max_retries','3')`);
         sqliteDb.run("INSERT OR IGNORE INTO settings (key,value) VALUES ('telegram_channel_id', ?)", [process.env.TELEGRAM_CHANNEL_ID || '@VXL_STORE_V1']);
         sqliteDb.run("INSERT OR IGNORE INTO settings (key,value) VALUES ('customer_bot_token', ?)", [process.env.CUSTOMER_BOT_TOKEN || '']);
     });
 }

// Helper to handle cookie expiration or deletion
async function handleCookieExpiration(cookieEmail) {
    if (!cookieEmail) return;
    console.log(`[DB Helper] Processing cookie expiration/inactivation for: ${cookieEmail}`);
    
    const cookieStore = require('./cookieStore');
    
    // 1. Mark cookie as Expired in store if it exists and is currently Active
    const cookie = cookieStore.getCookie(cookieEmail);
    if (cookie && cookie.status !== 'Expired') {
        cookie.status = 'Expired';
        cookie.last_checked = new Date().toISOString();
        cookieStore.saveCookie(cookieEmail, cookie);
    }
    
    try {
        // 2. Fetch all CDKs linked to this cookie (both active and unused)
        const cdks = await module.exports.all(
            "SELECT * FROM cdks WHERE cookie_email = ? OR bound_cookie_email = ?",
            [cookieEmail, cookieEmail]
        );
        
        for (const cdk of cdks) {
            // Case A: CDK is BOUND to this specific cookie
            if (cdk.bound_cookie_email === cookieEmail) {
                // Only unused bound keys are marked as expired. Used keys are kept intact.
                if (cdk.status === 'unused') {
                    console.log(`[DB Helper] Expiring unused bound CDK ${cdk.key} because bound cookie ${cookieEmail} is dead.`);
                    await module.exports.run("UPDATE cdks SET status = 'expired' WHERE key = ?", [cdk.key]);
                } else {
                    console.log(`[DB Helper] Bound CDK ${cdk.key} is already used/active; leaving status intact.`);
                }
            }
            // Case B: CDK is standard/random (bound_cookie_email is null/empty) and active with this cookie
            else if (!cdk.bound_cookie_email && cdk.status === 'active' && cdk.cookie_email === cookieEmail) {
                console.log(`[DB Helper] Standard active CDK ${cdk.key} needs migration from dead cookie ${cookieEmail}.`);
                
                // Find a new working cookie in the same warranty pool
                const pool = cdk.warranty_type || '1_month';
                const cookies = cookieStore.getAllCookies();
                
                const candidates = [];
                for (const c of cookies) {
                    if (c.warranty_type === pool && await cookieStore.isCookieEligible(c, cdk.plan_type)) {
                        candidates.push(c);
                    }
                }
                
                let selectedCookie = null;
                if (candidates.length > 0) {
                    candidates.sort((a, b) => (a.active_users || 0) - (b.active_users || 0));
                    selectedCookie = candidates[0];
                } else {
                    // Fallback to any active eligible cookie anywhere
                    const fallbackAll = [];
                    for (const c of cookies) {
                        if (await cookieStore.isCookieEligible(c, cdk.plan_type)) {
                            fallbackAll.push(c);
                        }
                    }
                    if (fallbackAll.length > 0) {
                        fallbackAll.sort((a, b) => (a.active_users || 0) - (b.active_users || 0));
                        selectedCookie = fallbackAll[0];
                    }
                }
                
                if (selectedCookie) {
                    console.log(`[DB Helper] Migrating CDK ${cdk.key} to new cookie: ${selectedCookie.email}`);
                    await module.exports.run("UPDATE cdks SET cookie_email = ? WHERE key = ?", [selectedCookie.email, cdk.key]);
                    cookieStore.adjustActiveUsers(cookieEmail, -1);
                    cookieStore.adjustActiveUsers(selectedCookie.email, 1);
                } else {
                    // No active cookie found at all! Keep CDK active but clear cookie_email so it can be reallocated next time
                    console.log(`[DB Helper] No active cookies found for migration. Clearing cookie_email for active CDK ${cdk.key}.`);
                    await module.exports.run("UPDATE cdks SET cookie_email = NULL WHERE key = ?", [cdk.key]);
                    cookieStore.adjustActiveUsers(cookieEmail, -1);
                }
            }
        }
    } catch (dbErr) {
        console.error(`[DB Helper] Error in handleCookieExpiration:`, dbErr.message);
    }
}

module.exports = {
    init,
    get,
    all,
    run,
    serialize,
    prepare,
    createTables,
    handleCookieExpiration,
    isPostgres: () => false
};
