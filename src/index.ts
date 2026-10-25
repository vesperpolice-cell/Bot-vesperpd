import { Client, GatewayIntentBits, Partials, Events, SlashCommandBuilder, ContextMenuCommandBuilder, ApplicationCommandType, PermissionFlagsBits, type RESTPostAPIApplicationCommandsJSONBody } from 'discord.js';
import http from 'http';
import https from 'https';
import crypto from 'crypto';
import path from 'path';
import { env, BOT, CACHE, validate } from './config';
import { configService } from './core/config.service';
import { rateLimiter } from './core/ratelimiter';
import { logger, recent, bufferStats, type LogLevel } from './core/logger';
import { startLogStore, flushLogSheet, pendingLogRows } from './core/logstore.service';
import { clearAllReplyTimeouts, silentCatch } from './services/utils';
import { flushPendingCounts, pendingCountOps } from './features/count/count.service';
import { allShardsReady, closeCodeName, isFatalLoginError, isUnrecoverableClose, shardStatusName } from './core/gateway-status';
import { MAX_LOGIN_ATTEMPTS, clearLoginAttempts, fileFor, formatWait, isLockedOut, readLoginAttempts, recordLoginFailure, retryDelay } from './core/login-attempts';

const errors = validate();
if (errors.length > 0) {
    // eslint-disable-next-line no-console
    console.error('❌ การตรวจสอบ Config ล้มเหลว:\n  ' + errors.join('\n  '));
    process.exit(1);
}

// ---- Discord client ----
// สร้างไว้ตรงนี้ (ก่อน watchdog และ HTTP server) เพราะทั้งสองส่วนต้องอ้างถึง
// เดิมสร้างหลัง server.listen() — request ที่เข้ามาในช่วงนั้นจะเจอตัวแปรที่ยังไม่ถูกประกาศ (TDZ)
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

let shuttingDown = false;

/**
 * หยุดพยายามเชื่อมต่อ Discord แล้วหรือยัง
 *
 * Discord ตอบ 429 ได้ง่ายมากเมื่อถูกยิงถี่ ๆ จาก IP เดียวกัน และ discord.js ไม่ throw อะไรออกมาให้เห็น
 * (มันรอแล้ว retry 429 ไปเรื่อย ๆ ไม่มีเพดาน) การปล่อยให้โฮสต์รีสตาร์ทวนไปเรื่อย ๆ จึงมีแต่ทำให้
 * หน้าต่างลิมิตยาวขึ้น ครบ MAX_LOGIN_ATTEMPTS ครั้งแล้วจะหยุดยิง Discord เลย
 * แต่ยังเปิด HTTP ไว้ให้ /health บอกสถานะและเหตุผล
 */
const LOGIN_STATE_FILE = fileFor(path.join(__dirname, '../logs'));
let lockedOut = false;
let lockOutReason = '';
let loginAttempts = 0;

/**
 * Discord ต่ออยู่จริงไหม
 *
 * ดูจากสถานะ shard แทน client.isReady() เพราะ discord.js ตั้ง ws.status = Ready
 * ครั้งเดียวตอนต่อติดแล้วไม่เคยตั้งกลับ (อธิบายไว้ใน core/gateway-status)
 */
function discordOnline(): boolean {
    return !shuttingDown && allShardsReady([...client.ws.shards.values()]);
}

/** ยังอยู่ในเซิร์ฟเวอร์หลักไหม — ถูกเตะ/แบนแล้วต่อติดก็ทำงานไม่ได้ */
function inHomeGuild(): boolean {
    return client.guilds.cache.has(env.guildId);
}

/**
 * login ที่มีเพดานเวลา
 *
 * client.login() ค้างเงียบ ๆ ได้ — แพ็กเก็ตออกไป discord.com แล้วไม่มีคำตอบกลับ
 * ไม่มี error ไม่มี log ไม่มี shard สักตัว บอทดู "รันอยู่" ทั้งอย่างนั้นเป็นชั่วโมง
 * ใส่เพดานเวลาไว้ให้ start() ล้มเหลวแล้วสั่งรีสตาร์ท แทนที่จะค้างข้ามคืนโดยไม่มีใครรู้
 */
const LOGIN_TIMEOUT_MS = 60_000;
async function loginWithTimeout(token: string, ms: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
        await Promise.race([
            client.login(token),
            new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`login ค้างเกิน ${Math.round(ms / 1000)} วิ (Discord ไม่ตอบ handshake)`)),
                    ms,
                );
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/** header ที่มีประโยชน์ต่อการวินิจฉัย 429 — เก็บแค่นี้เพื่อไม่ให้ log ยาว */
const PROBE_HEADERS = [
    'retry-after',
    'x-ratelimit-global',
    'x-ratelimit-limit',
    'x-ratelimit-remaining',
    'x-ratelimit-reset-after',
    'x-ratelimit-scope',
    'x-ratelimit-bucket',
    'server',
    'cf-ray',
    'via',
    'content-type',
] as const;

