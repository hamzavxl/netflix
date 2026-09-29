/**
 * customEmoji.js — Telegram Premium Custom Animated Emojis
 * Netflix-themed animated emojis for NETVXL Bot
 *
 * Usage in HTML parse_mode messages:
 *   ce('fire')  →  <tg-emoji emoji-id="5773790684420361225">🔥</tg-emoji>
 *
 * Falls back to regular emoji for non-Premium users automatically.
 */

// ── Netflix-Themed Custom Emoji IDs ──────────────────────────────
// These are from Telegram's built-in animated emoji packs
const EMOJI_MAP = {
    // Core Netflix/Streaming
    netflix:     { id: '5237699328522921681', fallback: '🎬' }, // Clapperboard
    tv:          { id: '5368324170671202286', fallback: '📺' }, // TV
    play:        { id: '5373141891321020908', fallback: '▶️' }, // Play button
    crown:       { id: '5371862875350312556', fallback: '👑' }, // Premium Crown
    diamond:     { id: '5434205371143692640', fallback: '💎' }, // Diamond
    star:        { id: '5368324170671202286', fallback: '⭐' }, // Star

    // Status Icons
    active:      { id: '5287399242813702049', fallback: '🟢' }, // Green circle
    expired:     { id: '5287399242813702049', fallback: '🔴' }, // Red circle
    fire:        { id: '5773790684420361225', fallback: '🔥' }, // Fire
    check:       { id: '5377855756482607120', fallback: '✅' }, // Check
    cross:       { id: '5382210502665158440', fallback: '❌' }, // Cross
    warning:     { id: '5367867912225213290', fallback: '⚠️' }, // Warning
    info:        { id: '5372872823904081067', fallback: 'ℹ️' }, // Info
    lock:        { id: '5373107619886432864', fallback: '🔐' }, // Lock

    // Management
    key:         { id: '5372888565419418038', fallback: '🔑' }, // Key
    cookie:      { id: '5373010218445595220', fallback: '🍪' }, // Cookie
    gift:        { id: '5373010218445595220', fallback: '🎁' }, // Gift
    settings:    { id: '5370869711888741447', fallback: '⚙️' }, // Settings
    users:       { id: '5373141891321020908', fallback: '👥' }, // Users
    stats:       { id: '5368324170671202286', fallback: '📊' }, // Stats
    list:        { id: '5373107619886432864', fallback: '📋' }, // List
    search:      { id: '5373141891321020908', fallback: '🔍' }, // Search
    trash:       { id: '5382210502665158440', fallback: '🗑️' }, // Trash
    back:        { id: '5373107619886432864', fallback: '⬅️' }, // Back

    // Misc
    clock:       { id: '5368324170671202286', fallback: '⏳' }, // Hourglass
    calendar:    { id: '5368324170671202286', fallback: '📅' }, // Calendar
    email:       { id: '5373107619886432864', fallback: '📧' }, // Email
    shield:      { id: '5434205371143692640', fallback: '🛡️' }, // Shield
    rocket:      { id: '5773790684420361225', fallback: '🚀' }, // Rocket
    wave:        { id: '5373141891321020908', fallback: '👋' }, // Wave
    sparkle:     { id: '5368324170671202286', fallback: '✨' }, // Sparkle

    // Numbers / Indicators
    dot_red:     { id: '5287399242813702049', fallback: '🔴' },
    dot_green:   { id: '5287399242813702049', fallback: '🟢' },
    dot_orange:  { id: '5287399242813702049', fallback: '🟡' },
};

/**
 * Generate a single custom emoji HTML tag
 * @param {string} name - emoji name from EMOJI_MAP
 * @returns {string} HTML custom emoji tag
 */
function ce(name) {
    const e = EMOJI_MAP[name];
    if (!e) return name; // fallback: return name as-is
    return `<tg-emoji emoji-id="${e.id}">${e.fallback}</tg-emoji>`;
}

/**
 * Generate multiple custom emojis as a space-separated string
 * @param {...string} names - emoji names
 * @returns {string}
 */
function ces(...names) {
    return names.map(n => ce(n)).join('');
}

/**
 * Escape HTML special characters for safe HTML mode messages
 * @param {string} text
 * @returns {string}
 */
