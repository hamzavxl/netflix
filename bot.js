require('dotenv').config();
const TelegramBot    = require('node-telegram-bot-api');
const path           = require('path');
const https          = require('https');
const crypto         = require('crypto');
const { LANG_NAMES, t } = require('./lang');
const proxy          = require('./proxy');
const cookieStore    = require('./cookieStore');
const { ce, esc, buildMainConsole, buildCdkMenu, buildCookiesMenu, buildManageCookie } = require('./customEmoji');

const TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_CHAT_ID;
if (!TOKEN || !ADMIN_ID) { console.error('Missing env vars: TELEGRAM_BOT_TOKEN, ADMIN_CHAT_ID'); process.exit(1); }

// ── Database ──────────────────────────────────────────────────
const db = require('./db');
db.init();
db.createTables().catch(err => console.error("[DB] Table creation failed:", err.message));

// ── Dual Bot Initialization ────────────────────────────────────
const adminBot = new TelegramBot(TOKEN, {
    polling: { params: { timeout: 30, allowed_updates: ['message','callback_query'] } }
});
adminBot.getUpdates({ offset: -1 })
   .then(u => { if (u.length) adminBot.getUpdates({ offset: u[u.length-1].update_id+1 }); })
   .catch(() => {});
console.log('Admin Bot started. Console wizard ready.');

const bot = adminBot; // Alias to keep existing admin bot code fully compatible

let customerBot = null;
let customerBotUsername = '';

async function initCustomerBot() {
    const custToken = await getSetting('customer_bot_token', process.env.CUSTOMER_BOT_TOKEN || '');
    if (!custToken) {
        console.log('[CUSTOMER BOT] Token is missing from database. Skipping initialization.');
        return;
    }
    try {
        customerBot = new TelegramBot(custToken, {
            polling: { params: { timeout: 30, allowed_updates: ['message','callback_query','chat_member','my_chat_member'] } }
        });
        customerBot.getUpdates({ offset: -1 })
           .then(u => { if (u.length) customerBot.getUpdates({ offset: u[u.length-1].update_id+1 }); })
           .catch(() => {});
           
        const me = await customerBot.getMe();
        customerBotUsername = me.username;
        console.log(`[CUSTOMER BOT] Started successfully as @${customerBotUsername}`);
        setupCustomerBotHandlers();
    } catch (err) {
        console.error('[CUSTOMER BOT] Start failed:', err.message);
    }
}


// ── Proxy init ───────────────────────────────────────────────
async function initProxy() {
    await initCustomerBot();
    const proxyUrl     = await getSetting('proxy_url', '');
    const proxyEnabled = (await getSetting('proxy_enabled', '0')) === '1';
    const maxRetries   = parseInt(await getSetting('proxy_max_retries', '3')) || 3;
    proxy.init({
        proxyUrl:    proxyUrl || null,
        proxyEnabled,
        maxRetries,
        notifyFn: async (msg) => {
            // Update DB — proxy disabled
            await dbRun("INSERT OR REPLACE INTO settings (key,value) VALUES ('proxy_enabled','0')");
            // Notify admin
            try { await bot.sendMessage(ADMIN_ID, msg, { parse_mode: 'Markdown' }); } catch(_) {}
        }
    });
    console.log(`[PROXY] ${proxyEnabled && proxyUrl ? `Enabled — ${proxyUrl}` : 'Disabled (local IP)'}`);
}

// ── Helpers ───────────────────────────────────────────────────
const seenMsgIds = new Set();
const sessions   = {};
function isAdmin(id) { return String(id) === String(ADMIN_ID); }

async function getUserRole(chatId) {
    if (String(chatId) === String(ADMIN_ID)) return 'owner';
    try {
        const user = await dbGet("SELECT role FROM bot_users WHERE chat_id = ?", [String(chatId)]);
        return user ? user.role : null;
    } catch (_) {
        return null;
    }
}

function getSetting(key, fallback) {
    return db.get('SELECT value FROM settings WHERE key=?',[key]).then(r => r ? r.value : fallback);
}
function dbAll(sql, p=[]) { return db.all(sql, p); }
function dbRun(sql, p=[]) { return db.run(sql, p); }
function dbGet(sql, p=[]) { return db.get(sql, p); }

// Get admin's current language
async function getLang() { return (await getSetting('lang','en')) || 'en'; }

// ── Pool & Plan Config ────────────────────────────────────────
const POOL_KEYS = ['no_warranty','7_days','1_month','2_months','3_months','6_months','1_year'];
const POOL_DAYS = { no_warranty:0, '7_days':7, '1_month':30, '2_months':60, '3_months':90, '6_months':180, '1_year':365 };
const PLAN_KEYS = ['Premium','Standard','Basic','TV'];

function poolLabel(k, lang) { return t(lang,'pool_label')[k] || k; }
function planLabel(k, lang) { return t(lang,'plan_label')[k] || k; }
function poolDays(k)  { return POOL_DAYS[k] ?? 30; }

function isExpiringSoon(billingDateStr) {
    if (!billingDateStr) return false;
    const parsed = Date.parse(billingDateStr);
    if (!isNaN(parsed)) {
        const diffMs = parsed - Date.now();
        const diffDays = diffMs / (1000 * 60 * 60 * 24);
        return diffDays >= 0 && diffDays <= 3;
    }
    const m = billingDateStr.match(/(\d{1,2})[\/\-](\d{1,2})/);
    if (m) {
        const now = new Date();
        const day1 = parseInt(m[1]);
        const day2 = parseInt(m[2]);
        const currentDay = now.getDate();
        const diff1 = day1 - currentDay;
        const diff2 = day2 - currentDay;
        if ((diff1 >= 0 && diff1 <= 3) || (diff2 >= 0 && diff2 <= 3)) {
            return true;
        }
    }
    return false;
}

const MONTH_MAP = {
    // English
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
    // French / Localized Arabic
    janv: 0, févr: 1, mars: 2, avri: 3, mai: 4, juin: 5, juil: 6, août: 7, out: 7, sept: 8, octo: 9, nove: 10, déce: 11,
    أوت: 7, اغسطس: 7, أغسطس: 7, جويلية: 6, جوان: 5, ماي: 4, فيفري: 1, جانفي: 0, ديسمبر: 11, نوفمبر: 10, أكتوبر: 9, سبتمبر: 8,
    // Vietnamese
    'tháng 1': 0, 'tháng 2': 1, 'tháng 3': 2, 'tháng 4': 3, 'tháng 5': 4, 'tháng 6': 5, 'tháng 7': 6, 'tháng 8': 7, 'tháng 9': 8, 'tháng 10': 9, 'tháng 11': 10, 'tháng 12': 11,
    // Turkish
    oca: 0, şub: 1, mar: 2, nīs: 3, may: 4, haz: 5, tem: 6, ağu: 7, eyl: 8, ekī: 9, kas: 10, ara: 11
};

function parseLocalizedDate(str) {
    if (!str) return null;
    const clean = str.toLowerCase().replace(/\s+/g, ' ');
    const std = Date.parse(clean);
    if (!isNaN(std)) return new Date(std);

    const yearMatch = clean.match(/\b(20\d{2})\b/);
    if (!yearMatch) return null;
    const year = parseInt(yearMatch[1]);

    const numbers = clean.match(/\b(\d{1,2})\b/g) || [];
    const dayVal = numbers.map(Number).find(n => n > 0 && n <= 31);
    if (dayVal === undefined) return null;

    let monthIdx = -1;
    for (const [key, idx] of Object.entries(MONTH_MAP)) {
        if (clean.includes(key)) {
            monthIdx = idx;
            break;
        }
    }

    if (monthIdx === -1) {
        const monthVal = numbers.map(Number).find(n => n > 0 && n <= 12 && n !== dayVal);
        if (monthVal !== undefined) {
            monthIdx = monthVal - 1;
        }
    }

    if (monthIdx === -1) return null;
    return new Date(year, monthIdx, dayVal);
}

function getRemainingDays(billingDateStr) {
    if (!billingDateStr || billingDateStr.toLowerCase() === 'unknown') {
        return null;
    }
    const d = parseLocalizedDate(billingDateStr);
    if (d && !isNaN(d.getTime())) {
        const diffMs = d.getTime() - Date.now();
        return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    }
    return null;
}

function getRemainingDaysLabel(billingDateStr, lang) {
    const days = getRemainingDays(billingDateStr);
    if (days === null) {
        return lang === 'ar' ? ' (شريك/غير معروف)' : ' (Partner/Unknown)';
    }
    if (days < 0) {
        return lang === 'ar' ? ' (منتهي)' : ' (Expired)';
    }
    return lang === 'ar' ? ` (${days} يوم متبقي)` : ` (${days}d remaining)`;
}

function getBillingStatusText(billingStr, lang) {
    if (!billingStr || billingStr.toLowerCase() === 'unknown') {
        return lang === 'ar' ? 'شريك دفع / غير محدد' : 'Partner payment / Unknown';
    }
    const d = parseLocalizedDate(billingStr);
    if (d && !isNaN(d.getTime())) {
        const diffMs = d.getTime() - Date.now();
        const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
        if (diffDays < 0) {
            return lang === 'ar' ? `${billingStr} (منتهي)` : `${billingStr} (Expired)`;
        }
        return t(lang, 'cook_manage_billing_days', { date: billingStr, days: diffDays });
    }
    return t(lang, 'cook_manage_billing_unknown', { date: billingStr });
}

// ── Keyboards ─────────────────────────────────────────────────
function mainKb(lang, role = 'owner') {
    const buttons = [];
    if (role === 'creator') {
        buttons.push([{ text: t(lang,'btn_cdk'), callback_data:'nav:cdk' }]);
        buttons.push([{ text: t(lang,'btn_set_lang'), callback_data:'set:lang' }]);
        return { inline_keyboard: buttons };
    }
    buttons.push([{ text: t(lang,'btn_cdk'), callback_data:'nav:cdk' }]);
    buttons.push([{ text: t(lang,'btn_cookies'), callback_data:'nav:cookies' }]);
    buttons.push([{ text: t(lang,'btn_settings'), callback_data:'nav:settings' }]);
    return { inline_keyboard: buttons };
}

function usersMenuKb(lang) {
    return { inline_keyboard: [
        [{ text: t(lang,'btn_users_add_partner'), callback_data:'users:add:partner' }],
        [{ text: t(lang,'btn_users_add_creator'), callback_data:'users:add:creator' }],
        [{ text: t(lang,'btn_users_list'),        callback_data:'users:list'        }],
        [{ text: t(lang,'btn_users_delete'),      callback_data:'users:delete'      }],
        [{ text: t(lang,'btn_back'),              callback_data:'nav:home'          }],
    ]};
}

function backUsersKb(lang) {
    return { inline_keyboard: [[{ text: t(lang,'btn_back_users'), callback_data:'nav:users' }]] };
}

function cdkMenuKb(lang) {
    return { inline_keyboard: [
        [{ text: t(lang,'btn_cdk_create'),     callback_data:'cdk:create'     }],
        [{ text: t(lang,'btn_cdk_check'),       callback_data:'cdk:check'      }],
        [{ text: t(lang,'btn_cdk_list'),        callback_data:'cdk:list'       }],
        [{ text: t(lang,'btn_cdk_delete'),      callback_data:'cdk:delete'     },
         { text: t(lang,'btn_cdk_delete_all'),  callback_data:'cdk:delete_all' }],
        [{ text: t(lang,'btn_back'),            callback_data:'nav:home'       }],
    ]};
}
function cookiesMenuKb(lang) {
    const poolButtons = POOL_KEYS.map(k => [{ text: poolLabel(k,lang), callback_data:`cook:pool:${k}` }]);
    return { inline_keyboard: [
        [{ text: t(lang,'btn_cook_stats'),   callback_data:'cook:stats'      }],
        [{ text: t(lang,'btn_cook_verify'),  callback_data:'cook:verify_all' }],
        [{ text: t(lang,'btn_cook_dead_cdks'), callback_data:'cook:dead_cdks' }],
        [{ text: t(lang,'btn_cook_delete'),  callback_data:'cook:delete'     },
         { text: t(lang,'btn_cook_delete_all'),callback_data:'cook:delete_all'}],
        [{ text: t(lang,'btn_cook_delete_dead'), callback_data:'cook:delete_dead'}],
        [{ text: t(lang,'btn_cook_divider'), callback_data:'noop'            }],
        ...poolButtons,
        [{ text: t(lang,'btn_back'),         callback_data:'nav:home'        }],
    ]};
}
function settingsKb(lang) {
    return { inline_keyboard: [
        [{ text: t(lang,'btn_set_max'),   callback_data:'set:max_users'  }],
        [{ text: t(lang,'btn_set_auto'),  callback_data:'set:auto_check' }],
        [{ text: t(lang,'btn_set_lang'),  callback_data:'set:lang'       }],
        [{ text: t(lang,'btn_set_proxy'), callback_data:'set:proxy'      }],
        [{ text: t(lang,'btn_back'),      callback_data:'nav:home'       }],
    ]};
}
function planKb(lang, back='nav:cdk') {
    return { inline_keyboard: [
        [{ text: planLabel('Premium',lang),  callback_data:'plan:Premium'  },
         { text: planLabel('Standard',lang), callback_data:'plan:Standard' }],
        [{ text: planLabel('Basic',lang),    callback_data:'plan:Basic'    },
         { text: planLabel('TV',lang),       callback_data:'plan:TV'       }],
        [{ text: t(lang,'btn_back_cdk'),     callback_data:back            }],
    ]};
}
function warrantyKb(lang) {
    const rows = [];
    for (let i=0;i<POOL_KEYS.length;i+=2) {
        const row=[{text:poolLabel(POOL_KEYS[i],lang),callback_data:`warr:${POOL_KEYS[i]}`}];
        if(POOL_KEYS[i+1]) row.push({text:poolLabel(POOL_KEYS[i+1],lang),callback_data:`warr:${POOL_KEYS[i+1]}`});
        rows.push(row);
    }
    rows.push([{text:t(lang,'btn_back_cdk'),callback_data:'cdk:create'}]);
    return {inline_keyboard:rows};
}
function allocKb(lang) {
    return { inline_keyboard: [
        [{ text: t(lang,'alloc_random'),   callback_data:'alloc:random'   }],
        [{ text: t(lang,'alloc_specific'), callback_data:'alloc:specific' }],
        [{ text: t(lang,'btn_back_cdk'),   callback_data:'cdk:create'     }],
    ]};
}
function qtyKb(lang) {
    return { inline_keyboard: [
        [{ text:'1',callback_data:'qty:1'},{ text:'5',callback_data:'qty:5'},{ text:'10',callback_data:'qty:10'}],
        [{ text:'25',callback_data:'qty:25'},{ text:'50',callback_data:'qty:50'},
         { text:`✏️ ${lang==='ar'?'مخصص':lang==='fr'?'Personnalisé':'Custom'}`, callback_data:'qty:custom'}],
        [{ text:t(lang,'btn_back_cdk'), callback_data:'cdk:create'}],
    ]};
}
function autoCheckKb(lang) {
    const btn=(h)=>({ text: t(lang,'set_auto_btn').replace('{h}',h), callback_data:`auto:${h}` });
    return { inline_keyboard: [
        [btn(1), btn(2)], [btn(6), btn(12)],
        [btn(24), { text:t(lang,'set_auto_off'), callback_data:'auto:0' }],
        [{ text:t(lang,'btn_back_settings'), callback_data:'nav:settings' }],
    ]};
}
function langKb() {
    return { inline_keyboard: [
        [{ text:'🇬🇧 English',   callback_data:'lang:en' }],
        [{ text:'🇸🇦 العربية',   callback_data:'lang:ar' }],
        [{ text:'🇫🇷 Français',  callback_data:'lang:fr' }],
    ]};
}
function confirmKb(lang, yes, no) {
    return { inline_keyboard: [
        [{ text:t(lang,'btn_confirm'),callback_data:yes },
         { text:t(lang,'btn_cancel'), callback_data:no  }],
    ]};
}