/**
 * UA เดียวกับที่ discord.js ยิง Discord: `DiscordBot (…) <appendix>`
 *
 * ต้องใส่ให้เหมือน ไม่งั้น Cloudflare จะเห็นเป็นบอทแปลกปลอม และผลตรวจจะไม่ตรงกับที่ login เจอจริง
 * (2.6.3 = ค่า DefaultUserAgent ของ @discordjs/rest ซึ่งเป็นค่าคงที่ในไลบรารี)
 */
const PROBE_USER_AGENT = `DiscordBot (https://discord.js.org, 2.6.3) ${client.rest.options.userAgentAppendix}`;

interface GatewayProbe {
    ok: boolean;
    status: number;
    ms: number;
    retryAfter: string | null;
    headers: Record<string, string>;
    body: string;
    error: string | null;
}

/**
 * ถาม Discord ว่า "พร้อมให้ต่อไหม" ด้วย endpoint เดียวกับที่ client.login() ใช้ (/gateway/bot)
 *
 * ตั้งใจให้เป็นด่านหน้า login: ถ้าโดน 429 ตั้งแต่ตรงนี้ การปล่อยให้ client.login() วิ่งต่อ
 * มีแต่ทำให้ Discord ถูกลิมิตหนักขึ้น (discord.js retry 429 ไปเรื่อย ๆ ไม่มีเพดาน)
 * พร้อมเก็บ header/body ไว้ให้ฟันธงสาเหตุได้ทันที
 */
function probeGateway(token: string, ms = 10_000): Promise<GatewayProbe> {
    const started = Date.now();
    return new Promise<GatewayProbe>((resolve) => {
        const fail = (message: string): void => {
            resolve({ ok: false, status: 0, ms: Date.now() - started, retryAfter: null, headers: {}, body: '', error: message });
        };
        const req = https.request(
            {
                hostname: 'discord.com',
                path: '/api/v10/gateway/bot',
                method: 'GET',
                timeout: ms,
                headers: {
                    Authorization: `Bot ${token}`,
                    'User-Agent': PROBE_USER_AGENT,
                    Accept: 'application/json',
                },
            },
            (res) => {
                let body = '';
                res.setEncoding('utf8');
                // body ของ 429 สั้นมาก แต่กันไว้ไม่ให้อ่านไม่จบถ้าเซิร์ฟเวอร์ส่งมายาว
                res.on('data', (chunk: string) => { if (body.length < 600) body += chunk; });
                res.on('error', (err: Error) => fail(err.message));
                res.on('end', () => {
                    const picked: Record<string, string> = {};
                    for (const name of PROBE_HEADERS) {
                        const value = res.headers[name];
                        if (typeof value === 'string') picked[name] = value;
                    }
                    resolve({
                        ok: (res.statusCode ?? 0) === 200,
                        status: res.statusCode ?? 0,
                        ms: Date.now() - started,
                        retryAfter: picked['retry-after'] ?? null,
                        headers: picked,
                        body: body.replace(/\s+/g, ' ').trim().slice(0, 300),
                        error: null,
                    });
                });
            },
        );
        req.on('timeout', () => req.destroy(new Error(`Discord ไม่ตอบภายใน ${ms} ms`)));
        req.on('error', (err: Error) => fail(err.message));
        req.end();
    });
}

/** log ผลตรวจแบบละเอียด — ตอนปกติเหลือบรรทัดเดียว ตอนผิดปกติใส่ header/body ครบ */
function logProbeResult(p: GatewayProbe): void {
    if (p.ok) {
        logger.info('STARTUP', `Discord API ตอบปกติ (HTTP 200 · ${p.ms} ms)`);
        return;
    }
    if (p.status === 0) {
        logger.error('STARTUP', `ติดต่อ discord.com ไม่ได้: ${p.error ?? 'ไม่ทราบสาเหตุ'} (${p.ms} ms)`);
        return;
    }
    logger.error('STARTUP', `Discord ปฏิเสธคำขอ: HTTP ${p.status} · ${p.ms} ms${p.retryAfter ? ` · Retry-After ${p.retryAfter} วิ` : ''}`);
    logger.error('STARTUP', `headers: ${JSON.stringify(p.headers)}`);
    if (p.body) logger.error('STARTUP', `body: ${p.body}`);
    if (p.status === 429) {
        const edge = /cloudflare|error 10\d\d|attention required|just a moment/i.test(p.body);
        // Discord ตอบแบบนี้ = บล็อกที่ระดับ IP ขาออก (shared IP ของโฮสต์คลาวด์โดนรวมหัว)
        const globalBlock = /global rate limits|blocked from accessing our api/i.test(p.body);
        logger.error('STARTUP', edge
            ? 'ตีความ: 429 มาจาก Cloudflare/edge — IP ขาออกของโฮสต์ถูกจำกัด ไม่ใช่ปัญหาที่ token'
            : globalBlock
                ? 'ตีความ: Discord บล็อก IP ขาออกของโฮสต์ (global rate limit) — ไม่ใช่ token/เน็ตหลุด เส้นทางถาวรคือเปลี่ยน IP (ย้าย region/VPS)'
                : 'ตีความ: 429 จาก Discord API — ลิมิตที่ระดับ IP (IP ร่วมกับคนอื่น) หรือ token ไม่ใช่เน็ตหลุด');
    }
}

