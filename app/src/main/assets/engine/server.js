#!/usr/bin/env node

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const events = require('events');
const { spawnSync } = require('child_process');
const { solvePOW } = require('./lib/pow');
const { loadDotEnv } = require('./lib/env');

if (require.main === module) loadDotEnv(path.join(__dirname, '.env'));

function envNumber(name, fallback, min = 0) {
    const raw = process.env[name];
    const value = raw === undefined || String(raw).trim() === '' ? NaN : Number(raw);
    return Number.isFinite(value) ? Math.max(min, value) : fallback;
}

const DS_BASE_URL = String(process.env.DEEPSEEK_BASE_URL || 'https://chat.deepseek.com').replace(/\/+$/, '');
function dsUrl(pathname) { return `${DS_BASE_URL}${pathname}`; }

const DS_FETCH_TIMEOUT_MS = envNumber('DEEPSEEK_FETCH_TIMEOUT_MS', 60000, 1000);
const DS_STREAM_IDLE_TIMEOUT_MS = envNumber('DEEPSEEK_STREAM_IDLE_TIMEOUT_MS', DS_FETCH_TIMEOUT_MS, 1000);
const DS_STREAM_MAX_MS = envNumber('DEEPSEEK_STREAM_MAX_MS', 10 * 60 * 1000, 1000);
const STREAM_KEEPALIVE_MS = envNumber('DEEPSEEK_STREAM_KEEPALIVE_MS', 10000, 1000);
function timeoutError(message) {
    const error = new Error(message);
    error.name = 'TimeoutError';
    return error;
}

function followSignal(controller, signal) {
    if (!signal) return;
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
}

function throwIfAborted(signal) {
    if (signal?.aborted) throw signal.reason || new Error('request aborted');
}

function dsFetch(url, options = {}, timeoutMs = DS_FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    followSignal(controller, options.signal);
    followSignal(controller, AbortSignal.timeout(timeoutMs));
    return fetch(url, { ...options, signal: controller.signal });
}

async function dsFetchStream(url, options = {}) {
    const controller = new AbortController();
    followSignal(controller, options.signal);
    const connectTimer = setTimeout(() => controller.abort(timeoutError(`DeepSeek did not respond within ${DS_FETCH_TIMEOUT_MS}ms`)), DS_FETCH_TIMEOUT_MS);
    try {
        const resp = await fetch(url, { ...options, signal: controller.signal });
        resp.abortController = controller;
        return resp;
    } finally {
        clearTimeout(connectTimer);
    }
}

async function readUpstreamText(resp, timeoutMs = DS_FETCH_TIMEOUT_MS) {
    const timer = setTimeout(() => resp.abortController?.abort(timeoutError(`DeepSeek error body not received within ${timeoutMs}ms`)), timeoutMs);
    try {
        return await resp.text();
    } catch (error) {
        return '';
    } finally {
        clearTimeout(timer);
    }
}

async function* readStreamWithTimeouts(resp) {
    const controller = resp.abortController;
    const body = resp.body;
    if (!body) return;
    if (!controller) { yield* body; return; }
    let idleTimer = null;
    const armIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => controller.abort(timeoutError(`DeepSeek stream was idle for ${DS_STREAM_IDLE_TIMEOUT_MS}ms`)), DS_STREAM_IDLE_TIMEOUT_MS);
    };
    const maxTimer = setTimeout(() => controller.abort(timeoutError(`DeepSeek stream exceeded ${DS_STREAM_MAX_MS}ms`)), DS_STREAM_MAX_MS);
    armIdle();
    try {
        for await (const chunk of body) {
            armIdle();
            yield chunk;
        }
    } catch (error) {
        throw controller.signal.aborted && controller.signal.reason ? controller.signal.reason : error;
    } finally {
        clearTimeout(idleTimer);
        clearTimeout(maxTimer);
    }
}

const SERVER_HOST = os.hostname();
const SERVER_PUBLIC_IP = (() => {
    try {
        const interfaces = os.networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                if (iface.family === 'IPv4' && !iface.internal) return iface.address;
            }
        }
    } catch (e) {}
    return 'localhost';
})();

const PORT = Number(process.env.PORT || 9655);
const HOST = process.env.HOST || '127.0.0.1';

function loadProxyApiKey(env = process.env) {
    if (env.PROXY_API_KEY) return String(env.PROXY_API_KEY);
    const secretPath = String(env.PROXY_API_KEY_FILE || '').trim();
    if (!secretPath) return '';
    try {
        return fs.readFileSync(secretPath, 'utf8').trim();
    } catch (error) {
        if (error.code === 'ENOENT') return '';
        throw new Error(`Could not read PROXY_API_KEY_FILE (${secretPath}): ${error.message}`);
    }
}

function requireProxyApiKey(key, required) {
    if (required && !key) {
        throw new Error('PROXY_API_KEY is required. Set PROXY_API_KEY or mount a secret and set PROXY_API_KEY_FILE.');
    }
}

const PROXY_API_KEY = loadProxyApiKey();
const PROXY_CORS_ORIGINS = new Set(String(process.env.PROXY_CORS_ORIGINS || '')
    .split(',')
    .map(value => normalizeOrigin(value))
    .filter(Boolean));
function printBanner() { console.log('DeepSeek Pocket · API'); }
function prompt(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
}
function isTruthy(value) { return typeof value === 'string' && ['1','true','yes','on'].includes(value.trim().toLowerCase()); }

function isProxyKeyMatch(suppliedKey, expectedKey) {
    if (typeof suppliedKey !== 'string') return false;
    const supplied = Buffer.from(suppliedKey, 'utf8');
    const expected = Buffer.from(String(expectedKey), 'utf8');
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function isProxyAuthorized(authorization, expectedKey = PROXY_API_KEY, apiKeyHeader = undefined) {
    if (!expectedKey) return true;
    if (typeof authorization === 'string' && authorization.startsWith('Bearer ')
        && isProxyKeyMatch(authorization.slice('Bearer '.length), expectedKey)) {
        return true;
    }
    return isProxyKeyMatch(apiKeyHeader, expectedKey);
}

function isLoopbackHost(host) {
    const normalized = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
    return normalized === '127.0.0.1'
        || normalized === '::1'
        || normalized === '::ffff:127.0.0.1'
        || normalized === 'localhost';
}

function normalizeOrigin(origin) {
    const value = String(origin || '').trim().replace(/\/+$/, '');
    if (!value) return '';
    try {
        const parsed = new URL(value);
        return parsed.origin === 'null' ? value : parsed.origin;
    } catch (e) {
        return value;
    }
}

const PROXY_CORS_ALLOW_ANY=isTruthy(process.env.PROXY_CORS_ALLOW_ANY);
function isBrowserOriginAllowed(origin, allowedOrigins = PROXY_CORS_ORIGINS) {
    if (!origin) return true;
    const normalized = normalizeOrigin(origin);
    if (allowedOrigins.has(normalized)) return true;
    try {
        const parsed = new URL(normalized);
        return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
            && (PROXY_CORS_ALLOW_ANY||isLoopbackHost(parsed.hostname));
    } catch (e) {
        return false;
    }
}

const CONTEXT_COMPACTED_HEADER = 'X-Pocket-Context-Compacted';
function setCorsResponseHeaders(res, requestedHeaders = '') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    const extra=String(requestedHeaders).split(',').map(value=>value.trim()).filter(value=>/^[a-z0-9-]+$/i.test(value));
    res.setHeader('Access-Control-Allow-Headers', ['Content-Type','Authorization','x-api-key','anthropic-version','anthropic-beta','x-agent-session',...extra].join(', '));
    res.setHeader('Access-Control-Expose-Headers', CONTEXT_COMPACTED_HEADER);
}
function markContextCompacted(res) {
    if (!res.headersSent) res.setHeader(CONTEXT_COMPACTED_HEADER, 'true');
}

const STATS_FILE=process.env.POCKET_STATS_FILE;
let totalMessages=0;
try { if(STATS_FILE)totalMessages=JSON.parse(fs.readFileSync(STATS_FILE,'utf8')).totalMessages||0; } catch {}
function countMessage(){
 totalMessages++;
 if(STATS_FILE)try { fs.writeFileSync(STATS_FILE+'.tmp',JSON.stringify({totalMessages}),{mode:0o600});fs.renameSync(STATS_FILE+'.tmp',STATS_FILE); }catch(error){console.error('[DS-API] Could not save message count:',error.message);}
}
const sessions = new Map();
const MAX_HISTORY_LENGTH = 15;
const MAX_HISTORY_CHARS = 10000;
const MAX_HISTORY_ENTRY_CHARS = 2000;
const MAX_MESSAGE_DEPTH = 100;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

const DS_CONFIG_PATH = process.env.DEEPSEEK_AUTH_PATH || path.join(__dirname, 'deepseek-auth.json');
const DEFAULT_ACCOUNT_COOLDOWN_MS = Number(process.env.DEEPSEEK_ACCOUNT_COOLDOWN_MS || 10 * 60 * 1000);
let DS_CONFIG = {};
let dsHeaders = {};
const accounts = [];
let accountRoundRobin = 0;
let inFlight = 0;
const REQUEST_DEADLINE_MS = Number(process.env.DEEPSEEK_REQUEST_DEADLINE_MS || 120000);
const MAX_CONCURRENT = Number(process.env.DEEPSEEK_MAX_CONCURRENT || 24);
const configuredEmptyRetries = Number(process.env.DEEPSEEK_MAX_RETRIES);
const MAX_EMPTY_RETRIES = Number.isFinite(configuredEmptyRetries)
    ? Math.max(0, Math.min(10, Math.floor(configuredEmptyRetries)))
    : 2;
const MIN_UPSTREAM_PROMPT_CHARS = 16000;
const MAX_UPSTREAM_PROMPT_CHARS = Number.MAX_SAFE_INTEGER;
const MAX_SESSION_CONTEXT_CHARS = Number.MAX_SAFE_INTEGER;
const RATE_LIMIT_COOLDOWN_MS = envNumber('DEEPSEEK_RATE_LIMIT_COOLDOWN_MS', 60 * 1000, 1000);
const DS_CLIENT_VERSION = process.env.DEEPSEEK_CLIENT_VERSION || '2.0.0';
function imageUploadEnabled(env = process.env) {
    const value = env.DEEPSEEK_IMAGE_UPLOAD;
    return value === undefined ? true : isTruthy(String(value));
}
const IMAGE_UPLOAD_ENABLED = imageUploadEnabled();
const MAX_IMAGES_PER_REQUEST = Math.floor(envNumber('DEEPSEEK_MAX_IMAGES', 4, 1));
const MAX_IMAGE_BYTES = Math.floor(envNumber('DEEPSEEK_MAX_IMAGE_BYTES', 7 * 1024 * 1024, 1024));
const DS_FILE_TIMEOUT_MS = envNumber('DEEPSEEK_FILE_TIMEOUT_MS', 60000, 1000);
const DS_FILE_POLL_MS = envNumber('DEEPSEEK_FILE_POLL_MS', 1000, 50);
const COMPLETION_PATH = '/api/v0/chat/completion';
const FILE_UPLOAD_PATH = '/api/v0/file/upload_file';
function buildBaseHeaders(config = DS_CONFIG) {
    return {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
        "x-client-platform": "web",
        "x-client-version": DS_CLIENT_VERSION,
        "x-client-locale": "ru",
        "x-client-timezone-offset": "14400",
        "x-app-version": DS_CLIENT_VERSION,
        "Authorization": `Bearer ${config.token || ''}`,
        "x-hif-dliq": config.hif_dliq || '',
        "x-hif-leim": config.hif_leim || '',
        "Origin": "https://chat.deepseek.com",
        "Referer": "https://chat.deepseek.com/",
        "Cookie": config.cookie || '',
        "Content-Type": "application/json",
    };
}
function discoverAuthPaths() {
    if (process.env.DEEPSEEK_AUTH_DIR) {
        try {
            return fs.readdirSync(process.env.DEEPSEEK_AUTH_DIR)
                .filter(f => f.endsWith('.json'))
                .sort()
                .map(f => path.join(process.env.DEEPSEEK_AUTH_DIR, f));
        } catch (e) {
            console.error(`[DS-API] Could not read DEEPSEEK_AUTH_DIR: ${e.message}`);
            return [];
        }
    }
    if (process.env.DEEPSEEK_AUTH_PATH && process.env.DEEPSEEK_AUTH_PATH.includes(',')) {
        return process.env.DEEPSEEK_AUTH_PATH.split(',').map(s => s.trim()).filter(Boolean);
    }
    return [DS_CONFIG_PATH];
}
function loadDeepSeekConfig({ fatal = true } = {}) {
    accounts.length = 0;
    const paths = discoverAuthPaths();
    for (const file of paths) {
        try {
            const raw = fs.readFileSync(file, 'utf8');
            const config = JSON.parse(raw);
            const id = `account_${accounts.length + 1}`;
            accounts.push({ id, file, config, headers: buildBaseHeaders(config), cooldownUntil: 0, failures: 0, lastUsedAt: 0 });
        } catch (e) {
            console.error(`[DS-API] Could not load auth config ${file}: ${e.message}`);
        }
    }
    DS_CONFIG = accounts[0]?.config || {};
    dsHeaders = accounts[0]?.headers || buildBaseHeaders({});
    if (accounts.length > 0) {
        console.log(`[DS-API] Loaded ${accounts.length} auth account(s): ${accounts.map(a => a.id).join(', ')}`);
        return true;
    }
    if (fatal) {
        console.error(`[DS-API] FATAL: Could not load any auth config. Expected ${paths.join(', ') || DS_CONFIG_PATH}`);
        process.exit(1);
    }
    return false;
}
function hasAuthConfig() { return accounts.some(a => a.config.token && a.config.cookie); }
function accountStatus(account) {
    return {
        id: account.id,
        ready: !!(account.config.token && account.config.cookie),
        cooldown: account.cooldownUntil > Date.now(),
        cooldown_remaining_sec: Math.max(0, Math.ceil((account.cooldownUntil - Date.now()) / 1000)),
        failures: account.failures,
        last_used_at: account.lastUsedAt || null,
    };
}
function selectAccountForSession(session) {
    const now = Date.now();
    if (session.accountId) {
        const sticky = accounts.find(a => a.id === session.accountId);
        if (sticky && sticky.config.token && sticky.config.cookie && sticky.cooldownUntil <= now) return sticky;
    }
    const ready = accounts.filter(a => a.config.token && a.config.cookie && a.cooldownUntil <= now);
    if (ready.length > 0 && session.accountId) {
        resetRemoteSession(session);
        session.accountId = null;
    }
    if (ready.length === 0) {
        const waiting = accounts.filter(a => a.config.token && a.config.cookie).sort((a, b) => a.cooldownUntil - b.cooldownUntil)[0];
        if (waiting) {
            const waitSec = Math.max(1, Math.ceil((waiting.cooldownUntil - now) / 1000));
            const err = new Error(`All DeepSeek auth accounts are cooling down. Retry in ~${waitSec}s or import a fresh account with npm run auth:import.`);
            err.status = 429; err.retryAfter = waitSec; err.type = 'rate_limit';
            throw err;
        }
        const noAuth = new Error('No valid DeepSeek auth accounts. Run npm run auth or npm run auth:import.');
        noAuth.status = 503; noAuth.type = 'no_auth';
        throw noAuth;
    }
    const account = ready[accountRoundRobin % ready.length];
    accountRoundRobin++;
    session.accountId = account.id;
    return account;
}
function parseRetryAfterMs(retryAfterRaw) {
    if (!retryAfterRaw) return null;
    const raw = String(retryAfterRaw).trim();
    if (/^\d+$/.test(raw)) return Math.max(1000, Number(raw) * 1000);
    const t = Date.parse(raw);
    if (!Number.isNaN(t)) return Math.max(1000, t - Date.now());
    return null;
}
function markAccountFailure(account, status, reason = '', retryAfterRaw = null, fallbackCooldownMs = DEFAULT_ACCOUNT_COOLDOWN_MS) {
    if (!account) return;
    account.failures++;
    if ([401, 403, 429].includes(Number(status))) {
        const retryMs = Number(status) === 429 ? parseRetryAfterMs(retryAfterRaw) : null;
        const cooldownMs = retryMs != null ? retryMs : fallbackCooldownMs;
        account.cooldownUntil = Date.now() + cooldownMs;
        console.log(`[account:${account.id}] cooldown for ${Math.round(cooldownMs / 1000)}s after HTTP ${status}${reason ? ` (${reason})` : ''}${retryMs != null ? ' (Retry-After)' : ''}`);
    }
}
function hasOtherReadyAccount(accountId, now = Date.now()) {
    return accounts.some(a => a.id !== accountId && a.config.token && a.config.cookie && a.cooldownUntil <= now);
}
function isAccountLevelError(error) {
    return [401, 403, 429].includes(Number(error?.status));
}
async function readDeepSeekJsonResponse(resp, label, account) {
    const text = await resp.text();
    let json = null;
    if (text) {
        try { json = JSON.parse(text); }
        catch (e) {
            markAccountFailure(account, resp.status, label);
            throw new Error(`DeepSeek returned non-JSON ${label} response (HTTP ${resp.status}). Run npm run doctor. First chars: ${text.substring(0, 120)}`);
        }
    }
    if (!resp.ok) markAccountFailure(account, resp.status, label);
    return { json, text };
}
if (require.main === module) {
    loadDeepSeekConfig({ fatal: false });
}