function proxyKb(lang, hasProxy, isEnabled) {
    const rows = [];
    rows.push([{ text: t(lang,'btn_proxy_check_ip'), callback_data:'proxy:check_ip' }]);
    rows.push([{ text: t(lang,'btn_proxy_add'),      callback_data:'proxy:add'      }]);
    if (hasProxy) {
        if (isEnabled) {
            rows.push([{ text: t(lang,'btn_proxy_disable'), callback_data:'proxy:disable' }]);
        } else {
            rows.push([{ text: t(lang,'btn_proxy_enable'),  callback_data:'proxy:enable'  }]);
        }
        rows.push([{ text: t(lang,'btn_proxy_delete'),  callback_data:'proxy:delete'  }]);
    }
    rows.push([{ text: t(lang,'btn_proxy_local'),   callback_data:'proxy:use_local' }]);
    rows.push([{ text: t(lang,'btn_back_settings'), callback_data:'nav:settings'    }]);
    return { inline_keyboard: rows };
}

function backKb(lang, target='nav:home') {
    return { inline_keyboard:[[{ text:t(lang,'btn_back'), callback_data:target }]] };
}
function backCdkKb(lang)     { return {inline_keyboard:[[{text:t(lang,'btn_back_cdk'),    callback_data:'nav:cdk'}]]}; }
function backCookiesKb(lang) { return {inline_keyboard:[[{text:t(lang,'btn_back_cookies'),callback_data:'nav:cookies'}]]}; }
function backCookiesFromImportKb(lang) { return {inline_keyboard:[[{text:t(lang,'btn_back_cookies'),callback_data:'cook:back_to_console'}]]}; }
function backSettingsKb(lang){ return {inline_keyboard:[[{text:t(lang,'btn_back_settings'),callback_data:'nav:settings'}]]}; }

// ── Show Main ─────────────────────────────────────────────────
async function showMain(chatId, msgId=null) {
    delete sessions[chatId];
    const lang = await getLang();
    const role = await getUserRole(chatId);
    const text = buildMainConsole(lang);
    const opts = { parse_mode: 'HTML', reply_markup: mainKb(lang, role) };
    if (msgId) {
        try {
            await bot.editMessageText(text, { chat_id:chatId, message_id:msgId, ...opts });
            sessions[chatId] = { consoleMsgId:msgId };
            return;
        } catch(_){}
    }
    const sent = await bot.sendMessage(chatId, text, opts);
    sessions[chatId] = { consoleMsgId:sent.message_id };
}

// ── /start ────────────────────────────────────────────────────
bot.onText(/\/start/, async msg => {
    const role = await getUserRole(msg.chat.id);
    if (!role) return;
    const old = (sessions[msg.chat.id]||{}).consoleMsgId;
    if (old) { try { await bot.deleteMessage(msg.chat.id,old); } catch(_){} }
    try { await bot.deleteMessage(msg.chat.id,msg.message_id); } catch(_){}
    await initProxy();
    await showMain(msg.chat.id);
});