/**
 * กำลังรอตามที่ Discord สั่ง (Retry-After) — ค่า > 0 = กำลังรอ (watchdog ต้องไม่รีสตาร์ท)
 */
let retryAtMs = 0;

/**
 * ประกาศหยุดเชื่อมต่อ — ไม่ exit เพราะ exit = โฮสต์สตาร์ทใหม่ = ยิง Discord อีกคำขอทันที
 * (ตัวนับบนดิสก์ไม่รอดจากการสร้าง instance ใหม่ของโฮสต์ จึงใช้ตัวนับในโปรเซสเป็นหลัก)
 */
function giveUp(reason: string): void {
    lockedOut = true;
    lockOutReason = reason;
    logger.error('STARTUP', `หยุดพยายามเชื่อมต่อ Discord: ${reason}`);
    logger.error('STARTUP', 'จะไม่ส่งคำขอไป Discord อีกเลยจนกว่าจะรีสตาร์ท/deploy ใหม่ — กันไม่ให้ถูกลิมิตยาวขึ้น');
}

/** รอตามเวลาที่กำหนดโดยไม่ยิงคำขอใด ๆ ออกไป แล้วคืนกลับมาลองครั้งสุดท้าย */
function waitBeforeRetry(ms: number, why: string): Promise<void> {
    retryAtMs = Date.now() + ms;
    logger.warn('STARTUP', `รอ ${formatWait(ms)} ${why} — ระหว่างนี้จะไม่ส่งคำขอไป Discord เลย`);
    return new Promise<void>((resolve) => {
        setTimeout(() => { retryAtMs = 0; resolve(); }, ms);
    });
}

/**
 * เชื่อมต่อ Discord แบบมีเพดาน: ถามก่อนว่าโดนลิมิตไหม → รอตามที่เขาสั่ง → ลองครั้งสุดท้าย → หยุด
 *
 * ห้ามใช้วิธี "exit แล้วให้โฮสต์สตาร์ทใหม่" เป็นตัวนับ เพราะไฟล์ตัวนับไม่รอดจากการสร้าง instance ใหม่
 * (Render ขึ้น instance ใหม่ = ดิสก์ใหม่ = อ่านได้ 0) ผลคือ restart loop ที่ยิง Discord ไม่จบ
 * การนับและรอในโปรเซสเดิมจึงเชื่อถือได้กว่า และไม่เกิด restart loop เลย
 */
