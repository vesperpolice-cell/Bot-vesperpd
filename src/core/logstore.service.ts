/**
 * เขียน log ที่ "ต้องย้อนดูได้" ลงแท็บ Log-Debug-Bot ในไฟล์ Settings
 *
 * แบ่งหน้าที่กับ logger ชัดเจน:
 *   - logger  เก็บ "ทุกบรรทัด" ไว้ในหน่วยความจำ 24 ชม. (ฟรี ไม่กินโควต้า)
 *   - ที่นี่   เก็บ "เฉพาะที่สำคัญ" ลงชีตแค่แถวล่าสุดตาม LOG.SHEET_MAX_ROWS (ทนบอทรีสตาร์ท)
 *
 * ทำไมต้องรวบเป็นชุด:
 * บอทกับเว็บใช้บัญชี Google ตัวเดียวกัน โควต้าเขียนจึงแชร์กัน (ราว 60 ครั้ง/นาที)
 * ถ้าเขียน log ทีละบรรทัด บอทที่นับ ~2,500 เคส/วันจะกินโควต้าจนการเขียนยอดเริ่มพลาด
 * = กลับไปเจอปัญหายอดหายอีกแบบหนึ่ง จึงรวบส่งนาทีละครั้ง และมีเพดานต่อครั้ง
 */

import { sheetService } from './sheet.service';
import { SHEETS, LOG } from '../config';
import { logger, onEntry, type LogEntry } from './logger';

const HEADER = ['เวลา', 'ระดับ', 'หมวด', 'ใครทำ', 'ข้อความ', 'รายละเอียด'];

/** โซนเวลาที่ใช้เขียนลงชีต — ต้องตรงกับที่คนอ่าน ไม่ใช่โซนของเครื่องโฮสต์ */
const TZ = 'Asia/Bangkok';

/**
 * หมวดของตัวเองห้ามเขียนลงชีตเด็ดขาด
 *
 * ถ้าเขียนลงไปด้วย เวลาชีตล่ม → เขียนพลาด → log ว่าพลาด → เข้าคิวอีก → พลาดอีก
 * กลายเป็นวนไม่จบและคิวบวมไม่หยุด
 */
const NEVER_PERSIST = 'LOGSTORE';

/**
 * หมวดระดับ INFO ที่ถือเป็น "เหตุการณ์" ต้องเก็บลงชีต
 *
 * ใช้วิธีระบุรายชื่อ ไม่ใช่เอาทุกอย่าง เพราะถ้าเอาหมดจะมีของปริมาณมากหลุดเข้ามา
 * ที่ชัดสุดคือ BYPD ซึ่ง log หนึ่งบรรทัดต่อหนึ่งคดี = ~2,160 แถว/วัน
 * ชีตจะอืดภายในเดือนเดียว ส่วนรายละเอียดระดับนั้นดูจากหน่วยความจำ 24 ชม.ได้อยู่แล้ว
 *
 * ระดับ WARN/ERROR เก็บทุกหมวดเสมอ ไม่ต้องอยู่ในรายชื่อนี้
 */
const EVENT_CONTEXTS = new Set([
    'CLIENT',       // ออนไลน์ / ต่อใหม่สำเร็จ
    'SERVER',
    'COMMAND',
    'STARTUP',
    'SHUTDOWN',
    'CONFIG',
    'รีโหลด',        // ใครกดรีโหลด config
    'สมัคร',         // ลงทะเบียนใครที่แถวไหน
    'Pre-Approved',
    'ต้อนรับ',       // คนเข้า / ออกเซิร์ฟ
    'แก้ชื่อ',
    'แก้เบอร์',
    'นับเคส',        // สรุปรายชั่วโมง + นับข้อความเก่าเสร็จ
    'PROCTOR',
    'ลงเวลา',
]);

/** บรรทัดนี้ควรเก็บลงชีตไหม — แยกเป็นฟังก์ชันเดี่ยวเพื่อให้เทสได้ */
export function shouldPersist(entry: Pick<LogEntry, 'level' | 'context'>): boolean {
    if (entry.context === NEVER_PERSIST) return false;
    if (entry.level === 'DEBUG') return false;
    if (entry.level === 'ERROR' || entry.level === 'WARN') return true;
    return EVENT_CONTEXTS.has(entry.context);
}