// ── Callback Handler ──────────────────────────────────────────
bot.on('callback_query', async q => {
    const chatId = q.message.chat.id;
    const msgId  = q.message.message_id;
    const action = q.data;
    const role   = await getUserRole(chatId);
    if (!role) { bot.answerCallbackQuery(q.id,{text:'🚫'}); return; }
    bot.answerCallbackQuery(q.id);

    const lang = await getLang();
    const s    = sessions[chatId] || {};
    const cm   = s.consoleMsgId || msgId;

    // ── Permission Guards ──────────────────────────────────────
    if (action === 'nav:cookies' || action.startsWith('cook:')) {
        if (role !== 'owner' && role !== 'partner') {
            await bot.sendMessage(chatId, t(lang, 'error_no_permission'));
            return;
        }
    }
    if (action === 'nav:settings' || action.startsWith('set:') || action.startsWith('proxy:') || action.startsWith('auto:')) {
        if (action === 'set:lang' || action.startsWith('lang:')) {
            // Creators are allowed to choose language
        } else if (role !== 'owner' && role !== 'partner') {
            await bot.sendMessage(chatId, t(lang, 'error_no_permission'));
            return;
        }
    }
    if (action === 'nav:users' || action.startsWith('users:')) {
        if (role !== 'owner') {
            await bot.sendMessage(chatId, t(lang, 'error_no_permission'));
            return;
        }
    }

    // ── Navigation ────────────────────────────────────────────
    if (action==='nav:home') { await showMain(chatId,cm); return; }
    
    if (action === 'admin:analytics') {
        if (role !== 'owner') {
            await bot.sendMessage(chatId, t(lang, 'error_no_permission'));
            return;
        }
        let totalUsers = 0;
        let totalPoints = 0.0;
        let latestUsers = [];
        try {
            const uCount = await dbGet("SELECT COUNT(*) as count FROM bot_users WHERE role = 'member'");
            totalUsers = uCount ? uCount.count : 0;
            const pSum = await dbGet("SELECT SUM(points) as sum FROM bot_users WHERE role = 'member'");
            totalPoints = pSum && pSum.sum ? pSum.sum : 0.0;
            latestUsers = await dbAll("SELECT chat_id, username, points, referrals_count, created_at FROM bot_users WHERE role = 'member' ORDER BY created_at DESC LIMIT 15");
        } catch(err) {
            console.error('[Analytics error]', err);
        }
        
        let userLines = [];
        latestUsers.forEach(u => {
            const username = u.username || 'NoUsername';
            const dateStr = (u.created_at || '').slice(0, 10);
            userLines.push(t(lang, 'admin_analytics_user_row', {
                username,
                id: u.chat_id,
                points: u.points,
                invites: u.referrals_count,
                date: dateStr
            }));
        });
        
        const responseText = t(lang, 'admin_analytics_title', {
            total_users: totalUsers,
            total_points: totalPoints
        }) + '\n\n' + (userLines.join('\n') || t(lang, 'users_list_empty'));
        
        await bot.editMessageText(responseText, {
            chat_id: chatId,
            message_id: cm,
            parse_mode: 'Markdown',
            reply_markup: backKb(lang, 'nav:home')
        });
        return;
    }
    if (action==='noop')     { return; }

    if (action==='nav:cdk') {
        sessions[chatId] = {...s, consoleMsgId:cm};
        await bot.editMessageText(buildCdkMenu(lang), {
            chat_id:chatId, message_id:cm, parse_mode:'HTML', reply_markup:cdkMenuKb(lang)});
        return;
    }

    if (action==='nav:cookies') {
        sessions[chatId] = {...s, consoleMsgId:cm};
        await bot.editMessageText(buildCookiesMenu(lang), {
            chat_id:chatId, message_id:cm, parse_mode:'HTML', reply_markup:cookiesMenuKb(lang)});
        return;
    }

    if (action==='nav:settings') {
        const max     = await getSetting('max_users','5');
        const autoHrs = await getSetting('auto_check_hours','6');
        const autoTxt = autoHrs==='0' ? t(lang,'set_auto_disabled')
                                      : t(lang,'auto_check_label').replace('{h}',autoHrs);
        const curLang = LANG_NAMES[await getLang()] || 'English';
        const proxyUrl  = await getSetting('proxy_url','');
        const proxyOn   = (await getSetting('proxy_enabled','0')) === '1';
        const proxyTxt  = proxyUrl ? (proxyOn ? t(lang,'proxy_status_on') : t(lang,'proxy_status_off')) : t(lang,'proxy_no_proxy');
        await bot.editMessageText(
            t(lang,'settings_title',{max,auto:autoTxt,lang:curLang,proxy:proxyTxt}),
            {chat_id:chatId,message_id:cm,parse_mode:'Markdown',reply_markup:settingsKb(lang)});
        return;
    }

    // ═══════════════════════════════════════════════
    // PROXY SECTION
    // ═══════════════════════════════════════════════
    if (action==='set:proxy') {
        const proxyUrl = await getSetting('proxy_url','');
        const proxyOn  = (await getSetting('proxy_enabled','0')) === '1';
        const maxRet   = await getSetting('proxy_max_retries','3');
        const status   = proxyOn ? t(lang,'proxy_status_on') : t(lang,'proxy_status_off');
        const mode     = proxyOn ? t(lang,'proxy_mode_proxy') : t(lang,'proxy_mode_local');
        const url      = proxyUrl || t(lang,'proxy_url_none');
        await bot.editMessageText(
            t(lang,'proxy_menu_title',{status,mode,url,fails:proxy.getFailCount(),max:maxRet}),
            {chat_id:chatId,message_id:cm,parse_mode:'Markdown',reply_markup:proxyKb(lang,!!proxyUrl,proxyOn)});
        return;
    }

    if (action==='proxy:check_ip') {
        await bot.editMessageText(t(lang,'proxy_checking_ip'),{chat_id:chatId,message_id:cm});
        try {
            const ip   = await proxy.checkCurrentIP(true);
            const mode = proxy.isProxyEnabled() ? t(lang,'proxy_mode_proxy') : t(lang,'proxy_mode_local');
            await bot.editMessageText(t(lang,'proxy_ip_result',{mode,ip}),
                {chat_id:chatId,message_id:cm,parse_mode:'Markdown',reply_markup:backSettingsKb(lang)});
        } catch(_) {
            await bot.editMessageText(t(lang,'proxy_ip_fail'),
                {chat_id:chatId,message_id:cm,reply_markup:backSettingsKb(lang)});
        }
        return;
    }

    if (action==='proxy:add') {
        sessions[chatId] = {...s, state:'PROXY_AWAIT_URL', consoleMsgId:cm};
        await bot.editMessageText(t(lang,'proxy_add_prompt'),
            {chat_id:chatId,message_id:cm,parse_mode:'Markdown',reply_markup:backSettingsKb(lang)});
        return;
    }

    if (action==='proxy:enable') {
        const proxyUrl = await getSetting('proxy_url','');
        if (!proxyUrl) { await bot.editMessageText(t(lang,'proxy_url_none'),{chat_id:chatId,message_id:cm,reply_markup:backSettingsKb(lang)}); return; }
        await dbRun("INSERT OR REPLACE INTO settings (key,value) VALUES ('proxy_enabled','1')");
        proxy.setProxyEnabled(true);
        await bot.editMessageText(t(lang,'proxy_enabled_ok'),
            {chat_id:chatId,message_id:cm,parse_mode:'Markdown',reply_markup:backSettingsKb(lang)});
        return;
    }

    if (action==='proxy:disable' || action==='proxy:use_local') {
        await dbRun("INSERT OR REPLACE INTO settings (key,value) VALUES ('proxy_enabled','0')");
        proxy.setProxyEnabled(false);
        await bot.editMessageText(t(lang,'proxy_disabled_ok'),
            {chat_id:chatId,message_id:cm,parse_mode:'Markdown',reply_markup:backSettingsKb(lang)});
        return;
    }

    if (action==='proxy:delete') {
        await dbRun("INSERT OR REPLACE INTO settings (key,value) VALUES ('proxy_url','')");
        await dbRun("INSERT OR REPLACE INTO settings (key,value) VALUES ('proxy_enabled','0')");
        proxy.setProxyUrl(null);
        proxy.setProxyEnabled(false);
        await bot.editMessageText(t(lang,'proxy_deleted_ok'),
            {chat_id:chatId,message_id:cm,parse_mode:'Markdown',reply_markup:backSettingsKb(lang)});
        return;
    }



    // ═══════════════════════════════════════════════
    // CDK SECTION
    // ═══════════════════════════════════════════════
    if (action==='cdk:create') {
        sessions[chatId] = {...s, state:'CDK_SELECT_PLAN', consoleMsgId:cm};
        await bot.editMessageText(t(lang,'cdk_create_step1'),
            {chat_id:chatId,message_id:cm,parse_mode:'Markdown',reply_markup:planKb(lang,'nav:cdk')});
        return;
    }

    if (action.startsWith('plan:') && s.state==='CDK_SELECT_PLAN') {
        const plan = action.split(':')[1];
        sessions[chatId] = {...s, plan, state:'CDK_SELECT_WARRANTY', consoleMsgId:cm};
        await bot.editMessageText(t(lang,'cdk_create_step2',{plan:planLabel(plan,lang)}),
            {chat_id:chatId,message_id:cm,parse_mode:'Markdown',reply_markup:warrantyKb(lang)});
        return;
    }

    if (action.startsWith('warr:') && s.state==='CDK_SELECT_WARRANTY') {
        const warranty = action.split(':')[1];
        sessions[chatId] = {...s, warranty, state:'CDK_SELECT_ALLOC', consoleMsgId:cm};
        await bot.editMessageText(
            t(lang,'cdk_create_step3',{plan:planLabel(s.plan,lang),warranty:poolLabel(warranty,lang)}),
            {chat_id:chatId,message_id:cm,parse_mode:'Markdown',reply_markup:allocKb(lang)});
        return;
    }

    if (action==='alloc:random' && s.state==='CDK_SELECT_ALLOC') {
        sessions[chatId] = {...s, allocMode:'random', state:'CDK_SELECT_QTY', consoleMsgId:cm};
        await bot.editMessageText(
            t(lang,'cdk_create_step3_random',{plan:planLabel(s.plan,lang),warranty:poolLabel(s.warranty,lang)}),
            {chat_id:chatId,message_id:cm,parse_mode:'Markdown',reply_markup:qtyKb(lang)});
        return;
    }

    if (action==='alloc:specific' && s.state==='CDK_SELECT_ALLOC') {
        const activeCookies = cookieStore.getAllCookies().filter(c => 
            c.status === 'Active' &&
            c.warranty_type === s.warranty &&
            (c.plan && (c.plan.toLowerCase().includes(s.plan.toLowerCase()) || 
                        (s.plan.toLowerCase() === 'premium' && c.plan.includes('مميز'))))
        );
        if (!activeCookies.length) {
            await bot.editMessageText(t(lang,'cdk_no_active_accounts'),
                {chat_id:chatId,message_id:cm,reply_markup:backCdkKb(lang)});
            return;
        }
        // Save mapping in session to avoid long callback_data
        const emailList = activeCookies.map(c => c.email);
        sessions[chatId] = {...s, activeCookiesList: emailList, state:'CDK_SELECT_BIND', consoleMsgId:cm};

        const buttons = activeCookies.map((c, index) => {
            const daysLabel = getRemainingDaysLabel(c.next_billing_date, lang);
            return [{
                text:`${c.email} (${planLabel(c.plan,lang)}) [${poolLabel(c.warranty_type,lang)}]${daysLabel}`,
                callback_data:`bind:${index}`
            }];
        });
        buttons.push([{text:t(lang,'btn_back_cdk'),callback_data:'cdk:create'}]);
        await bot.editMessageText(
            t(lang,'cdk_create_step3_specific',{plan:planLabel(s.plan,lang),warranty:poolLabel(s.warranty,lang)}),
            {chat_id:chatId,message_id:cm,parse_mode:'Markdown',reply_markup:{inline_keyboard:buttons}});
        return;
    }

    if (action.startsWith('bind:') && s.state==='CDK_SELECT_BIND') {
        const index = parseInt(action.split(':')[1]);
        const email = getBindEmailFromIndex(chatId, index, s);
        if (!email) {
            await bot.editMessageText(t(lang,'error_db'),{chat_id:chatId,message_id:cm,reply_markup:backCdkKb(lang)});
            return;
        }
        sessions[chatId] = {...s, cookieEmail: email, state:'CDK_SELECT_QTY', consoleMsgId:cm};
        await bot.editMessageText(
            t(lang,'cdk_create_step4_bound',{plan:planLabel(s.plan,lang),warranty:poolLabel(s.warranty,lang),id:email}),
            {chat_id:chatId,message_id:cm,parse_mode:'Markdown',reply_markup:qtyKb(lang)});
        return;
    }


    if (action.startsWith('qty:') && s.state==='CDK_SELECT_QTY') {
        const val = action.split(':')[1];
        if (val==='custom') {
            sessions[chatId] = {...s, state:'CDK_AWAIT_COUNT', consoleMsgId:cm};
            await bot.editMessageText(
                t(lang,'cdk_create_custom_qty',{plan:planLabel(s.plan,lang),warranty:poolLabel(s.warranty,lang)}),
                {chat_id:chatId,message_id:cm,parse_mode:'Markdown',reply_markup:backCdkKb(lang)});
            return;
        }
        await doGenerateKeys(chatId, parseInt(val), s, cm, lang);
        return;
    }

    // ── CDK: List ─────────────────────────────────
    if (action==='cdk:list') {
        let rows = [];
        try {
            if (role === 'creator') {
                rows = await dbAll('SELECT * FROM cdks WHERE created_by = ? ORDER BY created_at DESC LIMIT 50', [String(chatId)]);
            } else {
                rows = await dbAll('SELECT * FROM cdks ORDER BY created_at DESC LIMIT 50');
            }
        } catch(_) {}
        if (!rows.length) {
            await bot.editMessageText(t(lang,'cdk_list_empty'),{chat_id:chatId,message_id:cm,reply_markup:backCdkKb(lang)});
            return;
        }
        const lines = rows.map(r => {
            const icon = r.status === 'unused' ? '🟢' : (r.status === 'active' ? '🔵' : '🔴');
            const statusLabel = r.status === 'unused' ? (lang === 'ar' ? 'صالح (غير مستعمل)' : 'Valid (Unused)')
                              : (r.status === 'active' ? (lang === 'ar' ? 'مفعّل (مستعمل)' : 'Active (Used)')
                              : (lang === 'ar' ? 'منتهي الصلاحية' : 'Expired'));
            return `${icon} \`${r.key}\`\n   ${planLabel(r.plan_type,lang)} | ${poolLabel(r.warranty_type,lang)} | ${statusLabel}`;
        });
        await bot.editMessageText(
            t(lang,'cdk_list_title',{count:rows.length}) + lines.join('\n\n'),
            {chat_id:chatId,message_id:cm,parse_mode:'Markdown',reply_markup:backCdkKb(lang)});
        return;
    }

    // ── CDK: Check ────────────────────────────────
    if (action==='cdk:check') {
        sessions[chatId] = {...s, state:'CDK_AWAIT_CHECK', consoleMsgId:cm};
        await bot.editMessageText(t(lang,'cdk_check_prompt'),
            {chat_id:chatId,message_id:cm,parse_mode:'Markdown',reply_markup:backCdkKb(lang)});
        return;
    }

    // ── CDK: Delete ───────────────────────────────
    if (action==='cdk:delete') {
        sessions[chatId] = {...s, state:'CDK_AWAIT_DELETE', consoleMsgId:cm};
        await bot.editMessageText(t(lang,'cdk_delete_prompt'),
            {chat_id:chatId,message_id:cm,parse_mode:'Markdown',reply_markup:backCdkKb(lang)});
        return;
    }

    // ── CDK: Delete All ───────────────────────────
    if (action==='cdk:delete_all') {
        await bot.editMessageText(t(lang,'cdk_delete_all_confirm'),
            {chat_id:chatId,message_id:cm,parse_mode:'Markdown',
             reply_markup:confirmKb(lang,'cdk:confirm_delete_all','nav:cdk')});
        return;
    }
    if (action==='cdk:confirm_delete_all') {
        try {
            await dbRun('DELETE FROM cdks');
            await dbRun('DELETE FROM activations');
            // Reset active users count in all JSON cookie files
            cookieStore.getAllCookies().forEach(c => {
                c.active_users = 0;
                cookieStore.saveCookie(c.email, c);
            });
            await bot.editMessageText(t(lang,'cdk_delete_all_success'),
                {chat_id:chatId,message_id:cm,reply_markup:backCdkKb(lang)});
        } catch(e) {
            await bot.editMessageText(t(lang,'error_db'),{chat_id:chatId,message_id:cm,reply_markup:backCdkKb(lang)});
        }
        return;
    }

    // ═══════════════════════════════════════════════
    // COOKIES SECTION
    // ═══════════════════════════════════════════════
    if (action.startsWith('cook:pool:')) {
        const pool = action.split(':')[2];
        sessions[chatId] = {...s, state:'COOK_AWAIT_FILE', targetPool:pool, consoleMsgId:cm};
        await bot.editMessageText(
            t(lang,'cook_pool_prompt',{pool:poolLabel(pool,lang)}),
            {chat_id:chatId,message_id:cm,parse_mode:'Markdown',reply_markup:backCookiesKb(lang)});
        return;
    }

    if (action==='cook:stats') {
        const rows = cookieStore.getAllCookies();
        if (!rows.length) {
            await bot.editMessageText(t(lang,'cook_stats_empty'),
                {chat_id:chatId,message_id:cm,parse_mode:'Markdown',reply_markup:backCookiesKb(lang)});
            return;
        }
        const grouped={};
        POOL_KEYS.forEach(k=>grouped[k]={active:0,expired:0});
        rows.forEach(r=>{
            const p=r.warranty_type||'1_month';
            if(!grouped[p]) grouped[p]={active:0,expired:0};
            if(r.status==='Active') grouped[p].active++;
            else grouped[p].expired++;
        });
        const totalActive  = rows.filter(r=>r.status==='Active').length;
        const totalExpired = rows.length-totalActive;
        const lines = [t(lang,'cook_stats_title',{active:totalActive,expired:totalExpired,total:rows.length})];
        POOL_KEYS.forEach(k=>{
            const g=grouped[k];
            if(g.active+g.expired===0) return;
            lines.push(t(lang,'cook_stats_row',{pool:poolLabel(k,lang),active:g.active,expired:g.expired}));
        });

        // Save mapping in session
        const emailList = rows.map(c => c.email);
        sessions[chatId] = {...s, activeCookiesList: emailList, consoleMsgId:cm};

        // Create buttons for each account
        const buttons = rows.map((c, index) => {
            const planLbl = planLabel(c.plan, lang);
            const poolLbl = poolLabel(c.warranty_type, lang);
            const statusIcon = c.status === 'Active' ? '🟢' : '🔴';
            return [{
                text: `${statusIcon} ${c.email} (${planLbl}) [${poolLbl}] (${c.active_users || 0}/${c.max_users || 5})`,
                callback_data: `cookindiv:manage:${index}`
            }];
        });
        buttons.push([{ text: t(lang,'btn_back'), callback_data:'nav:cookies' }]);

        await bot.editMessageText(lines.join('\n'),
            {chat_id:chatId,message_id:cm,parse_mode:'Markdown',reply_markup:{inline_keyboard:buttons}});
        return;
    }

    if (action==='cook:dead_cdks') {
        const deadCookies = cookieStore.getAllCookies().filter(c => c.status === 'Expired');
        if (!deadCookies.length) {
            await bot.editMessageText(t(lang,'cook_dead_empty'),
                {chat_id:chatId,message_id:cm,parse_mode:'Markdown',reply_markup:backCookiesKb(lang)});
            return;
        }

        const lines = [t(lang,'cook_dead_title')];
        
        for (const cookie of deadCookies) {
            lines.push(t(lang,'cook_dead_row', {
                email: cookie.email,
                pool: poolLabel(cookie.warranty_type, lang),
                date: (cookie.last_checked || '').slice(0,16).replace('T',' ') || '—'
            }));

            // Find cdks bound to this cookie email
            let cdks = [];
            try {
                cdks = await dbAll("SELECT key, status, used_device, active_users FROM cdks WHERE cookie_email=? OR bound_cookie_email=?", [cookie.email, cookie.email]);
            } catch(_) {}

            if (cdks.length) {
                cdks.forEach(k => {
                    const statusText = k.status === 'unused' ? (lang === 'ar' ? 'صالح (غير مستعمل)' : 'Valid (Unused)')
                                     : (k.status === 'active' ? (lang === 'ar' ? 'مفعّل (مستعمل)' : 'Active (Used)')
                                     : (lang === 'ar' ? 'منتهي الصلاحية' : 'Expired'));
                    lines.push(t(lang,'cook_dead_key', {
                        key: k.key,
                        status: statusText,
                        device: k.used_device || t(lang,'cdk_device_none'),
                        active: k.active_users || 0
                    }));
                });
            } else {
                lines.push('    - (No keys found)');
            }
        }

        await bot.editMessageText(lines.join('\n'),
            {chat_id:chatId,message_id:cm,parse_mode:'Markdown',reply_markup:backCookiesKb(lang)});
        return;
    }


    if (action==='cook:verify_all') {
        await bot.editMessageText(t(lang,'cook_verify_start'),
            {chat_id:chatId,message_id:cm,parse_mode:'Markdown'});
        runCookieCheck(chatId, cm, lang);
        return;
    }

    if (action==='cook:delete') {
        sessions[chatId] = {...s, state:'COOK_AWAIT_DELETE', consoleMsgId:cm};
        await bot.editMessageText(t(lang,'cook_delete_prompt'),
            {chat_id:chatId,message_id:cm,parse_mode:'Markdown',reply_markup:backCookiesKb(lang)});
        return;
    }

    if (action==='cook:delete_all') {
        if (role !== 'owner') { 
            await bot.answerCallbackQuery(q.id, { text: t(lang, 'error_no_permission'), show_alert: true });
            return; 
        }
        await bot.editMessageText(t(lang,'cook_delete_all_confirm'),
            {chat_id:chatId,message_id:cm,parse_mode:'Markdown',reply_markup:confirmKb(lang, 'cook:delete_all_confirm', 'nav:cookies')});
        return;
    }

    if (action==='cook:delete_all_confirm') {
        if (role !== 'owner') { 
            await bot.answerCallbackQuery(q.id, { text: t(lang, 'error_no_permission'), show_alert: true });
            return; 
        }
        const count = cookieStore.deleteAllCookies();
        try {
            await dbRun("UPDATE cdks SET cookie_email = NULL");
        } catch(_) {}
        await bot.editMessageText(t(lang,'cook_delete_all_success', { count }),
            {chat_id:chatId,message_id:cm,parse_mode:'Markdown',reply_markup:backCookiesKb(lang)});
        return;
    }

    if (action==='cook:delete_dead') {
        if (role !== 'owner' && role !== 'partner') { 
            await bot.answerCallbackQuery(q.id, { text: t(lang, 'error_no_permission'), show_alert: true });
            return; 
        }
        const expiredCookies = cookieStore.getAllCookies().filter(c => c.status === 'Expired');
        if (!expiredCookies.length) {
            await bot.answerCallbackQuery(q.id, { text: t(lang, 'cook_delete_dead_empty'), show_alert: true });
            return;
        }
        let count = 0;
        for (const cookie of expiredCookies) {
            const success = cookieStore.deleteCookie(cookie.email);
            if (success) {
                count++;
                try {
                    await dbRun("UPDATE cdks SET cookie_email = NULL WHERE cookie_email = ?", [cookie.email]);
                } catch(_) {}
            }
        }
        return;
    }

    // ── Individual Cookie Management callbacks ──
    if (action.startsWith('cookindiv:manage:')) {
        try {
            const index = parseInt(action.split(':')[2]);
            await showManageCookiePage(chatId, cm, index, lang, s);
        } catch (err) {
            console.error(err);
            await bot.sendMessage(chatId, "🔴 *Developer Debug Error:* " + err.stack, { parse_mode: 'Markdown' });
        }
        return;
    }

    if (action.startsWith('cookindiv:slots:')) {
        try {
            const index = parseInt(action.split(':')[2]);
            const email = getEmailFromIndex(chatId, index, s);
            if (!email) throw new Error(`Email index ${index} not found.`);
            sessions[chatId] = { ...s, state: 'COOK_AWAIT_INDIV_SLOTS', targetCookieIndex: index, consoleMsgId: cm };
            await bot.editMessageText(t(lang, 'cook_change_slots_prompt', { email }), {
                chat_id: chatId,
                message_id: cm,
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: t(lang, 'btn_back'), callback_data: `cookindiv:manage:${index}` }]] }
            });
        } catch (err) {
            console.error(err);
            await bot.sendMessage(chatId, "🔴 *Developer Debug Error (slots):* " + err.stack, { parse_mode: 'Markdown' });
        }
        return;
    }

    if (action.startsWith('cookindiv:pool:')) {
        try {
            const index = parseInt(action.split(':')[2]);
            const email = getEmailFromIndex(chatId, index, s);
            if (!email) throw new Error(`Email index ${index} not found.`);
            
            const buttons = POOL_KEYS.map(k => [
                { text: poolLabel(k, lang), callback_data: `cookindiv:update_pool:${index}:${k}` }
            ]);
            buttons.push([{ text: t(lang, 'btn_cancel'), callback_data: `cookindiv:manage:${index}` }]);

            await bot.editMessageText(t(lang, 'cook_change_pool_title', { email }), {
                chat_id: chatId,
                message_id: cm,
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: buttons }
            });
        } catch (err) {
            console.error(err);
            await bot.sendMessage(chatId, "🔴 *Developer Debug Error (pool):* " + err.stack, { parse_mode: 'Markdown' });
        }
        return;
    }

    if (action.startsWith('cookindiv:update_pool:')) {
        try {
            const parts = action.split(':');
            const index = parseInt(parts[2]);
            const newPool = parts[3];
            const email = getEmailFromIndex(chatId, index, s);
            if (!email) throw new Error(`Email index ${index} not found.`);

            const c = cookieStore.getCookie(email);
            if (c) {
                c.warranty_type = newPool;
                cookieStore.saveCookie(email, c);
                await bot.answerCallbackQuery(q.id, { text: t(lang, 'cook_change_pool_success', { email, pool: poolLabel(newPool, lang) }) });
            } else {
                throw new Error(`Cookie for ${email} not found.`);
            }
            await showManageCookiePage(chatId, cm, index, lang, s);
        } catch (err) {
            console.error(err);
            await bot.sendMessage(chatId, "🔴 *Developer Debug Error (update_pool):* " + err.stack, { parse_mode: 'Markdown' });
        }
        return;
    }

    if (action.startsWith('cookindiv:verify:')) {
        try {
            const index = parseInt(action.split(':')[2]);
            const email = getEmailFromIndex(chatId, index, s);
            if (!email) throw new Error(`Email index ${index} not found.`);

            await bot.editMessageText(t(lang, 'cook_verify_single_start', { email }), {
                chat_id: chatId,
                message_id: cm,
                parse_mode: 'Markdown'
            });

            const c = cookieStore.getCookie(email);
            if (!c) throw new Error(`Cookie for "${email}" not found.`);

            const res = await checkCookie({ cookie_text: c.cookie_text });
            if (res.valid) {
                // If it was expired, reactivate
                c.status = 'Active';
                c.last_checked = new Date().toISOString();
                if (res.info) {
                    if (res.info.plan) c.plan = res.info.plan;
                    if (res.info.country) c.country = res.info.country;
                    if (res.info.expiry) c.next_billing_date = res.info.expiry;
                }
                cookieStore.saveCookie(email, c);

                const billingText = getBillingStatusText(c.next_billing_date, lang);
                const planLbl = planLabel(c.plan, lang);
                await bot.sendMessage(chatId, t(lang, 'cook_verify_single_ok', { email, plan: planLbl, billing: billingText }), {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [[{ text: t(lang, 'btn_back'), callback_data: `cookindiv:manage:${index}` }]]
                    }
                });
            } else {
                c.status = 'Expired';
                c.last_checked = new Date().toISOString();
                cookieStore.saveCookie(email, c);

                await bot.sendMessage(chatId, t(lang, 'cook_verify_single_fail', { email }), {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [[{ text: t(lang, 'btn_back'), callback_data: `cookindiv:manage:${index}` }]]
                    }
                });
            }
        } catch (err) {
            console.error(err);
            await bot.sendMessage(chatId, "🔴 *Developer Debug Error (verify):* " + err.stack, { parse_mode: 'Markdown' });
        }
        return;
    }

    if (action.startsWith('cookindiv:del:')) {
        try {
            const index = parseInt(action.split(':')[2]);
            const email = getEmailFromIndex(chatId, index, s);
            if (!email) throw new Error(`Email index ${index} not found.`);

            await bot.editMessageText(t(lang, 'cook_delete_one_confirm', { email }), {
                chat_id: chatId,
                message_id: cm,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: t(lang, 'btn_yes'), callback_data: `cookindiv:del_conf:${index}` },
                            { text: t(lang, 'btn_no'), callback_data: `cookindiv:manage:${index}` }
                        ]
                    ]
                }
            });
        } catch (err) {
            console.error(err);
            await bot.sendMessage(chatId, "🔴 *Developer Debug Error (del):* " + err.stack, { parse_mode: 'Markdown' });
        }
        return;
    }

    if (action.startsWith('cookindiv:del_conf:')) {
        try {
            const index = parseInt(action.split(':')[2]);
            const email = getEmailFromIndex(chatId, index, s);
            if (!email) throw new Error(`Email index ${index} not found.`);

            const success = cookieStore.deleteCookie(email);
            if (success) {
                try {
                    await dbRun("UPDATE cdks SET cookie_email = NULL WHERE cookie_email = ?", [email]);
                } catch (_) {}
                await bot.answerCallbackQuery(q.id, { text: t(lang, 'cook_delete_success', { email }) });
            } else {
                throw new Error(`Failed to delete cookie for ${email}.`);
            }
            await showCookieStatsPage(chatId, cm, lang, s);
        } catch (err) {
            console.error(err);
            await bot.sendMessage(chatId, "🔴 *Developer Debug Error (del_conf):* " + err.stack, { parse_mode: 'Markdown' });
        }
        return;
    }

    if (action === 'cook:back_to_console') {
        try {
            await bot.deleteMessage(chatId, cm);
        } catch (_) {}
        const consoleMsgId = s.consoleMsgId;
        if (consoleMsgId) {
            try {
                await bot.editMessageText(t(lang, 'cookies_menu_title'), {
                    chat_id: chatId,
                    message_id: consoleMsgId,
                    parse_mode: 'Markdown',
                    reply_markup: cookiesMenuKb(lang)
                });
            } catch (_) {
                const m = await bot.sendMessage(chatId, t(lang, 'cookies_menu_title'), {
                    parse_mode: 'Markdown',
                    reply_markup: cookiesMenuKb(lang)
                });
                sessions[chatId] = { ...s, consoleMsgId: m.message_id };
            }
        }
        return;
    }

    // ═══════════════════════════════════════════════
    // SETTINGS SECTION
    // ═══════════════════════════════════════════════
    if (action==='set:max_users') {
        sessions[chatId] = {...s, state:'SET_MAX_USERS', consoleMsgId:cm};
        const cur = await getSetting('max_users','5');
        await bot.editMessageText(t(lang,'set_max_prompt',{cur}),
            {chat_id:chatId,message_id:cm,parse_mode:'Markdown',reply_markup:backSettingsKb(lang)});
        return;
    }

    if (action==='set:auto_check') {
        const cur = await getSetting('auto_check_hours','6');
        const curTxt = cur==='0' ? t(lang,'set_auto_disabled') : t(lang,'auto_check_label').replace('{h}',cur);
        await bot.editMessageText(t(lang,'set_auto_title',{cur:curTxt}),
            {chat_id:chatId,message_id:cm,parse_mode:'Markdown',reply_markup:autoCheckKb(lang)});
        return;
    }

    if (action.startsWith('auto:')) {
        const hrs = action.split(':')[1];
        await dbRun("INSERT OR REPLACE INTO settings (key,value) VALUES ('auto_check_hours',?)",[hrs]);
        setupAutoCheck();
        const val = hrs==='0' ? t(lang,'set_auto_disabled') : t(lang,'auto_check_label').replace('{h}',hrs);
        await bot.editMessageText(t(lang,'set_auto_success',{val}),
            {chat_id:chatId,message_id:cm,parse_mode:'Markdown',reply_markup:settingsKb(lang)});
        return;
    }

    if (action==='set:lang') {
        await bot.editMessageText(t(lang,'set_lang_title'),
            {chat_id:chatId,message_id:cm,reply_markup:langKb()});
        return;
    }

    if (action.startsWith('lang:')) {
        const newLang = action.split(':')[1];
        await dbRun("INSERT OR REPLACE INTO settings (key,value) VALUES ('lang',?)",[newLang]);
        const updLang = newLang;
        const userRole = await getUserRole(chatId);
        await bot.editMessageText(
            t(updLang,'set_lang_success',{lang:LANG_NAMES[newLang]||newLang}),
            {chat_id:chatId,message_id:cm,parse_mode:'Markdown',reply_markup:mainKb(updLang, userRole)});
        return;
    }

    // ═══════════════════════════════════════════════
    // DEPRECATED SECTION
    // ═══════════════════════════════════════════════
    if (action==='nav:users' || action==='admin:analytics') {
        try { await bot.answerCallbackQuery(query.id, { text: 'Section removed.' }); } catch(_) {}
        await showMain(chatId, cm, lang, s);
        return;
    }

    if (action==='users:add:partner') {
        sessions[chatId] = {...s, state:'USERS_AWAIT_ADD_PARTNER', consoleMsgId:cm};
        await bot.editMessageText(t(lang,'users_add_partner_prompt'),
            {chat_id:chatId,message_id:cm,parse_mode:'Markdown',reply_markup:backUsersKb(lang)});
        return;
    }

    if (action==='users:add:creator') {
        sessions[chatId] = {...s, state:'USERS_AWAIT_ADD_CREATOR', consoleMsgId:cm};
        await bot.editMessageText(t(lang,'users_add_creator_prompt'),
            {chat_id:chatId,message_id:cm,parse_mode:'Markdown',reply_markup:backUsersKb(lang)});
        return;
    }

    if (action==='users:delete') {
        sessions[chatId] = {...s, state:'USERS_AWAIT_DELETE', consoleMsgId:cm};
        await bot.editMessageText(t(lang,'users_delete_prompt'),
            {chat_id:chatId,message_id:cm,parse_mode:'Markdown',reply_markup:backUsersKb(lang)});
        return;
    }

    if (action==='users:list') {
        let rows = [];
        try {
            rows = await dbAll("SELECT chat_id, username, role, created_at FROM bot_users WHERE role IN ('owner', 'partner', 'creator') ORDER BY created_at DESC");
        } catch(_) {}
        
        let text = t(lang, 'users_list_title') + '\n\n';
        if (rows.length) {
            rows.forEach(r => {
                text += t(lang, 'users_list_row', {
                    id: r.chat_id,
                    role: r.role === 'partner' ? 'Partner (شريك)' : 'CDK Creator (موزع)',
                    date: (r.created_at || '').slice(0, 10)
                }) + '\n';
            });
        } else {
            text += t(lang, 'users_list_empty');
        }

        await bot.editMessageText(text,
            {chat_id:chatId,message_id:cm,parse_mode:'Markdown',reply_markup:backUsersKb(lang)});
        return;
    }
});