async function connectDiscord(): Promise<void> {
    const prior = readLoginAttempts(LOGIN_STATE_FILE);
    // ต่อจากที่เคยนับไว้ ถ้าดิสก์เก็บไว้ได้ (VPS/เครื่องตัวเองเก็บได้ ส่วนโฮสต์ฟรีมักไม่ได้)
    let attempts = prior.attempts;
    loginAttempts = attempts;
    if (isLockedOut(prior)) {
        giveUp(`เคยล้มเหลว ${prior.attempts} ครั้ง (ล่าสุด ${prior.lastAt ?? '-'} · ${prior.lastError ?? '-'})`);
        return;
    }

    while (attempts < MAX_LOGIN_ATTEMPTS) {
        attempts += 1;
        loginAttempts = attempts;

        // ด่านที่ 1: ถามด้วย endpoint เดียวกับ login — โดน 429 ตั้งแต่ตรงนี้ก็ไม่ต้องเสียคำขอให้ login อีก
        const probe = await probeGateway(env.botToken);
        logProbeResult(probe);

        if (probe.ok) {
            logger.info('CLIENT', 'กำลังเชื่อมต่อ Discord...');
            try {
                await loginWithTimeout(env.botToken, LOGIN_TIMEOUT_MS);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                recordLoginFailure(LOGIN_STATE_FILE, probe.status, message);
                // client ที่ login ค้างไว้ใช้ซ้ำไม่ได้ — หยุดแทนการ exit (exit = ยิง Discord ใหม่)
                giveUp(`เชื่อมต่อไม่สำเร็จครั้งที่ ${attempts}/${MAX_LOGIN_ATTEMPTS}: ${message}`);
                return;
            }
            loginAttempts = 0;
            clearLoginAttempts(LOGIN_STATE_FILE);
            return;
        }

        const error = probe.error ?? `HTTP ${probe.status}`;
        const { state } = recordLoginFailure(LOGIN_STATE_FILE, probe.status === 0 ? null : probe.status, error);

        // token/intents ผิด = ลองอีกกี่ครั้งก็ได้ผลเดิม ไม่ต้องเสียคำขอไปฟรี
        if (isFatalLoginError(error) || probe.status === 401 || probe.status === 403) {
            giveUp(`${error} (ต้องแก้ token/intents ก่อนแล้วค่อยรีสตาร์ท)`);
            return;
        }
        if (attempts >= MAX_LOGIN_ATTEMPTS || isLockedOut(state)) {
            giveUp(`เชื่อมต่อไม่สำเร็จ ${attempts} ครั้งติดกัน · ล่าสุด: ${error}`);
            return;
        }

        const wait = retryDelay(probe.status === 0 ? null : probe.status, probe.retryAfter);
        if (wait.capped) {
            logger.warn('STARTUP', `Discord สั่งรอนานกว่าเพดาน — จะรอแค่ ${formatWait(wait.ms)} แล้วลองครั้งสุดท้าย`);
        }
        await waitBeforeRetry(wait.ms, probe.status === 429 ? 'ตามที่ Discord สั่ง (Retry-After)' : 'แล้วลองใหม่');
    }
}

let restartCount = 0;
let firstCrash = Date.now();
let capWarnedAt = 0;
function safeRestart(reason: string): void {
    const now = Date.now();
    if (now - firstCrash > BOT.RESTART_RESET_INTERVAL_MS) { restartCount = 0; firstCrash = now; }
    restartCount++;
    if (restartCount > BOT.MAX_RESTART_PER_DAY) {
        // ไม่สแปม log ทุกครั้งที่ watchdog ตรวจ — เตือนชั่วโมงละครั้งพอ
        if (now - capWarnedAt > 60 * 60 * 1000) {
            capWarnedAt = now;
            logger.error('SYSTEM', `ถึงขีดจำกัดการรีสตาร์ทแล้ว (${BOT.MAX_RESTART_PER_DAY} ครั้ง/วัน) — หยุดรีสตาร์ทอัตโนมัติจนถึงรอบถัดไป`);
        }
        return;
    }
    logger.warn('SYSTEM', `กำลังรีสตาร์ท (${restartCount}/${BOT.MAX_RESTART_PER_DAY}) | ${reason}`);
    // ปิด log ให้เขียนลงไฟล์จนจบก่อนออก ไม่งั้นบรรทัดสุดท้ายก่อนตายหายเงียบ ๆ
    setTimeout(() => { logger.close(); process.exit(1); }, BOT.RESTART_DELAY_MS);
}

// ---- Watchdog ----
// เฝ้าดู "การเชื่อมต่อ Discord" ไม่ใช่เว็บเซิร์ฟเวอร์ของตัวเอง
// ของเดิมนับ heartbeat จาก HTTP request ที่เข้ามา ซึ่ง self-ping เติมให้เองทุก 7 นาที
// ทำให้ lastAlive สดตลอดเวลา และ watchdog ไม่มีวันทำงาน แม้ Discord จะหลุดไปนานแค่ไหน
// และเช็กจากสถานะ shard (discordOnline) ไม่ใช่ client.isReady() ที่ค้าง true ตลอด
let lastDiscordOk = Date.now();

setInterval(() => {
    // ตั้งใจหยุดเชื่อมต่อ/กำลังรอตามที่ Discord สั่ง — ห้ามรีสตาร์ท เพราะการรีสตาร์ทคือการยิง Discord ใหม่
    if (lockedOut || retryAtMs > 0) return;
    if (discordOnline()) { lastDiscordOk = Date.now(); return; }
    if (Date.now() - lastDiscordOk > BOT.WATCHDOG_TIMEOUT_MIN * 60 * 1000) {
        logger.error('SYSTEM', `Watchdog: Discord หลุดเกิน ${BOT.WATCHDOG_TIMEOUT_MIN} นาที กำลังรีสตาร์ท`);
        lastDiscordOk = Date.now(); // กันสั่งรีสตาร์ทซ้ำระหว่างรอ RESTART_DELAY_MS
        safeRestart('Discord disconnected');
    }
}, BOT.WATCHDOG_CHECK_INTERVAL_MS);