function esc(text) {
    if (typeof text !== 'string') return String(text);
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Bold text in HTML mode
 */
function b(text) { return `<b>${esc(text)}</b>`; }

/**
 * Italic text in HTML mode
 */
function i(text) { return `<i>${esc(text)}</i>`; }

/**
 * Code/monospace text in HTML mode
 */
function code(text) { return `<code>${esc(text)}</code>`; }

/**
 * Build the main console message with custom emojis (HTML mode)
 */
function buildMainConsole(lang) {
    if (lang === 'ar') {
        return [
            `${ce('netflix')} <b>NETVXL — لوحة التحكم</b>`,
            '',
            `${ce('wave')} أهلاً بك في نظام إدارة Netflix CDK`,
            '',
            `${ce('key')} <b>CDK</b> — إنشاء وإدارة مفاتيح الاشتراك`,
            `${ce('cookie')} <b>Cookies</b> — رفع والتحقق من حسابات Netflix`,
            `${ce('settings')} <b>Settings</b> — إعداد الفحص التلقائي والحدود`,
        ].join('\n');
    }
    if (lang === 'fr') {
        return [
            `${ce('netflix')} <b>NETVXL — Console de Gestion</b>`,
            '',
            `${ce('wave')} Bienvenue dans le système de gestion Netflix CDK`,
            '',
            `${ce('key')} <b>CDK</b> — Créer et gérer les clés d'abonnement`,
            `${ce('cookie')} <b>Cookies</b> — Importer et vérifier les comptes Netflix`,
            `${ce('settings')} <b>Settings</b> — Configurer la vérification automatique`,
        ].join('\n');
    }
    // English (default)
    return [
        `${ce('netflix')} <b>NETVXL — Management Console</b>`,
        '',
        `${ce('wave')} Welcome to the Netflix CDK Management System`,
        '',
        `${ce('key')} <b>CDK</b> — Create &amp; manage subscription keys`,
        `${ce('cookie')} <b>Cookies</b> — Upload &amp; verify Netflix accounts`,
        `${ce('settings')} <b>Settings</b> — Configure auto-check &amp; limits`,
    ].join('\n');
}

/**
 * Build CDK menu message with custom emojis (HTML mode)
 */
function buildCdkMenu(lang) {
    if (lang === 'ar') return `${ce('key')} <b>إدارة مفاتيح CDK</b>\n\nاختر إجراءً:`;
    if (lang === 'fr') return `${ce('key')} <b>Gestion des Clés CDK</b>\n\nChoisissez une action:`;
    return `${ce('key')} <b>CDK Key Management</b>\n\nChoose an action:`;
}

/**
 * Build Cookies menu message with custom emojis (HTML mode)
 */
function buildCookiesMenu(lang) {
    if (lang === 'ar') return `${ce('cookie')} <b>إدارة الكوكيز</b>\n\nاختر قسماً أو ارفع ملف:`;
    if (lang === 'fr') return `${ce('cookie')} <b>Gestion des Cookies</b>\n\nChoisissez une section ou importez:`;
    return `${ce('cookie')} <b>Cookie Management</b>\n\nChoose a section or upload a file:`;
}

/**
 * Build cookie stats message with custom emojis (HTML mode)
 * @param {Object} stats - { totalActive, totalExpired, total, groups }
 * @param {string} lang
 */
function buildCookieStats(stats, lang) {
    const { totalActive, totalExpired, total } = stats;
    const lines = [
        `${ce('stats')} <b>Cookie Statistics by Pool</b>`,
        '',
        `• Total ${ce('active')} Active: <b>${totalActive}</b> | ${ce('expired')} Expired: <b>${totalExpired}</b> | All: <b>${total}</b>`,
    ];
    return lines.join('\n');
}

/**
 * Build manage cookie page with custom emojis (HTML mode)
 */
function buildManageCookie({ email, plan, pool, active, max, billing }) {
    return [
        `${ce('email')} <b>Manage Account</b>`,
        '',
        `${ce('email')} Email: <code>${esc(email)}</code>`,
        `${ce('crown')} Plan: <b>${esc(plan)}</b>`,
        `${ce('shield')} Warranty Pool: <b>${esc(pool)}</b>`,
        `${ce('users')} Slots: <b>${active}/${max}</b>`,
        `${ce('calendar')} Billing: <b>${esc(billing)}</b>`,
    ].join('\n');
}

module.exports = { ce, ces, esc, b, i, code, buildMainConsole, buildCdkMenu, buildCookiesMenu, buildCookieStats, buildManageCookie, EMOJI_MAP };