// ── Message Handler ───────────────────────────────────────────
bot.on('message', async msg => {
    const role = await getUserRole(msg.chat.id);
    if (!role) return;
    if (seenMsgIds.has(msg.message_id)) return;
    seenMsgIds.add(msg.message_id);
    setTimeout(()=>seenMsgIds.delete(msg.message_id), 30000);

    const chatId = msg.chat.id;
    const lang   = await getLang();
    const s      = sessions[chatId] || {};

    // ── File upload ───────────────────────────────
    if (msg.document) {
        if (s.state==='COOK_AWAIT_FILE') {
            if (!s.docQueue) sessions[chatId]={...s,docQueue:[]};
            sessions[chatId].docQueue.push(msg.document);
            clearTimeout(sessions[chatId].docTimer);
            sessions[chatId].docTimer = setTimeout(()=>processBatchDocs(chatId,lang), 800);
        } else {
            await bot.sendMessage(chatId, t(lang,'cook_no_file'),
                {parse_mode:'Markdown',reply_markup:backKb(lang,'nav:cookies')});
        }
        return;
    }

    const text = msg.text ? msg.text.trim() : null;
    if (!text || text.startsWith('/')) return;

    const isCookieText = text && (
        text.includes('netflix.com') ||
        text.includes('NetflixId') ||
        text.includes('SecureNetflixId') ||
        (text.startsWith('[') && text.includes('name') && text.includes('value'))
    );
    if (isCookieText) {
        await bot.sendMessage(chatId, t(lang, 'error_raw_cookie_paste'), { parse_mode: 'Markdown', reply_markup: backCookiesKb(lang) });
        return;
    }

    switch (s.state) {
        case 'CDK_AWAIT_COUNT': {
            const n = parseInt(text);
            if (isNaN(n)||n<1) { await bot.sendMessage(chatId,t(lang,'error_number')); return; }
            await doGenerateKeys(chatId, n, s, s.consoleMsgId, lang);
            return;
        }
        case 'CDK_AWAIT_CHECK': {
            let row;
            const cleanKey = (text || '').trim().toUpperCase();
            try {
                row = await dbGet('SELECT * FROM cdks WHERE UPPER(key)=?', [cleanKey]);
            } catch(_){}
            if (!row) {
                await bot.sendMessage(chatId,t(lang,'cdk_check_notfound',{key:cleanKey}),
                    {parse_mode:'Markdown',reply_markup:backCdkKb(lang)});
                return;
            }
            const icon   = row.status === 'unused' ? '🟢' : (row.status === 'active' ? '🔵' : '🔴');
            const status = row.status === 'unused' ? (lang === 'ar' ? 'صالح (غير مستعمل)' : 'Valid (Unused)')
                         : (row.status === 'active' ? (lang === 'ar' ? 'مفعّل (مستعمل)' : 'Active (Used)')
                         : (lang === 'ar' ? 'منتهي الصلاحية' : 'Expired'));
            const device = row.used_device||t(lang,'cdk_device_none');
            const emailVal = row.cookie_email || row.bound_cookie_email;
            const email  = emailVal ? `\`${emailVal}\`` : t(lang,'cdk_email_none');
            await bot.sendMessage(chatId,
                t(lang,'cdk_check_result',{
                    key:row.key, plan:planLabel(row.plan_type,lang),
                    icon, status, warranty:poolLabel(row.warranty_type,lang),
                    active:row.active_users, max:row.max_users,
                    device, email, date:(row.created_at||'').slice(0,10)||'—'
                }),
                {parse_mode:'Markdown',reply_markup:backCdkKb(lang)});
            delete sessions[chatId];
            return;
        }
        case 'CDK_AWAIT_DELETE': {
            const cleanKey = (text || '').trim().toUpperCase();
            try {
                const cdk = await dbGet('SELECT status, cookie_email, bound_cookie_email, created_by FROM cdks WHERE UPPER(key)=?', [cleanKey]);
                if (cdk) {
                    if (role === 'creator' && String(cdk.created_by) !== String(chatId)) {
                        await bot.sendMessage(chatId, t(lang,'error_no_permission'), {parse_mode:'Markdown', reply_markup:backCdkKb(lang)});
                        delete sessions[chatId];
                        return;
                    }
                    const res = await dbRun('DELETE FROM cdks WHERE UPPER(key)=?', [cleanKey]);
                    await dbRun('DELETE FROM activations WHERE UPPER(cdk_key)=?', [cleanKey]);
                    const email = cdk.cookie_email || cdk.bound_cookie_email;
                    if (cdk.status === 'active' && email) {
                        cookieStore.adjustActiveUsers(email, -1);
                    }
                    const reply = res && res.changes > 0
                        ? t(lang,'cdk_delete_success',{key:cleanKey})
                        : t(lang,'cdk_delete_notfound',{key:cleanKey});
                    await bot.sendMessage(chatId,reply,{parse_mode:'Markdown',reply_markup:backCdkKb(lang)});
                } else {
                    await bot.sendMessage(chatId,t(lang,'cdk_delete_notfound',{key:text}),{parse_mode:'Markdown',reply_markup:backCdkKb(lang)});
                }
            } catch(e) {
                await bot.sendMessage(chatId,t(lang,'error_db'),{parse_mode:'Markdown',reply_markup:backCdkKb(lang)});
            }
            delete sessions[chatId];
            return;
        }
        case 'USERS_AWAIT_ADD_PARTNER': {
            if (role !== 'owner') { await bot.sendMessage(chatId, t(lang, 'error_no_permission')); return; }
            try {
                await dbRun("INSERT OR REPLACE INTO bot_users (chat_id, role, added_by, created_at) VALUES (?, 'partner', ?, ?)",
                    [text, String(chatId), new Date().toISOString()]);
                await bot.sendMessage(chatId, t(lang, 'users_add_success', { id: text, role: 'Partner (شريك)' }),
                    { parse_mode: 'Markdown', reply_markup: backUsersKb(lang) });
            } catch (err) {
                await bot.sendMessage(chatId, t(lang, 'error_db'), { reply_markup: backUsersKb(lang) });
            }
            delete sessions[chatId];
            return;
        }
        case 'USERS_AWAIT_ADD_CREATOR': {
            if (role !== 'owner') { await bot.sendMessage(chatId, t(lang, 'error_no_permission')); return; }
            try {
                await dbRun("INSERT OR REPLACE INTO bot_users (chat_id, role, added_by, created_at) VALUES (?, 'creator', ?, ?)",
                    [text, String(chatId), new Date().toISOString()]);
                await bot.sendMessage(chatId, t(lang, 'users_add_success', { id: text, role: 'CDK Creator (موزع)' }),
                    { parse_mode: 'Markdown', reply_markup: backUsersKb(lang) });
            } catch (err) {
                await bot.sendMessage(chatId, t(lang, 'error_db'), { reply_markup: backUsersKb(lang) });
            }
            delete sessions[chatId];
            return;
        }
        case 'USERS_AWAIT_DELETE': {
            if (role !== 'owner') { await bot.sendMessage(chatId, t(lang, 'error_no_permission')); return; }
            try {
                const res = await dbRun("DELETE FROM bot_users WHERE chat_id = ?", [text]);
                const reply = res && res.changes > 0
                    ? t(lang, 'users_delete_success', { id: text })
                    : t(lang, 'users_list_empty');
                await bot.sendMessage(chatId, reply, { parse_mode: 'Markdown', reply_markup: backUsersKb(lang) });
            } catch (err) {
                await bot.sendMessage(chatId, t(lang, 'error_db'), { reply_markup: backUsersKb(lang) });
            }
            delete sessions[chatId];
            return;
        }
        case 'COOK_AWAIT_DELETE': {
            if (role !== 'owner' && role !== 'partner') { 
                await bot.sendMessage(chatId, t(lang, 'error_no_permission')); 
                delete sessions[chatId];
                return; 
            }
            const email = text.toLowerCase();
            const deleted = cookieStore.deleteCookie(email);
            if (deleted) {
                try {
                    await dbRun("UPDATE cdks SET cookie_email = NULL WHERE cookie_email = ?", [email]);
                } catch(_) {}
                await bot.sendMessage(chatId, t(lang, 'cook_delete_success', { email }), { parse_mode: 'Markdown', reply_markup: backCookiesFromImportKb(lang) });
            } else {
                await bot.sendMessage(chatId, t(lang, 'cook_delete_notfound', { email }), { parse_mode: 'Markdown', reply_markup: backCookiesFromImportKb(lang) });
            }
            delete sessions[chatId];
            return;
        }
        case 'COOK_AWAIT_INDIV_SLOTS': {
            const n = parseInt(text);
            if (isNaN(n)||n<1) { await bot.sendMessage(chatId,t(lang,'error_number')); return; }
            const index = s.targetCookieIndex;
            const email = s.activeCookiesList ? s.activeCookiesList[index] : null;
            if (email) {
                const c = cookieStore.getCookie(email);
                if (c) {
                    c.max_users = n;
                    cookieStore.saveCookie(email, c);
                    await bot.sendMessage(chatId, t(lang, 'cook_change_slots_success', { email, n }), { parse_mode: 'Markdown' });
                }
            }
            const origConsoleMsgId = s.consoleMsgId;
            sessions[chatId] = { ...s, state: null };
            await showManageCookiePage(chatId, origConsoleMsgId, index, lang, sessions[chatId]);
            return;
        }
        case 'SET_MAX_USERS': {
            const n = parseInt(text);
            if (isNaN(n)||n<1) { await bot.sendMessage(chatId,t(lang,'error_number')); return; }
            await dbRun("INSERT OR REPLACE INTO settings (key,value) VALUES ('max_users',?)",[String(n)]);
            cookieStore.updateMaxUsersAll(n);
            await bot.sendMessage(chatId,t(lang,'set_max_success',{n}),
                {parse_mode:'Markdown',reply_markup:backSettingsKb(lang)});
            delete sessions[chatId];
            return;
        }
        case 'PROXY_AWAIT_URL': {
            const validation = proxy.validateProxyUrl(text);
            if (!validation.valid) {
                await bot.sendMessage(chatId,
                    t(lang,'proxy_invalid_url',{reason:validation.reason}),
                    {parse_mode:'Markdown',reply_markup:backSettingsKb(lang)});
                return;
            }
            const proxyUrl = validation.normalized;
            // Test the proxy
            const testMsg = await bot.sendMessage(chatId, t(lang,'proxy_testing'));
            const result  = await proxy.testProxy(proxyUrl);
            if (result.success) {
                // Save & enable
                await dbRun("INSERT OR REPLACE INTO settings (key,value) VALUES ('proxy_url',?)",[proxyUrl]);
                await dbRun("INSERT OR REPLACE INTO settings (key,value) VALUES ('proxy_enabled','1')");
                proxy.setProxyUrl(proxyUrl);
                proxy.setProxyEnabled(true);
                await bot.editMessageText(
                    t(lang,'proxy_test_ok',{ip:result.ip}),
                    {chat_id:chatId,message_id:testMsg.message_id,parse_mode:'Markdown',reply_markup:backSettingsKb(lang)});
            } else {
                await bot.editMessageText(
                    t(lang,'proxy_test_fail',{error:result.error||'Unknown error'}),
                    {chat_id:chatId,message_id:testMsg.message_id,parse_mode:'Markdown',reply_markup:backSettingsKb(lang)});
            }
            delete sessions[chatId];
            return;
        }
    }
});