function createSession() {
    return {
        id: null,
        parentMessageId: null,
        createdAt: null,
        messageCount: 0,
        accountId: null,
        history: [],
        lastActivityAt: Date.now(),
        sentMessageKeys: [],
        contextKey: null,
        remoteChars: 0,
        busy: false,
    };
}

function resetRemoteSession(session) {
    const failed = {
        failedSessionId: session.id,
        failedMessageCount: session.messageCount,
        accountId: session.accountId,
    };
    session.id = null;
    session.parentMessageId = null;
    session.createdAt = null;
    session.messageCount = 0;
    session.sentMessageKeys = [];
    session.contextKey = null;
    session.remoteChars = 0;
    return failed;
}

function prepareSessionForPrompt(session, now = Date.now()) {
    if (!session || !session.id) return null;
    let reason = null;
    if (session.messageCount >= MAX_MESSAGE_DEPTH) reason = 'max_message_depth';
    else if (session.createdAt && now - session.createdAt > SESSION_TTL_MS) reason = 'session_ttl';
    else if ((session.remoteChars || 0) >= MAX_SESSION_CONTEXT_CHARS) reason = 'max_context_chars';
    if (!reason) return null;
    return { reason, ...resetRemoteSession(session) };
}

function getOrCreateAgentSession(agentId) {
    if (!sessions.has(agentId)) {
        sessions.set(agentId, createSession());
    }
    const session = sessions.get(agentId);
    session.lastActivityAt = Date.now();
    return session;
}

function sweepIdleSessions(maxIdleMs = SESSION_TTL_MS * 2) {
    const now = Date.now();
    let removed = 0;
    for (const [agentId, session] of sessions) {
        if (now - (session.lastActivityAt || 0) > maxIdleMs) { sessions.delete(agentId); removed++; }
    }
    if (removed) console.log(`[DS-API] swept ${removed} idle session(s); ${sessions.size} remain`);
    return removed;
}


const DEEPSEEK_MODEL_TYPE = String(process.env.DEEPSEEK_MODEL_TYPE ?? 'default').trim();
const UNIFIED_REAL_MODEL = 'DeepSeek-V4.1-Flash (DeepSeek Web unified mode)';

function unifiedModel({ thinking = false, search = true, legacy = null } = {}) {
    let realModel = UNIFIED_REAL_MODEL;
    if (thinking) realModel += ' + DeepThink';
    if (search) realModel += ' + web search';
    if (legacy) realModel += `; legacy alias: ${legacy}`;
    return {
        model_type: DEEPSEEK_MODEL_TYPE,
        thinking_enabled: thinking,
        search_enabled: search,
        real_model: realModel,
        capabilities: { reasoning: thinking, web_search: search, files: true },
        supported: true,
        deprecated: Boolean(legacy),
    };
}

const MODEL_CONFIGS = {
    'deepseek-v4.1-flash': unifiedModel(),
    'deepseek-v4.1-flash-thinking': unifiedModel({ thinking: true }),
};

const SUPPORTED_MODEL_IDS = Object.keys(MODEL_CONFIGS).filter(id => MODEL_CONFIGS[id].supported);
const ALL_MODEL_CAPABILITIES = Object.fromEntries(Object.entries(MODEL_CONFIGS).map(([id, cfg]) => [id, {
    id,
    real_model: cfg.real_model,
    model_type: cfg.model_type,
    thinking_enabled: cfg.thinking_enabled,
    search_enabled: cfg.search_enabled,
    capabilities: cfg.capabilities,
    supported: cfg.supported,
    deprecated: cfg.deprecated === true,
    unavailable_reason: cfg.unavailable_reason || null,
}]));

function isAssistantOutputFragment(fragment) {
    return fragment
        && (fragment.type === 'RESPONSE' || fragment.type === 'SEARCH')
        && typeof fragment.content === 'string';
}

function isReasoningFragment(fragment) {
    return fragment
        && (fragment.type === 'THINK' || fragment.type === 'REASONING')
        && typeof fragment.content === 'string';
}

function isDeepSeekModelErrorEvent(event) {
    return event && event.type === 'error';
}

function createUpstreamHttpError(status, body = '', retryAfter = null) {
    const code = Number(status) || 502;
    const detail = String(body || '').replace(/\s+/g, ' ').trim().substring(0, 300);
    const type = code === 429
        ? 'rate_limit_error'
        : ((code === 401 || code === 403) ? 'authentication_error' : 'upstream_http_error');
    const error = new Error(`DeepSeek upstream HTTP ${code}${detail ? `: ${detail}` : ''}`);
    error.status = code;
    error.type = type;
    if (retryAfter) error.retryAfter = retryAfter;
    return error;
}

function rebuildFragmentText(fragments) {
    const responseText = fragments
        .filter(isAssistantOutputFragment)
        .map(f => f.content)
        .join('');
    const thinkText = fragments
        .filter(isReasoningFragment)
        .map(f => f.content)
        .join('');
    return { responseText, thinkText };
}

function applyResponsePatchOperations(ops, appendFragments) {
    if (!Array.isArray(ops)) return false;
    let applied = false;
    for (const op of ops) {
        if (!op || typeof op !== 'object') continue;
        if (op.p === 'fragments' && op.o === 'APPEND' && op.v !== undefined) {
            appendFragments(op.v);
            applied = true;
        }
    }
    return applied;
}

function resolveModelConfig(model) {
    const requested = String(model || 'deepseek-v4.1-flash').toLowerCase();
    return MODEL_CONFIGS[requested] || MODEL_CONFIGS['deepseek-v4.1-flash'];
}
function isKnownModel(model) { return Object.prototype.hasOwnProperty.call(MODEL_CONFIGS, String(model || '').toLowerCase()); }
function isSupportedModel(model) { return resolveModelConfig(model).supported === true; }

async function createPowHeader(account, signal, targetPath = COMPLETION_PATH) {
    const cr = await dsFetch(dsUrl('/api/v0/chat/create_pow_challenge'), {
        method: 'POST', headers: account.headers, signal,
        body: JSON.stringify({ target_path: targetPath })
    });
    const chalText = await cr.text();
    if (!cr.ok) {
        markAccountFailure(account, cr.status, 'pow challenge', cr.headers.get('retry-after'));
        const error = createUpstreamHttpError(cr.status, chalText, cr.headers.get('retry-after'));
        error.message = `DeepSeek auth/network error while creating PoW challenge: HTTP ${cr.status}. Run npm run doctor. If auth expired, run npm run auth or npm run auth:import.`;
        throw error;
    }
    let chalJson;
    try { chalJson = JSON.parse(chalText); }
    catch (e) { throw new Error(`DeepSeek returned non-JSON PoW response. Run npm run doctor. First chars: ${chalText.substring(0, 120)}`); }
    const challenge = chalJson?.data?.biz_data?.challenge;
    if (!challenge) {
        throw new Error('DeepSeek PoW response has no data.biz_data.challenge. Auth may be expired, captcha may be required, or DeepSeek changed Web API. Run npm run doctor, then npm run auth.');
    }
    const answer = await solvePOW(challenge, account.config.wasmUrl);
    return Buffer.from(JSON.stringify({
        algorithm: challenge.algorithm, challenge: challenge.challenge,
        salt: challenge.salt, answer: answer,
        signature: challenge.signature, target_path: targetPath
    })).toString('base64');
}