/**
 * เทียบรหัสผ่านแบบไม่หลุดเวลา
 *
 * เทียบด้วย === จะคืนผลเร็วกว่าเมื่อตัวอักษรแรกไม่ตรง ซึ่งพอวัดเวลาหลาย ๆ ครั้ง
 * จะเดารหัสทีละตัวได้ — ช่องนี้เปิดรับจากอินเทอร์เน็ต จึงไม่ควรเปิดช่องนั้นไว้
 */
function tokenMatches(given: string): boolean {
    const want = env.logApiToken;
    if (!want || !given) return false;
    const a = Buffer.from(given);
    const b = Buffer.from(want);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

const LEVELS: LogLevel[] = ['INFO', 'WARN', 'ERROR', 'DEBUG'];

/** อ่านตัวกรองจาก query string ของ /logs */
function parseLogQuery(url: URL): Parameters<typeof recent>[0] {
    const levelsRaw = (url.searchParams.get('level') || '').toUpperCase();
    const levels = LEVELS.filter(l => levelsRaw.split(',').map(s => s.trim()).includes(l));
    const limit = Number(url.searchParams.get('limit'));
    const since = Number(url.searchParams.get('since'));
    return {
        levels: levels.length > 0 ? levels : undefined,
        context: url.searchParams.get('context') || undefined,
        search: url.searchParams.get('q') || undefined,
        since: Number.isFinite(since) && since > 0 ? since : undefined,
        limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
    };
}

/**
 * ส่ง log ที่เก็บไว้ในหน่วยความจำให้หน้าเว็บ
 *
 * อ่านจากหน่วยความจำ ไม่ใช่จากไฟล์ เพราะบนโฮสต์ปิดการเขียนไฟล์ไว้ (LOG_TO_FILE=false)
 * ข้อความถูกกรองความลับออกตั้งแต่ตอนเก็บแล้ว (ดู redact ใน core/logger)
 */
function handleLogs(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url || '/', 'http://localhost');
    const given = (req.headers['x-log-token'] as string | undefined) || url.searchParams.get('token') || '';

    if (!env.logApiToken) {
        res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'ยังไม่ได้ตั้ง LOG_API_TOKEN — ช่องนี้ถูกปิดไว้' }));
        return;
    }
    if (!tokenMatches(given)) {
        logger.warn('LOGAPI', 'มีการขอ log ด้วยรหัสผ่านที่ไม่ถูกต้อง');
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'รหัสผ่านไม่ถูกต้อง' }));
        return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
        ok: true,
        bot: { online: discordOnline(), inGuild: inHomeGuild(), lockedOut, uptime: process.uptime(), wsPing: client.ws.ping },
        buffer: bufferStats(),
        pendingSheetRows: pendingLogRows(),
        pendingCountOps: pendingCountOps(),
        entries: recent(parseLogQuery(url)),
    }));
}

// ---- HTTP server (health check + กันโฮสต์ฟรีหลับ) ----
const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/logs')) {
        handleLogs(req, res);
        return;
    }
    if (req.url === '/health') {
        const online = discordOnline();
        // ต่อติดไม่เท่ากับใช้งานได้ — ถูกเตะ/แบนแล้วบอทยังออนไลน์แต่คำสั่งทั้งหมดเงียบ
        const inGuild = inHomeGuild();
        const ok = online && inGuild;
        // ตอบ 503 เมื่อ Discord หลุด หรือหลุดออกจากเซิร์ฟเวอร์หลัก เพื่อให้ตัวมอนิเตอร์ภายนอก
        // (เช่น UptimeRobot) แจ้งเตือนได้ทันที แทนที่จะเห็น 200 แล้วเข้าใจว่าบอทยังปกติดี
        res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            status: ok ? 'ok'
                : lockedOut ? 'login_locked_out'
                : retryAtMs > 0 ? 'rate_limited'
                : !online ? 'discord_disconnected'
                : 'not_in_guild',
            discord: online,
            inGuild,
            // หยุดพยายามเชื่อมต่อเองแล้วหรือยัง — true = จะไม่ยิง Discord อีกจนกว่าจะรีสตาร์ท/deploy ใหม่
            lockedOut,
            loginAttempts,
            lockOutReason: lockedOut ? lockOutReason : null,
            // กำลังรอตาม Retry-After ของ Discord อยู่ — ระหว่างนี้ไม่มีการยิงคำขอเลย
            retryAtMs: retryAtMs > 0 ? retryAtMs : null,
            retryInSeconds: retryAtMs > 0 ? Math.max(0, Math.ceil((retryAtMs - Date.now()) / 1000)) : null,
            // ถูกนำออกจากเซิร์ฟเวอร์ทั้งหมดแล้วค่านี้จะเป็น 0
            guilds: client.guilds.cache.size,
            // ปกติมี shard เดียว ส่งแค่ id/สถานะ/ping ไม่ได้เก็บข้อมูลเพิ่ม
            shards: client.ws.shards.map(s => ({ id: s.id, status: shardStatusName(s.status), ping: s.ping })),
            wsPing: client.ws.ping,
            uptime: process.uptime(),
            timestamp: Date.now(),
        }));
        return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is alive! ✅');
});
server.listen(env.port, () => logger.info('SERVER', `HTTP เซิร์ฟเวอร์รันที่พอร์ต ${env.port}`));
// พอร์ตชนกับโปรเซสอื่น = server emit error ถ้าไม่มีใครดักไว้ โปรเซสจะตายแบบไม่มี log อะไรเลย
server.on('error', (err) => logger.error('SERVER', `HTTP เซิร์ฟเวอร์มีปัญหา: ${err.message}`));