// ── Batch Doc Processor ───────────────────────────────────────
async function processBatchDocs(chatId, lang) {
    const s    = sessions[chatId] || {};
    const docs = s.docQueue || [];
    const pool = s.targetPool || '1_month';
    if (!docs.length) return;
    sessions[chatId] = {...s, docQueue:[], docTimer:null};

    const statusMsg = await bot.sendMessage(chatId,t(lang,'cook_downloading',{count:docs.length}));
    const rawBlocks = [];
    for (const doc of docs) {
        try {
            const link = await bot.getFileLink(doc.file_id);
            const txt  = await downloadText(link);
            rawBlocks.push({name:doc.file_name||'file',text:txt});
        } catch(_){}
    }
    if (!rawBlocks.length) {
        await bot.editMessageText(t(lang,'cook_download_fail'),
            {chat_id:chatId,message_id:statusMsg.message_id,reply_markup:backCookiesKb(lang)});
        return;
    }
    await bot.editMessageText(t(lang,'cook_processing',{count:rawBlocks.length,pool:poolLabel(pool,lang)}),
        {chat_id:chatId,message_id:statusMsg.message_id,parse_mode:'Markdown'});

    const source = rawBlocks.length===1 ? rawBlocks[0].name : `${rawBlocks.length} files`;
    await importCookies(chatId, rawBlocks.map(b=>b.text), source, pool, statusMsg.message_id, lang);
}

function downloadText(url) {
    return new Promise((res,rej)=>{
        https.get(url,r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>res(b));}).on('error',rej);
    });
}

// ── Cookie Importer ───────────────────────────────────────────
async function importCookies(chatId, rawTexts, sourceName, warrantyType='1_month', existingMsgId=null, lang='en') {
    const allBlocks=[];
    for (const raw of rawTexts) {
        let blocks=[raw];
        try { const p=JSON.parse(raw); if(Array.isArray(p)&&Array.isArray(p[0])) blocks=p.map(b=>JSON.stringify(b)); } catch(_){}
        if (blocks.length===1) {
            const multi=raw.split(/\n\s*\n/).filter(b=>/netflixid/i.test(b));
            if(multi.length>1) blocks=multi;
        }
        allBlocks.push(...blocks);
    }

    let report;
    if (existingMsgId) {
        await bot.editMessageText(t(lang,'cook_checking',{count:allBlocks.length}),{chat_id:chatId,message_id:existingMsgId});
        report={chat_id:chatId,message_id:existingMsgId};
    } else {
        const m=await bot.sendMessage(chatId,t(lang,'cook_checking',{count:allBlocks.length}));
        report={chat_id:chatId,message_id:m.message_id};
    }

    const maxUsers = parseInt(await getSetting('max_users','5'))||5;
    let added=0, replaced=0, expired=0, failed=0;
    const addedList=[], replacedList=[];

    // Run cookie validation concurrently to avoid timeout bottlenecks
    const results = await Promise.all(allBlocks.map(async (block) => {
        const dict = parseCookies(block);
        if (!dict['NetflixId']) {
            const key = Object.keys(dict).find(k => k.toLowerCase() === 'netflixid');
            if (key) dict['NetflixId'] = dict[key];
        }
        if (!dict['NetflixId']) return { valid: false, block, reason: 'failed' };
        
        try {
            const check = await checkCookie(dict);
            return { valid: check.valid, info: check.info, dict, block };
        } catch (_) {
            return { valid: false, block, reason: 'expired' };
        }
    }));

    for (const r of results) {
        if (!r.valid) {
            if (r.reason === 'failed') failed++;
            else expired++;
            continue;
        }
        const info = r.info;
        const dict = r.dict;
        const cookieStr = Object.entries(dict).map(([k,v]) => `${k}=${v}`).join('; ');
        
        try {
            const isSoon = isExpiringSoon(info.billing);
            const warnText = isSoon ? (lang === 'ar' ? ' ⚠️ (ينتهي قريباً!)' : ' ⚠️ (Expiring Soon!)') : '';
            const existing = cookieStore.getCookie(info.email);
            if (existing) {
                existing.cookie_text = cookieStr;
                existing.plan = info.plan;
                existing.country = info.country;
                existing.next_billing_date = info.billing;
                existing.status = 'Active';
                existing.warranty_type = warrantyType;
                existing.last_checked = new Date().toISOString();
                cookieStore.saveCookie(info.email, existing);
                replaced++; replacedList.push(`  ♻️ ${info.email}${warnText}`);
            } else {
                cookieStore.saveCookie(info.email, {
                    email: info.email,
                    plan: info.plan,
                    country: info.country,
                    next_billing_date: info.billing,
                    cookie_text: cookieStr,
                    max_users: maxUsers,
                    active_users: 0,
                    status: 'Active',
                    warranty_type: warrantyType,
                    last_checked: new Date().toISOString()
                });
                added++; addedList.push(`  ✅ ${info.email} (${info.plan||'?'})${warnText}`);
            }
        } catch (_){ failed++; }
    }

    const poolLbl = poolLabel(warrantyType,lang);
    let text = t(lang,'cook_import_result',{
        source:sourceName, pool:poolLbl, total:allBlocks.length,
        added, replaced, bad:expired+failed
    });
    if (addedList.length)    text += '\n' + t(lang,'cook_import_new')    + '\n' + addedList.join('\n');
    if (replacedList.length) text += '\n' + t(lang,'cook_import_replaced')+ '\n' + replacedList.join('\n');

    await bot.editMessageText(text,
        {chat_id:report.chat_id,message_id:report.message_id,parse_mode:'Markdown',reply_markup:backCookiesFromImportKb(lang)});
}

// ── CDK Generator ─────────────────────────────────────────────
async function doGenerateKeys(chatId, count, s, consoleMsgId, lang) {
    const plan        = s.plan     || 'Premium';
    const warranty    = s.warranty || '1_month';
    const days        = poolDays(warranty);
    const cookieEmail = s.cookieEmail || null;

    if (consoleMsgId) {
        await bot.editMessageText(lang === 'ar' ? '⏳ *جاري فحص الحسابات للتأكد من صلاحيتها أولاً...*' : '⏳ *Checking accounts to ensure validity first...*', {
            chat_id: chatId,
            message_id: consoleMsgId,
            parse_mode: 'Markdown'
        });
    }

    // Stock & Validity Verification check
    let availableSlots = 0;
    if (cookieEmail) {
        // Bound/Specific Cookie check
        const c = cookieStore.getCookie(cookieEmail);
        if (c && c.status === 'Active') {
            // Verify specific cookie is working
            const dict = parseCookies(c.cookie_text);
            const check = await checkCookie(dict);
            if (check.valid) {
                availableSlots = Math.max(0, (c.max_users || 5) - (c.active_users || 0));
            } else {
                c.status = 'Expired';
                cookieStore.saveCookie(cookieEmail, c);
            }
        }
    } else {
        // Random / Pool Cookie check
        // Sum up all available slots in the matching pool/plan after verifying validity
        const cookies = cookieStore.getAllCookies().filter(c =>
            c.status === 'Active' &&
            c.warranty_type === warranty &&
            (c.plan && (c.plan.toLowerCase().includes(plan.toLowerCase()) || 
                        (plan.toLowerCase() === 'premium' && c.plan.includes('مميز'))))
        );
        
        // Check sequentially to avoid overwhelming Netflix but keep quick check
        for (const c of cookies) {
            const dict = parseCookies(c.cookie_text);
            const check = await checkCookie(dict);
            if (check.valid) {
                availableSlots += Math.max(0, (c.max_users || 5) - (c.active_users || 0));
            } else {
                c.status = 'Expired';
                cookieStore.saveCookie(c.email, c);
            }
        }
    }

    if (availableSlots < count) {
        const errText = t(lang, 'cdk_gen_no_stock', {
            plan: planLabel(plan, lang),
            warranty: poolLabel(warranty, lang),
            available: availableSlots,
            requested: count
        });
        if (consoleMsgId) {
            await bot.editMessageText(errText, { chat_id: chatId, message_id: consoleMsgId, parse_mode: 'Markdown', reply_markup: backCdkKb(lang) });
        } else {
            await bot.sendMessage(chatId, errText, { parse_mode: 'Markdown', reply_markup: backCdkKb(lang) });
        }
        delete sessions[chatId];
        return;
    }

    const keys=[];
    for (let i=0;i<count;i++) {
        const key=`NETVXL-${crypto.randomBytes(3).toString('hex').toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
        keys.push(key);
        try {
            await dbRun(
                "INSERT INTO cdks (key,status,max_users,plan_type,warranty_type,duration_days,created_at,bound_cookie_email,created_by) VALUES (?,'unused',1,?,?,?,?,?,?)",
                [key,plan,warranty,days,new Date().toISOString(),cookieEmail,String(chatId)]);
        } catch(err){
            console.error('[CDK Gen Error]', err);
        }
    }

    const dur  = days===0 ? t(lang,'cdk_duration_unlimited') : t(lang,'cdk_duration_days',{days});
    const bind = cookieEmail
        ? t(lang,'cdk_bind_specific',{id:cookieEmail})
        : t(lang,'cdk_bind_random');

    let keysFormatted = '';
    if (count > 10) {
        keysFormatted = `📁 *Generated ${count} CDK keys and attached them as a .txt file below for easy export.*`;
    } else {
        keysFormatted = `\`\`\`copy\n${keys.join('\n')}\n\`\`\``;
    }

    const text = t(lang,'cdk_generated',{
        count, plan:planLabel(plan,lang), warranty:poolLabel(warranty,lang),
        duration:dur, bind, keys: keysFormatted
    });

    if (consoleMsgId) {
        try {
            await bot.editMessageText(text,{chat_id:chatId,message_id:consoleMsgId,parse_mode:'Markdown',reply_markup:backCdkKb(lang)});
        } catch (_) {
            await bot.sendMessage(chatId,text,{parse_mode:'Markdown',reply_markup:backCdkKb(lang)});
        }
    } else {
        await bot.sendMessage(chatId,text,{parse_mode:'Markdown',reply_markup:backCdkKb(lang)});
    }

    if (count > 10) {
        const txtBuffer = Buffer.from(keys.join('\n'), 'utf8');
        await bot.sendDocument(chatId, txtBuffer, {}, { filename: `NETVXL_${count}_KEYS.txt`, contentType: 'text/plain' });
    }
    sessions[chatId]={consoleMsgId};
}

// ── Cookie Checker (Netflix API) ──────────────────────────────
// All HTTP calls now route through proxy.httpGet which handles
// proxy usage, fallback to local IP, and admin notifications automatically.

function decodeEsc(s) {
    if(!s) return s;
    return s.replace(/\\x([0-9A-Fa-f]{2})/g,(_,h)=>String.fromCharCode(parseInt(h,16)))
            .replace(/\\u([0-9A-Fa-f]{4})/g,(_,h)=>String.fromCharCode(parseInt(h,16)));
}
function parseCookies(raw) {
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
    raw.split(/\r?\n/).forEach(line=>{const t=line.trim();if(!t||t.startsWith('#'))return;const p=t.split('\t');if(p.length>=7){result[p[5]]=p[6];tsv++;}});
    if(tsv) return result;
    raw.split(/[;\n]/).forEach(pair=>{const i=pair.indexOf('=');if(i<1)return;const k=pair.slice(0,i).trim();const v=pair.slice(i+1).trim().replace(/^"|"$/g,'');if(k)result[k]=decodeEsc(v);});
    if(result['NetflixId']) return result;
    TARGETS.forEach(k=>{const m=raw.match(new RegExp(k+'["\']?\\s*[:=]\\s*["\']?([^"\'\\s;,\\}\\]]+)','i'));if(m&&m[1])result[k]=decodeEsc(m[1].replace(/^"|"$/g,'').split('\\n')[0]);});
    return result;
}
// Route all Netflix API calls through proxy (with auto-fallback)
function httpGet(url, headers) { return proxy.httpGet(url, headers); }

function mergeCookiesIntoDict(cookieDict, headers) {
    if (!headers) return;
    const setCookies = headers['set-cookie'] || headers['Set-Cookie'] || [];
    const setCookieHeaders = Array.isArray(setCookies) ? setCookies : [setCookies];
    setCookieHeaders.forEach(header => {
        if (!header) return;
        const parts = header.split(';');
        if (parts.length > 0) {
            const pair = parts[0];
            const idx = pair.indexOf('=');
            if (idx > 0) {
                const k = pair.slice(0, idx).trim();
                const v = pair.slice(idx + 1).trim();
                if (k && !['path', 'domain', 'expires', 'maxage', 'samesite', 'secure', 'httponly'].includes(k.toLowerCase())) {
                    cookieDict[k] = v;
                }
            }
        }
    });
}