function sleepWithSignal(ms, signal) {
    return new Promise((resolve, reject) => {
        const onAbort = () => { clearTimeout(timer); reject(signal.reason || new Error('request aborted')); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

const UPLOADED_FILE_TTL_MS = 30 * 60 * 1000;
const UPLOADED_FILE_CACHE_MAX = 256;
const uploadedFileCache = new Map();
function getCachedUpload(key) {
    const entry = uploadedFileCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.at > UPLOADED_FILE_TTL_MS) { uploadedFileCache.delete(key); return null; }
    return entry.id;
}
function setCachedUpload(key, id) {
    uploadedFileCache.delete(key);
    uploadedFileCache.set(key, { id, at: Date.now() });
    while (uploadedFileCache.size > UPLOADED_FILE_CACHE_MAX) uploadedFileCache.delete(uploadedFileCache.keys().next().value);
}

function extractUploadedFileStatus(json, fileId) {
    const biz = json?.data?.biz_data;
    const list = Array.isArray(biz?.files) ? biz.files
        : Array.isArray(biz) ? biz
        : (biz && typeof biz === 'object' && biz[fileId]) ? [biz[fileId]]
        : (biz && (biz.id || biz.file_id)) ? [biz] : [];
    const entry = list.find(file => file && (file.id === fileId || file.file_id === fileId)) || (list.length === 1 ? list[0] : null);
    return { status: String(entry?.status || '').toUpperCase(), error: entry?.error_msg || entry?.error || null };
}

function throwIfImageBusinessRateLimited(account, resp, json) {
    const bizCode = json?.data?.biz_code;
    if (!Number.isSafeInteger(bizCode) || bizCode === 0) return;
    const bizData = json?.data?.biz_data;
    const message = [
        json?.data?.biz_msg, json?.data?.biz_message, json?.data?.message, json?.data?.msg,
        bizData?.biz_msg, bizData?.biz_message, bizData?.message, bizData?.msg, bizData?.error_msg,
    ].find(value => typeof value === 'string' && value.length <= 2048);
    if (!message || !isRateLimitError(message)) return;
    throwIfRateLimited(account, resp.status, `Too many messages (DeepSeek business code ${bizCode})`, resp.headers.get('retry-after'));
}

const FILE_READY_STATUS = /^(?:SUCCESS|PARSED|DONE|COMPLETED?|FINISHED|READY)$/;
const FILE_FAILED_STATUS = /FAIL|ERROR|REJECT|UNSUPPORT|INVALID|EMPTY/;

async function uploadImageToDeepSeek(account, image, signal, deadlineAt = Infinity) {
    const powB64 = await createPowHeader(account, signal, FILE_UPLOAD_PATH);
    const form = new FormData();
    form.append('file', new Blob([image.data], { type: image.mime }), image.filename);
    const headers = { ...account.headers, 'X-DS-PoW-Response': powB64, 'x-file-size': String(image.data.length) };
    delete headers['Content-Type'];
    const resp = await dsFetch(dsUrl(FILE_UPLOAD_PATH), { method: 'POST', headers, body: form, signal }, DS_FILE_TIMEOUT_MS);
    const { json, text } = await readDeepSeekJsonResponse(resp, 'file upload', account);
    if (!resp.ok) {
        throwIfRateLimited(account, resp.status, text, resp.headers.get('retry-after'));
        throw createUpstreamHttpError(resp.status, text, resp.headers.get('retry-after'));
    }
    throwIfImageBusinessRateLimited(account, resp, json);
    const biz = json?.data?.biz_data;
    const fileId = biz?.id || biz?.file_id || biz?.file?.id;
    if (!fileId) throw new Error(`DeepSeek file upload returned no file id. First chars: ${String(text || '').substring(0, 160)}`);

    let { status } = { status: String(biz?.status || '').toUpperCase() };
    const deadline = Math.min(Date.now() + DS_FILE_TIMEOUT_MS, deadlineAt);
    const statusHeaders = { ...account.headers };
    delete statusHeaders['Content-Type'];
    while (!FILE_READY_STATUS.test(status)) {
        if (FILE_FAILED_STATUS.test(status)) throw new Error(`DeepSeek could not process the image (status ${status})`);
        if (Date.now() > deadline) throw timeoutError('DeepSeek did not finish processing the image in time');
        await sleepWithSignal(DS_FILE_POLL_MS, signal);
        const pr = await dsFetch(dsUrl(`/api/v0/file/fetch_files?file_ids=${encodeURIComponent(fileId)}`), { method: 'GET', headers: statusHeaders, signal });
        const polled = await readDeepSeekJsonResponse(pr, 'file status', account);
        if (!pr.ok) {
            throwIfRateLimited(account, pr.status, polled.text, pr.headers.get('retry-after'));
            throw createUpstreamHttpError(pr.status, polled.text, pr.headers.get('retry-after'));
        }
        throwIfImageBusinessRateLimited(account, pr, polled.json);
        const state = extractUploadedFileStatus(polled.json, fileId);
        status = state.status;
        if (state.error && FILE_FAILED_STATUS.test(status)) throw new Error(`DeepSeek could not process the image: ${state.error}`);
    }
    return fileId;
}

async function uploadImagesForAccount(account, images, signal, agentTag, deadlineAt = Infinity) {
    if (!images || images.length === 0) return [];
    const ids = [];
    let uploaded = 0;
    try {
        for (const image of images) {
            const key = `${account.id}:${image.hash}`;
            let id = getCachedUpload(key);
            if (!id) {
                if (Date.now() > deadlineAt) throw timeoutError('Request deadline reached while uploading images');
                id = await uploadImageToDeepSeek(account, image, signal, deadlineAt);
                setCachedUpload(key, id);
                uploaded++;
            }
            ids.push(id);
        }
    } catch (error) {
        if (signal?.aborted || isAccountLevelError(error) || isTimeoutError(error)) throw error;
        const failure = new Error(`DeepSeek image upload failed: ${error.message}`);
        failure.status = 502;
        failure.type = 'image_upload_failed';
        throw failure;
    }
    if (uploaded) console.log(`${agentTag} Uploaded ${uploaded} image(s) to DeepSeek`);
    return ids;
}

async function createRemoteChat(session, account, agentTag, label = 'session create', signal) {
    const sr = await dsFetch(dsUrl('/api/v0/chat_session/create'), {
        method: 'POST', headers: account.headers, body: '{}', signal,
    });
    const { json: sessionData, text: sessionText } = await readDeepSeekJsonResponse(sr, label, account);
    const createdSessionId = sessionData?.data?.biz_data?.chat_session?.id || sessionData?.data?.biz_data?.id;
    if (!sr.ok || !createdSessionId) {
        const error = sr.ok ? new Error('') : createUpstreamHttpError(sr.status, sessionText, sr.headers.get('retry-after'));
        error.message = `Could not create DeepSeek chat session (HTTP ${sr.status}). Auth may be expired/captcha-blocked. Run npm run doctor, then npm run auth. First chars: ${String(sessionText || '').substring(0, 120)}`;
        throw error;
    }
    session.id = createdSessionId;
    session.accountId = account.id;
    session.parentMessageId = null;
    session.createdAt = Date.now();
    session.messageCount = 0;
    session.sentMessageKeys = [];
    session.contextKey = null;
    session.remoteChars = 0;
    console.log(`${agentTag} Created new session: ${session.id}`);
}

async function postCompletion(session, account, modelCfg, promptText, signal, refFileIds = []) {
    const powB64 = await createPowHeader(account, signal);
    throwIfAborted(signal);
    const payload = {
        chat_session_id: session.id,
        parent_message_id: session.parentMessageId,
        prompt: promptText, ref_file_ids: refFileIds,
        thinking_enabled: modelCfg.thinking_enabled, search_enabled: modelCfg.search_enabled,
        action: null, preempt: false,
    };
    if (modelCfg.model_type) payload.model_type = modelCfg.model_type;
    return dsFetchStream(dsUrl('/api/v0/chat/completion'), {
        method: 'POST',
        headers: { ...account.headers, 'X-DS-PoW-Response': powB64 },
        body: JSON.stringify(payload),
        signal,
    });
}

function throwIfRateLimited(account, status, errText, retryAfter) {
    if ([401, 403, 429].includes(Number(status)) || !isRateLimitError(errText)) return;
    markAccountFailure(account, 429, 'rate limited', retryAfter, RATE_LIMIT_COOLDOWN_MS);
    throw createUpstreamHttpError(429, errText, retryAfter || String(Math.ceil(RATE_LIMIT_COOLDOWN_MS / 1000)));
}

async function askDeepSeekStream(prompt, agentId, model = 'deepseek-v4.1-flash', freshSessionPrompt = prompt, session = getOrCreateAgentSession(agentId), signal = null, attachments = null) {
    const modelCfg = resolveModelConfig(model);
    const hadRemoteSession = Boolean(session.id);
    const account = selectAccountForSession(session);
    account.lastUsedAt = Date.now();
    const agentTag = `[${agentId}/acct:${account.id}]`;

    const rollover = prepareSessionForPrompt(session);
    const accountRotationReset = hadRemoteSession && !session.id && !rollover;
    const startsFreshChat = !session.id;
    let effectivePrompt = startsFreshChat ? freshSessionPrompt : prompt;
    if (accountRotationReset) {
        console.log(`${agentTag} Account rotation reset the previous remote session; using recovery prompt.`);
    }
    if (rollover) {
        console.log(`${agentTag} Session ${rollover.failedSessionId} reset before upstream call (${rollover.reason}).`);
    }

    const images = attachments ? (startsFreshChat ? attachments.full : attachments.delta) : [];
    const refFileIds = await uploadImagesForAccount(account, images, signal, agentTag, attachments?.deadlineAt);

    if (!session.id) {
        await createRemoteChat(session, account, agentTag, 'session create', signal);
    } else {
        console.log(`${agentTag} Reusing session: ${session.id} (parent: ${session.parentMessageId}, msg#${session.messageCount})`);
    }

    const resp = await postCompletion(session, account, modelCfg, effectivePrompt, signal, refFileIds);

    if (resp.status !== 200) {
        const retryAfter = resp.headers.get('retry-after');
        markAccountFailure(account, resp.status, 'completion', retryAfter);
        const errText = await readUpstreamText(resp);
        throwIfAborted(signal);
        console.log(`${agentTag} Session error (${resp.status}): ${errText.substring(0, 100)}`);
        throwIfRateLimited(account, resp.status, errText, retryAfter);
        if (resp.status === 400 || resp.status === 404 || resp.status === 500) {
            console.log(`${agentTag} Session ${session.id} expired. Creating new session...`);
            resetRemoteSession(session);
            await createRemoteChat(session, account, agentTag, 'session recreate', signal);
            effectivePrompt = freshSessionPrompt;
            const fullRefFileIds = attachments
                ? await uploadImagesForAccount(account, attachments.full, signal, agentTag, attachments.deadlineAt)
                : [];
            const resp2 = await postCompletion(session, account, modelCfg, effectivePrompt, signal, fullRefFileIds);
            if (!resp2.ok) {
                const retryAfter2 = resp2.headers.get('retry-after');
                markAccountFailure(account, resp2.status, 'completion after session recreate', retryAfter2);
                const errText2 = await readUpstreamText(resp2);
                resetRemoteSession(session);
                throwIfAborted(signal);
                throwIfRateLimited(account, resp2.status, errText2, retryAfter2);
                throw createUpstreamHttpError(resp2.status, errText2, retryAfter2);
            }
            session.remoteChars += effectivePrompt.length;
            return { resp: resp2, agentId, account, promptUsed: effectivePrompt, freshSessionReset: true };
        }
        throw createUpstreamHttpError(resp.status, errText, retryAfter);
    }

    session.remoteChars += effectivePrompt.length;
    return { resp, agentId, account, promptUsed: effectivePrompt, freshSessionReset: startsFreshChat };
}


const TOOL_SCHEMA_ANNOTATION_KEYS = new Set(['description', 'examples', '$comment', 'title']);
const TOOL_SCHEMA_MAP_KEYS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
const TOOL_SCHEMA_ARRAY_KEYS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const TOOL_SCHEMA_SINGLE_KEYS = new Set([
    'additionalItems', 'additionalProperties', 'contains', 'contentSchema', 'else', 'if',
    'items', 'not', 'propertyNames', 'then', 'unevaluatedItems', 'unevaluatedProperties',
]);

function compactToolSchema(value) {
    if (Array.isArray(value)) return value.map(compactToolSchema);
    if (!value || typeof value !== 'object') return value;
    const compact = {};
    for (const [key, child] of Object.entries(value)) {
        if (TOOL_SCHEMA_ANNOTATION_KEYS.has(key)) continue;
        if (TOOL_SCHEMA_MAP_KEYS.has(key) && child && typeof child === 'object' && !Array.isArray(child)) {
            compact[key] = Object.fromEntries(Object.entries(child).map(([name, schema]) => [name, compactToolSchema(schema)]));
        } else if (TOOL_SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(child)) {
            compact[key] = child.map(compactToolSchema);
        } else if (TOOL_SCHEMA_SINGLE_KEYS.has(key)) {
            compact[key] = Array.isArray(child) ? child.map(compactToolSchema) : compactToolSchema(child);
        } else if (key === 'dependencies' && child && typeof child === 'object' && !Array.isArray(child)) {
            compact[key] = Object.fromEntries(Object.entries(child).map(([name, dependency]) => [
                name,
                Array.isArray(dependency) ? dependency : compactToolSchema(dependency),
            ]));
        } else {
            compact[key] = child;
        }
    }
    return compact;
}

const TOOL_CALL_FORMAT = '{"tool_call":{"name":"<function_name>","arguments":{...}}}';

function formatToolDefinitions(tools) {
    if (!tools || tools.length === 0) return '';
    const rawSchemaChars = tools.reduce((total, tool) => {
        try { return total + JSON.stringify(tool?.function?.parameters || {}).length; }
        catch (e) { return total; }
    }, 0);
    const compactSchemas = rawSchemaChars > Math.floor(MAX_UPSTREAM_PROMPT_CHARS * 0.4);
    let text = '\n\n--- TOOL REQUEST SYSTEM ---\n';
    text += 'You are an AI that ONLY REASONS and REQUESTS tool executions. You do NOT run any commands yourself.\n';
    text += 'When you need data from the local server or need to change something there, REQUEST exactly one tool call using exactly this JSON format:\n';
    text += `${TOOL_CALL_FORMAT}\n\n`;
    text += 'Your response will be sent to the local gateway, which executes the command and sends the output back in the next message.\n\n';
    text += 'RULES:\n';
    text += '1. You ONLY output the tool request — you never run anything yourself\n';
    text += '2. Do NOT simulate, guess, or fabricate command output — wait for the actual result\n';
    text += '3. The tool runs on ' + SERVER_HOST + ' (' + SERVER_PUBLIC_IP + '), the local server — NOT on DeepSeek\n';
    text += '4. After the tool executes, the result will be sent to you as a new message starting with [Tool Result]\n';
    text += '5. A tool request contains nothing but that JSON: no explanation before or after it, no Markdown code fence, one tool per response\n';
    text += '6. Arguments must be valid JSON: escape backslashes (C:\\\\Users\\\\me), double quotes and newlines (\\n) inside strings. Keep arguments compact.\n';
    text += '7. When no tool is needed (for example the task is finished), answer normally in plain text without any tool_call JSON\n\n';
    text += 'Available functions:\n';
    for (const tool of tools) {
        if (tool.type === 'function' && tool.function) {
            const fn = tool.function;
            text += `\n## ${fn.name}\n`;
            const description = String(fn.description || '').replace(/\s+/g, ' ').trim();
            text += `${description.length > 500 ? description.substring(0, 497) + '...' : description}\n`;
            if (fn.parameters) {
                text += `Parameters: ${JSON.stringify(compactSchemas ? compactToolSchema(fn.parameters) : fn.parameters)}\n`;
            }
        }
    }
    text += '\n--- END TOOL REQUEST SYSTEM ---\n';
    text += `\nREMEMBER: Request a tool only with ${TOOL_CALL_FORMAT}. Never simulate results.`;
    return text;
}

function formatToolReminder(tools) {
    const names = (tools || [])
        .filter(tool => tool?.type === 'function' && tool.function?.name)
        .map(tool => tool.function.name);
    if (names.length === 0) return '';
    let list = names.join(', ');
    if (list.length > 1500) list = list.substring(0, 1497) + '...';
    return `[Tool reminder] Available tools: ${list}. To use one, reply with ONLY ${TOOL_CALL_FORMAT} (valid JSON, one tool, nothing else). Otherwise answer normally. Never invent tool results.`;
}

const MAX_TOOL_MARKUP_CHARS = 256 * 1024;
const MAX_TOOL_ARGUMENT_CHARS = 128 * 1024;
const MAX_TOOL_JSON_CANDIDATES = 32;
const MAX_DSML_PARAMETERS = 128;
const MAX_DSML_STRUCTURAL_TAGS = MAX_DSML_PARAMETERS * 2 + 16;
const MAX_DSML_TAG_CHARS = 2048;

function extractBalancedJsonAt(text, startIndex) {
    if (text[startIndex] !== '{') return null;
    let braceDepth = 0;
    let inString = false;
    let escape = false;
    for (let i = startIndex; i < text.length; i++) {
        const ch = text[i];
        if (escape) { escape = false; continue; }
        if (ch === '\\' && inString) { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (!inString) {
            if (ch === '{') braceDepth++;
            if (ch === '}') {
                braceDepth--;
                if (braceDepth === 0) return text.substring(startIndex, i + 1);
            }
        }
    }
    return null;
}

function extractBalancedJsonObjects(text, maxObjects = MAX_TOOL_JSON_CANDIDATES, accept = null) {
    const objects = [];
    let start = -1;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (start === -1) {
            if (ch === '{') {
                start = i;
                depth = 1;
                inString = false;
                escape = false;
            }
            continue;
        }
        if (escape) { escape = false; continue; }
        if (ch === '\\' && inString) { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') depth++;
        if (ch === '}') {
            depth--;
            if (depth === 0) {
                const object = text.substring(start, i + 1);
                if (!accept || accept(object)) {
                    objects.push(object);
                    if (objects.length >= maxObjects) return objects;
                }
                start = -1;
            }
        }
    }
    return objects;
}

const VALID_JSON_ESCAPE = /^(?:["\\/bfnrt]|u[0-9a-fA-F]{4})/;
const TOOL_ENVELOPE_KEY_RE = /["'](?:tool_call|tool_calls|function_call)["']\s*:/;

function repairJsonStringBody(body) {
    let rawBackslashes = /^[A-Za-z]:\\(?!\\)/.test(body);
    for (let k = 0; !rawBackslashes && k < body.length; k++) {
        if (body[k] !== '\\') continue;
        const next = body.substring(k + 1, k + 6);
        if (!VALID_JSON_ESCAPE.test(next) || next[0] === 'b' || next[0] === 'f') rawBackslashes = true;
        k++;
    }
    let result = '';
    for (let k = 0; k < body.length; k++) {
        const c = body[k];
        if (c === '\\') {
            if (rawBackslashes && !/^(?:["\\]|u[0-9a-fA-F]{4})/.test(body.substring(k + 1, k + 6))) {
                result += '\\\\';
            } else {
                result += c + (body[k + 1] ?? '');
                k++;
            }
            continue;
        }
        const code = c.charCodeAt(0);
        if (code < 0x20) {
            result += c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t' : '\\u' + code.toString(16).padStart(4, '0');
            continue;
        }
        result += c;
    }
    return result;
}

function repairJsonText(raw) {
    const text = String(raw || '');
    let out = '';
    let changed = false;
    let i = 0;
    while (i < text.length) {
        if (text[i] !== '"') { out += text[i++]; continue; }
        let j = i + 1;
        while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
        if (j >= text.length) { out += text.substring(i); break; }
        const body = text.substring(i + 1, j);
        const fixed = repairJsonStringBody(body);
        if (fixed !== body) changed = true;
        out += `"${fixed}"`;
        i = j + 1;
    }
    return changed ? out : text;
}

function parseJsonLenient(raw) {
    let parsed;
    let error = null;
    try { parsed = JSON.parse(raw); } catch (e) { error = e; }
    const repaired = repairJsonText(raw);
    if (repaired !== raw) {
        try { return JSON.parse(repaired); }
        catch (e) {   }
    }
    if (error) throw error;
    return parsed;
}

function buildToolCall(name, args = {}) {
    const toolName = typeof name === 'string' ? name.trim() : '';
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/.test(toolName)) return null;
    let parsedArgs = args;
    if (typeof parsedArgs === 'string') {
        if (parsedArgs.length > MAX_TOOL_ARGUMENT_CHARS) return null;
        try { parsedArgs = parseJsonLenient(parsedArgs); } catch (e) { return null; }
    }
    if (parsedArgs === null || parsedArgs === undefined) parsedArgs = {};
    if (typeof parsedArgs !== 'object' || Array.isArray(parsedArgs)) return null;
    let serialized;
    try { serialized = JSON.stringify(parsedArgs); } catch (e) { return null; }
    if (serialized.length > MAX_TOOL_ARGUMENT_CHARS) return null;
    return { name: toolName, arguments: serialized };
}

function coerceToolCallObject(obj, { allowBare = false } = {}) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    let candidate = null;
    if (Object.prototype.hasOwnProperty.call(obj, 'tool_call')) {
        candidate = obj.tool_call;
    } else if (Object.prototype.hasOwnProperty.call(obj, 'function_call')) {
        candidate = obj.function_call;
    } else if (Object.prototype.hasOwnProperty.call(obj, 'tool_calls')) {
        if (!Array.isArray(obj.tool_calls) || obj.tool_calls.length !== 1) return null;
        candidate = obj.tool_calls[0];
    } else if (allowBare) {
        candidate = obj;
    }
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const fn = candidate.function && typeof candidate.function === 'object'
        ? candidate.function
        : candidate;
    return buildToolCall(
        fn.name ?? candidate.name,
        fn.arguments ?? candidate.arguments ?? candidate.input ?? {}
    );
}

function parseJsonToolCandidate(raw, label = 'json', options = {}) {
    if (!raw) return null;
    try {
        const parsed = parseJsonLenient(raw);
        const tc = coerceToolCallObject(parsed, options);
        if (tc) {
            console.log(`[parseToolCall] SUCCESS ${label}: ${tc.name} (args=${tc.arguments.length} chars)`);
            return tc;
        }
    } catch (e) {
        if (options.allowBare || TOOL_ENVELOPE_KEY_RE.test(raw)) {
            console.log(`[parseToolCall] ${label} JSON.parse failed: ${e.message.substring(0, 100)}`);
        }
    }
    return null;
}

function canonicalizeToolMarkupTag(rawTag) {
    let token = String(rawTag || '').trim()
        .replace(/｜/g, '|')
        .replace(/[“”＂]/g, '"')
        .replace(/[‘’＇]/g, "'");
    let closing = false;
    if (token.startsWith('/')) {
        closing = true;
        token = token.substring(1).trim();
    }
    token = token.replace(/^\|+\s*DSML\s*\|+\s*/i, '');
    if (token.startsWith('/')) {
        closing = true;
        token = token.substring(1).trim();
    }
    token = token.replace(/^DSML(?=(?:tool[\s_-]*calls|function[\s_-]*calls|invoke|parameter)\b)/i, '');

    if (!closing && /^name\s*=/i.test(token)) return `<direct ${token}>`;

    const semantic = token.match(/^(?:(?:[A-Za-z_][\w.-]*):)?(tool[\s_-]*calls|function[\s_-]*calls|invoke|parameter)\b([\s\S]*)$/i);
    if (!semantic) return null;
    const localName = semantic[1].replace(/[\s_-]/g, '').toLowerCase();
    const canonicalName = localName === 'toolcalls' || localName === 'functioncalls'
        ? 'tool_calls'
        : localName;
    const attrs = closing ? '' : semantic[2];
    return `<${closing ? '/' : ''}${canonicalName}${attrs}>`;
}

function normalizeToolMarkupTags(text) {
    const withAsciiAngles = String(text || '').replace(/＜/g, '<').replace(/＞/g, '>');
    return withAsciiAngles.replace(/<([^<>]{0,1024})>/g, (whole, rawTag) => {
        const canonical = canonicalizeToolMarkupTag(rawTag);
        return canonical || whole;
    });
}

function decodeDsmlValue(value) {
    return String(value || '')
        .replace(/&quot;/gi, '"')
        .replace(/&apos;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&amp;/gi, '&');
}

function decodeDsmlParameterValue(value) {
    const raw = String(value || '');
    const cdata = raw.trim().match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/i);
    return cdata ? cdata[1] : decodeDsmlValue(raw);
}

function getMarkupAttribute(attrs, attribute) {
    const match = String(attrs || '').match(new RegExp(`\\b${attribute}\\s*=\\s*(["'])([^"']+)\\1`, 'i'));
    return match ? match[2] : null;
}

function readDsmlTagAt(text, start) {
    if (text[start] !== '<') return null;
    const prefix = text.substring(start + 1, Math.min(text.length, start + 40)).trimStart();
    if (!/^\/?(?:tool_calls|invoke|parameter|direct)\b/i.test(prefix)) return null;
    let quote = null;
    let end = -1;
    const scanEnd = Math.min(text.length, start + MAX_DSML_TAG_CHARS + 1);
    for (let i = start + 1; i < scanEnd; i++) {
        const ch = text[i];
        if (quote) {
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (ch === '>') {
            end = i;
            break;
        }
    }
    if (end === -1) return { invalid: true };

    let token = text.substring(start + 1, end).trim();
    let closing = false;
    if (token.startsWith('/')) {
        closing = true;
        token = token.substring(1).trim();
    }
    let selfClosing = false;
    if (!closing && token.endsWith('/')) {
        selfClosing = true;
        token = token.substring(0, token.length - 1).trim();
    }
    const match = token.match(/^(tool_calls|invoke|parameter|direct)\b([\s\S]*)$/i);
    if (!match) return null;
    return {
        name: match[1].toLowerCase(),
        attrs: closing ? '' : match[2],
        closing,
        selfClosing,
        start,
        end: end + 1,
    };
}

function scanDsmlStructuralTags(text) {
    const tags = [];
    const value = String(text || '');
    for (let i = 0; i < value.length;) {
        if (value.substring(i, i + 9).toUpperCase() === '<![CDATA[') {
            const cdataEnd = value.indexOf(']]>', i + 9);
            if (cdataEnd === -1) return null;
            i = cdataEnd + 3;
            continue;
        }
        if (value[i] !== '<') {
            i++;
            continue;
        }
        const tag = readDsmlTagAt(value, i);
        if (!tag) {
            i++;
            continue;
        }
        if (tag.invalid) return null;
        tags.push(tag);
        if (tags.length > MAX_DSML_STRUCTURAL_TAGS) return null;
        i = tag.end;
    }
    return tags;
}

function parseDsmlParameter(attrs, rawBody, args, seenNames) {
    const parameterName = getMarkupAttribute(attrs, 'name');
    if (!parameterName || !/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/.test(parameterName) || seenNames.has(parameterName)) return false;
    seenNames.add(parameterName);
    const stringMode = getMarkupAttribute(attrs, 'string');
    const rawValue = decodeDsmlParameterValue(rawBody);
    if (rawValue.length > MAX_TOOL_ARGUMENT_CHARS) return false;
    let value = rawValue;
    if (stringMode && stringMode.toLowerCase() === 'false') {
        try { value = parseJsonLenient(rawValue.trim()); } catch (e) { return false; }
    }
    args[parameterName] = value;
    return true;
}

function parseDsmlInvoke(name, body) {
    const structuralTags = scanDsmlStructuralTags(body);
    if (!structuralTags) return null;
    const parameterTags = structuralTags.filter(tag => tag.name === 'parameter');
    if (structuralTags.some(tag => tag.name !== 'parameter')) return null;

    const args = {};
    let parameterCount = 0;
    const seenNames = new Set();
    let cursor = 0;
    for (let i = 0; i < parameterTags.length; i += 2) {
        const opening = parameterTags[i];
        const closing = parameterTags[i + 1];
        if (!opening || opening.closing || opening.selfClosing || !closing || !closing.closing) return null;
        if (body.substring(cursor, opening.start).trim()) return null;
        parameterCount++;
        if (parameterCount > MAX_DSML_PARAMETERS) return null;
        if (!parseDsmlParameter(opening.attrs, body.substring(opening.end, closing.start), args, seenNames)) return null;
        cursor = closing.end;
    }
    if (parameterCount > 0) {
        if (body.substring(cursor).trim()) return null;
        return buildToolCall(name, args);
    }

    const decodedBody = decodeDsmlValue(body).trim();
    if (!decodedBody) return buildToolCall(name, {});
    const objects = extractBalancedJsonObjects(decodedBody, 2);
    if (objects.length !== 1 || decodedBody !== objects[0]) return null;
    try { return buildToolCall(name, parseJsonLenient(objects[0])); }
    catch (e) { return null; }
}

function extractToolCallScope(normalized) {
    const tags = scanDsmlStructuralTags(normalized);
    if (!tags) return null;
    const wrappers = tags.filter(tag => tag.name === 'tool_calls');
    const openings = wrappers.filter(tag => !tag.closing);
    const closings = wrappers.filter(tag => tag.closing);
    if (openings.length > 0) {
        if (openings.length !== 1 || openings[0].selfClosing || closings.length === 0) return null;
        const opening = openings[0];
        const closing = closings[closings.length - 1];
        if (wrappers.some(tag => tag.closing && tag.start < opening.end) || closing.start < opening.end) return null;
        if (tags.some(tag => tag.name !== 'tool_calls' && (tag.start < opening.end || tag.start >= closing.start))) return null;
        return normalized.substring(opening.end, closing.start);
    }
    if (closings.length > 0) {
        const closing = closings[closings.length - 1];
        const invokeOpenings = tags.filter(tag => tag.name === 'invoke' && !tag.closing && tag.start < closing.start);
        if (invokeOpenings.length === 1 && !invokeOpenings[0].selfClosing) {
            if (tags.some(tag => tag.name !== 'tool_calls' && (tag.start < invokeOpenings[0].start || tag.start >= closing.start))) return null;
            return normalized.substring(invokeOpenings[0].start, closing.start);
        }
    }
    return null;
}

function parseDsmlToolCall(text) {
    if (String(text || '').length > MAX_TOOL_MARKUP_CHARS) return null;
    const normalized = normalizeToolMarkupTags(text);
    const scope = extractToolCallScope(normalized);
    if (scope === null) return null;
    const tags = scanDsmlStructuralTags(scope);
    if (!tags || tags.length === 0) return null;
    const first = tags[0];
    if (scope.substring(0, first.start).trim()) return null;

    if (first.name === 'invoke' && !first.closing && !first.selfClosing) {
        const invokeTags = tags.filter(tag => tag.name === 'invoke');
        if (invokeTags.length !== 2 || invokeTags[0] !== first || invokeTags[1].closing !== true) return null;
        const closing = invokeTags[1];
        if (scope.substring(closing.end).trim()) return null;
        if (tags.some(tag => (tag.name === 'tool_calls' || tag.name === 'direct'))) return null;
        const parsed = parseDsmlInvoke(getMarkupAttribute(first.attrs, 'name'), scope.substring(first.end, closing.start));
        if (parsed) {
            console.log(`[parseToolCall] SUCCESS dsml: ${parsed.name} (args=${parsed.arguments.length} chars)`);
            return parsed;
        }
    }

    if (first.name === 'direct' && !first.closing && !first.selfClosing) {
        if (tags.some((tag, index) => index > 0 && (tag.name === 'direct' || tag.name === 'invoke' || tag.name === 'tool_calls'))) return null;
        const parsed = parseDsmlInvoke(getMarkupAttribute(first.attrs, 'name'), scope.substring(first.end));
        if (parsed) {
            console.log(`[parseToolCall] SUCCESS dsml-direct: ${parsed.name} (args=${parsed.arguments.length} chars)`);
            return parsed;
        }
    }
    return null;
}

function looksLikeToolCallMarkup(rawText) {
    const text = stripForeignCodeFences(rawText);
    return /TOOL_CALL:\s*[\w-]+|<\s*tool_call\b|[|｜]+\s*DSML\s*[|｜]+|[<＜]\s*\/?\s*(?:DSML)?(?:[\w.-]+:)?(?:tool[\s_-]*calls|function[\s_-]*calls|invoke)\b|["'](?:tool_call|tool_calls|function_call)["']\s*:/i.test(String(text || ''));
}

const CODE_FENCE_RE = /(`{3,})([\w+.-]*)[^\S\r\n]*\r?\n?([\s\S]*?)\1(?!`)/;

function isJsonFenceLanguage(language) {
    return !language || /^(?:json[c5]?|tool_?calls?|tool|text|plaintext|txt)$/i.test(language);
}

function stripForeignCodeFences(text) {
    return String(text || '').replace(new RegExp(CODE_FENCE_RE.source, 'g'), (whole, ticks, language) => (isJsonFenceLanguage(language) ? whole : '\n'));
}

function parseToolCall(text) {
    if (!text || typeof text !== 'string') return null;
    if (text.length > MAX_TOOL_MARKUP_CHARS) {
        console.log(`[parseToolCall] Refusing oversized tool markup candidate (${text.length} chars)`);
        return null;
    }

    const scanText = stripForeignCodeFences(text);

    if (/[|｜]+\s*DSML\s*[|｜]+|[<＜]\s*\/?\s*(?:DSML)?(?:[\w.-]+:)?(?:tool[\s_-]*calls|function[\s_-]*calls|invoke)\b/i.test(scanText)) {
        const dsml = parseDsmlToolCall(scanText);
        if (dsml) return dsml;
        console.log('[parseToolCall] Tool markup found but wrapper/invoke was incomplete or malformed');
        return null;
    }

    const xmlMatch = scanText.match(/<tool_call[^>]*>([\s\S]*?)<\/tool_call>/i);
    if (xmlMatch) {
        const inner = xmlMatch[1].trim();
        let tc = parseJsonToolCandidate(inner, 'xml', { allowBare: true });
        if (!tc) {
            const objectStart = inner.indexOf('{');
            const object = objectStart === -1 ? null : extractBalancedJsonAt(inner, objectStart);
            if (object && object !== inner) tc = parseJsonToolCandidate(object, 'xml-object', { allowBare: true });
        }
        if (tc) return tc;
    }

    const fenceRe = new RegExp(CODE_FENCE_RE.source, 'g');
    let fence;
    while ((fence = fenceRe.exec(text)) !== null) {
        if (!isJsonFenceLanguage(fence[2])) continue;
        const body = fence[3].trim();
        if (!body.startsWith('{')) continue;
        const tc = parseJsonToolCandidate(body, 'fenced');
        if (tc) return tc;
    }

    const match = scanText.match(/TOOL_CALL:\s*([\w-]+)\s*/i);
    if (match) {
        const name = match[1];
        const afterMatch = scanText.substring(match.index + match[0].length);
        const braceIdx = afterMatch.indexOf('{');
        if (braceIdx !== -1) {
            const rawJson = extractBalancedJsonAt(afterMatch, braceIdx);
            if (rawJson) {
                try {
                    const args = parseJsonLenient(rawJson);
                    const tc = buildToolCall(name, args);
                    if (tc) {
                        console.log(`[parseToolCall] SUCCESS legacy: ${name} (args=${rawJson.length} chars)`);
                        return tc;
                    }
                } catch (e) {
                    console.log(`[parseToolCall] legacy JSON.parse failed: ${e.message.substring(0,100)}`);
                }
            } else {
                console.log(`[parseToolCall] TOOL_CALL:${name} found but JSON braces are unbalanced`);
            }
        } else {
            console.log(`[parseToolCall] TOOL_CALL:${name} found but no { after it`);
        }
    }

    for (const rawJson of extractBalancedJsonObjects(scanText, MAX_TOOL_JSON_CANDIDATES, object => TOOL_ENVELOPE_KEY_RE.test(object))) {
        const tc = parseJsonToolCandidate(rawJson, 'inline');
        if (tc) return tc;
    }

    console.log(`[parseToolCall] No tool call match in ${text.length} chars`);
    return null;
}




function sanitizeContent(text) {
    return String(text || '').replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '');
}

function estimateTokens(text) {
    return text ? Math.ceil(String(text).length / 4) : 0;
}

function buildUsage(prompt, content, reasoningContent = '') {
    const promptTokens = estimateTokens(prompt);
    const contentTokens = estimateTokens(content);
    const reasoningTokens = estimateTokens(reasoningContent);
    const completionTokens = contentTokens + reasoningTokens;
    return {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        completion_tokens_details: {
            reasoning_tokens: reasoningTokens
        }
    };
}

function buildToolCallResponse(toolCall, model = 'deepseek-v4.1-flash', prompt = '', reasoningContent = '') {
    const id = 'call_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
    const message = {
        role: 'assistant',
        content: null,
        tool_calls: [{
            id: id,
            type: 'function',
            function: { name: toolCall.name, arguments: toolCall.arguments }
        }]
    };
    return {
        id: 'ds-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
            index: 0,
            message,
            finish_reason: 'tool_calls'
        }],
        usage: buildUsage(prompt, '', reasoningContent),
    };
}

function buildTextResponse(content, prompt, model = 'deepseek-v4.1-flash', reasoningContent = '', finishReason = null) {
    const message = { role: 'assistant', content };
    if (reasoningContent) message.reasoning_content = reasoningContent;
    return {
        id: 'ds-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
            index: 0,
            message,
            finish_reason: finishReason === 'length' ? 'length' : 'stop'
        }],
        usage: buildUsage(prompt, content, reasoningContent),
    };
}

function describeAttachment(kind, reference) {
    const value = typeof reference === 'string' ? reference.trim() : '';
    if (!value || value.startsWith('data:') || value.length > 512 || !/^(?:https?:\/\/|[\w.-]+$)/i.test(value)) {
        return `[${kind} attached; not visible through this proxy]`;
    }
    return `[${kind}: ${value}]`;
}

const decodedImageCache = new WeakMap();

function decodeImagePart(part) {
    if (!part || typeof part !== 'object') return null;
    if (decodedImageCache.has(part)) return decodedImageCache.get(part);
    let mime = '';
    let base64 = '';
    if (part.type === 'image' && part.source?.type === 'base64') {
        mime = String(part.source.media_type || '');
        base64 = String(part.source.data || '');
    } else if (part.type === 'image_url' || part.type === 'input_image') {
        const url = part.image_url?.url ?? part.image_url ?? part.url;
        const match = typeof url === 'string' ? url.match(/^data:([\w.+-]+\/[\w.+-]+)?((?:;[^;,]*)*),([\s\S]*)$/) : null;
        if (match && /;base64/i.test(match[2])) {
            mime = match[1] || 'image/png';
            base64 = match[3];
        }
    }
    let image = null;
    if (/^image\/(?:png|jpe?g|webp|gif)$/i.test(mime) && base64) {
        const data = Buffer.from(base64.replace(/\s+/g, ''), 'base64');
        if (data.length > 0 && data.length <= MAX_IMAGE_BYTES) {
            const hash = crypto.createHash('sha256').update(data).digest('hex').substring(0, 12);
            const extension = (mime.split('/')[1] || 'png').replace(/[^\w]/g, '').substring(0, 8) || 'png';
            image = { mime, data, hash, filename: `image-${hash}.${extension}` };
        }
    }
    decodedImageCache.set(part, image);
    return image;
}

function hasInlineImageData(part) {
    if (part.type === 'image') return part.source?.type === 'base64';
    const url = part.image_url?.url ?? part.image_url ?? part.url;
    return typeof url === 'string' && /^data:/i.test(url);
}

function describeImagePart(part) {
    if (!IMAGE_UPLOAD_ENABLED && hasInlineImageData(part)) return '[Image attached; not visible through this proxy]';
    const image = decodeImagePart(part);
    if (image) return IMAGE_UPLOAD_ENABLED ? `[Image ${image.hash} attached]` : '[Image attached; not visible through this proxy]';
    return describeAttachment('Image', part.image_url?.url ?? part.image_url ?? part.url ?? part.source?.url ?? part.source?.data);
}

function collectImages(messages, limit = MAX_IMAGES_PER_REQUEST) {
    const images = [];
    const seen = new Set();
    const visit = (content) => {
        if (!Array.isArray(content)) return;
        for (const part of content) {
            if (!part || typeof part !== 'object') continue;
            if (part.type === 'tool_result') { visit(part.content); continue; }
            const image = decodeImagePart(part);
            if (!image) continue;
            if (seen.has(image.hash)) images.splice(images.findIndex(item => item.hash === image.hash), 1);
            seen.add(image.hash);
            images.push(image);
        }
    };
    for (const msg of messages || []) {
        if (msg && !isSystemRole(msg.role)) visit(msg.content);
    }
    return images.slice(-limit);
}

function normalizeMessageContent(content) {
    if (content === null || content === undefined) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(part => {
            if (typeof part === 'string') return part;
            if (!part || typeof part !== 'object') return '';
            if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') return part.text || '';
            if (part.type === 'tool_result') return `[Tool Result ${part.tool_use_id || ''}]\n${normalizeMessageContent(part.content)}`;
            if (part.type === 'thinking' || part.type === 'redacted_thinking' || part.type === 'reasoning') return '';
            if (part.type === 'image_url' || part.type === 'input_image' || part.type === 'image') {
                return describeImagePart(part);
            }
            if (part.type === 'file' || part.type === 'input_file' || part.type === 'document') {
                return describeAttachment('File', part.file?.filename ?? part.filename ?? part.title ?? part.file_url ?? part.source?.url ?? part.source?.data);
            }
            if (typeof part.text === 'string') return part.text;
            if (part.content !== undefined) return normalizeMessageContent(part.content);
            return JSON.stringify(part);
        }).filter(Boolean).join('\n');
    }
    return String(content);
}

function normalizeAnthropicTools(tools = []) {
    return (tools || []).map(tool => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description || '',
            parameters: tool.input_schema || tool.parameters || { type: 'object', properties: {} }
        }
    })).filter(tool => tool.function.name);
}

