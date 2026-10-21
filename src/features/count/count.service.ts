import { Client, CommandInteraction, ButtonInteraction } from 'discord.js';
import { sheetService } from '../../core/sheet.service';
import { configService } from '../../core/config.service';
import { normalizeName, replyAndDelete, silentCatch } from '../../services/utils';
import { isSystemNickname } from '../../services/member.service';
import { lookupName } from '../../services/name-resolver';
import { logger } from '../../core/logger';
import { locks } from '../../core/lock.service';
import type { TagInfo } from '../../types/discord';
import { CONSTANTS } from '../../types/discord';
import { countStates } from './count.state';

/** Queued batch: accumulate count changes and flush periodically */
interface CountOp {
    tag: TagInfo;
    channelId: string;
    isDelete: boolean;
}

let countQueue: CountOp[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushFailures = 0;

const FLUSH_DELAY_MS = 3000;
/** เพดานการถอยห่าง — 3 วิ → 6 → 12 → 24 → 48 วิ แล้วคาที่ 48 วิ */
const MAX_BACKOFF_STEPS = 4;

/** หน่วงก่อนลองเขียนใหม่ ยิ่งพลาดติดกันยิ่งถอยห่าง กันยิง Google ซ้ำ ๆ ตอนมันล่ม */
export function flushDelayFor(failures: number): number {
    return FLUSH_DELAY_MS * 2 ** Math.min(Math.max(failures, 0), MAX_BACKOFF_STEPS);
}

/** จำนวนยอดที่ยังค้างในคิว ยังไม่ได้เขียนลงชีต */
export function pendingCountOps(): number {
    return countQueue.length;
}

function scheduleFlush(delayMs = FLUSH_DELAY_MS): void {
    if (flushTimer) return;
    flushTimer = setTimeout(async () => {
        flushTimer = null;
        try {
            await flushCountQueue();
        } catch (e) {
            logger.error('นับเคส', `flush error: ${e}`);
        }
    }, delayMs);
}

/**
 * เขียนยอดที่ยังค้างในคิวลงชีตทันที ไม่ต้องรอครบ 3 วินาที
 * ใช้ตอนปิดบอท เพื่อไม่ให้ยอดที่ยังอยู่ในหน่วยความจำหายไปพร้อมกับ process
 */
export async function flushPendingCounts(): Promise<void> {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    await flushCountQueue();
}

async function flushCountQueue(): Promise<void> {
    if (countQueue.length === 0) return;

    // ใช้กุญแจตัวเดียวกับ manualRecount เพื่อไม่ให้สองระบบเขียนชีตทับกัน
    // ของเดิมใช้คนละดอก (countBatch กับ count) จึงไม่ได้กันกันเลย ระหว่างนับใหม่ที่กินเวลาเป็นนาที
    // นับสดยังเขียนแทรกได้ แล้วโดนนับใหม่เขียนทับด้วยข้อมูลที่อ่านไว้ตั้งแต่ก่อนเริ่ม
    await locks.count.run(async () => {
        const cfg = configService.getCountConfig();
        if (!cfg.SPREADSHEET_ID || !cfg.SHEET_NAME) return;

        // ดึงของออกจากคิวหลังได้กุญแจแล้วเท่านั้น
        // ระหว่างรอ ของจะกองรวมเป็นก้อนเดียว พอถึงคิวก็เขียนทีเดียวจบ
        // ไม่ใช่ทยอยเขียนทีละรอบจนยิง Google รัวเป็นร้อยครั้ง
        const ops = countQueue;
        countQueue = [];
        if (ops.length === 0) return;

        try {
            await writeCountOps(ops, cfg);
            flushFailures = 0;
        } catch (err) {
            // เขียนชีตไม่สำเร็จ — เอาของกลับเข้าคิวไว้หน้าสุด แล้วนัดลองใหม่แบบถอยห่างขึ้นเรื่อย ๆ
            // ของเดิมตัดคิวทิ้งตั้งแต่ก่อนเขียน พอเขียนพลาดยอดรอบนั้นจึงหายถาวร
            countQueue = [...ops, ...countQueue];
            flushFailures++;
            scheduleFlush(flushDelayFor(flushFailures));
            throw err;
        }
    });
}

type CountConfig = ReturnType<typeof configService.getCountConfig>;

/** อ่านชีต บวก/ลบยอด แล้วเขียนกลับเฉพาะแถวที่เปลี่ยน */
async function writeCountOps(ops: CountOp[], cfg: CountConfig): Promise<void> {
    const chMap: Record<string, number> = {
        [cfg.CHANNELS.CHANNEL_1]: 2,
        [cfg.CHANNELS.CHANNEL_2]: 3,
        [cfg.CHANNELS.CHANNEL_3]: 4,
        [cfg.CHANNELS.CHANNEL_4]: 5,
        [cfg.CHANNELS.CHANNEL_5]: 6,
    };

    const byChannel = new Map<string, CountOp[]>();
    for (const op of ops) {
        const arr = byChannel.get(op.channelId);
        if (arr) arr.push(op);
        else byChannel.set(op.channelId, [op]);
    }

    const rows = await sheetService.getValues(cfg.SPREADSHEET_ID, `${cfg.SHEET_NAME}!A:G`, 0);
    while (rows.length < CONSTANTS.COUNT_DATA_START) rows.push([]);

    const headerIdx = CONSTANTS.COUNT_DATA_START - 1;
    let headerWritten = false;
    if (rows[headerIdx]?.length < 7 || !rows[headerIdx]?.[0]) {
        rows[headerIdx] = [...CONSTANTS.COUNT_HEADER];
        headerWritten = true;
    }

    // จำไว้ว่าแถวเดิมมีกี่แถว และแถวไหนบ้างที่ถูกแตะ
    // เพื่อจะเขียนกลับเฉพาะแถวนั้น แทนการส่งทั้งตารางกลับไปทุก 3 วินาที
    const existingRowCount = rows.length;
    const touched = new Set<number>();

    for (const [channelId, channelOps] of byChannel) {
        const colIdx = chMap[channelId];
        if (colIdx === undefined) continue;
        for (const op of channelOps) {
            // หักยอด: ต้องมีแถวอยู่แล้วเท่านั้น ไม่มีแถว = ไม่มีอะไรให้หัก
            // ถ้าปล่อยให้สร้างแถวใหม่เพื่อจะหัก จะได้แถวขยะเปล่า ๆ เพิ่มมาในชีต
            // (ยิ่งตอนหักคนที่ออกจากเซิร์ฟไปแล้ว เราจะไม่มีชื่อเขา แถวที่สร้างจะไม่มีชื่อด้วย)
            const rowIdx = op.isDelete ? findUserRow(rows, op.tag) : ensureUserRow(rows, op.tag);
            if (rowIdx === -1) continue;
            // ชื่อเล่นในเซิร์ฟเปลี่ยนแล้ว → ให้ชีตตามความจริง ไม่ต้องรอใครมาแก้มือ
            refreshDisplayName(rows, rowIdx, op.tag);
            const currentVal = parseInt(rows[rowIdx][colIdx] || '0') || 0;
            const newVal = currentVal + (op.isDelete ? -1 : 1);
            rows[rowIdx][colIdx] = newVal > 0 ? newVal.toString() : '';
            touched.add(rowIdx);
        }
    }

    const updates = buildCountUpdates(cfg.SHEET_NAME, rows, touched, existingRowCount, headerWritten);
    if (updates.length > 0) {
        await sheetService.batchUpdateValues(cfg.SPREADSHEET_ID, updates);
    }
}

export interface SheetRangeUpdate {
    range: string;
    values: string[][];
}

/** เติมช่องที่ขาดหรือเป็นรูโหว่ให้ครบ 7 คอลัมน์ (A–G) ให้รูปร่างตรงกับ range ที่จะเขียน */
function toFullRow(row: string[] | undefined): string[] {
    const out: string[] = [];
    for (let c = 0; c < 7; c++) out.push(row?.[c] ?? '');
    return out;
}

/**
 * สร้างรายการ range ที่ต้องเขียนจริง แทนการส่งทั้งตารางกลับไปทุกครั้ง
 *   - แถวเดิมที่ถูกแก้ → เขียนทีละแถว A{n}:G{n}
 *   - แถวใหม่ที่เพิ่มต่อท้าย → รวมเป็นบล็อกเดียว
 * แยกออกมาเป็น pure function เพื่อให้เทสได้โดยไม่ต้องต่อ Google Sheets
 */
export function buildCountUpdates(
    sheetName: string,
    rows: string[][],
    touched: Set<number>,
    existingRowCount: number,
    headerWritten: boolean,
): SheetRangeUpdate[] {
    const updates: SheetRangeUpdate[] = [];

    if (headerWritten) {
        const r = CONSTANTS.COUNT_DATA_START; // index 2 (0-based) = แถวที่ 3 ของชีต
        updates.push({ range: `${sheetName}!A${r}:G${r}`, values: [toFullRow(rows[r - 1])] });
    }

    const existingTouched = [...touched].filter(i => i < existingRowCount).sort((a, b) => a - b);
    for (const idx of existingTouched) {
        const r = idx + 1; // index 0-based → เลขแถวของชีต (1-based)
        updates.push({ range: `${sheetName}!A${r}:G${r}`, values: [toFullRow(rows[idx])] });
    }

    if (rows.length > existingRowCount) {
        updates.push({
            range: `${sheetName}!A${existingRowCount + 1}:G${rows.length}`,
            values: rows.slice(existingRowCount).map(toFullRow),
        });
    }

    return updates;
}

/*
 * IMPORTANT: Actual Sheet Structure
 *   Row 1: (empty)
 *   Row 2: (empty)
 *   Row 3: Header row (A="ชื่อDC", B="User ID", C-G=count columns)
 *   Row 4+: Data (A=display name, B=Discord User ID, C=Take2, D=คดีปกติ, E=รถยอด, F=คุมสอบ, G=อุ้มเอ๋อ)
 * 
 * Column indices: A=0, B=1, C=2, D=3, E=4, F=5, G=6
 * Data starts at row index 3 (0-based)
 */

/**
 * Find row index by exact Discord User ID match in Column B (index 1).
 * Only searches data rows (index 3+).
 */
export function findRowById(rows: string[][], userId: string): number {
    for (let i = CONSTANTS.COUNT_DATA_START; i < rows.length; i++) {
        if (rows[i]?.length > 1 && rows[i][1] === userId) return i;
    }
    return -1;
}

/**
 * Backward-compatible fallback: find row by name/nickname match in Column A (index 0).
 * For existing rows that may not have User ID in Column B yet.
 * Only searches data rows (index 3+).
 */
function findRowByName(rows: string[][], tag: TagInfo): number {
    const n = normalizeName(tag.nickname);
    const u = normalizeName(tag.username);
    // ไม่มีชื่อให้เทียบ ก็อย่าเดา — includes('') เป็นจริงกับทุกชื่อ
    // ถ้าปล่อยผ่านจะไปเจอแถวแรกที่มีชื่อ แล้วบวก/หักยอดผิดคน
    if (!n && !u) return -1;
    for (let i = CONSTANTS.COUNT_DATA_START; i < rows.length; i++) {
        const nameCell = rows[i]?.[0]; // Column A = display name
        const idCell = rows[i]?.[1];   // Column B = User ID (may be empty in old data)
        if (nameCell) {
            const nameLower = normalizeName(nameCell);
            // Match by display name OR by username in Column B
            // เทียบเฉพาะค่าที่มีจริง — includes('') เป็นจริงกับทุกชื่อ
            // ตอนนี้ชื่อเล่นว่างได้บ่อยขึ้น (แท็กคนที่หาตัวไม่เจอ) จึงต้องกันทีละค่า
            // ไม่ใช่กันแค่ตอนที่ว่างทั้งคู่ ไม่งั้นยอดจะไปโดนแถวแรกที่มีชื่อแบบมั่ว ๆ
            if ((n && nameLower.includes(n)) || (u && nameLower.includes(u)) || (u && normalizeName(idCell || '') === u)) {
                return i;
            }
        }
    }
    return -1;
}

/**
 * Ensure a row exists for the user, creating one if not found.
 * Returns the row index.
 * 
 * Priority: 1) Exact User ID match in Column B  2) Name match in Column A  3) Create new row
 * When found by name, automatically sets User ID in Column B.
 * 
 * Sheet format: [A=displayName, B=UserID, C=Take2, D=คดีปกติ, E=รถยอด, F=คุมสอบ, G=อุ้มเอ๋อ]
 */
export function findUserRow(rows: string[][], tag: TagInfo): number {
    // Priority 1: Exact User ID match in Column B
    const byId = findRowById(rows, tag.id);
    if (byId !== -1) return byId;

    // Priority 2: Backward-compatible name match in Column A
    const byName = findRowByName(rows, tag);
    if (byName !== -1) {
        // Migrate: set User ID in Column B for future exact lookups
        rows[byName][1] = tag.id;
    }
    return byName;
}

export function ensureUserRow(rows: string[][], tag: TagInfo): number {
    const found = findUserRow(rows, tag);
    if (found !== -1) return found;

    // Priority 3: Create new row [displayName, UserID, '', '', '', '', '']
    // หาชื่อไม่ได้ (เช่นคนออกจากเซิร์ฟไปแล้ว) ก็ยังต้องนับยอดให้ — ใส่เลขไอดีไว้ในช่องชื่อก่อน
    // ดีกว่าทิ้งยอดทิ้ง และคนดูชีตเอาเลขไปหาตัวคนแล้วเติมชื่อเองได้ทีหลัง
    rows.push([tag.nickname || tag.username || tag.id, tag.id, '', '', '', '', '']);
    return rows.length - 1;
}

/**
 * อัปเดตช่องชื่อ (คอลัมน์ A) ให้เป็นชื่อเล่นปัจจุบันในเซิร์ฟเวอร์ — คืน true เมื่อเปลี่ยนจริง
 *
 * ของเดิมเขียนคอลัมน์ A ครั้งเดียวตอนสร้างแถว (ดู ensureUserRow) แล้วไม่เคยอัปเดตอีกเลย
 * ใครถูกนับยอดก่อนลงทะเบียน ชื่อบัญชี Discord จะคาอยู่ในชีตตลอดไป
 * แม้ภายหลังจะมีชื่อในระบบ `รหัส [VES-PD] ชื่อ IC` แล้วก็ไม่มีอะไรมาแก้ให้
 * และปุ่มนับใหม่ก็ไม่ช่วย เพราะมันล้างแต่คอลัมน์ยอด (C–G) ไม่แตะชื่อ
 *
 * เขียนทับเฉพาะเมื่อครบ 2 เงื่อนไข:
 *   1) ชื่อมาจากชื่อเล่นที่ตั้งในเซิร์ฟจริง ไม่ใช่ชื่อบัญชี Discord ที่ fallback มา
 *   2) อยู่ในรูปแบบชื่อในระบบของคนใน
 *
 * ต้องกัน 2 ชั้นเพราะชื่อในชีตต้อง "ดีขึ้นหรือเท่าเดิม" ห้ามถอยหลัง —
 * คนนอกและคนที่ออกจากเซิร์ฟไปแล้วไม่มีชื่อเล่นให้ใช้ ปล่อยชื่อเดิมไว้ดีกว่าทับด้วยชื่อบัญชี
 */
export function refreshDisplayName(rows: string[][], rowIdx: number, tag: TagInfo): boolean {
    const row = rows[rowIdx];
    if (!row || !tag.hasGuildNickname) return false;
    const name = tag.nickname.trim();
    if (!name || !isSystemNickname(name)) return false;
    if ((row[0] ?? '') === name) return false;
    row[0] = name;
    return true;
}

export async function processCountBatch(
    tags: TagInfo[],
    channelId: string,
    isDelete: boolean
): Promise<void> {
    for (const tag of tags) {
        countQueue.push({ tag, channelId, isDelete });
    }
    scheduleFlush();
}

/**
 * Shared interaction type for manual recount — only needs deferReply, editReply, guild
 */
type RecountInteraction = CommandInteraction<'cached'> | ButtonInteraction<'cached'>;

export async function manualRecount(client: Client, interaction: RecountInteraction, abortSignal?: AbortSignal): Promise<void> {
    return locks.count.run(async () => {
        const cfg = configService.getCountConfig();
        if (!cfg.SPREADSHEET_ID || !cfg.SHEET_NAME) {
            try {
                await interaction.deferReply({ flags: 64 }).catch(silentCatch('Count'));
                await interaction.editReply({ content: '❌ ยังไม่ได้ตั้งค่า' });
            } catch (e) { logger.warn('Count', String(e)); }
            return;
        }

        try {
            await interaction.deferReply({ flags: 64 }).catch(silentCatch('Count'));
        } catch (e) { logger.warn('Count', `deferReply failed: ${String(e)}`); return; }

        // Read current sheet data
        const rows = await sheetService.getValues(
            cfg.SPREADSHEET_ID,
            `${cfg.SHEET_NAME}!A:G`,
            0
        );

        // Ensure sheet has minimum structure
        while (rows.length < CONSTANTS.COUNT_DATA_START) {
            rows.push([]);
        }

        // Ensure header row exists at row index 3 (0-based)
        if (rows[CONSTANTS.COUNT_DATA_START - 1]?.length < 7 || !rows[CONSTANTS.COUNT_DATA_START - 1]?.[0]) {
            rows[CONSTANTS.COUNT_DATA_START - 1] = CONSTANTS.COUNT_HEADER;
        }

        // Reset all count columns (C-G, indices 2-6) for existing data rows only (index 3+)
        for (let i = CONSTANTS.COUNT_DATA_START; i < rows.length; i++) {
            if (rows[i]) {
                // Ensure row has enough columns (at least 7: A-G)
                while (rows[i].length < 7) rows[i].push('0');
                // Reset count columns C-G to empty
                for (let c = 2; c <= 6; c++) {
                    rows[i][c] = '';
                }
            }
        }

        const channels = [
            { id: cfg.CHANNELS.CHANNEL_1, col: 2 },
            { id: cfg.CHANNELS.CHANNEL_2, col: 3 },
            { id: cfg.CHANNELS.CHANNEL_3, col: 4 },
            { id: cfg.CHANNELS.CHANNEL_4, col: 5 },
            { id: cfg.CHANNELS.CHANNEL_5, col: 6 },
        ];

        // Cache fetched Discord users to avoid repeated API calls
        const userCache = new Map<string, TagInfo>();
        let totalMessages = 0;
        let lastProgressUpdate = Date.now();
        const PROGRESS_INTERVAL_MS = 3000;

        for (const ch of channels) {
            if (abortSignal?.aborted) break;
            if (!ch.id) continue;

            const channel = client.channels.cache.get(ch.id);
            if (!channel || !channel.isTextBased()) continue;

            let lastId: string | undefined;
            let hasMore = true;

            while (hasMore) {
                if (abortSignal?.aborted) break;
                const msgs = await channel.messages.fetch({ limit: 100, before: lastId });
                if (msgs.size === 0) break;

                for (const msg of msgs.values()) {
                    const mentions = msg.content.match(/<@!?(\d+)>/g) || [];
                    const uniqueIds = [...new Set(
                        mentions
                            .map((m: string) => m.match(/\d+/)?.[0])
                            .filter(Boolean)
                    )] as string[];

                    for (const uid of uniqueIds) {
                        let person = userCache.get(uid);
                        if (!person) {
                            /*
                             * ใช้ตัวหาชื่อตัวเดียวกับการนับสด
                             *
                             * ของเดิมตรงนี้มีตรรกะหาชื่อของตัวเองแยกอีกชุด สองทางจึงได้ชื่อไม่เท่ากัน
                             * และไม่รู้ด้วยว่าชื่อที่ได้เป็นชื่อเล่นจริงหรือชื่อบัญชีที่ fallback มา
                             */
                            const name = await lookupName(interaction.guild, uid);
                            // หาไม่ได้ทั้งชื่อเล่นและชื่อบัญชี = เลขปลอมหรือบัญชีถูกลบ ไม่ต้องสร้างแถว
                            if (!name.nickname && !name.username) continue;
                            person = {
                                id: uid,
                                nickname: name.nickname,
                                username: name.username,
                                hasGuildNickname: name.hasGuildNickname,
                            };
                            userCache.set(uid, person);
                        }

                        const rowIdx = ensureUserRow(rows, person);
                        // รอบนี้เขียนชีตทั้งตาราง — ซ่อมชื่อเก่าที่ค้างอยู่ให้ทุกแถวที่เจอไปเลย
                        refreshDisplayName(rows, rowIdx, person);
                        const currentVal = parseInt(rows[rowIdx][ch.col] || '0') || 0;
                        rows[rowIdx][ch.col] = (currentVal + 1).toString();
                    }
                }

                totalMessages += msgs.size;
                lastId = msgs.last()?.id;
                if (msgs.size < 100) hasMore = false;

                // อัปเดตความคืบหน้าทุก 3 วิ
                if (Date.now() - lastProgressUpdate > PROGRESS_INTERVAL_MS) {
                    lastProgressUpdate = Date.now();
                    try {
                        const channelName = 'name' in channel ? `#${channel.name}` : 'unknown';
                        await interaction.editReply({ content: `📂 กำลังสแกน: ${channelName}\n⏳ กำลังนับข้อความเก่า... ${totalMessages} ข้อความแล้ว` });
                    } catch { /* ignore */ }
                }

                // ป้องกัน Discord rate limit — หน่วง 200ms ระหว่าง fetch
                await new Promise(r => setTimeout(r, 200));
            }
        }

        if (abortSignal?.aborted) {
            countStates.stop();
            await interaction.editReply({ content: `⏹️ หยุดนับข้อความเก่า\n📊 สแกน: ${totalMessages} ข้อความ` });
            return;
        }

        await sheetService.updateValues(
            cfg.SPREADSHEET_ID,
            `${cfg.SHEET_NAME}!A1`,
            rows
        );

        countStates.stop();
        await replyAndDelete(interaction, `✅ นับข้อความเก่าเสร็จ: ${totalMessages} ข้อความ`);
        logger.info('นับเคส', `นับข้อความเก่าเสร็จ: ${totalMessages} ข้อความ`);
    });
}