async function generateToken(cookieDict) {
    const id=cookieDict['NetflixId'];
    if(!id) throw new Error('NetflixId missing');
    const params=new URLSearchParams({appVersion:'15.48.1',config:'{"gamesInTrailersEnabled":"false","isTrailersEvidenceEnabled":"false","cdsMyListSortEnabled":"true","kidsBillboardEnabled":"true","addHorizontalBoxArtToVideoSummariesEnabled":"false","skOverlayTestEnabled":"false","homeFeedTestTVMovieListsEnabled":"false","baselineOnIpadEnabled":"true","trailersVideoIdLoggingFixEnabled":"true","postPlayPreviewsEnabled":"false","bypassContextualAssetsEnabled":"false","roarEnabled":"false","useSeason1AltLabelEnabled":"false","disableCDSSearchPaginationSectionKinds":["searchVideoCarousel"],"cdsSearchHorizontalPaginationEnabled":"true","searchPreQueryGamesEnabled":"true","kidsMyListEnabled":"true","billboardEnabled":"true","useCDSGalleryEnabled":"true","contentWarningEnabled":"true","videosInPopularGamesEnabled":"true","avifFormatEnabled":"false","sharksEnabled":"true"}',device_type:'NFAPPL-02-',esn:'NFAPPL-02-IPHONE8%3D1-PXA-02026U9VV5O8AUKEAEO8PUJETCGDD4PQRI9DEB3MDLEMD0EACM4CS78LMD334MN3MQ3NMJ8SU9O9MVGS6BJCURM1PH1MUTGDPF4S4200',idiom:'phone',iosVersion:'15.8.5',isTablet:'false',languages:'en-US',locale:'en-US',maxDeviceWidth:'375',model:'saget',modelType:'IPHONE8-1',odpAware:'true',path:'["account","token","default"]',pathFormat:'graph',pixelDensity:'2.0',progressive:'false',responseFormat:'json'});
    const headers={'User-Agent':'Argo/15.48.1 (iPhone; iOS 15.8.5; Scale/2.00)','x-netflix.request.attempt':'1','x-netflix.request.client.user.guid':'A4CS633D7VCBPE2GPK2HL4EKOE','x-netflix.context.profile-guid':'A4CS633D7VCBPE2GPK2HL4EKOE','x-netflix.request.routing':'{"path":"/nq/mobile/nqios/~15.48.0/user","control_tag":"iosui_argo"}','x-netflix.context.app-version':'15.48.1','x-netflix.argo.translated':'true','x-netflix.context.form-factor':'phone','x-netflix.context.sdk-version':'2012.4','x-netflix.client.appversion':'15.48.1','x-netflix.context.max-device-width':'375','x-netflix.context.ab-tests':'','x-netflix.tracing.cl.useractionid':'4DC655F2-9C3C-4343-8229-CA1B003C3053','x-netflix.client.type':'argo','x-netflix.client.ftl.esn':'NFAPPL-02-IPHONE8=1-PXA-02026U9VV5O8AUKEAEO8PUJETCGDD4PQRI9DEB3MDLEMD0EACM4CS78LMD334MN3MQ3NMJ8SU9O9MVGS6BJCURM1PH1MUTGDPF4S4200','x-netflix.context.locales':'en-US','x-netflix.context.top-level-uuid':'90AFE39F-ADF1-4D8A-B33E-528730990FE3','x-netflix.client.iosversion':'15.8.5','accept-language':'en-US;q=1','x-netflix.argo.abtests':'','x-netflix.context.os-version':'15.8.5','x-netflix.request.client.context':'{"appState":"foreground"}','x-netflix.context.ui-flavor':'argo','x-netflix.argo.nfnsm':'9','x-netflix.context.pixel-density':'2.0','x-netflix.request.toplevel.uuid':'90AFE39F-ADF1-4D8A-B33E-528730990FE3','x-netflix.request.client.timezoneid':'Asia/Dhaka','Cookie':`NetflixId=${id}`};
    const r=await httpGet(`https://ios.prod.ftl.netflix.com/iosui/user/15.48?${params}`,headers);
    if(r.code!==200) throw new Error(`HTTP ${r.code}`);
    mergeCookiesIntoDict(cookieDict, r.headers);
    const token=JSON.parse(r.body)?.value?.account?.token?.default?.token;
    if(!token) throw new Error('No token');
    return token;
}
async function getAccountInfo(dict) {
    const cookieStr=Object.entries(dict).map(([k,v])=>`${k}=${v}`).join('; ');
    try {
        const r=await httpGet('https://www.netflix.com/account',{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0','Cookie':cookieStr,'Accept-Language':'en-US,en;q=0.9'});
        
        let allSetCookies = [];
        if (r.headers && (r.headers['set-cookie'] || r.headers['Set-Cookie'])) {
            const sc = r.headers['set-cookie'] || r.headers['Set-Cookie'];
            if (Array.isArray(sc)) allSetCookies.push(...sc);
            else allSetCookies.push(sc);
        }

        if(r.code===302 || r.body.includes('/login') || r.body.includes('/signup') || r.body.includes('Netflix_Logon')) return {valid:false};
        const h=r.body;
        const statusMatch = h.match(/"membershipStatus"\s*:\s*"([^"]+)"/i);
        if (statusMatch && statusMatch[1] !== 'CURRENT_MEMBER') {
            return {valid:false};
        }

        const isInactiveOrUnpaid = 
            h.includes('"membershipStatus":"FORMER_MEMBER"') || 
            h.includes('"membershipStatus":"NEVER_MEMBER"') || 
            h.includes('"membershipStatus":"ACCOUNT_HOLD"') || 
            h.includes('"membershipStatus":"SUSPENDED"') || 
            h.includes('"membershipStatus":"OFFBOARDED"') || 
            h.includes('"membershipStatus":"DEFERRED"') || 
            h.includes('"membershipStatus":"PAUSED"') || 
            h.includes('"membershipStatus":"PAYMENT_ERROR"') || 
            h.includes('"membershipStatus":"DVD_ONLY"') || 
            h.includes('"membershipStatus":"PENDING"') || 
            h.includes('Restart your membership') || 
            h.includes('Restart Membership') ||
            h.includes('Recommencer l\'abonnement') || 
            h.includes('Recommencer votre abonnement') ||
            h.includes('إعادة تشغيل عضويتك') ||
            h.includes('أعد تشغيل عضويتك') ||
            h.includes('Renovar suscripción') ||
            h.includes('Reiniciar suscripción') ||
            h.includes('Vuelve a suscribirte') ||
            h.includes('Update payment') ||
            h.includes('Update payment method') ||
            h.includes('Your account is on hold') ||
            h.includes('Account on hold') ||
            h.includes('Account is on hold') ||
            h.includes('Billing problem') ||
            h.includes('العضوية متوقفة') ||
            h.includes('مشكلة في الدفع') ||
            h.includes('تحديث طريقة الدفع') ||
            h.includes('حسابك معلق') ||
            h.includes('Finish sign-up') ||
            h.includes('Finish Sign-up') ||
            h.includes('Complete sign-up') ||
            h.includes('إكمال التسجيل') ||
            h.includes('Completa tu registro') ||
            h.includes('Choose the plan that\'s right for you') ||
            h.includes('Pick your plan') ||
            h.includes('Pay to resume') ||
            h.includes('Payment error') ||
            h.includes('Payment problem') ||
            h.includes('Please update your payment') ||
            h.includes('Membership is paused') ||
            h.includes('Your membership is paused') ||
            h.includes('must pay to watch') ||
            h.includes('pay to watch') ||
            h.includes('Unpaid membership');

        if (isInactiveOrUnpaid) return {valid:false};

        const em=h.match(/"emailAddress"\s*:\s*"([^"]+)"/i);
        const pm=h.match(/"localizedPlanName"[^}]*"value"\s*:\s*"([^"]+)"/i)||h.match(/"planName"\s*:\s*"([^"]+)"/i);
        const planName = pm ? decodeEsc(pm[1]) : 'Unknown';

        // Language-independent plan normalization using streams capacity or video quality
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
            // String fallback for various languages
            const planLower = planName.toLowerCase();
            if (planLower.includes('premium') || planLower.includes('مميز') || planLower.includes('cao cấp') || planLower.includes('özel') || planLower.includes('uhd') || planLower.includes('4k')) {
                planKey = 'Premium';
            } else if (planLower.includes('standard') || planLower.includes('قياسي') || planLower.includes('standart') || planLower.includes('tiêu chuẩn') || planLower.includes('padrão') || planLower.includes('estándar') || planLower.includes('fhd') || planLower.includes('hd')) {
                planKey = 'Standard';
            } else if (planLower.includes('basic') || planLower.includes('أساسي') || planLower.includes('اساسي') || planLower.includes('temel') || planLower.includes('di động') || planLower.includes('cơ bản') || planLower.includes('básico') || planLower.includes('base') || planLower.includes('basis') || planLower.includes('essentiel')) {
                planKey = 'Basic';
            }
        }

        if (planKey === 'Unknown') return {valid:false};

        const cm = h.match(/"countryOfSignup"\s*:\s*"([^"]+)"/i) ||
                   h.match(/"signupCountry"\s*:\s*"([^"]+)"/i) ||
                   h.match(/"currentCountryOfRegistration"\s*:\s*"([^"]+)"/i) ||
                   h.match(/"countryOfRegistration"\s*:\s*"([^"]+)"/i) ||
                   h.match(/"accountCountry"\s*:\s*"([^"]+)"/i) ||
                   h.match(/"billingCountry"\s*:\s*"([^"]+)"/i);
        const bm = h.match(/"nextBillingDate"[^}]*"value"\s*:\s*"([^"]+)"/i);
        
        mergeCookiesIntoDict(dict, r.headers);
        
        return {valid:true,email:em?decodeEsc(em[1]):'Unknown',plan:planKey,country:cm?decodeEsc(cm[1]).toUpperCase():'Unknown',billing:bm?decodeEsc(bm[1]):'Unknown'};
    } catch(_){ return {valid:false}; }
}
// Timeout wrapper — prevents any single cookie check from hanging forever
function withTimeout(promise, ms = 15000) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), ms))
    ]);
}

async function checkCookie(dict) {
    try {
        await withTimeout(generateToken(dict), 12000);
        const info = await withTimeout(getAccountInfo(dict), 12000);
        if (!info.valid) {
            console.log(`[Cookie Check] Cookie invalid (login redirect or no active plan).`);
        }
        if (info.valid) {
            const updatedCookieText = Object.entries(dict).map(([k, v]) => `${k}=${v}`).join('; ');
            return { valid: true, info, updatedCookieText };
        }
        return { valid: false };
    } catch (err) {
        const msg = err.message || err;
        if (msg === 'TIMEOUT') {
            console.warn('[Cookie Check] Timed out after 12s — treating as failed.');
        } else {
            console.error('[Cookie Check Error]', msg);
        }
        return { valid: false };
    }
}