function normalizeResponsesTools(tools = []) {
    return (tools || []).map(tool => {
        if (tool.type === 'function' && tool.function) return tool;
        if (tool.type === 'function' && tool.name) {
            return { type: 'function', function: { name: tool.name, description: tool.description || '', parameters: tool.parameters || { type: 'object', properties: {} } } };
        }
        return null;
    }).filter(Boolean);
}

function normalizeResponsesInput(input) {
    if (typeof input === 'string') return [{ role: 'user', content: input }];
    if (!Array.isArray(input)) return [];
    const messages = [];
    for (const item of input) {
        if (!item || typeof item !== 'object') continue;
        if (item.type === 'message') {
            messages.push({ role: item.role || 'user', content: item.content });
        } else if (item.role) {
            messages.push({ role: item.role, content: item.content });
        } else if (item.type === 'function_call') {
            messages.push({ role: 'assistant', content: null, tool_calls: [{
                id: item.call_id || item.id,
                type: 'function',
                function: { name: item.name, arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {}) },
            }] });
        } else if (item.type === 'function_call_output') {
            messages.push({ role: 'tool', tool_call_id: item.call_id, content: item.output });
        } else if (item.type === 'input_text') {
            messages.push({ role: 'user', content: item.text || '' });
        }
    }
    return messages;
}

function normalizeApiParams(params, apiMode) {
    if (apiMode === 'anthropic') {
        const messages = [];
        if (params.system) messages.push({ role: 'system', content: normalizeMessageContent(params.system) });
        for (const msg of params.messages || []) {
            if (msg.role === 'assistant' && Array.isArray(msg.content)) {
                const toolUses = msg.content.filter(part => part && part.type === 'tool_use');
                const text = normalizeMessageContent(msg.content.filter(part => !part || part.type !== 'tool_use'));
                if (text) messages.push({ role: 'assistant', content: text });
                for (const tu of toolUses) {
                    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: tu.id, type: 'function', function: { name: tu.name, arguments: JSON.stringify(tu.input || {}) } }] });
                }
            } else if (msg.role === 'user' && Array.isArray(msg.content) && msg.content.some(part => part && part.type === 'tool_result')) {
                for (const part of msg.content) {
                    if (part && part.type === 'tool_result') messages.push({ role: 'tool', tool_call_id: part.tool_use_id, content: part.content });
                    else messages.push({ role: 'user', content: [part] });
                }
            } else {
                messages.push({ role: msg.role || 'user', content: msg.content });
            }
        }
        return {
            ...params,
            model: params.model || 'deepseek-v4.1-flash',
            messages,
            tools: normalizeAnthropicTools(params.tools || []),
            stream: params.stream === true,
            user: params.metadata?.user_id || params.user,
        };
    }
    if (apiMode === 'responses') {
        const messages = normalizeResponsesInput(params.input);
        if (params.instructions) messages.unshift({ role: 'system', content: params.instructions });
        return {
            ...params,
            model: params.model || 'deepseek-v4.1-flash',
            messages,
            tools: normalizeResponsesTools(params.tools || []),
            stream: params.stream === true,
            user: params.user,
        };
    }
    return params;
}