// ---- Self-ping ----
// มีไว้กันโฮสต์ฟรีหลับอย่างเดียว ไม่ยุ่งกับ watchdog อีกต่อไป
setInterval(() => {
    // หยุดเชื่อมต่ออยู่ = ไม่มีอะไรให้เฝ้า ปล่อยให้โฮสต์หลับได้ ไม่ต้องเปลืองชั่วโมงฟรี
    if (lockedOut) return;
    const lib = env.renderUrl.startsWith('https://') ? https : http;
    const req = lib.get(env.renderUrl, (res) => { res.resume(); }); // resume() = ทิ้ง body ให้ socket ถูกคืน ไม่งั้นรั่วสะสม
    req.setTimeout(10000, () => req.destroy());
    req.on('error', () => { /* ปลุกไม่ติดก็ไม่เป็นไร รอบหน้าเอาใหม่ */ });
}, BOT.SELF_PING_INTERVAL_MS);

// Cleanup expired rate limiter entries
setInterval(() => rateLimiter.cleanup(), CACHE.RATE_LIMITER_CLEANUP_INTERVAL_MS);

async function gracefulShutdown(signal: string): Promise<void> {
    if (shuttingDown) return; // กันสัญญาณซ้ำ (SIGINT ตามด้วย SIGTERM) สั่งปิดซ้อนกัน
    shuttingDown = true;
    logger.info('SHUTDOWN', `ได้รับสัญญาณ ${signal} — กำลังปิดระบบอย่างปลอดภัย...`);
    try {
        clearAllReplyTimeouts();
    } catch (e) { logger.warn('SHUTDOWN', String(e)); }

    // ยอดที่เพิ่งนับได้จะถูกพักไว้ในหน่วยความจำราว 3 วินาทีก่อนเขียนลงชีต
    // ถ้าดับตอนนั้นพอดี ยอดช่วงนั้นหายไปเลย — เขียนให้จบก่อนปิด
    const pending = pendingCountOps();
    if (pending > 0) {
        logger.info('SHUTDOWN', `เขียนยอดที่ยังค้างอยู่ ${pending} รายการลงชีตก่อนปิด`);
        await Promise.race([
            flushPendingCounts().catch(silentCatch('SHUTDOWN')),
            new Promise<void>(resolve => setTimeout(resolve, BOT.SHUTDOWN_FLUSH_TIMEOUT_MS)),
        ]);
    }

    // log ที่ยังค้างในคิวก็ต้องลงชีตให้ทัน ไม่งั้นเหตุการณ์ช่วงท้ายหายไปพร้อม process
    const pendingLogs = pendingLogRows();
    if (pendingLogs > 0) {
        logger.info('SHUTDOWN', `เขียน log ที่ยังค้างอยู่ ${pendingLogs} แถวลงชีตก่อนปิด`);
        await Promise.race([
            flushLogSheet().catch(silentCatch('SHUTDOWN')),
            new Promise<void>(resolve => setTimeout(resolve, BOT.SHUTDOWN_FLUSH_TIMEOUT_MS)),
        ]);
    }

    client.destroy().catch(silentCatch('SHUTDOWN'));
    server.close();
    setTimeout(() => { logger.close(); process.exit(0); }, BOT.GRACEFUL_SHUTDOWN_TIMEOUT_MS);
}