// ── Auto Cookie Check ─────────────────────────────────────────
let autoCheckTimer = null;
async function runCookieCheck(reportChatId = null, reportMsgId = null, lang = 'en') {
    const cookies = cookieStore.getAllCookies();
    if (!cookies.length) {
        if (reportChatId) bot.editMessageText(t(lang, 'cook_verify_empty'),
            { chat_id: reportChatId, message_id: reportMsgId, reply_markup: backCookiesKb(lang) });
        return;
    }

    const total = cookies.length;
    let checked = 0;

    // Live progress update every 4 seconds while checking
    const progressInterval = (reportChatId && reportMsgId) ? setInterval(async () => {
        try {
            await bot.editMessageText(
                `⏳ Checking cookies... ${checked}/${total} done`,
                { chat_id: reportChatId, message_id: reportMsgId }
            );
        } catch (_) {}
    }, 4000) : null;

    // Concurrent batches of 3 — fast but avoids rate limits
    const CONCURRENCY = 3;
    const allResults = [];

    for (let i = 0; i < cookies.length; i += CONCURRENCY) {
        const batch = cookies.slice(i, i + CONCURRENCY);
        const batchRes = await Promise.allSettled(
            batch.map(async (cookie) => {
                const dict  = parseCookies(cookie.cookie_text);
                const check = await checkCookie(dict); // has 12s timeout built-in
                checked++;
                return { cookie, check };
            })
        );
        allResults.push(...batchRes);
    }

    if (progressInterval) clearInterval(progressInterval);

    let nowActive = 0, nowExpired = 0;
    const expiredList = [], expiringList = [];

    for (const result of allResults) {
        if (result.status !== 'fulfilled') continue;
        const { cookie, check } = result.value;
        if (check.valid) {
            const info = check.info;
            cookie.status             = 'Active';
            cookie.email              = info.email;
            cookie.plan               = info.plan;
            cookie.country            = info.country;
            cookie.next_billing_date  = info.billing;
            cookie.last_checked       = new Date().toISOString();
            if (check.updatedCookieText) {
                cookie.cookie_text = check.updatedCookieText;
            }
            nowActive++;
            if (info.billing && isExpiringSoon(info.billing)) {
                expiringList.push(`${cookie.email} — ${info.billing}`);
            }
        } else {
            cookie.status       = 'Expired';
            cookie.last_checked = new Date().toISOString();
            try { await db.handleCookieExpiration(cookie.email); } catch (_) {}
            nowExpired++;
            expiredList.push(`${cookie.email}`);
        }
        cookieStore.saveCookie(cookie.email, cookie);
    }

    const escMd = (text) => (typeof text === 'string' ? text.replace(/([_*\[\]`])/g, '\\$1') : String(text));
    let lines = t(lang, 'cook_verify_result', { active: nowActive, expired: nowExpired, total });
    if (expiredList.length)  lines += '\n' + t(lang, 'cook_verify_expired')  + '\n' + expiredList.map(x  => `  • ${escMd(x)}`).join('\n');
    if (expiringList.length) lines += '\n' + t(lang, 'cook_verify_expiring') + '\n' + expiringList.map(x => `  • ${escMd(x)}`).join('\n');

    const target = reportChatId || ADMIN_ID;
    try {
        if (reportMsgId) {
            await bot.editMessageText(lines, { chat_id: target, message_id: reportMsgId, parse_mode: 'Markdown', reply_markup: backCookiesKb(lang) });
        } else {
            bot.sendMessage(target, lines, { parse_mode: 'Markdown' });
        }
    } catch (_) {
        // If edit fails (e.g. message too old), send fresh
        bot.sendMessage(target, lines, { parse_mode: 'Markdown', reply_markup: backCookiesKb(lang) });
    }
}


async function setupAutoCheck() {
    clearInterval(autoCheckTimer);
    const hrs=parseInt(await getSetting('auto_check_hours','6'));
    if(!hrs||hrs<=0){console.log('[AUTO-CHECK] Disabled.');return;}
    autoCheckTimer=setInterval(async()=>{ const lang=await getLang(); runCookieCheck(null,null,lang); }, hrs*60*60*1000);
    console.log(`[AUTO-CHECK] Scheduled every ${hrs} hour(s).`);
}
setupAutoCheck();
initProxy();

async function showManageCookiePage(chatId, cm, index, lang, s) {
    try {
        const email = getEmailFromIndex(chatId, index, s);
        if (!email) throw new Error(`Email index ${index} not found. Please reopen stats.`);
        const c = cookieStore.getCookie(email);
        if (!c) throw new Error(`Cookie for "${email}" not found in database.`);

        const billingText = getBillingStatusText(c.next_billing_date, lang);
        const planLbl = planLabel(c.plan, lang);
        const poolLbl = poolLabel(c.warranty_type, lang);

        const text = buildManageCookie({
            email:   c.email,
            plan:    planLbl,
            pool:    poolLbl,
            active:  c.active_users || 0,
            max:     c.max_users || 5,
            billing: billingText
        });

        const buttons = [
            [
                { text: t(lang, 'btn_cook_change_slots'), callback_data: `cookindiv:slots:${index}` },
                { text: t(lang, 'btn_cook_change_pool'), callback_data: `cookindiv:pool:${index}` }
            ],
            [
                { text: t(lang, 'btn_cook_verify_single'), callback_data: `cookindiv:verify:${index}` },
                { text: t(lang, 'btn_cook_delete'), callback_data: `cookindiv:del:${index}` }
            ],
            [
                { text: t(lang, 'btn_cook_back_list'), callback_data: 'cook:stats' }
            ]
        ];
        try {
            await bot.editMessageText(text, {
                chat_id: chatId,
                message_id: cm,
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: buttons }
            });
        } catch (editErr) {
            if (editErr.message && editErr.message.includes('message is not modified')) {
                try { await bot.deleteMessage(chatId, cm); } catch(_) {}
                const newMsg = await bot.sendMessage(chatId, text, {
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: buttons }
                });
                if (sessions[chatId]) sessions[chatId].consoleMsgId = newMsg.message_id;
            } else {
                throw editErr;
            }
        }
    } catch (err) {
        console.error('showManageCookiePage error:', err);
        throw err;
    }
}

async function showCookieStatsPage(chatId, cm, lang, s) {
    const rows = cookieStore.getAllCookies();
    if (!rows.length) {
        await bot.editMessageText(t(lang,'cook_stats_empty'),
            {chat_id:chatId,message_id:cm,parse_mode:'Markdown',reply_markup:backCookiesKb(lang)});
        return;
    }
    const grouped={};
    POOL_KEYS.forEach(k=>grouped[k]={active:0,expired:0});
    rows.forEach(r=>{
        const p=r.warranty_type||'1_month';
        if(!grouped[p]) grouped[p]={active:0,expired:0};
        if(r.status==='Active') grouped[p].active++;
        else grouped[p].expired++;
    });
    const totalActive  = rows.filter(r=>r.status==='Active').length;
    const totalExpired = rows.length-totalActive;
    const lines = [t(lang,'cook_stats_title',{active:totalActive,expired:totalExpired,total:rows.length})];
    POOL_KEYS.forEach(k=>{
        const g=grouped[k];
        if(g.active+g.expired===0) return;
        lines.push(t(lang,'cook_stats_row',{pool:poolLabel(k,lang),active:g.active,expired:g.expired}));
    });

    const emailList = rows.map(c => c.email);
    sessions[chatId] = {...s, activeCookiesList: emailList, consoleMsgId:cm};

    const buttons = rows.map((c, index) => {
        const planLbl = planLabel(c.plan, lang);
        const poolLbl = poolLabel(c.warranty_type, lang);
        const statusIcon = c.status === 'Active' ? '🟢' : '🔴';
        return [{
            text: `${statusIcon} ${c.email} (${planLbl}) [${poolLbl}] (${c.active_users || 0}/${c.max_users || 5})`,
            callback_data: `cookindiv:manage:${index}`
        }];
    });
    buttons.push([{ text: t(lang,'btn_back'), callback_data:'nav:cookies' }]);

    await bot.editMessageText(lines.join('\n'),
        {chat_id:chatId,message_id:cm,parse_mode:'Markdown',reply_markup:{inline_keyboard:buttons}});
}

function getEmailFromIndex(chatId, index, s) {
    let emailList = s.activeCookiesList;
    if (!emailList || !emailList[index]) {
        const rows = cookieStore.getAllCookies();
        emailList = rows.map(c => c.email);
        if (!sessions[chatId]) sessions[chatId] = {};
        sessions[chatId].activeCookiesList = emailList;
    }
    return emailList[index] || null;
}

function getBindEmailFromIndex(chatId, index, s) {
    let emailList = s.activeCookiesList;
    if (!emailList || !emailList[index]) {
        const plan = s.plan || 'Premium';
        const warranty = s.warranty || '1_month';
        const activeCookies = cookieStore.getAllCookies().filter(c => 
            c.status === 'Active' && 
            c.plan === plan && 
            c.warranty_type === warranty
        );
        emailList = activeCookies.map(c => c.email);
        if (!sessions[chatId]) sessions[chatId] = {};
        sessions[chatId].activeCookiesList = emailList;
    }
    return emailList[index] || null;
}


// ── Customer Bot Event Handlers & Logics ─────────────────────────

function detectTelegramLang(telegramUser) {
    if (!telegramUser || !telegramUser.language_code) return 'ar';
    const lc = telegramUser.language_code.toLowerCase();
    if (lc.startsWith('ar')) return 'ar';
    if (lc.startsWith('fr')) return 'fr';
    if (lc.startsWith('zh')) return 'zh';
    if (lc.startsWith('ru')) return 'ru';
    if (lc.startsWith('en')) return 'en';
    return 'ar';
}


function getJoinChannelBtnText(lang) {
    if (lang === 'ar') return '📢 انضم إلى القناة';
    if (lang === 'fr') return '📢 Rejoindre le canal';
    if (lang === 'zh') return '📢 加入频道';
    if (lang === 'ru') return '📢 Подписаться на канал';
    return '📢 Join Channel';
}


async function calculateRejoinPoints(chatId, curPoints, signupPointGiven) {
    const cdkRow = await dbGet("SELECT COUNT(*) as cnt FROM cdks WHERE created_by = ?", [String(chatId)]);
    const cdkCount = cdkRow ? cdkRow.cnt : 0;
    
    if (cdkCount > 0) {
        // User already redeemed CDK before -> cap restored points at 0.0 (cannot go to 1.0 or get free CDK)
        return Math.min(0.0, (curPoints || 0) + 1.0);
    } else if (signupPointGiven === 1) {
        // User hasn't redeemed CDK yet -> restore up to 1.0 signup point
        return Math.min(1.0, (curPoints || 0) + 1.0);
    } else {
        return Math.min(0.0, (curPoints || 0) + 1.0);
    }
}

function setupCustomerBotHandlers() {
    if (!customerBot) return;

    // A helper to verify channel membership
    async function checkChannelMembership(chatId, userLang, msgId = null) {
        console.log(`[CUSTOMER BOT] checkChannelMembership called for chat ${chatId} with lang ${userLang}, msgId: ${msgId}`);
        const channelId = await getSetting('telegram_channel_id', process.env.TELEGRAM_CHANNEL_ID || '@VXL_STORE_V1');
        if (!channelId) {
            // No required channel set, auto-verify
            await dbRun("UPDATE bot_users SET is_member = 1 WHERE chat_id = ?", [String(chatId)]);
            await giveSignupReward(chatId, userLang);
            await showCustomerMainMenu(chatId, userLang, msgId);
            return;
        }

        try {
            const userRec = await dbGet("SELECT points, is_member, leave_count, signup_point_given FROM bot_users WHERE chat_id = ?", [String(chatId)]);
            const wasActive = userRec && Number(userRec.is_member) === 1;

            const member = await customerBot.getChatMember(channelId, chatId);
            const isSubscribed = ['member', 'administrator', 'creator'].includes(member.status);
            if (isSubscribed) {
                if (!wasActive) {
                    // User was inactive (left before or new join)
                    const cdkRow = await dbGet("SELECT COUNT(*) as cnt FROM cdks WHERE created_by = ?", [String(chatId)]);
                    const cdkCount = cdkRow ? cdkRow.cnt : 0;
                    const signupGiven = userRec ? userRec.signup_point_given : 0;
                    
                    if ((userRec && userRec.leave_count > 0) || (userRec && userRec.is_member === 0)) {
                        let newPts = 0.0;
                        if (cdkCount > 0) {
                            newPts = Math.min(0.0, (userRec.points || 0) + 1.0);
                        } else if (signupGiven === 1) {
                            newPts = Math.min(1.0, (userRec.points || 0) + 1.0);
                        } else {
                            newPts = Math.min(0.0, (userRec.points || 0) + 1.0);
                        }
                        await dbRun("UPDATE bot_users SET is_member = 1, points = ? WHERE chat_id = ?", [newPts, String(chatId)]);
                        console.log(`[CUSTOMER BOT] User ${chatId} REJOINED channel (verify button). Restored points: ${newPts}`);
                        try {
                            await customerBot.sendMessage(chatId, t(userLang, 'cust_rejoined_channel', { points: newPts }), { parse_mode: 'HTML' });
                        } catch(_) {}
                    } else {
                        await dbRun("UPDATE bot_users SET is_member = 1 WHERE chat_id = ?", [String(chatId)]);
                    }
                } else {
                    await dbRun("UPDATE bot_users SET is_member = 1 WHERE chat_id = ?", [String(chatId)]);
                }
                await giveSignupReward(chatId, userLang);
                await showCustomerMainMenu(chatId, userLang, msgId);
            } else {
                // Not subscribed
                if (wasActive) {
                    const newPoints = (userRec.points || 0) - 1;
                    const newLeaveCount = (userRec.leave_count || 0) + 1;
                    await dbRun("UPDATE bot_users SET points = ?, leave_count = ?, is_member = 0 WHERE chat_id = ?", [newPoints, newLeaveCount, String(chatId)]);
                    console.log(`[CUSTOMER BOT] User ${chatId} LEFT channel. Deducted 1 point. New points: ${newPoints}`);
                    try {
                        await customerBot.sendMessage(chatId, t(userLang, 'cust_left_channel_warning', { points: newPoints }), { parse_mode: 'HTML' });
                    } catch(err) {
                        console.error('[Penalty DM Error]', err.message);
                    }
                } else {
                    await dbRun("UPDATE bot_users SET is_member = 0 WHERE chat_id = ?", [String(chatId)]);
                }
                const cleanChannel = channelId.replace('@', '');
                const channelLink = `https://t.me/${cleanChannel}`;
                const text = t(userLang, 'cust_join_channel', { channel: channelLink });
                const keyboard = {
                    inline_keyboard: [
                        [{ text: getJoinChannelBtnText(userLang), url: channelLink }],
                        [{ text: t(userLang, 'cust_btn_verify'), callback_data: 'nav:verify_join' }]
                    ]
                };
                if (msgId) {
                    await customerBot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: keyboard });
                } else {
                    await customerBot.sendMessage(chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: keyboard });
                }
            }
        } catch (err) {
            console.error('[Membership check error]', err.message);
            // Strictly block user on error (treat as not subscribed)
            await dbRun("UPDATE bot_users SET is_member = 0 WHERE chat_id = ?", [String(chatId)]);
            const cleanChannel = channelId.replace('@', '');
            const channelLink = `https://t.me/${cleanChannel}`;
            const text = t(userLang, 'cust_join_channel', { channel: channelLink }) + `\n\n⚠️ <i>(Verification error: Ensure bot is admin in ${channelId})</i>`;
            const keyboard = {
                inline_keyboard: [
                    [{ text: getJoinChannelBtnText(userLang), url: channelLink }],
                    [{ text: t(userLang, 'cust_btn_verify'), callback_data: 'nav:verify_join' }]
                ]
            };
            if (msgId) {
                await customerBot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: keyboard });
            } else {
                await customerBot.sendMessage(chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: keyboard });
            }
        }
    }

    async function giveSignupReward(chatId, userLang) {
        console.log(`[CUSTOMER BOT] giveSignupReward called for chat ${chatId}`);
        const u = await dbGet("SELECT signup_point_given, referred_by FROM bot_users WHERE chat_id = ?", [String(chatId)]);
        if (u && u.signup_point_given === 0) {
            // Give 1 signup point
            await dbRun("UPDATE bot_users SET points = points + 1.0, signup_point_given = 1 WHERE chat_id = ?", [String(chatId)]);
            await customerBot.sendMessage(chatId, t(userLang, 'cust_btn_verify_success'));

            // Process referral reward for referrer
            if (u.referred_by) {
                const referrerId = u.referred_by;
                const ref = await dbGet("SELECT lang, referrals_count FROM bot_users WHERE chat_id = ?", [String(referrerId)]);
                if (ref) {
                    const newRefCount = ref.referrals_count + 1;
                    await dbRun("UPDATE bot_users SET referrals_count = ? WHERE chat_id = ?", [newRefCount, String(referrerId)]);
                    
                    const refLang = ref.lang || 'en';
                    const finalRefForNotify = await dbGet("SELECT points FROM bot_users WHERE chat_id = ?", [String(referrerId)]);
                    const currentPoints = finalRefForNotify ? finalRefForNotify.points : 0.0;
                    const progressCount = ((newRefCount - 1) % 3) + 1;
                    await customerBot.sendMessage(referrerId, t(refLang, 'cust_ref_notify', { 
                        ref_count: progressCount,
                        points: currentPoints
                    }), { parse_mode: 'HTML' });

                    // If referrals count is multiple of 3, grant 1 point!
                    if (newRefCount % 3 === 0) {
                        await dbRun("UPDATE bot_users SET points = points + 1.0 WHERE chat_id = ?", [String(referrerId)]);
                        const finalRef = await dbGet("SELECT points FROM bot_users WHERE chat_id = ?", [String(referrerId)]);
                        await customerBot.sendMessage(referrerId, t(refLang, 'cust_ref_point_reward', { points: finalRef ? finalRef.points : 0.0 }), { parse_mode: 'HTML' });
                    }
                }
            }
        }
    }

    async function showCustomerMainMenu(chatId, userLang, msgId = null) {
        console.log(`[CUSTOMER BOT] showCustomerMainMenu called for chat ${chatId}, msgId: ${msgId}`);
        const u = await dbGet("SELECT points, referrals_count FROM bot_users WHERE chat_id = ?", [String(chatId)]);
        const points = u ? u.points : 0.0;
        const refCount = u ? (u.referrals_count % 3) : 0;
        const refLink = `https://t.me/${customerBotUsername}?start=ref_${chatId}`;

        const text = t(userLang, 'cust_main_menu', {
            points,
            ref_count: refCount,
            ref_link: refLink
        });

        const keyboard = {
            inline_keyboard: [
                [{ text: t(userLang, 'cust_btn_get_cdk'), callback_data: 'cust:get_cdk' }],
                [{ text: t(userLang, 'cust_btn_lang'), callback_data: 'cust:change_lang' },
                 { text: t(userLang, 'cust_btn_support'), callback_data: 'cust:support' }]
            ]
        };
        try {
            if (msgId) {
                console.log(`[CUSTOMER BOT] Editing main menu in chat ${chatId}, msgId ${msgId}...`);
                await customerBot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: keyboard });
            } else {
                console.log(`[CUSTOMER BOT] Sending new main menu to chat ${chatId}...`);
                await customerBot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard });
            }
        } catch (err) {
            console.error(`[CUSTOMER BOT] Failed to show main menu for chat ${chatId}:`, err.message);
        }
    }

    // Customer /start command
    customerBot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
        const chatId = msg.chat.id;
        console.log(`[CUSTOMER BOT] Received /start from chat ${chatId}. Match parameter:`, match[1]);
        const refParam = match[1]; // e.g. ref_123456
        const username = msg.chat.username || 'User';

        let user = await dbGet("SELECT lang, is_member FROM bot_users WHERE chat_id = ?", [String(chatId)]);
        
        // Proactively clean up user start commands
        try { await customerBot.deleteMessage(chatId, msg.message_id); } catch(_) {}

        if (!user) {
            // New user, register them
            let referredBy = null;
            if (refParam && refParam.startsWith('ref_')) {
                const potentialRef = refParam.split('_')[1];
                if (potentialRef !== String(chatId)) {
                    // Check if referrer exists
                    const refExists = await dbGet("SELECT chat_id FROM bot_users WHERE chat_id = ?", [String(potentialRef)]);
                    if (refExists) {
                        referredBy = potentialRef;
                    }
                }
            }

            await dbRun(
                "INSERT INTO bot_users (chat_id, username, role, created_at, points, referrals_count, referred_by, is_member, signup_point_given, lang) VALUES (?, ?, 'member', ?, 0.0, 0, ?, 0, 0, 'en')",
                [String(chatId), username, new Date().toISOString(), referredBy]
            );
            
            // Show Language Selection first
            const keyboard = {
                inline_keyboard: [
                    [{ text: '🇸🇦 العربية', callback_data: 'lang:ar' }, { text: '🇬🇧 English', callback_data: 'lang:en' }],
                    [{ text: '🇫🇷 Français', callback_data: 'lang:fr' }, { text: '🇨🇳 中文', callback_data: 'lang:zh' }],
                    [{ text: '🇷🇺 Русский', callback_data: 'lang:ru' }]
                ]
            };
            await customerBot.sendMessage(chatId, t('en', 'cust_select_lang'), { reply_markup: keyboard });
        } else {
            // Existing user, proceed to channel verification
            const userLang = user.lang || 'en';
            if (!user.lang) {
                const keyboard = {
                    inline_keyboard: [
                        [{ text: '🇸🇦 العربية', callback_data: 'lang:ar' }, { text: '🇬🇧 English', callback_data: 'lang:en' }],
                        [{ text: '🇫🇷 Français', callback_data: 'lang:fr' }, { text: '🇨🇳 中文', callback_data: 'lang:zh' }],
                        [{ text: '🇷🇺 Русский', callback_data: 'lang:ru' }]
                    ]
                };
                await customerBot.sendMessage(chatId, t('en', 'cust_select_lang'), { reply_markup: keyboard });
            } else {
                // Force a live check
                await checkChannelMembership(chatId, userLang);
            }
        }
    });

    // Customer Callback Query Handler
    customerBot.on('callback_query', async (q) => {
        const chatId = q.message.chat.id;
        const msgId = q.message.message_id;
        const action = q.data;

        await customerBot.answerCallbackQuery(q.id);

        let user = await dbGet("SELECT lang, is_member, points FROM bot_users WHERE chat_id = ?", [String(chatId)]);
        const userLang = user ? (user.lang || 'en') : 'en';

        // 1. Let lang selection and subscription checks pass without strict verification
        if (action.startsWith('lang:') || action === 'nav:verify_join') {
            if (action.startsWith('lang:')) {
                const selectedLang = action.split(':')[1];
                await dbRun("UPDATE bot_users SET lang = ? WHERE chat_id = ?", [selectedLang, String(chatId)]);
                await checkChannelMembership(chatId, selectedLang, msgId);
            } else if (action === 'nav:verify_join') {
                await checkChannelMembership(chatId, userLang, msgId);
            }
            return;
        }

        // 2. Strict live subscription verification for all other button clicks!
        const channelId = await getSetting('telegram_channel_id', process.env.TELEGRAM_CHANNEL_ID || '@VXL_STORE_V1');
        if (channelId) {
            try {
                const member = await customerBot.getChatMember(channelId, chatId);
                const isSubscribed = ['member', 'administrator', 'creator'].includes(member.status);
                if (!isSubscribed) {
                    console.log(`[CUSTOMER BOT] User ${chatId} left the channel. Locking interface.`);
                    const userRec = await dbGet("SELECT points, is_member, leave_count FROM bot_users WHERE chat_id = ?", [String(chatId)]);
                    const wasActive = userRec && Number(userRec.is_member) === 1;
                    if (wasActive) {
                        const newPoints = (userRec.points || 0) - 1;
                        const newLeaveCount = (userRec.leave_count || 0) + 1;
                        await dbRun("UPDATE bot_users SET points = ?, leave_count = ?, is_member = 0 WHERE chat_id = ?", [newPoints, newLeaveCount, String(chatId)]);
                        console.log(`[CUSTOMER BOT] User ${chatId} LEFT channel (via callback). Deducted 1 point. New points: ${newPoints}`);
                        try {
                            await customerBot.sendMessage(chatId, t(userLang, 'cust_left_channel_warning', { points: newPoints }), { parse_mode: 'HTML' });
                        } catch(err) {
                            console.error('[Penalty DM Error]', err.message);
                        }
                    } else {
                        await dbRun("UPDATE bot_users SET is_member = 0 WHERE chat_id = ?", [String(chatId)]);
                    }
                    const cleanChannel = channelId.replace('@', '');
                    const channelLink = `https://t.me/${cleanChannel}`;
                    const text = t(userLang, 'cust_join_channel', { channel: channelLink });
                    const keyboard = {
                        inline_keyboard: [
                            [{ text: getJoinChannelBtnText(userLang), url: channelLink }],
                            [{ text: t(userLang, 'cust_btn_verify'), callback_data: 'nav:verify_join' }]
                        ]
                    };
                    await customerBot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: keyboard });
                    return; // Block execution
                }
            } catch (err) {
                console.error('[Callback Live check error]', err.message);
                // Allow fallback in case of Telegram API errors
            }
        }

        // 3. Process actions after strict check passes
        if (action === 'cust:back_to_menu') {
            await showCustomerMainMenu(chatId, userLang, msgId);
            return;
        }

        if (action === 'cust:get_cdk') {
            if (user && user.points >= 1.0) {
                // Deduct point
                await dbRun("UPDATE bot_users SET points = points - 1.0 WHERE chat_id = ?", [String(chatId)]);
                
                // Generate CDK key
                const key = `NETVXL-${crypto.randomBytes(3).toString('hex').toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
                const plans = ['Premium', 'Standard', 'Basic'];
                const randomPlan = plans[Math.floor(Math.random() * plans.length)];
                try {
                    await dbRun(
                        "INSERT INTO cdks (key,status,max_users,plan_type,warranty_type,duration_days,created_at,bound_cookie_email,created_by) VALUES (?,'unused',1,?,'no_warranty',30,?,NULL,?)",
                        [key, randomPlan, new Date().toISOString(), String(chatId)]
                    );
                    
                    const congrats = t(userLang, 'cust_cdk_success', { key, plan: randomPlan });
                    const keyboard = {
                        inline_keyboard: [
                            [{ text: t(userLang, 'cust_btn_back'), callback_data: 'cust:back_to_menu' }]
                        ]
                    };
                    await customerBot.editMessageText(congrats, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: keyboard });
                } catch(err) {
                    console.error('[Auto CDK Gen error]', err);
                    await dbRun("UPDATE bot_users SET points = points + 1.0 WHERE chat_id = ?", [String(chatId)]);
                    const keyboard = {
                        inline_keyboard: [
                            [{ text: t(userLang, 'cust_btn_back'), callback_data: 'cust:back_to_menu' }]
                        ]
                    };
                    await customerBot.editMessageText(t(userLang, 'error_db'), { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: keyboard });
                }
            } else {
                const refLink = `https://t.me/${customerBotUsername}?start=ref_${chatId}`;
                const text = t(userLang, 'cust_not_enough_points', { ref_link: refLink });
                const keyboard = {
                    inline_keyboard: [
                        [{ text: t(userLang, 'cust_btn_back'), callback_data: 'cust:back_to_menu' }]
                    ]
                };
                await customerBot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: keyboard });
            }
            return;
        }

        if (action === 'cust:change_lang') {
            const keyboard = {
                inline_keyboard: [
                    [{ text: '🇸🇦 العربية', callback_data: 'lang:ar' }, { text: '🇬🇧 English', callback_data: 'lang:en' }],
                    [{ text: '🇫🇷 Français', callback_data: 'lang:fr' }, { text: '🇨🇳 中文', callback_data: 'lang:zh' }],
                    [{ text: '🇷🇺 Русский', callback_data: 'lang:ru' }],
                    [{ text: t(userLang, 'cust_btn_back'), callback_data: 'cust:back_to_menu' }]
                ]
            };
            await customerBot.editMessageText(t(userLang, 'cust_select_lang'), { chat_id: chatId, message_id: msgId, reply_markup: keyboard });
            return;
        }

        if (action === 'cust:support') {
            const adminUser = '@V_X_L1'; // Support contact
            const text = t(userLang, 'cust_support_msg', { admin: adminUser });
            const keyboard = {
                inline_keyboard: [
                    [{ text: t(userLang, 'cust_btn_back'), callback_data: 'cust:back_to_menu' }]
                ]
            };
            await customerBot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: keyboard });
            return;
        }
    });

    // Daily broadcast task scheduler
    async function runDailyBroadcast() {
        console.log('[BROADCAST] Running check for daily broadcast...');
        const now = new Date();
        const lastBroadcastVal = await getSetting('last_daily_broadcast_time', null);
        
        let shouldBroadcast = false;
        if (!lastBroadcastVal) {
            shouldBroadcast = true;
        } else {
            const lastBroadcastDate = new Date(lastBroadcastVal);
            const diffMs = now - lastBroadcastDate;
            const diffHours = diffMs / (1000 * 60 * 60);
            if (diffHours >= 24) {
                shouldBroadcast = true;
            }
        }

        if (shouldBroadcast) {
            console.log('[BROADCAST] Starting daily broadcast to all users...');
            const users = await dbAll("SELECT chat_id, lang FROM bot_users WHERE role = 'member'");
            
            // Update the setting immediately so if there is a restart during broadcast, we don't start over
            await dbRun("INSERT OR REPLACE INTO settings (key, value) VALUES ('last_daily_broadcast_time', ?)", [now.toISOString()]);

            for (const user of users) {
                const targetChatId = user.chat_id;
                const userLang = user.lang || 'en';
                const refLink = `https://t.me/${customerBotUsername}?start=ref_${targetChatId}`;
                const text = t(userLang, 'cust_daily_broadcast', { ref_link: refLink });
                
                try {
                    // Send broadcast message to customer
                    await customerBot.sendMessage(targetChatId, text, { parse_mode: 'HTML' });
                    // Delay for rate limiting (max 30 msgs per sec -> 50ms delay)
                    await new Promise(resolve => setTimeout(resolve, 50));
                } catch (err) {
                    console.error(`[BROADCAST] Failed to send broadcast to user ${targetChatId}:`, err.message);
                }
            }
            console.log('[BROADCAST] Daily broadcast finished.');
        } else {
            console.log('[BROADCAST] Daily broadcast not due yet.');
        }
    }

    // Run the check every 30 minutes
    setInterval(runDailyBroadcast, 30 * 60 * 1000);
    // Also run it 15 seconds after startup
    setTimeout(runDailyBroadcast, 15 * 1000);

    // ═══ Channel Membership Polling (Anti-Exploit) ═══════════════
    // Checks every 5 minutes if users left the channel
    // More reliable than chat_member event (which needs bot admin)
    async function runChannelMembershipCheck() {
        try {
            const channelId = await getSetting('telegram_channel_id', process.env.TELEGRAM_CHANNEL_ID || '@VXL_STORE_V1');
            if (!channelId) return;

            // Get all active members
            const users = await dbAll(
                "SELECT chat_id, lang, points, is_member, join_count, leave_count FROM bot_users WHERE role = 'member'",
                []
            );
            if (!users.length) return;

            console.log('[ChannelCheck] Checking ' + users.length + ' users in ' + channelId);

            const ACTIVE = ['member', 'administrator', 'creator'];

            for (const user of users) {
                try {
                    const member = await customerBot.getChatMember(channelId, user.chat_id);
                    const isNowActive = ACTIVE.includes(member.status);
                    const wasActive   = user.is_member === 1;

                    if (wasActive && !isNowActive) {
                        // User LEFT since last check
                        const newPoints    = (user.points || 0) - 1;
                        const newLeaveCount = (user.leave_count || 0) + 1;
                        await dbRun(
                            'UPDATE bot_users SET points=?, leave_count=?, is_member=0 WHERE chat_id=?',
                            [newPoints, newLeaveCount, user.chat_id]
                        );
                        console.log('[ChannelCheck] ' + user.chat_id + ' LEFT. Points=' + newPoints);
                        // Send DM warning
                        try {
                            const userLang = user.lang || 'en';
                            await customerBot.sendMessage(
                                user.chat_id,
                                t(userLang, 'cust_left_channel_warning', { points: newPoints }),
                                { parse_mode: 'HTML' }
                            );
                        } catch(_) {}

                    } else if (!wasActive && isNowActive) {
                        // User REJOINED since last check
                        const cdkRow = await dbGet("SELECT COUNT(*) as cnt FROM cdks WHERE created_by = ?", [String(user.chat_id)]);
                        const cdkCount = cdkRow ? cdkRow.cnt : 0;
                        const signupGiven = user.signup_point_given || 0;
                        let newPoints = 0.0;
                        if (cdkCount > 0) {
                            newPoints = Math.min(0.0, (user.points || 0) + 1.0);
                        } else if (signupGiven === 1) {
                            newPoints = Math.min(1.0, (user.points || 0) + 1.0);
                        } else {
                            newPoints = Math.min(0.0, (user.points || 0) + 1.0);
                        }
                        const newJoinCount = (user.join_count || 0) + 1;
                        await dbRun(
                            'UPDATE bot_users SET points=?, join_count=?, is_member=1 WHERE chat_id=?',
                            [newPoints, newJoinCount, user.chat_id]
                        );
                        console.log('[ChannelCheck] ' + user.chat_id + ' REJOINED. Points=' + newPoints);
                        // Notify if this is a return (had left before)
                        if ((user.leave_count || 0) > 0) {
                            try {
                                const userLang = user.lang || 'en';
                                await customerBot.sendMessage(
                                    user.chat_id,
                                    t(userLang, 'cust_rejoined_channel', { points: newPoints }),
                                    { parse_mode: 'HTML' }
                                );
                            } catch(_) {}
                        }
                    }

                    // Throttle to avoid hitting Telegram rate limits
                    await new Promise(r => setTimeout(r, 100));
                } catch(userErr) {
                    // User might have blocked the bot — skip silently
                }
            }
            console.log('[ChannelCheck] Done.');
        } catch(err) {
            console.error('[ChannelCheck] Error:', err.message);
        }
    }

    // Run every 5 minutes
    setInterval(runChannelMembershipCheck, 60 * 1000);
    // Run 30 seconds after startup
    setTimeout(runChannelMembershipCheck, 30 * 1000);


}