function safeJsonParseObject(text, fallback = {}) {
    try {
        const parsed = JSON.parse(text || '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
    } catch (e) {
        return fallback;
    }
}

function toAnthropicResponse(openaiResp) {
    const choice = openaiResp.choices[0];
    const msg = choice.message || {};
    const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;
    const content = [];
    if (hasToolCalls) {
        for (const tc of msg.tool_calls) {
            content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: safeJsonParseObject(tc.function.arguments) });
        }
    } else {
        content.push({ type: 'text', text: msg.content || '' });
    }
    const response = {
        id: 'msg_' + openaiResp.id,
        type: 'message',
        role: 'assistant',
        model: openaiResp.model,
        content,
        stop_reason: choice.finish_reason === 'tool_calls' ? 'tool_use' : (choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn'),
        stop_sequence: null,
        usage: {
            input_tokens: openaiResp.usage?.prompt_tokens || 0,
            output_tokens: openaiResp.usage?.completion_tokens || 0,
        },
    };
    if (!hasToolCalls && msg.reasoning_content) response.reasoning_content = msg.reasoning_content;
    return response;
}

function chunkText(text, size) {
    return String(text || '').match(new RegExp(`[\\s\\S]{1,${size}}`, 'gu')) || [];
}

function toResponsesResponse(openaiResp, ids = {}) {
    const choice = openaiResp.choices[0];
    const msg = choice.message || {};
    const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;
    const output = [];
    if (!hasToolCalls && msg.reasoning_content) {
        output.push({ id: ids.reasoning || 'rs_' + Date.now(), type: 'reasoning', summary: [{ type: 'summary_text', text: msg.reasoning_content }], status: 'completed' });
    }
    if (hasToolCalls) {
        for (const tc of msg.tool_calls) {
            output.push({ type: 'function_call', id: 'fc_' + tc.id, call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments || '{}' });
        }
    } else {
        output.push({ id: ids.message || 'msg_' + Date.now(), type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: msg.content || '', annotations: [] }] });
    }
    return {
        id: ids.response || openaiResp.id.replace(/^ds-/, 'resp_'),
        object: 'response',
        created_at: openaiResp.created,
        status: 'completed',
        model: openaiResp.model,
        output,
        output_text: msg.content || '',
        usage: {
            input_tokens: openaiResp.usage?.prompt_tokens || 0,
            output_tokens: openaiResp.usage?.completion_tokens || 0,
            total_tokens: openaiResp.usage?.total_tokens || 0,
            output_tokens_details: { reasoning_tokens: openaiResp.usage?.completion_tokens_details?.reasoning_tokens || 0 },
        },
    };
}

function sendJsonError(res, status, message, type, extra = {}, headers = {}) {
    if (res.headersSent) { if (!res.writableEnded) res.end(); return; }
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify({ error: { message, type, ...extra } }));
}