process.on('SIGINT', () => { void gracefulShutdown('SIGINT'); });
process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });
process.on('unhandledRejection', (reason: unknown) => {
    logger.error('SYSTEM', `ข้อผิดพลาดที่ไม่ถูกจัดการ: ${reason instanceof Error ? reason.message : String(reason)}`);
});
process.on('uncaughtException', (err: Error) => {
    // เก็บ stack ไว้ด้วย — log แค่ message ทำให้ตามหาต้นตอไม่เจอ
    logger.error('SYSTEM', `Exception ที่ไม่ถูกจัดการ: ${err.stack || err.message}`);
});

client.on('error', (err) => logger.error('CLIENT', `Discord error: ${err.message}`));
client.on('warn', (info) => logger.warn('CLIENT', `Discord คำเตือน: ${info}`));
// เห็นชัดใน log ว่าหลุด/ต่อใหม่ตอนไหน เวลาต้องไล่ปัญหาย้อนหลัง
// discord.js 14 ยิง shardDisconnect เฉพาะ code ที่ "ต่อใหม่ไม่ได้" — หลุดชั่วคราวจะได้ shardReconnecting แทน
client.on(Events.ShardDisconnect, (ev, id) => {
    const name = closeCodeName(ev.code);
    // ตรวจซ้ำอีกชั้นเผื่ออนาคตไลบรารีเปลี่ยนพฤติกรรม: code ที่ต่อใหม่ได้ก็แค่บันทึก ไม่ต้องรีสตาร์ท
    if (!isUnrecoverableClose(ev.code)) {
        logger.warn('CLIENT', `Shard ${id} หลุดการเชื่อมต่อ (${ev.code} ${name})`);
        return;
    }
    // code กลุ่มนี้ Discord ไม่ยอมให้ต่อใหม่ — ต่ออีกกี่ครั้งก็ไม่ติด ต้องแก้ที่ต้นเหตุแล้วสตาร์ทใหม่
    logger.error('CLIENT', `Shard ${id} หลุดแบบต่อใหม่ไม่ได้ (${ev.code} ${name}) — ต้องแก้ token/intents ที่ Developer Portal`);
    safeRestart(`shard ${id} close ${ev.code} ${name}`);
});
client.on(Events.ShardReconnecting, (id) => logger.warn('CLIENT', `Shard ${id} กำลังเชื่อมต่อใหม่`));
// resume ไม่ได้จะ re-identify ใหม่และไม่มี shardResume ตามมา บรรทัดนี้จึงเป็นตัวบอกว่า "กลับมาแล้ว" จริง ๆ
client.on(Events.ShardReady, (id) => {
    lastDiscordOk = Date.now();
    logger.info('CLIENT', `Shard ${id} พร้อมทำงาน`);
});
client.on(Events.ShardResume, (id) => {
    lastDiscordOk = Date.now();
    logger.info('CLIENT', `Shard ${id} กลับมาเชื่อมต่อแล้ว`);
});
// ถูกเตะกับถูกแบนได้ event เดียวกัน แยกจากฝั่ง gateway ไม่ได้ — แต่ต้องรู้ทั้งคู่
// ถ้าไม่ดักไว้ บอทจะดู "ออนไลน์" ทั้งที่ไม่มีเซิร์ฟเวอร์ให้ทำงานแล้ว
client.on(Events.GuildDelete, (guild) => {
    const home = guild.id === env.guildId;
    logger.error('GUILD', `บอทถูกนำออกจากเซิร์ฟเวอร์ "${guild.name}" (${guild.id})`
        + (home ? ' — เป็นเซิร์ฟเวอร์หลัก บอทจะไม่ทำงานเลยจนกว่าจะเชิญกลับ' : ''));
});
client.once(Events.ClientReady, async () => {
    lastDiscordOk = Date.now();
    logger.info('CLIENT', `${client.user?.tag} ออนไลน์พร้อมทำงาน!`);

    // ไม่เห็นเซิร์ฟเวอร์หลักแปลว่าถูกเตะ/แบน หรือ GUILD_ID ใน .env ไม่ตรง
    if (!inHomeGuild()) {
        logger.error('CLIENT', `ไม่พบเซิร์ฟเวอร์หลัก ${env.guildId} — ถูกเตะ/แบน หรือ GUILD_ID ใน .env ไม่ตรง`);
    }

    // ✅ ลงทะเบียน Slash Commands ทั้งหมดด้วย Bulk Registration
    // ✅ Slash Commands
    const slashDefs = [
        { name: 'editpd', description: '📝 แก้ไขโปรไฟล์ตำรวจ (ชื่อ IC, เบอร์โทร, อายุ)' },
        { name: 'recount', description: '⚙️ แผงควบคุมตั้งค่าและนับยอดเคส' },
        { name: 'reload', description: '🔄 รีโหลด config จาก Google Sheet', permissions: 0 },
        { name: 'de', description: 'ลบข้อความล่าสุดในแชนแนลนี้ (สูงสุด 500)', permissions: PermissionFlagsBits.ManageMessages },
    ];

    const commands: RESTPostAPIApplicationCommandsJSONBody[] = slashDefs.map(def => {
        const cmd = new SlashCommandBuilder().setName(def.name).setDescription(def.description);
        if (def.name === 'de') {
            cmd.addIntegerOption(opt => opt.setName('amount').setDescription('จำนวนข้อความที่ต้องการลบ (1-500)').setRequired(false).setMinValue(1).setMaxValue(500));
            cmd.addBooleanOption(opt => opt.setName('all').setDescription('ลบทั้งหมดในห้อง (ลบเป็นรอบๆ)').setRequired(false));
        }
        if (def.permissions !== undefined) cmd.setDefaultMemberPermissions(def.permissions);
        return cmd.toJSON();
    });

    // ✅ Context Menu — รวมไว้ใน bulk registration เพื่อป้องกันหายตอน restart
    commands.push(
        new ContextMenuCommandBuilder()
            .setName('Edit Tags')
            .setType(ApplicationCommandType.Message)
            .toJSON()
    );

    // ลบ Guild Commands เก่า (Guild level) เพื่อป้องกันคำสั่งซ้ำกับ Global
    try {
        const guild = client.guilds.cache.get(env.guildId);
        if (guild) {
            const existingGuild = await guild.commands.fetch();
            if (existingGuild.size > 0) {
                await guild.commands.set([]);
                logger.info('COMMAND', `ลบ ${existingGuild.size} คำสั่ง Guild level เก่า`);
            }
        }
    } catch (e: unknown) {
        logger.warn('COMMAND', `ลบ Guild commands ไม่สำเร็จ (ไม่ใช่ปัญหา): ${e instanceof Error ? e.message : String(e)}`);
    }

    try {
        await client.application?.commands.set(commands);
        logger.info('COMMAND', `ลงทะเบียน ${commands.length} คำสั่งสำเร็จ (Bulk)`);
    } catch (err) {
        logger.error('COMMAND', `ลงทะเบียนคำสั่งล้มเหลว: ${err}`);
    }
});