async function triggerCookiesUpdateBroadcast() {
    if (!customerBot) {
        console.warn('[BROADCAST] Cannot start cookie update broadcast: customerBot is not initialized.');
        return;
    }
    console.log('[BROADCAST] Starting cookie update notification broadcast to all users...');
    try {
        const users = await dbAll("SELECT chat_id, lang FROM bot_users WHERE role = 'member'");
        console.log(`[BROADCAST] Found ${users.length} users to notify.`);
        for (const user of users) {
            const targetChatId = user.chat_id;
            const userLang = user.lang || 'en';
            const refLink = `https://t.me/${customerBotUsername}?start=ref_${targetChatId}`;
            const text = t(userLang, 'cust_cookies_updated', { ref_link: refLink });
            try {
                await customerBot.sendMessage(targetChatId, text, { parse_mode: 'HTML' });
                // Delay for rate limiting
                await new Promise(resolve => setTimeout(resolve, 50));
            } catch (err) {
                console.error(`[BROADCAST] Failed to send update notify to user ${targetChatId}:`, err.message);
            }
        }
        console.log('[BROADCAST] Cookie update notification broadcast finished.');
    } catch (err) {
        console.error('[BROADCAST] Error during cookie update broadcast:', err.message);
    }
}

module.exports = { triggerCookiesUpdateBroadcast };