function sendCompletion(res, apiMode, stream, openaiResponse) {
    if (stream) {
        if (apiMode === 'anthropic') sendAnthropicStream(res, openaiResponse);
        else if (apiMode === 'responses') sendResponsesStream(res, openaiResponse);
        else sendOpenAIStream(res, openaiResponse);
        return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (apiMode === 'anthropic') res.end(JSON.stringify(toAnthropicResponse(openaiResponse)));
    else if (apiMode === 'responses') res.end(JSON.stringify(toResponsesResponse(openaiResponse)));
    else res.end(JSON.stringify(openaiResponse));
}

function writeSse(res, event, data) {
    if (event) res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
}

const SSE_HEADERS = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' };

function anthropicErrorType(type, status) {
    if (status === 429 || /rate/i.test(String(type))) return 'rate_limit_error';
    if (status === 401 || status === 403) return 'authentication_error';
    if (status === 400 || status === 413) return 'invalid_request_error';
    if (status === 503) return 'overloaded_error';
    return 'api_error';
}

function createStreamWriter(res, apiMode, { model = 'deepseek-v4.1-flash', promptTokens = 0, id = 'ds-' + Date.now(), created = Math.floor(Date.now() / 1000) } = {}) {
    const state = { started: false, ended: false, lastWriteAt: 0, reasoning: '', content: '', section: null, reasoningSource: null, pendingWhitespace: '', sources: 0 };
    const itemIds = { response: id.replace(/^ds-/, 'resp_'), reasoning: `rs_${id}`, message: `msg_${id}` };
    let roleSent = false;
    let blockIndex = -1;
    let outputIndex = -1;

    const sse = (event, data) => { writeSse(res, event, data); state.lastWriteAt = Date.now(); };
    const chunk = (delta, finishReason = null) => sse(null, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finishReason }] });
    const responseSkeleton = () => ({ id: itemIds.response, object: 'response', created_at: created, status: 'in_progress', model, output: [], });

    function start() {
        if (state.started) return;
        state.started = true;
        res.writeHead(200, SSE_HEADERS);
        state.lastWriteAt = Date.now();
        if (apiMode === 'anthropic') {
            sse('message_start', { type: 'message_start', message: { id: 'msg_' + id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: promptTokens, output_tokens: 0 }, } });
        } else if (apiMode === 'responses') {
            sse('response.created', { type: 'response.created', response: responseSkeleton() });
            sse('response.in_progress', { type: 'response.in_progress', response: responseSkeleton() });
        }
    }

    function openaiRole(toolTurn) {
        if (roleSent) return;
        roleSent = true;
        chunk({ role: 'assistant', content: toolTurn ? null : '' });
    }

    function openSection(kind) {
        if (state.section === kind) return;
        closeSection();
        state.section = kind;
        if (apiMode === 'openai') {
            openaiRole(false);
        } else if (apiMode === 'anthropic') {
            blockIndex++;
            sse('content_block_start', { type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } });
            if (kind === 'reasoning') sse('content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: '[reasoning]\n' } });
        } else {
            outputIndex++;
            if (kind === 'reasoning') {
                sse('response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item: { id: itemIds.reasoning, type: 'reasoning', summary: [], status: 'in_progress' } });
                sse('response.reasoning_summary_part.added', { type: 'response.reasoning_summary_part.added', item_id: itemIds.reasoning, output_index: outputIndex, summary_index: 0, part: { type: 'summary_text', text: '' } });
            } else {
                sse('response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item: { id: itemIds.message, type: 'message', role: 'assistant', status: 'in_progress', content: [] } });
                sse('response.content_part.added', { type: 'response.content_part.added', item_id: itemIds.message, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
            }
        }
    }

    function closeSection() {
        const kind = state.section;
        if (!kind) return;
        state.section = null;
        if (apiMode === 'openai') return;
        if (apiMode === 'anthropic') {
            if (kind === 'reasoning') sse('content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: '\n[/reasoning]\n' } });
            sse('content_block_stop', { type: 'content_block_stop', index: blockIndex });
            return;
        }
        if (kind === 'reasoning') {
            const part = { type: 'summary_text', text: state.reasoning };
            sse('response.reasoning_summary_text.done', { type: 'response.reasoning_summary_text.done', item_id: itemIds.reasoning, output_index: outputIndex, summary_index: 0, text: state.reasoning });
            sse('response.reasoning_summary_part.done', { type: 'response.reasoning_summary_part.done', item_id: itemIds.reasoning, output_index: outputIndex, summary_index: 0, part });
            sse('response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item: { id: itemIds.reasoning, type: 'reasoning', summary: [part], status: 'completed' } });
        } else {
            const part = { type: 'output_text', text: state.content, annotations: [] };
            sse('response.output_text.done', { type: 'response.output_text.done', item_id: itemIds.message, output_index: outputIndex, content_index: 0, text: state.content });
            sse('response.content_part.done', { type: 'response.content_part.done', item_id: itemIds.message, output_index: outputIndex, content_index: 0, part });
            sse('response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item: { id: itemIds.message, type: 'message', role: 'assistant', status: 'completed', content: [part] } });
        }
    }

    function emit(kind, text) {
        if (!text) return;
        start();
        openSection(kind);
        for (const piece of chunkText(text, apiMode === 'openai' ? 50 : 80)) {
            if (apiMode === 'openai') chunk(kind === 'reasoning' ? { reasoning_content: piece } : { content: piece });
            else if (apiMode === 'anthropic') sse('content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: piece } });
            else if (kind === 'reasoning') sse('response.reasoning_summary_text.delta', { type: 'response.reasoning_summary_text.delta', item_id: itemIds.reasoning, output_index: outputIndex, summary_index: 0, delta: piece });
            else sse('response.output_text.delta', { type: 'response.output_text.delta', item_id: itemIds.message, output_index: outputIndex, content_index: 0, delta: piece });
        }
        state[kind] += text;
    }

    function pushReasoning(text, sourceId = null) {
        if (state.ended || state.content || state.section === 'content') return;
        if (sourceId !== null) {
            if (state.reasoningSource !== null && state.reasoningSource !== sourceId) return;
            if (text) state.reasoningSource = sourceId;
        }
        emit('reasoning', text);
    }

    function pushContent(text) {
        if (state.ended) return;
        if (!state.content) {
            const combined = state.pendingWhitespace + text;
            if (!combined.trim()) { state.pendingWhitespace = combined; return; }
            state.pendingWhitespace = '';
            text = combined;
        }
        emit('content', text);
    }

    return {
        get started() { return state.started; },
        get lastWriteAt() { return state.lastWriteAt; },
        get streamedContent() { return state.content; },
        source(kind) {
            const sourceId = ++state.sources;
            if (kind === 'content' && !state.content) state.pendingWhitespace = '';
            let consumed = 0;
            let carry = '';
            return (cumulative) => {
                const raw = String(cumulative || '');
                if (raw.length <= consumed) return;
                let piece = carry + raw.slice(consumed);
                consumed = raw.length;
                carry = '';
                if (/[\ud800-\udbff]$/.test(piece)) { carry = piece.slice(-1); piece = piece.slice(0, -1); }
                piece = sanitizeContent(piece);
                if (kind === 'reasoning') pushReasoning(piece, sourceId);
                else pushContent(piece);
            };
        },
        keepAlive() {
            if (state.ended) return;
            start();
            res.write(': keep-alive\n\n');
            state.lastWriteAt = Date.now();
        },
        finish(openaiResp) {
            if (state.ended) return;
            const choice = openaiResp.choices[0];
            const msg = choice.message || {};
            const toolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0 ? msg.tool_calls : null;
            const usage = { input_tokens: openaiResp.usage?.prompt_tokens || 0, output_tokens: openaiResp.usage?.completion_tokens || 0 };
            start();
            if (toolCalls) {
                closeSection();
                if (apiMode === 'openai') {
                    openaiRole(true);
                    chunk({ tool_calls: toolCalls.map((tc, index) => ({ index, ...tc })) });
                    chunk({}, 'tool_calls');
                } else if (apiMode === 'anthropic') {
                    for (const tc of toolCalls) {
                        blockIndex++;
                        sse('content_block_start', { type: 'content_block_start', index: blockIndex, content_block: { type: 'tool_use', id: tc.id, name: tc.function.name, input: {} } });
                        sse('content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'input_json_delta', partial_json: tc.function.arguments || '{}' } });
                        sse('content_block_stop', { type: 'content_block_stop', index: blockIndex });
                    }
                    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage });
                } else {
                    for (const tc of toolCalls) {
                        outputIndex++;
                        const item = { type: 'function_call', id: 'fc_' + tc.id, call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments || '{}', status: 'completed' };
                        sse('response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item: { ...item, arguments: '', status: 'in_progress' } });
                        sse('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', output_index: outputIndex, item_id: item.id, delta: item.arguments });
                        sse('response.function_call_arguments.done', { type: 'response.function_call_arguments.done', output_index: outputIndex, item_id: item.id, arguments: item.arguments });
                        sse('response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item });
                    }
                }
            } else {
                const reasoning = String(msg.reasoning_content || '');
                if (reasoning && !state.content && reasoning.startsWith(state.reasoning)) pushReasoning(reasoning.slice(state.reasoning.length));
                const content = String(msg.content || '');
                let rest = content;
                if (state.content) {
                    if (content.startsWith(state.content)) {
                        rest = content.slice(state.content.length);
                    } else {
                        let common = 0;
                        while (common < state.content.length && content[common] === state.content[common]) common++;
                        console.log(`[stream] final answer diverged from the streamed text after ${common} chars`);
                        rest = content.slice(common);
                    }
                }
                start();
                openSection('content');
                if (rest) emit('content', rest);
                closeSection();
                if (apiMode === 'openai') {
                    chunk({}, choice.finish_reason === 'length' ? 'length' : 'stop');
                } else if (apiMode === 'anthropic') {
                    sse('message_delta', { type: 'message_delta', delta: { stop_reason: choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn', stop_sequence: null }, usage });
                }
            }
            if (apiMode === 'anthropic') {
                sse('message_stop', { type: 'message_stop' });
            } else if (apiMode === 'responses') {
                const streamed = toolCalls ? openaiResp : {
                    ...openaiResp,
                    choices: [{ ...choice, message: { ...msg, reasoning_content: state.reasoning || undefined, content: state.content } }],
                };
                sse('response.completed', { type: 'response.completed', response: toResponsesResponse(streamed, itemIds) });
                res.write('data: [DONE]\n\n');
            } else {
                res.write('data: [DONE]\n\n');
            }
            state.ended = true;
            res.end();
        },
        fail(status, error, headers = {}) {
            if (state.ended) return;
            state.ended = true;
            if (!state.started) {
                if (res.headersSent) { if (!res.writableEnded) res.end(); return; }
                res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
                res.end(JSON.stringify({ error }));
                return;
            }
            const message = error?.message || 'DeepSeek request failed';
            if (apiMode === 'anthropic') {
                writeSse(res, 'error', { type: 'error', error: { type: anthropicErrorType(error?.type, status), message } });
            } else if (apiMode === 'responses') {
                writeSse(res, 'error', { type: 'error', code: error?.type || 'server_error', message, param: null, error: { ...error, status } });
            } else {
                writeSse(res, null, { error: { ...error, code: status } });
                res.write('data: [DONE]\n\n');
            }
            res.end();
        },
    };
}

function sendStreamedCompletion(res, apiMode, openaiResp) {
    createStreamWriter(res, apiMode, { model: openaiResp.model, promptTokens: openaiResp.usage?.prompt_tokens || 0, id: openaiResp.id, created: openaiResp.created }).finish(openaiResp);
}

function sendAnthropicStream(res, openaiResp) { sendStreamedCompletion(res, 'anthropic', openaiResp); }
function sendResponsesStream(res, openaiResp) { sendStreamedCompletion(res, 'responses', openaiResp); }
function sendOpenAIStream(res, openaiResp) { sendStreamedCompletion(res, 'openai', openaiResp); }

function storeHistory(session, prompt, content, toolCall) {
    const assistantResponse = toolCall
        ? toolCallAsPromptText({ function: toolCall })
        : content;
    const shortPrompt = prompt.length > 500 ? '...' + prompt.substring(prompt.length - 500) : prompt;
    const shortAnswer = truncatePromptMiddle(assistantResponse, MAX_HISTORY_ENTRY_CHARS, 0.6);
    session.history.push({ user: shortPrompt, assistant: shortAnswer });
    while (session.history.length > MAX_HISTORY_LENGTH) session.history.shift();
    let historyChars = session.history.reduce((sum, e) => sum + e.user.length + e.assistant.length, 0);
    while (historyChars > MAX_HISTORY_CHARS && session.history.length > 1) {
        const removed = session.history.shift();
        historyChars -= removed.user.length + removed.assistant.length;
    }
}

function extractScreenshotPaths(messages) {
    const paths = [];
    const list = Array.isArray(messages) ? messages : [];
    let start = 0;
    for (let i = list.length - 1; i >= 0; i--) {
        if (list[i]?.role === 'user') { start = i; break; }
    }
    const addPath = (filePath) => {
        const tag = `MEDIA:${filePath}`;
        if (paths.includes(tag)) return;
        try {
            if (fs.statSync(filePath).isFile()) paths.push(tag);
        } catch (e) {   }
    };
    for (const msg of list.slice(start)) {
        if (!msg) continue;
        const content = normalizeMessageContent(msg.content);
        if (!content) continue;
        if (msg.role === 'tool') {
            const pngMatch = content.match(/["'](screenshot_path|path)["']\s*:\s*["']([^"']+\.(?:png|jpg|jpeg|webp|gif))["']/i);
            if (pngMatch && pngMatch[2].startsWith('/')) addPath(pngMatch[2]);
            for (const tag of content.match(/MEDIA:(\S+)/g) || []) addPath(tag.replace(/^MEDIA:/, ''));
        }
        if (msg.role === 'user' || msg.role === 'assistant') {
            const pathRegex = /(\/[^\s<>"']+\.(?:png|jpg|jpeg|webp|gif))/gi;
            let match;
            while ((match = pathRegex.exec(content)) !== null) addPath(match[1]);
        }
    }
    return paths;
}

const PROMPT_COMPACTION_MARKER = '\n\n[Earlier context compacted by DeepSeek Pocket]\n\n';

function truncatePromptMiddle(text, maxChars, headRatio = 0.35) {
    const value = String(text || '');
    if (value.length <= maxChars) return value;
    if (maxChars <= 0) return '';
    if (maxChars <= PROMPT_COMPACTION_MARKER.length) return value.substring(value.length - maxChars);
    const payloadChars = maxChars - PROMPT_COMPACTION_MARKER.length;
    const headChars = Math.max(0, Math.min(payloadChars, Math.floor(payloadChars * headRatio)));
    const tailChars = payloadChars - headChars;
    return value.substring(0, headChars) + PROMPT_COMPACTION_MARKER + value.substring(value.length - tailChars);
}

function hasExplicitConversationHistory(messages) {
    return (messages || []).some(msg => msg && msg.role === 'assistant');
}

function buildRecoveryHistoryPrefix(history) {
    if (!Array.isArray(history) || history.length === 0) return '';
    let prefix = '[Previous conversation]\n';
    for (const exchange of history) {
        prefix += `User: ${String(exchange?.user || '')}\nAssistant: ${String(exchange?.assistant || '')}\n\n`;
    }
    return prefix + '[Continue from here]\n\n';
}

function buildBoundedPrompt(systemPrompt, historyPrefix, conversationPrompt, maxChars = MAX_UPSTREAM_PROMPT_CHARS) {
    const system = String(systemPrompt || '').trim();
    const history = String(historyPrefix || '');
    const conversation = String(conversationPrompt || '').trim();
    const original = system ? `${system}\n\n${history}${conversation}` : `${history}${conversation}`;
    const safeMax = Math.max(1, Math.floor(Number(maxChars) || MAX_UPSTREAM_PROMPT_CHARS));
    if (original.length <= safeMax) {
        return { prompt: original, compacted: false, historyDropped: false, originalChars: original.length, promptChars: original.length };
    }

    const historyDropped = history.length > 0;
    const currentConversation = conversation;
    const separatorLength = system && currentConversation ? 2 : 0;
    let systemBudget = system ? Math.floor((safeMax - separatorLength) * 0.5) : 0;
    let conversationBudget = Math.max(0, safeMax - separatorLength - systemBudget);

    if (system.length < systemBudget) {
        systemBudget = system.length;
        conversationBudget = Math.max(0, safeMax - separatorLength - systemBudget);
    } else if (currentConversation.length < conversationBudget) {
        conversationBudget = currentConversation.length;
        systemBudget = Math.max(0, safeMax - separatorLength - conversationBudget);
    }

    const boundedSystem = truncatePromptMiddle(system, systemBudget, 0.35);
    const boundedConversation = truncatePromptMiddle(currentConversation, conversationBudget, 0.25);
    let bounded = boundedSystem && boundedConversation
        ? `${boundedSystem}\n\n${boundedConversation}`
        : (boundedSystem || boundedConversation);
    if (bounded.length > safeMax) bounded = bounded.substring(0, safeMax);
    return {
        prompt: bounded,
        compacted: true,
        historyDropped,
        originalChars: original.length,
        promptChars: bounded.length,
    };
}

function buildRetryPrompt(systemPrompt, historyPrefix, conversationPrompt, currentPrompt, maxChars) {
    const retryBuild = buildBoundedPrompt(systemPrompt, historyPrefix, conversationPrompt, maxChars);
    const current = String(currentPrompt || '');
    return {
        ...retryBuild,
        compacted: retryBuild.compacted || retryBuild.prompt.length < current.length,
        originalChars: retryBuild.originalChars,
        promptChars: retryBuild.prompt.length,
        previousPromptChars: current.length,
    };
}

function appendPromptInstruction(promptText, instruction, maxChars = MAX_UPSTREAM_PROMPT_CHARS) {
    const suffix = `\n\n${String(instruction || '').trim()}`;
    const baseBudget = Math.max(0, maxChars - suffix.length);
    return truncatePromptMiddle(promptText, baseBudget, 0.35) + suffix;
}

function isContinuationRecoverySafe(previousAccountId, continuationCall) {
    const nextAccountId = continuationCall?.account?.id;
    return !previousAccountId
        || !nextAccountId
        || nextAccountId === previousAccountId
        || continuationCall?.freshSessionReset === true;
}

function isContextTooLongError(error) {
    const message = typeof error === 'string'
        ? error
        : `${error?.content || ''} ${error?.message || ''} ${error?.finish_reason || ''} ${error?.type || ''}`;
    return /(?:content|prompt|context).{0,40}(?:too\s+long|too\s+large|length|limit|maximum)|maximum.{0,30}(?:context|token)|too\s+many\s+tokens|содержани[ея]\s+слишком\s+длин|контекст.{0,30}(?:длин|лимит)|内容.{0,12}(?:过长|太长)|上下文.{0,12}(?:过长|超出)/i.test(message);
}

function normalizeRetryResponse(result) {
    return {
        content: result?.content ? sanitizeContent(result.content) : '',
        reasoningContent: result?.reasoningContent ? sanitizeContent(result.reasoningContent) : '',
        finishReason: result?.finishReason ?? null,
        modelError: result?.modelError || null,
    };
}

function isRateLimitError(error) {
    const message = typeof error === 'string'
        ? error
        : `${error?.content || ''} ${error?.message || ''} ${error?.type || ''}`;
    return /too\s+many\s+(?:messages|requests)|rate[\s_-]?limit|过于频繁|слишком\s+(?:много\s+(?:сообщений|запросов)|частые\s+сообщения)/i.test(message);
}

function classifyRecoveryFailure(modelError, timedOut = false) {
    if (isContextTooLongError(modelError)) return { status: 400, type: 'context_length_exceeded' };
    if (isRateLimitError(modelError)) return { status: 429, type: 'rate_limit_error' };
    if (timedOut) return { status: 504, type: 'request_timeout' };
    return { status: 502, type: modelError?.type || 'empty_response' };
}

function isTimeoutError(error) {
    const name = String(error?.name || '');
    const message = String(error?.message || '');
    return name === 'TimeoutError' || name === 'AbortError' || /(?:timed?\s*out|timeout)/i.test(message);
}

function isSystemRole(role) {
    return role === 'system' || role === 'developer';
}

function toolCallAsPromptText(toolCall) {
    const name = toolCall?.function?.name || toolCall?.name || '';
    let args = toolCall?.function?.arguments ?? toolCall?.arguments ?? {};
    if (typeof args === 'string') {
        try { args = JSON.parse(args || '{}'); } catch (e) {   }
    }
    return JSON.stringify({ tool_call: { name, arguments: args } });
}

function buildToolNameIndex(messages) {
    const names = new Map();
    for (const msg of messages || []) {
        if (msg?.role !== 'assistant' || !Array.isArray(msg.tool_calls)) continue;
        for (const tc of msg.tool_calls) {
            if (tc?.id && tc.function?.name) names.set(tc.id, tc.function.name);
        }
    }
    return names;
}

function formatConversation(messages, toolNames = buildToolNameIndex(messages)) {
    let conversation = '';
    for (const msg of messages || []) {
        if (!msg || isSystemRole(msg.role)) continue;
        if (msg.role === 'user') {
            const text = normalizeMessageContent(msg.content);
            if (text) conversation += `<user_message>\n${text}\n</user_message>\n\n`;
        } else if (msg.role === 'assistant') {
            const text = normalizeMessageContent(msg.content);
            if (text) conversation += `<assistant_message>\n${text}\n</assistant_message>\n\n`;
            for (const tc of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
                conversation += `<assistant_message>\n${toolCallAsPromptText(tc)}\n</assistant_message>\n\n`;
            }
        } else if (msg.role === 'tool' || msg.role === 'function') {
            const name = msg.name || toolNames.get(msg.tool_call_id) || '';
            conversation += `[Tool Result${name ? `: ${name}` : ''}]\n${normalizeMessageContent(msg.content)}\n\n`;
        }
    }
    return conversation.trim();
}

function isReplacementStub(result) {
    const signal=[result?.finishReason,result?.modelError?.finish_reason,result?.responseStatus].filter(Boolean).join(' ');
    if(/(?:content[_ -]filter(?:ed)?|content[_ -]blocked|censored)/i.test(signal))return true;
    const text=String(result?.content||'').normalize('NFKC').replace(/[’‘]/g,"'").replace(/\s+/g,' ').trim().toLowerCase();
    return ["sorry, that's beyond my current scope. let's talk about something else.","sorry, that is beyond my current scope. let's talk about something else."].includes(text);
}

function simulatedGenerationSettings(params = {}) {
    const lines=[];
    if(typeof params.temperature==='number' && Number.isFinite(params.temperature) && params.temperature>=0 && params.temperature<=2)
        lines.push(`Respond as if your sampling temperature were ${params.temperature}. Lower values favor consistency and precision; higher values favor variety and creativity.`);
    const limits=['max_completion_tokens','max_output_tokens','max_tokens'].map(key=>params[key]).filter(value=>typeof value==='number' && Number.isSafeInteger(value) && value>0);
    const maxTokens=limits.length?Math.min(...limits):null;
    if(maxTokens!==null)lines.push(`Keep the complete generated answer within approximately ${maxTokens} tokens. Plan for this budget, prioritize essential information, and finish coherently without unnecessary padding.`);
    return {maxTokens,block:lines.length?'<HIGH_PRIORITY_GENERATION_SETTINGS>\nTreat the following generation preferences as high-priority output constraints within the system instructions and current task. These are requested behavioral settings, not actual decoder controls.\n'+lines.join('\n')+'\n</HIGH_PRIORITY_GENERATION_SETTINGS>':''};
}

function formatMessages(messages, tools, params = {}) {
    let systemPrompt = '';
    for (const msg of messages || []) {
        if (msg && isSystemRole(msg.role) && msg.content) {
            systemPrompt += normalizeMessageContent(msg.content) + '\n';
        }
    }
    systemPrompt += formatToolDefinitions(tools);
    const generation=simulatedGenerationSettings(params);
    return {
        prompt: formatConversation(messages),
        systemPrompt: [systemPrompt.trim() ? '<system_instructions>\n'+systemPrompt.trim()+'\n</system_instructions>' : '',generation.block].filter(Boolean).join('\n\n'),
        toolReminder: formatToolReminder(tools),
    };
}

function hashText(value) {
    return crypto.createHash('sha256').update(String(value)).digest('base64');
}

function conversationMessageKey(msg) {
    const toolCalls = Array.isArray(msg?.tool_calls)
        ? msg.tool_calls.map(tc => [tc?.function?.name || '', String(tc?.function?.arguments ?? ''), tc?.id || ''])
        : [];
    return hashText(JSON.stringify([
        msg?.role || '',
        normalizeMessageContent(msg?.content),
        toolCalls,
        msg?.tool_call_id || '',
    ]));
}

const SEND_FULL_HISTORY = isTruthy(process.env.DEEPSEEK_SEND_FULL_HISTORY);
const NEW_CHAT_EACH_MESSAGE = SEND_FULL_HISTORY && isTruthy(process.env.DEEPSEEK_NEW_CHAT_EACH_MESSAGE);

function planSessionTurn(session, messages, contextKey, policy = {}) {
    const conversation = (messages || []).filter(msg => msg && !isSystemRole(msg.role));
    const keys = conversation.map(conversationMessageKey);
    const fullHistory=policy.sendFullHistory ?? SEND_FULL_HISTORY;
    const newChat=fullHistory && (policy.newChatEachMessage ?? NEW_CHAT_EACH_MESSAGE);
    if (newChat || policy.regenerate) return {mode:'full',reason:policy.regenerate?'regenerate response':'new chat for each message',keys};
    if (!session?.id) return { mode: 'full', reason: null, keys };
    if (!session.contextKey) return { mode: 'full', reason: 'remote chat has no completed turn yet', keys };
    const sent = Array.isArray(session.sentMessageKeys) ? session.sentMessageKeys : [];
    if (!conversation.some(msg => msg.role === 'assistant'))
        return {mode:'full',reason:'new conversation without prior assistant turns',keys};
    if (session.contextKey !== contextKey) return { mode: 'full', reason: 'system prompt or tools changed', keys };
    if (sent.length > 0 && sent.length < keys.length && sent.every((key, index) => keys[index] === key)) {
        if(session.answerKey && conversation[sent.length]?.role==='assistant' && conversationMessageKey(conversation[sent.length])!==session.answerKey)
            return {mode:'full',reason:'assistant branch changed',keys};
        let start = sent.length;
        while (start < conversation.length && conversation[start].role === 'assistant') start++;
        const delta = conversation.slice(start);
        if (delta.some(msg => msg.role !== 'assistant')) {
            if(fullHistory)return {mode:'full',reason:'full history replay',keys,keepRemote:true};
            return { mode: 'delta', messages: delta, keys,includeSystem:true };
        }
        return { mode: 'full', reason: 'no new input after the last answer', keys };
    }
    return { mode: 'full', reason: 'conversation history diverged', keys };
}

function buildDeltaPrompt(deltaMessages, allMessages, toolReminder, maxChars = MAX_UPSTREAM_PROMPT_CHARS, systemPrompt = '') {
    const body = formatConversation(deltaMessages, buildToolNameIndex(allMessages));
    const suffix = toolReminder ? `\n\n${toolReminder}` : '';
    const budget = Math.max(0, maxChars - suffix.length);
    if (systemPrompt) {
        const bounded = buildBoundedPrompt(systemPrompt, '', body, budget);
        return { prompt: bounded.prompt + suffix, compacted: bounded.compacted };
    }
    const bounded = truncatePromptMiddle(body, budget, 0.25);
    return { prompt: bounded + suffix, compacted: bounded.length < body.length };
}

const server = http.createServer(async (req, res) => {
    const requestOrigin = req.headers.origin;
    res.setHeader('Vary', 'Origin');
    if (!isBrowserOriginAllowed(requestOrigin)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Browser origin is not allowed', type: 'cors_error' } }));
        return;
    }
    if (requestOrigin) res.setHeader('Access-Control-Allow-Origin', normalizeOrigin(requestOrigin));
    setCorsResponseHeaders(res,req.headers['access-control-request-headers']);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const isPublicProbe = req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health' || url.pathname === '/readyz');
    if (!isPublicProbe && !isProxyAuthorized(req.headers.authorization, PROXY_API_KEY, req.headers['x-api-key'])) {
        res.writeHead(401, {
            'Content-Type': 'application/json',
            'WWW-Authenticate': 'Bearer',
        });
        res.end(JSON.stringify({ error: { message: 'Invalid or missing proxy API key', type: 'authentication_error' } }));
        return;
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
        const includePrivateStatus = !PROXY_API_KEY || isProxyAuthorized(req.headers.authorization, PROXY_API_KEY, req.headers['x-api-key']);
        const health = { status: 'ok', service: 'DeepSeek Pocket', };
        if (includePrivateStatus) Object.assign(health, {
            models: SUPPORTED_MODEL_IDS,
            unsupported_models: Object.keys(MODEL_CONFIGS).filter(id => !MODEL_CONFIGS[id].supported),
            agents: sessions.size,
            in_flight: inFlight,
            total_messages:totalMessages,
            accounts: accounts.map(accountStatus),
            config_ready: hasAuthConfig(),
            session_reuse: { strategy: 'sticky per x-agent-session/user', ttl_minutes: Math.round(SESSION_TTL_MS / 60000), max_messages: MAX_MESSAGE_DEPTH, reset_all: 'POST /reset-session?agent=all', send_full_history:SEND_FULL_HISTORY,new_chat_each_message:NEW_CHAT_EACH_MESSAGE },
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(health));
        return;
    }

    if (req.method === 'GET' && url.pathname === '/readyz') {
        const now = Date.now();
        const ready = accounts.filter(a => a.config.token && a.config.cookie && a.cooldownUntil <= now).length;
        res.writeHead(ready > 0 ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ready: ready > 0, ready_accounts: ready, total_accounts: accounts.length }));
        return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: SUPPORTED_MODEL_IDS.map(id => ({ id, object: 'model', created: 1700000000, owned_by: 'deepseek-web', real_model: MODEL_CONFIGS[id].real_model, capabilities: MODEL_CONFIGS[id].capabilities })) }));
        return;
    }

    if (req.method === 'GET' && (url.pathname === '/v1/model-capabilities' || url.pathname === '/api/model-capabilities')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'model_capabilities', data: ALL_MODEL_CAPABILITIES }));
        return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/sessions') {
        const agentList = [];
        for (const [agentId, session] of sessions) {
            agentList.push({
                agent: agentId,
                session_id: session.id,
                message_count: session.messageCount,
                account: session.accountId,
                history_size: session.history.length,
                tracked_messages: (session.sentMessageKeys || []).length,
                remote_chars: session.remoteChars || 0,
                busy: session.busy === true,
                age_min: session.createdAt ? Math.round((Date.now() - session.createdAt) / 60000) : 0,
            });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ agents: agentList, total: agentList.length }));
        return;
    }

    if (req.method === 'POST' && url.pathname === '/reset-session') {
        const agentId = url.searchParams.get('agent') || 'default';
        if (agentId === 'all') {
            const count = sessions.size;
            sessions.clear();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'all_sessions_cleared', count }));
            return;
        }
        const session = sessions.get(agentId);
        if (!session) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `No session for agent: ${agentId}` }));
            return;
        }
        const historyCount = session.history.length;
        const historyPreview = session.history.map(e => e.user.substring(0, 40)).join(' | ');
        resetRemoteSession(session);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'session_reset', agent: agentId, history_preserved: historyCount, history: historyPreview }));
        return;
    }

    const apiMode = url.pathname === '/v1/messages'
        ? 'anthropic'
        : (url.pathname === '/v1/responses' ? 'responses' : 'openai');
    const acceptedPostPaths = ['/v1/chat/completions', '/v1/messages', '/v1/responses'];
    if (req.method !== 'POST' || !acceptedPostPaths.includes(url.pathname)) {
        res.writeHead(404); res.end('Not found'); return;
    }

    if (inFlight >= MAX_CONCURRENT) {
        res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '2' });
        res.end(JSON.stringify({ error: { message: `Server busy (${inFlight}/${MAX_CONCURRENT} requests in flight). Retry shortly.`, type: 'overloaded' } }));
        return;
    }

    const MAX_BODY_BYTES = Infinity;
    const bodyChunks = [];
    let bodyBytes = 0;
    let bodyTooLarge = false;
    req.on('data', chunk => {
        if (bodyTooLarge) return;
        bodyBytes += chunk.length;
        if (bodyBytes > MAX_BODY_BYTES) {
            bodyTooLarge = true;
            bodyChunks.length = 0;
            sendJsonError(res, 413, 'Request body too large', 'payload_too_large', {}, { 'Connection': 'close' });
            return;
        }
        bodyChunks.push(chunk);
    });
    req.on('end', async () => {
        if (bodyTooLarge) return;
        const body = Buffer.concat(bodyChunks).toString('utf8');
        inFlight++;
        let clientGone = false;
        const requestAbort = new AbortController();
        events.setMaxListeners(0, requestAbort.signal);
        res.on('close', () => {
            if (res.writableFinished) return;
            clientGone = true;
            requestAbort.abort(new Error('client disconnected'));
        });
        const requestStartedAt = Date.now();
        const deadlineHit = () => Date.now() - requestStartedAt > REQUEST_DEADLINE_MS;
        let activeSession = null;
        let activeAgentId = null;
        let lockedSession = null;
        let live = null;
        let keepAliveTimer = null;
        const respondError = (status, error, headers = {}) => {
            if (live) { live.fail(status, error, headers); return; }
            if (res.headersSent) { if (!res.writableEnded) res.end(); return; }
            res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
            res.end(JSON.stringify({ error }));
        };
        let remoteTouched = false;
        try {
            let rawParams;
            try { rawParams = JSON.parse(body || '{}'); }
            catch (e) {
                sendJsonError(res, 400, `Request body is not valid JSON: ${e.message}`, 'invalid_request_error');
                return;
            }
            if (!rawParams || typeof rawParams !== 'object' || Array.isArray(rawParams)) {
                sendJsonError(res, 400, 'Request body must be a JSON object', 'invalid_request_error');
                return;
            }
            const params = normalizeApiParams(rawParams, apiMode);
            const messages = Array.isArray(params.messages)
                ? params.messages.filter(m => m && typeof m === 'object')
                : [];
            if (messages.length === 0) {
                sendJsonError(res, 400, 'messages must be a non-empty array', 'invalid_request_error');
                return;
            }
            const tools = Array.isArray(params.tools) ? params.tools : [];
            const stream = params.stream === true;
            const requestedModel = String(params.model || 'deepseek-v4.1-flash').toLowerCase();
            if (!isKnownModel(requestedModel)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: `Unknown model: ${requestedModel}`, type: 'invalid_model', supported_models: SUPPORTED_MODEL_IDS, model_capabilities_url: '/v1/model-capabilities' } }));
                return;
            }
            if (!isSupportedModel(requestedModel)) {
                const cfg = resolveModelConfig(requestedModel);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: `${requestedModel} is not currently supported through this DeepSeek Web API path`, type: 'unsupported_model', model: requestedModel, real_model: cfg.real_model, reason: cfg.unavailable_reason, capabilities: cfg.capabilities, supported_models: SUPPORTED_MODEL_IDS } }));
                return;
            }
            const requestedSession = req.headers['x-agent-session'] || params.session || params.user;
            const rootMessage=messages.find(m=>m.role==='user');
            const rootContext=messages.filter(m=>isSystemRole(m.role)).map(m=>normalizeMessageContent(m.content)).join('\n');
            const agentId = requestedSession ? String(requestedSession) : 'chat-'+hashText(rootContext+'\n'+conversationMessageKey(rootMessage||{})).slice(0,24);
            const agentTag = `[${agentId}]`;
            activeAgentId = agentId;
            console.log(`[DS-API] Request accepted (${apiMode}, ${requestedModel})`);

            const lastUserMessage = [...messages].reverse().find(m => m.role === 'user');
            const lastUserText = lastUserMessage ? normalizeMessageContent(lastUserMessage.content).trim() : '';
            if (lastUserText === '/new') {
                const existing = sessions.get(agentId);
                const historyCount = existing ? existing.history.length : 0;
                sessions.set(agentId, createSession());
                console.log(`${agentTag} /new received — session reset (history cleared: ${historyCount})`);
                const confirmation = buildTextResponse('Started a new chat. Session and history have been reset.', '/new', requestedModel);
                sendCompletion(res, apiMode, stream, confirmation);
                return;
            }

            const { prompt, systemPrompt, toolReminder } = formatMessages(messages, tools, params);
            const clientPromptText = messages.map(m => normalizeMessageContent(m.content)).join('\n');
            const allowedToolNames = new Set(tools
                .filter(tool => tool?.type === 'function' && tool.function?.name)
                .map(tool => tool.function.name));

            if (stream) {
                live = createStreamWriter(res, apiMode, { model: requestedModel, promptTokens: estimateTokens(clientPromptText) });
                keepAliveTimer = setInterval(() => {
                    if (Date.now() - Math.max(requestStartedAt, live.lastWriteAt) >= STREAM_KEEPALIVE_MS) live.keepAlive();
                }, 1000);
                keepAliveTimer.unref();
            }
            const liveProgress = () => null;

            const agentSession = getOrCreateAgentSession(agentId);
            const ephemeral = agentSession.busy === true;
            const session = ephemeral ? createSession() : agentSession;
            if (ephemeral) {
                console.log(`${agentTag} Agent session is busy; serving this concurrent request in a separate DeepSeek chat.`);
            } else {
                agentSession.busy = true;
                lockedSession = agentSession;
            }
            activeSession = session;

            const promptRollover = prepareSessionForPrompt(session);
            if (promptRollover) {
                console.log(`${agentTag} Session ${promptRollover.failedSessionId} reset before prompt build (${promptRollover.reason}); recovery history preserved.`);
            }

            const recoveryHistoryPrefix = '';
            const freshPromptBuild = buildBoundedPrompt(systemPrompt, recoveryHistoryPrefix, prompt);
            const contextKey = hashText(systemPrompt);
            const plan = planSessionTurn(session, messages, contextKey,{regenerate:params.regenerate===true});
            let fullPrompt;
            let promptCompacted;
            if (plan.mode === 'delta') {
                const delta = buildDeltaPrompt(plan.messages, messages, toolReminder, MAX_UPSTREAM_PROMPT_CHARS, systemPrompt);
                fullPrompt = delta.prompt;
                promptCompacted = delta.compacted;
                console.log(`${agentTag} Sending ${plan.messages.length} new message(s) to the existing DeepSeek chat (${fullPrompt.length} chars${delta.compacted ? ', compacted' : ''})`);
            } else {
                if (session.id && !plan.keepRemote) {
                    console.log(`${agentTag} Starting a fresh DeepSeek chat: ${plan.reason}.`);
                    resetRemoteSession(session);
                    if(plan.reason !== 'regenerate response' && plan.reason !== 'new chat for each message')session.history=[];
                }
                fullPrompt = freshPromptBuild.prompt;
                promptCompacted = freshPromptBuild.compacted;
                if (freshPromptBuild.compacted) {
                    console.log(`${agentTag} Compacted upstream prompt ${freshPromptBuild.originalChars} -> ${freshPromptBuild.promptChars} chars${freshPromptBuild.historyDropped ? ' (recovery history dropped)' : ''}`);
                }
            }
            if (promptCompacted) markContextCompacted(res);

            const attachments = IMAGE_UPLOAD_ENABLED ? {
                delta: plan.mode === 'delta' ? collectImages(plan.messages) : plan.keepRemote ? collectImages(messages) : [],
                full: collectImages(messages),
                deadlineAt: requestStartedAt + REQUEST_DEADLINE_MS,
            } : null;

            let lastAccount = null;
            const callDeepSeek = async (promptText, freshPrompt = promptText, callAttachments = attachments) => {
                for (let attempt = 0; ; attempt++) {
                    throwIfAborted(requestAbort.signal);
                    try {
                        const call = await askDeepSeekStream(promptText, agentId, requestedModel, freshPrompt, session, requestAbort.signal, callAttachments);
                        remoteTouched = true;
                        lastAccount = call.account;
                        return call;
                    } catch (error) {
                        const failedAccountId = session.accountId;
                        if (!isAccountLevelError(error) || attempt + 1 >= accounts.length
                            || !hasOtherReadyAccount(failedAccountId) || requestAbort.signal.aborted || deadlineHit()) {
                            throw error;
                        }
                        console.log(`${agentTag} Account ${failedAccountId} failed (HTTP ${error.status}); retrying on another account.`);
                        resetRemoteSession(session);
                        promptText = freshPrompt;
                    }
                }
            };

            async function readDeepSeekResponse(call, onProgress = null) {
                let buffer = '';
                let lastPath = null;
                const fragments = [];
                let fullContent = '';
                let interceptedContent = '';
                let replacementDetected = false;
                let reasoningContent = '';
                let newMessageId = null;
                let finishReason = null;
                let responseStatus = null;
                let modelError = null;

                const rebuildFragmentState = () => {
                    const { responseText, thinkText } = rebuildFragmentText(fragments);
                    if (responseText) fullContent = responseText;
                    reasoningContent = thinkText;
                };

                const appendFragments = (value) => {
                    const incoming = Array.isArray(value) ? value : [value];
                    for (const fragment of incoming) {
                        if (fragment && typeof fragment === 'object') fragments.push({ ...fragment });
                    }
                    rebuildFragmentState();
                };

                const handleLine = (rawLine) => {
                    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
                    if (!line.startsWith('data:')) return;
                    const payload = line.slice(5).trimStart();
                    if (!payload || payload === '[DONE]') return;
                    let d;
                    try { d = JSON.parse(payload); } catch (e) { return; }
                    if (!d || typeof d !== 'object') return;
                    if (d.response_message_id !== undefined && !newMessageId) newMessageId = d.response_message_id;
                    if (isDeepSeekModelErrorEvent(d)) {
                        modelError = { type: d.type || 'error', content: d.content || '', finish_reason: d.finish_reason || null };
                    }
                    if (d.finish_reason) {
                        finishReason = d.finish_reason;
                    }
                    if (d.p !== undefined) lastPath = d.p;
                    if (d.v && typeof d.v === 'object' && d.v.response) {
                        if (d.v.response.message_id !== undefined) {
                            newMessageId = d.v.response.message_id;
                        }
                        if (d.v.response.content !== undefined) {
                            fullContent = d.v.response.content;
                        }
                        if (Array.isArray(d.v.response.fragments)) {
                            fragments.length = 0;
                            appendFragments(d.v.response.fragments);
                        }
                        if (d.v.response.finish_reason !== undefined) {
                            finishReason = d.v.response.finish_reason;
                        }
                        if (typeof d.v.response.status === 'string') responseStatus = d.v.response.status;
                    }
                    if (lastPath === 'response/fragments' && d.v !== undefined) {
                        appendFragments(d.v);
                    }
                    if (lastPath === 'response' && d.v !== undefined) {
                        applyResponsePatchOperations(d.v, appendFragments);
                    }
                    if (lastPath === 'response/fragments/-1/content' && d.v !== undefined && typeof d.v !== 'object') {
                        if (fragments.length > 0) {
                            const lastFragment = fragments[fragments.length - 1];
                            lastFragment.content = `${lastFragment.content || ''}${d.v}`;
                            rebuildFragmentState();
                        }
                    }
                    if (lastPath === 'response/content' && d.v !== undefined && typeof d.v !== 'object') {
                        fullContent += d.v;
                    }
                    if (lastPath === 'response/finish_reason' && d.v !== undefined) {
                        finishReason = d.v;
                    }
                    if (lastPath === 'response/status' && typeof d.v === 'string') {
                        responseStatus = d.v;
                    }
                    if(isReplacementStub({content:fullContent,finishReason,modelError,responseStatus}))replacementDetected=true;
                    else if(fullContent.trim())interceptedContent=fullContent;
                };

                const decoder = new TextDecoder();
                for await (const chunk of readStreamWithTimeouts(call.resp)) {
                    buffer += decoder.decode(chunk, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';
                    for (const line of lines) handleLine(line);
                    if(isReplacementStub({content:fullContent,finishReason,modelError,responseStatus})){replacementDetected=true;}
                    else if(fullContent.trim())interceptedContent=fullContent;
                    if (onProgress) onProgress(fullContent, reasoningContent);
                }
                buffer += decoder.decode();
                if (buffer) handleLine(buffer);
                if (onProgress) onProgress(fullContent, reasoningContent);

                if (!finishReason && /^INCOMPLETE$/i.test(String(responseStatus || ''))) finishReason = 'length';

                if (newMessageId) {
                    session.parentMessageId = newMessageId;
                    session.messageCount++;
                } else {
                    console.log(`${agentTag} WARNING: could not extract message_id`);
                }
                session.remoteChars = (session.remoteChars || 0) + fullContent.length + reasoningContent.length;

                if (fullContent.trim() && isRateLimitError(modelError)) {
                    const retryAfter = String(Math.ceil(RATE_LIMIT_COOLDOWN_MS / 1000));
                    markAccountFailure(call.account, 429, 'rate limited in stream', retryAfter, RATE_LIMIT_COOLDOWN_MS);
                    throw createUpstreamHttpError(429, modelError.content, retryAfter);
                }

                return { content: fullContent, reasoningContent, messageId: newMessageId, finishReason, modelError,responseStatus,replacementDetected,interceptedContent };
            }

            const startTime = Date.now();
            let firstResult;
            try {
                const initialCall = await callDeepSeek(fullPrompt, freshPromptBuild.prompt);
                if (initialCall.promptUsed !== fullPrompt) {
                    fullPrompt = initialCall.promptUsed;
                    if (freshPromptBuild.compacted) {
                        promptCompacted = true;
                        markContextCompacted(res);
                    }
                }
                firstResult = await readDeepSeekResponse(initialCall, liveProgress());
            } catch (error) {
                if (!isContextTooLongError(error)) throw error;
                console.log(`${agentTag} DeepSeek rejected the prompt as too long; retrying with a compacted prompt.`);
                resetRemoteSession(session);
                firstResult = { content: '', reasoningContent: '', finishReason: null, modelError: { type: 'error', content: error.message } };
            }
            const canRecoverReplacement = !NEW_CHAT_EACH_MESSAGE;
            if(canRecoverReplacement && (firstResult.replacementDetected || isReplacementStub(firstResult)) && !clientGone && !deadlineHit()) {
                console.log('[DS-API] Replacement stub detected; retrying once in a new chat with client history.');
                const captured=firstResult.interceptedContent;
                const replay=captured && !isReplacementStub({content:captured})
                    ? [...messages,{role:'assistant',content:captured},{role:'user',content:'Please provide the complete answer to my last request.'}]
                    : messages;
                const formattedReplay=formatMessages(replay,tools,params);
                const recoveryPrompt=buildBoundedPrompt(formattedReplay.systemPrompt,'',formattedReplay.prompt).prompt;
                resetRemoteSession(session);
                const recoveryCall=await callDeepSeek(recoveryPrompt,recoveryPrompt);
                firstResult=await readDeepSeekResponse(recoveryCall,null);
                fullPrompt=recoveryPrompt;
            }
            if(firstResult.replacementDetected || isReplacementStub(firstResult)) {
                resetRemoteSession(session);
                const blocked=new Error('DeepSeek replaced the response with a content-filter placeholder. Recovery did not produce an available answer.');
                blocked.status=502;blocked.type='content_filter';throw blocked;
            }
            let fullContent = sanitizeContent(firstResult.content || '');
            let reasoningContent = sanitizeContent(firstResult.reasoningContent || '');
            let { finishReason, modelError } = firstResult;
            const elapsed = Date.now() - startTime;
            console.log(`${agentTag} Got ${fullContent.length} chars (+${reasoningContent.length} reasoning chars) in ${elapsed}ms (msg#${session.messageCount})`);

            let retryAttempt = 0;
            while (!fullContent || fullContent.trim().length === 0) {
                if (clientGone) {
                    console.log(`${agentTag} client disconnected; abandoning empty-retry loop`);
                    resetRemoteSession(session);
                    return;
                }
                if (deadlineHit()) { console.log(`${agentTag} request deadline hit; stopping empty-retry loop`); break; }
                const contextTooLong = isContextTooLongError(modelError);
                if (!contextTooLong && isRateLimitError(modelError)) {
                    markAccountFailure(lastAccount, 429, 'rate limited in stream', null, RATE_LIMIT_COOLDOWN_MS);
                    if (!hasOtherReadyAccount(lastAccount?.id)) break;
                } else if (modelError && !contextTooLong) {
                    break;
                }
                if (retryAttempt >= MAX_EMPTY_RETRIES) break;
                retryAttempt++;

                const retryRatio = contextTooLong
                    ? Math.max(0.35, 0.8 - retryAttempt * 0.2)
                    : Math.max(0.5, 1 - retryAttempt * 0.2);
                const retryBudget = Math.max(MIN_UPSTREAM_PROMPT_CHARS, Math.floor(MAX_UPSTREAM_PROMPT_CHARS * retryRatio));
                const retryBuild = buildRetryPrompt(systemPrompt, recoveryHistoryPrefix, prompt, freshPromptBuild.prompt, retryBudget);
                const retryPrompt = retryBuild.prompt;
                if (retryBuild.compacted) {
                    promptCompacted = true;
                    markContextCompacted(res);
                }
                const reason = contextTooLong ? 'context-too-long response' : (modelError ? 'rate-limited response' : 'empty response');
                console.log(`${agentTag} ${reason} (msg#${session.messageCount}, retry ${retryAttempt}/${MAX_EMPTY_RETRIES}, prompt=${retryPrompt.length} chars). Resetting session...`);
                resetRemoteSession(session);
                await new Promise(r => setTimeout(r, Math.min(500 * retryAttempt, 1500)));
                const retryCall = await callDeepSeek(retryPrompt);
                const retryState = normalizeRetryResponse(await readDeepSeekResponse(retryCall, liveProgress()));
                fullPrompt = retryPrompt;
                modelError = retryState.modelError;
                finishReason = retryState.finishReason;
                if (retryState.content && retryState.content.trim().length > 0) {
                    console.log(`${agentTag} Retry ${retryAttempt} succeeded`);
                    fullContent = retryState.content;
                    reasoningContent = retryState.reasoningContent;
                }
            }

            if (!fullContent || fullContent.trim().length === 0) {
                const timedOut = deadlineHit();
                const failureClass = classifyRecoveryFailure(modelError, timedOut);
                const failure = resetRemoteSession(session);
                const errorType = failureClass.type;
                const errorMessage = modelError?.content
                    || (timedOut
                        ? 'DeepSeek request deadline reached while recovering an empty response'
                        : `DeepSeek returned empty content after ${retryAttempt} retr${retryAttempt === 1 ? 'y' : 'ies'}`);
                console.log(`${agentTag} ${errorType} after ${retryAttempt} retr${retryAttempt === 1 ? 'y' : 'ies'}. Giving up.`);
                const headers = {};
                if (failureClass.status === 429) headers['Retry-After'] = String(Math.ceil(RATE_LIMIT_COOLDOWN_MS / 1000));
                respondError(failureClass.status, {
                        message: errorMessage,
                        type: errorType,
                        agent: agentId,
                        failed_session_id: failure.failedSessionId,
                        message_count: failure.failedMessageCount,
                        history_length: agentSession.history.length,
                        account: failure.accountId,
                        retry_attempts: retryAttempt,
                        upstream_prompt_chars: fullPrompt.length,
                        prompt_compacted: promptCompacted,
                        model: requestedModel,
                        real_model: resolveModelConfig(requestedModel).real_model,
                }, headers);
                return;
            }

            let continuationRounds = 0;
            const MAX_CONTINUATION = 2;
            while (finishReason === 'length' && simulatedGenerationSettings(params).maxTokens===null && continuationRounds < MAX_CONTINUATION) {
                if (clientGone || deadlineHit()) break;
                continuationRounds++;
                console.log(`${agentTag} Response ${fullContent.length} chars (finish=${finishReason}). Auto-continuing (${continuationRounds}/${MAX_CONTINUATION})...`);
                await new Promise(r => setTimeout(r, 500));
                const contBeforeId = session.accountId;
                const continuationRecoveryPrompt = appendPromptInstruction(
                    `${freshPromptBuild.prompt}\n\n[Assistant response so far]\n${fullContent}`,
                    'Continue the assistant response from exactly where it stopped. Do not restart or repeat completed sections.'
                );
                let continuationCall;
                try {
                    continuationCall = await callDeepSeek('continue', continuationRecoveryPrompt, attachments && { ...attachments, delta: [] });
                } catch (error) {
                    if (requestAbort.signal.aborted) throw error;
                    console.log(`${agentTag} Continuation failed (${error.message}); returning the partial answer`);
                    resetRemoteSession(session);
                    break;
                }
                const { account: contAccount } = continuationCall;
                if (!isContinuationRecoverySafe(contBeforeId, continuationCall)) {
                    console.log(`${agentTag} continuation rotated to ${contAccount.id} ≠ ${contBeforeId} — skipping (foreign session)`);
                    continuationCall.resp.abortController?.abort(new Error('foreign session'));
                    resetRemoteSession(session);
                    break;
                }
                let contResult;
                try {
                    contResult = await readDeepSeekResponse(continuationCall);
                    if (isRateLimitError(contResult.modelError)) {
                        const retryAfter = String(Math.ceil(RATE_LIMIT_COOLDOWN_MS / 1000));
                        markAccountFailure(continuationCall.account, 429, 'rate limited in continuation', retryAfter, RATE_LIMIT_COOLDOWN_MS);
                        throw createUpstreamHttpError(429, contResult.modelError.content, retryAfter);
                    }
                } catch (error) {
                    if (requestAbort.signal.aborted || (Number(error?.status) === 429 && error?.type === 'rate_limit_error')) throw error;
                    console.log(`${agentTag} Continuation stream failed (${error.message}); returning the partial answer`);
                    resetRemoteSession(session);
                    break;
                }
                const contContent = contResult && contResult.content ? sanitizeContent(contResult.content) : '';
                const contReasoning = contResult && contResult.reasoningContent ? sanitizeContent(contResult.reasoningContent) : '';
                if (contContent && contContent.trim().length > 0 && !contContent.includes('I am an AI')) {
                    fullContent += contContent;
                    if (contReasoning) reasoningContent += (reasoningContent ? '\n' : '') + contReasoning;
                    finishReason = contResult.finishReason;
                    console.log(`${agentTag} Continuation added ${contContent.length} chars (total: ${fullContent.length})`);
                } else {
                    console.log(`${agentTag} Continuation returned nothing useful, stopping`);
                    break;
                }
            }

            let toolCall = allowedToolNames.size > 0 ? parseToolCall(fullContent) : null;
            if (toolCall && !allowedToolNames.has(toolCall.name)) {
                console.log(`${agentTag} Model requested unknown tool ${toolCall.name}; attempting format repair.`);
                toolCall = null;
            }

            if (allowedToolNames.size > 0 && !toolCall && looksLikeToolCallMarkup(fullContent) && !clientGone && !deadlineHit()) {
                console.log(`${agentTag} Tool-call markup detected but invalid/truncated (${fullContent.length} chars). Retrying with stricter prompt...`);
                resetRemoteSession(session);
                await new Promise(r => setTimeout(r, 1000));
                const strictPrompt = appendPromptInstruction(
                    freshPromptBuild.prompt,
                    `[STRICT INSTRUCTION] Your previous response contained incomplete or invalid tool-call markup. Keep arguments short and output ONLY strict JSON: ${TOOL_CALL_FORMAT} (escape backslashes and newlines inside strings). Available tools: ${[...allowedToolNames].join(', ').substring(0, 1500)}`
                );
                const retryCall2 = await callDeepSeek(strictPrompt);
                const retryResult2 = await readDeepSeekResponse(retryCall2);
                const retryContent2 = retryResult2 && retryResult2.content ? sanitizeContent(retryResult2.content) : '';
                if (retryContent2 && retryContent2.trim()) {
                    const retryTc = parseToolCall(retryContent2);
                    if (retryTc && allowedToolNames.has(retryTc.name)) {
                        console.log(`${agentTag} Retry with strict prompt succeeded: ${retryTc.name}`);
                        fullContent = retryContent2;
                        reasoningContent = retryResult2.reasoningContent ? sanitizeContent(retryResult2.reasoningContent) : '';
                        toolCall = retryTc;
                    } else if (!looksLikeToolCallMarkup(retryContent2)) {
                        console.log(`${agentTag} Strict retry returned a plain answer instead of tool markup.`);
                        fullContent = retryContent2;
                        reasoningContent = retryResult2.reasoningContent ? sanitizeContent(retryResult2.reasoningContent) : '';
                        finishReason = retryResult2.finishReason;
                    } else {
                        console.log(`${agentTag} Retry still has broken tool markup. Returning a safe error instead of leaking it as text.`);
                        reasoningContent = retryResult2.reasoningContent ? sanitizeContent(retryResult2.reasoningContent) : reasoningContent;
                    }
                }
            }

            if (allowedToolNames.size > 0 && !toolCall && looksLikeToolCallMarkup(fullContent)) {
                const failure = resetRemoteSession(session);
                respondError(502, {
                    message: 'DeepSeek returned malformed tool-call markup after one repair attempt',
                    type: 'malformed_tool_call',
                    agent: agentId,
                    failed_session_id: failure.failedSessionId,
                    message_count: failure.failedMessageCount,
                    history_length: agentSession.history.length,
                    account: failure.accountId,
                    prompt_compacted: promptCompacted,
                    model: requestedModel,
                    real_model: resolveModelConfig(requestedModel).real_model,
                });
                return;
            }

            if (!toolCall && !fullContent.includes('MEDIA:')) {
                const screenshotPaths = extractScreenshotPaths(messages);
                if (screenshotPaths.length > 0) {
                    fullContent += '\n\n' + screenshotPaths.join('\n');
                    console.log(`${agentTag} Injected MEDIA paths into response: ${screenshotPaths.join(', ')}`);
                }
            }

            if (clientGone) {
                resetRemoteSession(session);
                console.log(`${agentTag} client disconnected before the answer was sent; discarding it`);
                return;
            }
            if(isReplacementStub({content:fullContent,finishReason,modelError})){
                resetRemoteSession(session);const blocked=new Error('DeepSeek content-filter placeholder detected.');blocked.status=502;blocked.type='content_filter';throw blocked;
            }
            if (!ephemeral) {
                const recoveryPrompt=prompt.length>500?'...'+prompt.substring(prompt.length-500):prompt;
                if(params.regenerate===true && agentSession.history.at(-1)?.user===recoveryPrompt)agentSession.history.pop();
                storeHistory(agentSession, prompt, fullContent, toolCall);
            }
            if (session.id) {
                session.sentMessageKeys = plan.keys;
                session.contextKey = contextKey;
            }

            countMessage();
            const openaiResponse = toolCall
                ? buildToolCallResponse(toolCall, requestedModel, clientPromptText, reasoningContent)
                : buildTextResponse(fullContent, clientPromptText, requestedModel, reasoningContent, finishReason);
            session.answerKey=conversationMessageKey(openaiResponse.choices[0].message);

            if (live) live.finish(openaiResponse);
            else sendCompletion(res, apiMode, false, openaiResponse);
            console.log(`${agentTag} ${stream ? 'Streamed' : 'Response'} ${apiMode} (tool=${!!toolCall}, ${Date.now() - startTime}ms, ${fullContent.length} chars)`);
        } catch (e) {
            console.log('[DS-API] Error:', e.message);
            const failure = remoteTouched && activeSession && activeSession.id ? resetRemoteSession(activeSession) : null;
            if (clientGone) return;
            const timedOut = isTimeoutError(e);
            const status = e.status || (timedOut ? 504 : 500);
            const headers = {};
            if (status === 429 && e.retryAfter) headers['Retry-After'] = String(e.retryAfter);
            respondError(status, {
                message: e.message,
                type: e.type || (timedOut ? 'request_timeout' : 'server_error'),
                ...(failure ? {
                    agent: activeAgentId,
                    failed_session_id: failure.failedSessionId,
                    message_count: failure.failedMessageCount,
                    history_length: activeSession.history.length,
                    account: failure.accountId,
                } : {}),
            }, headers);
        } finally {
            if (keepAliveTimer) clearInterval(keepAliveTimer);
            if (lockedSession) lockedSession.busy = false;
            inFlight--;
        }
    });
});