/** เวลาแบบ `YYYY-MM-DD HH:mm:ss` ตามเวลาไทย — อ่านรู้เรื่องและเรียงลำดับได้ */
export function formatSheetTime(at: number): string {
    const p = new Intl.DateTimeFormat('sv-SE', {
        timeZone: TZ,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
    }).format(new Date(at));
    // 'sv-SE' ให้รูปแบบ "2026-10-02 03:15:42" มาแล้ว แค่กันกรณีมีตัวคั่นแปลก ๆ
    return p.replace('T', ' ');
}

/**
 * เกินเพดานกี่แถว — เอาไปลบจากแถวบน (เก่าสุด)
 *
 * เราต่อท้ายเสมอ แถวบนจึงเก่าสุด ตัดหัวทิ้งจึงเหลือของใหม่สุดตามเพดานพอดี
 * rows มาจากคอลัมน์ A ทั้งแท็บ: index 0 = หัวตาราง, ข้อมูลเริ่ม index 1
 *
 * ไม่แตะเวลาในเซลล์เลยโดยเจตนา — นับจำนวนแถวตรง ๆ จึงไม่มีทางพังเพราะ
 * Google เปลี่ยนรูปแบบการแสดงค่าในเซลล์ ซึ่งของเดิม (ตัดตามวัน) พังได้เงียบ ๆ
 */
export function countRowsToDrop(rows: string[][], maxRows: number): number {
    if (maxRows <= 0) return 0;
    const data = Math.max(rows.length - 1, 0);   // ไม่นับหัวตาราง
    return data > maxRows ? data - maxRows : 0;
}

/** หมายเลขแท็บภายในจำไว้ — ไม่เปลี่ยนตอน append/deleteRow เปลี่ยนเฉพาะตอนสร้างแท็บใหม่ */
const tabIdCache = new Map<string, number | null>();

/** เอา tabId จาก cache ก่อน ถ้าไม่มีค่อยถาม Google — ลดคำขอ metadata ที่ยิงซ้ำทุกชั่วโมง */
async function cachedTabId(tab: string): Promise<number | null> {
    if (tabIdCache.has(tab)) return tabIdCache.get(tab) ?? null;
    const id = await sheetService.getSheetTabId(SHEETS.CONFIG_SHEET_ID, tab);
    tabIdCache.set(tab, id);
    return id;
}


function toRow(entry: LogEntry): string[] {
    const meta = entry.meta ?? {};
    const actor = typeof meta.actor === 'string' ? meta.actor : '';
    const rest = { ...meta };
    delete rest.actor;
    const detail = Object.keys(rest).length > 0 ? JSON.stringify(rest) : '';
    return [
        formatSheetTime(entry.at),
        entry.level,
        entry.context,
        actor,
        entry.message,
        detail,
    ];
}

let queue: string[][] = [];
let flushing = false;
let failures = 0;
let skipTicks = 0;
let tabChecked = false;

/** จำนวนแถวที่ยังไม่ได้เขียนลงชีต — ใช้บอกสถานะและตอนปิดบอท */
export function pendingLogRows(): number {
    return queue.length;
}

function enqueue(entry: LogEntry): void {
    if (!shouldPersist(entry)) return;
    queue.push(toRow(entry));
    // คิวเต็ม → ทิ้งของเก่าสุด ดีกว่าปล่อยให้หน่วยความจำบวมจนบอทตาย
    if (queue.length > LOG.SHEET_QUEUE_MAX) {
        queue.splice(0, queue.length - LOG.SHEET_QUEUE_MAX);
    }
}