async function start(): Promise<void> {
    // เริ่มเก็บ log ก่อนทำอย่างอื่น เพื่อให้ปัญหาตอนสตาร์ทถูกบันทึกไว้ด้วย
    startLogStore();

    try {
        await configService.load();
    } catch {
        logger.error('STARTUP', 'โหลด config ไม่สำเร็จ — บอทอาจทำงานไม่ครบ');
    }

    // ✅ Feature Registry — โหลดฟีเจอร์ทั้งหมด
    const featureSetups: ((client: Client) => void)[] = [
        (await import('./features/welcome/listener')).setupWelcomeFeature,
        (await import('./features/logtime/listener')).setupLogtimeFeature,
        (await import('./features/bypd/listener')).setupBypdFeature,
        (await import('./features/reload/listener')).setupReloadFeature,
        (await import('./features/count/listener')).setupCountFeature,
        (await import('./features/edit-tag/listener')).setupEditTagFeature,
        (await import('./features/editpd/listener')).setupEditPdFeature,
        (await import('./features/recount/listener')).setupRecountFeature,
        (await import('./features/clear/listener')).setupClearFeature,
        (await import('./features/proctor/listener')).setupProctorFeature,
    ];

    for (const setupFn of featureSetups) {
        try {
            setupFn(client);
        } catch (err) {
            logger.error('FEATURE', `โหลดฟีเจอร์ล้มเหลว: ${err}`);
        }
    }

    // ต่อ Discord แบบมีเพดานการลอง — ถ้าโดนลิมิต/ต่อไม่ติดซ้ำ ๆ จะหยุดยิง Discord เอง (ดู connectDiscord)
    await connectDiscord();
}

start().catch((err: Error) => {
    // ข้อผิดพลาดระหว่างสตาร์ท — "เชื่อมต่อ Discord ไม่สำเร็จ" ถูกจัดการใน connectDiscord แล้ว
    // ตรงนี้จึงเหลือเคสไม่คาดคิด: ปล่อยให้โฮสต์สตาร์ทใหม่ แต่รอให้ log เขียนลงไฟล์จบก่อน
    logger.error('STARTUP', `เริ่มบอทไม่สำเร็จ: ${err.stack || err.message}`);
    if (isFatalLoginError(err.message)) {
        logger.error('STARTUP', 'สาเหตุ: token ไม่ถูกต้อง/ถูกรีเซ็ต หรือไม่ได้เปิด Privileged Intents ใน Developer Portal');
    }
    setTimeout(() => { logger.close(); process.exit(1); }, 200);
});