async function runAuthScript() {
    const script = path.join(__dirname, 'scripts', 'deepseek_chrome_auth.js');
    const result = spawnSync(process.execPath, [script], { stdio: 'inherit', env: process.env });
    loadDeepSeekConfig({ fatal: false });
    return result.status === 0 && hasAuthConfig();
}

function printStatus() {
    console.log(`Auth: ${hasAuthConfig() ? '✅ OK' : '❌ не найден deepseek-auth.json'}`);
    console.log(`Auth source: ${process.env.DEEPSEEK_AUTH_DIR || DS_CONFIG_PATH}`);
    console.log(`Аккаунты: ${accounts.length ? accounts.map(a => `${a.id}${a.cooldownUntil > Date.now() ? ' (cooldown)' : ''}`).join(', ') : 'нет'}`);
    console.log(`Рабочие модели: ${SUPPORTED_MODEL_IDS.join(', ')}`);
    console.log('Нерабочие/скрытые aliases: ' + Object.keys(MODEL_CONFIGS).filter(id => !MODEL_CONFIGS[id].supported).join(', '));
    console.log('Capabilities: GET /v1/model-capabilities');
}

async function showStartupMenu() {
    if (isTruthy(process.env.SKIP_ACCOUNT_MENU) || isTruthy(process.env.NON_INTERACTIVE)) {
        if (!hasAuthConfig()) loadDeepSeekConfig({ fatal: true });
        return true;
    }
    while (true) {
        printStatus();
        console.log('\n=== Меню ===');
        console.log('1 - Авторизоваться / обновить DeepSeek login');
        console.log('2 - Импортировать auth-файл / cookies');
        console.log('3 - Показать модели и статусы');
        console.log('4 - Запустить прокси (по умолчанию)');
        console.log('5 - Выход');
        let choice = await prompt('Ваш выбор (Enter = 4): ');
        if (!choice) choice = '4';
        if (choice === '1') {
            await runAuthScript();
        } else if (choice === '2') {
            spawnSync(process.execPath, [path.join(__dirname, 'scripts', 'auth_import.js')], { stdio: 'inherit', env: process.env });
            loadDeepSeekConfig({ fatal: false });
        } else if (choice === '3') {
            console.log(JSON.stringify(ALL_MODEL_CAPABILITIES, null, 2));
            await prompt('\nНажмите Enter, чтобы вернуться в меню...');
        } else if (choice === '4') {
            if (!hasAuthConfig()) {
                console.log('Нужен deepseek-auth.json. Запустите пункт 1 или 2.');
                continue;
            }
            return true;
        } else if (choice === '5') {
            return false;
        }
    }
}