/** เขียนคิวลงชีต — เรียกจากตัวตั้งเวลา และตอนปิดบอท */
export async function flushLogSheet(): Promise<void> {
    if (flushing || queue.length === 0) return;
    // พลาดติดกันก็ถอยห่าง ไม่ยิงซ้ำทุกนาทีตอน Google ล่ม
    if (skipTicks > 0) { skipTicks--; return; }

    flushing = true;
    const batch = queue.slice(0, LOG.SHEET_MAX_ROWS_PER_FLUSH);
    queue = queue.slice(batch.length);
    try {
        if (!tabChecked) {
            const created = await sheetService.ensureSheetTab(SHEETS.CONFIG_SHEET_ID, SHEETS.LOG_SHEET_NAME, HEADER);
            tabChecked = true;
            if (created) {
                tabIdCache.delete(SHEETS.LOG_SHEET_NAME);
                logger.info(NEVER_PERSIST, `สร้างแท็บ ${SHEETS.LOG_SHEET_NAME} ให้ใหม่แล้ว`);
            }
        }
        // RAW = เก็บเป็นข้อความเป๊ะ ๆ ห้ามให้ Google แปลงเวลาเป็นค่าวันที่ของมันเอง
        // ไม่งั้นอ่านกลับมาจะได้รูปแบบที่มันจัดแสดง ไม่ตรงกับที่เขียน แล้วการลบของเก่าจะพังเงียบ ๆ
        await sheetService.appendValues(
            SHEETS.CONFIG_SHEET_ID,
            `${SHEETS.LOG_SHEET_NAME}!A1`,
            batch,
            'RAW',
        );
        failures = 0;
    } catch (err) {
        // เอากลับเข้าคิวไว้หน้าสุด ไม่ทิ้ง แล้วถอยห่างขึ้นเรื่อย ๆ
        queue = [...batch, ...queue];
        if (queue.length > LOG.SHEET_QUEUE_MAX) queue.splice(0, queue.length - LOG.SHEET_QUEUE_MAX);
        failures++;
        skipTicks = Math.min(failures, 10);
        tabChecked = false;
        logger.warn(NEVER_PERSIST, `เขียน log ลงชีตไม่สำเร็จ (พลาดติดกัน ${failures} ครั้ง) — ค้างในคิว ${queue.length} แถว: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
        flushing = false;
    }
}

/** ตัดแท็บหนึ่งให้เหลือแถวล่าสุดตามเพดาน — ไม่สร้างแท็บให้ ถ้ายังไม่มีก็ข้าม */
async function trimLogTab(tab: string): Promise<void> {
    try {
        const rows = await sheetService.getValues(SHEETS.CONFIG_SHEET_ID, `${tab}!A:A`, 0);
        const drop = countRowsToDrop(rows, LOG.SHEET_MAX_ROWS);
        if (drop < 1) return;

        const tabId = await cachedTabId(tab);
        if (tabId === null) return;

        // index 1 = แถวที่ 2 ของชีต (ข้ามหัวตาราง) · ปลายช่วงไม่ถูกรวม
        await sheetService.deleteRowRange(SHEETS.CONFIG_SHEET_ID, tabId, 1, drop + 1);
        logger.info(NEVER_PERSIST, `ตัด log แท็บ ${tab} ทิ้ง ${drop} แถว (เหลือ ${LOG.SHEET_MAX_ROWS} แถวล่าสุด)`);
    } catch (err) {
        logger.warn(NEVER_PERSIST, `ตัด log แท็บ ${tab} ไม่สำเร็จ: ${err instanceof Error ? err.message : String(err)}`);
    }
}

/**
 * ตัด log ในชีตให้เหลือแค่แถวล่าสุดตามเพดาน
 *
 * ดูแลแท็บของเว็บให้ด้วย เพราะเว็บรันบน Vercel ซึ่งไม่มีตัวตั้งเวลาของตัวเอง
 * ของเดิมแท็บเว็บถูกตัดเฉพาะตอนมีคนเปิดหน้า /police/logs — ไม่มีคนเปิดก็ไม่ถูกตัด
 * ทั้งสองแท็บอยู่ไฟล์เดียวกันและบอทมีสิทธิ์เขียนอยู่แล้ว จึงทำให้ตรงนี้ทีเดียวจบ
 */
export async function cleanupLogSheet(): Promise<void> {
    await trimLogTab(SHEETS.LOG_SHEET_NAME);
    await trimLogTab(SHEETS.WEB_LOG_SHEET_NAME);
}

let started = false;

/** เริ่มรับ log และตั้งเวลาเขียน/เก็บกวาด — เรียกครั้งเดียวตอนบอทสตาร์ท */
export function startLogStore(): void {
    if (started) return;
    started = true;

    onEntry(enqueue);

    setInterval(() => { void flushLogSheet(); }, LOG.SHEET_FLUSH_INTERVAL_MS);
    setInterval(() => { void cleanupLogSheet(); }, LOG.SHEET_CLEANUP_INTERVAL_MS);

    logger.info(NEVER_PERSIST, `เริ่มเก็บ log ลงแท็บ ${SHEETS.LOG_SHEET_NAME} (รวบส่งทุก ${LOG.SHEET_FLUSH_INTERVAL_MS / 1000} วิ · เก็บ ${LOG.SHEET_MAX_ROWS} แถวล่าสุด)`);
}