async function main() {
    printBanner();
    requireProxyApiKey(PROXY_API_KEY, isTruthy(process.env.REQUIRE_PROXY_API_KEY));
    if (!isLoopbackHost(HOST) && !PROXY_API_KEY) {
        console.warn(`[DS-API] WARNING: HOST=${HOST} exposes the proxy without authentication. Set PROXY_API_KEY or bind to 127.0.0.1.`);
    }
    const shouldStart = await showStartupMenu();
    if (!shouldStart) process.exit(0);
    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') console.error(`[DS-API] FATAL: port ${PORT} already in use. Set PORT=<other> or stop the other instance.`);
        else console.error('[DS-API] server error:', err);
        process.exit(1);
    });
    setInterval(sweepIdleSessions, 10 * 60 * 1000).unref();
    server.listen(PORT, HOST, () => {
        console.log(`[DS-API] Server on http://${HOST}:${PORT} (multi-agent sessions enabled)`);
        console.log('[DS-API] POST /v1/chat/completions (OpenAI Chat Completions, stream=true|false)');
        console.log('[DS-API] POST /v1/messages — Anthropic Messages shim for Claude Code');
        console.log('[DS-API] POST /v1/responses — OpenAI Responses API shim');
        console.log('[DS-API] GET  /v1/models — supported OpenAI-compatible models');
        console.log('[DS-API] GET  /v1/model-capabilities — real model mapping and capabilities');
        console.log('[DS-API] GET  /v1/sessions — list active agent sessions');
        console.log('[DS-API] POST /reset-session?agent=<id> — reset agent session');
        console.log('[DS-API] POST /reset-session?agent=all — reset ALL sessions');
    });
}

if (require.main === module) {
    process.on('unhandledRejection', (reason) => console.error('[DS-API] unhandledRejection:', reason));
    process.on('uncaughtException', (err) => console.error('[DS-API] uncaughtException:', err));
    const shutdown = (sig) => {
        console.log(`[DS-API] ${sig} received — shutting down…`);
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 10000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    main().catch(err => { console.error('[DS-API] FATAL:', err); process.exit(1); });
}

module.exports = {
    __test: {
        isAssistantOutputFragment,
        isReasoningFragment,
        isDeepSeekModelErrorEvent,
        createUpstreamHttpError,
        rebuildFragmentText,
        applyResponsePatchOperations,
        compactToolSchema,
        formatToolDefinitions,
        parseToolCall,
        parseDsmlToolCall,
        looksLikeToolCallMarkup,
        truncatePromptMiddle,
        hasExplicitConversationHistory,
        buildRecoveryHistoryPrefix,
        buildBoundedPrompt,
        buildRetryPrompt,
        isContinuationRecoverySafe,
        isContextTooLongError,
        normalizeRetryResponse,
        classifyRecoveryFailure,
        isTimeoutError,
        formatMessages,
        simulatedGenerationSettings,
        isReplacementStub,
        formatConversation,
        formatToolReminder,
        conversationMessageKey,
        planSessionTurn,
        buildDeltaPrompt,
        hashText,
        repairJsonText,
        parseJsonLenient,
        sanitizeContent,
        normalizeMessageContent,
        normalizeApiParams,
        extractScreenshotPaths,
        collectImages,
        uploadedFileCache,
        isRateLimitError,
        imageUploadEnabled,
        loadDotEnv,
        MODEL_CONFIGS,
        SUPPORTED_MODEL_IDS,
        resolveModelConfig,
        server,
        createSession,
        resetRemoteSession,
        prepareSessionForPrompt,
        sweepIdleSessions,
        sessions,
        accounts,
        selectAccountForSession,
        isProxyAuthorized,
        loadProxyApiKey,
        requireProxyApiKey,
        isLoopbackHost,
        normalizeOrigin,
        isBrowserOriginAllowed,
        setCorsResponseHeaders,
        markContextCompacted,
        CONTEXT_COMPACTED_HEADER,
        sendAnthropicStream,
        sendResponsesStream,
        sendOpenAIStream,
    },
};
