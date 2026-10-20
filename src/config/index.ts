import dotenv from 'dotenv';
import path from 'path';
import { checkCredentials } from '../core/credentials';

dotenv.config({ path: path.join(__dirname, '../../.env') });

// ---- ตัวช่วยตรวจค่าจาก .env ----
// เก็บ error ทั้งหมดไว้ใน validationErrors แล้วให้ validate() คืนทีเดียว
// เพื่อให้ผู้ใช้เห็นทุกจุดที่ผิดในรอบเดียว ไม่ต้องแก้ทีละอัน
const validationErrors: string[] = [];

/** อ่านค่าที่ "ต้องมี" — ว่างไม่ได้ */
function requiredStr(key: string): string {
    const raw = (process.env[key] || '').trim();
    if (!raw) validationErrors.push(`❌ ${key} หายไป — กรุณาใส่ ${key} ใน .env`);
    return raw;
}

/** Discord Snowflake ID = ตัวเลขล้วน 17–20 หลัก */
function requiredSnowflake(key: string): string {
    const raw = requiredStr(key);
    if (raw && !/^\d{17,20}$/.test(raw)) {
        validationErrors.push(`❌ ${key} ไม่ใช่ Discord ID ที่ถูกต้อง (ต้องเป็นตัวเลข 17–20 หลัก) — ได้รับ: "${raw}"`);
    }
    return raw;
}

/** พอร์ตต้องเป็นจำนวนเต็ม 1–65535 ห้ามเป็น NaN เด็ดขาด */
function port(key: string, fallback: number): number {
    const raw = (process.env[key] || '').trim();
    if (!raw) return fallback;
    if (!/^\d+$/.test(raw)) {
        validationErrors.push(`❌ ${key} ต้องเป็นตัวเลขล้วน — ได้รับ: "${raw}"`);
        return fallback;
    }
    const n = Number(raw);
    if (n < 1 || n > 65535) {
        validationErrors.push(`❌ ${key} ต้องอยู่ระหว่าง 1–65535 — ได้รับ: ${n}`);
        return fallback;
    }
    return n;
}

/** URL ต้องขึ้นต้นด้วย http:// หรือ https:// และ parse ได้จริง */
function httpUrl(key: string, fallback: string): string {
    const raw = (process.env[key] || '').trim();
    if (!raw) return fallback;
    try {
        const u = new URL(raw);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol');
        return raw;
    } catch {
        validationErrors.push(`❌ ${key} ไม่ใช่ URL ที่ถูกต้อง (ต้องขึ้นต้นด้วย http:// หรือ https://) — ได้รับ: "${raw}"`);
        return fallback;
    }
}

/** ค่า true/false จาก .env — ไม่ใส่ = ใช้ค่า default */
function bool(key: string, fallback: boolean): boolean {
    const raw = (process.env[key] || '').trim().toLowerCase();
    if (!raw) return fallback;
    if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
    if (['0', 'false', 'no', 'off'].includes(raw)) return false;
    validationErrors.push(`❌ ${key} ต้องเป็น true หรือ false — ได้รับ: "${raw}"`);
    return fallback;
}

// ---- Env Config ----
const resolvedPort = port('PORT', 3000);

export const env = {
    botToken: requiredStr('BOT_TOKEN'),
    clientId: requiredSnowflake('CLIENT_ID'),
    guildId: requiredSnowflake('GUILD_ID'),
    port: resolvedPort,
    renderUrl: httpUrl('RENDER_EXTERNAL_URL', `http://localhost:${resolvedPort}`),
    /** เขียน log ลงไฟล์ด้วยไหม — บนโฮสต์ควรปิด แล้วให้แพลตฟอร์มเก็บ log จาก stdout แทน */
    logToFile: bool('LOG_TO_FILE', true),
    /**
     * รหัสผ่านของช่อง /logs ที่หน้าเว็บใช้มาขอ log
     *
     * ไม่ใส่ = ปิดช่องนี้ไปเลย (ปลอดภัยกว่าเปิดทิ้งไว้ให้ใครก็ขอได้)
     * log มีรหัส Discord ของกำลังพลอยู่ด้วย จึงไม่ใช่ของที่เปิดสาธารณะได้
     */
    logApiToken: (process.env.LOG_API_TOKEN || '').trim(),
};

// ---- Google Sheet IDs (same as original) ----
export const SHEETS = {
    CONFIG_SHEET_ID: '1TEAXp_nIblYgKMIl9-TmlwiLhjL19KCZAuf8N64spwI',
    CONFIG_SHEET_NAME: 'config',
    /**
     * แท็บเก็บ log ของบอท อยู่ไฟล์ Settings เดียวกับ config
     *
     * อยู่ไฟล์ตั้งค่า ไม่ใช่ไฟล์ข้อมูล (NamePD / ชีตนับเคส) เพราะ log โตขึ้นเรื่อย ๆ
     * ถ้าไปปนกับไฟล์ข้อมูล จะทำให้ไฟล์ที่ใช้งานจริงอืดและกินโควต้าช่องร่วมกัน
     *
     * ฝั่งเว็บเขียนลงแท็บ 'Log-Debug-web' ในไฟล์เดียวกัน — แยกแท็บกันคนละตัว
     * จะได้ไม่ต้องแย่งกันต่อท้ายแถว และเปิดดูแยกกันได้
     */
    LOG_SHEET_NAME: 'Log-Debug-Bot',
    /** แท็บ log ของฝั่งเว็บ — บอทไม่ได้เขียน แต่ช่วยไล่ลบแถวเก่าให้ เพราะเว็บไม่มีตัวตั้งเวลา */
    WEB_LOG_SHEET_NAME: 'Log-Debug-web',
};

// ---- Cache TTLs ----
export const CACHE = {
    SHEET_TTL: 5000,        // 5 seconds for sheet reads
    RATE_LIMITER_CLEANUP_INTERVAL_MS: 5 * 60 * 1000, // Cleanup rate limiter every 5 min
    COUNT_CLEANUP_INTERVAL_MS: 24 * 60 * 60 * 1000, // Cleanup message log every 24h
    /**
     * จำนวนโพสที่บอทจำได้ว่า "นับให้ใครไปแล้ว" — ใช้ตอนมีคนแก้แท็กหรือลบโพส
     *
     * เดิมตั้งไว้ 200 ซึ่งที่ปริมาณจริงราว 1,000 โพส/สัปดาห์ (~143 โพส/วัน)
     * แปลว่าบอทลืมโพสหลังผ่านไปแค่ราว 1 วัน แก้แท็กคดีเมื่อวานยอดก็เพี้ยนแล้ว
     * 2,000 ครอบคลุมราว 14 วัน ซึ่งยาวกว่ารอบตัดยอด 7 วันพอสมควร
     */
    MESSAGE_LOG_MAX_SIZE: 2000,
};

// ---- Count Config ----
export const COUNT = {
    /**
     * ใบที่อายุเกินเท่านี้แล้วยังมี event แก้ไขเข้ามา = ผิดปกติ → แจ้งเตือนไว้ใน log
     *
     * ไม่ได้ห้ามแก้ (บอทห้ามไม่ได้) และยอดยังอัปเดตตามความจริงเหมือนเดิม
     * มีไว้เฝ้าดูว่ากรอบเวลาที่คนแก้กันจริง ๆ เป็นเท่าไหร่ แล้วค่อยปรับเลขให้ตรง
     * ปรับได้จากชีตตั้งค่าด้วยคีย์ EDIT_ALERT_HOURS (0 = ปิดการแจ้งเตือน)
     */
    EDIT_ALERT_HOURS_DEFAULT: 2,
    /** สรุปสถิติการนับลง log ทุก ๆ เท่านี้ */
    SUMMARY_INTERVAL_MS: 60 * 60 * 1000,
    /** จำชื่อที่ถาม Discord มาได้นานเท่านี้ — กันถามซ้ำคนเดิมรัว ๆ ทุกข้อความ */
    NAME_CACHE_TTL_MS: 30 * 60 * 1000,
    /**
     * ถามแล้วไม่ได้ชื่อ ให้พักไว้เท่านี้ก่อนลองใหม่
     *
     * ต้องสั้น ๆ เพราะถ้าจำ "ผลที่ล้มเหลว" ไว้นาน เน็ตสะดุดครั้งเดียวจะทำให้ทุกคน
     * ในช่วงนั้นถูกบันทึกชื่อเป็นเลขไอดีไปหมด (บทเรียนจาก tagCache ของ BYPD)
     * แต่ก็ต้องมี ไม่งั้นบัญชีที่ถูกลบจะถูกยิงถาม Discord ซ้ำทุกข้อความ
     */
    NAME_MISS_TTL_MS: 2 * 60 * 1000,
};

// ---- Log Config ----
export const LOG = {
    MAX_FILE_BYTES: 5 * 1024 * 1024,  // ไฟล์ log โตได้ไม่เกิน 5 MB
    KEEP_ROTATED: 1,                  // เก็บไฟล์เก่าไว้ 1 รุ่น (app.log.1)

    /**
     * เก็บบรรทัดล่าสุดไว้ในหน่วยความจำกี่ชั่วโมง — ให้หน้าเว็บมาขอดูย้อนหลังได้
     * ที่ปริมาณจริง ~2,500–5,000 บรรทัด/วัน × ~113 ไบต์ = ไม่ถึง 1 MB ต่อ 24 ชม.
     */
    BUFFER_HOURS: 24,
    /** เพดานจำนวนบรรทัด — กันหน่วยความจำบวมถ้ามี error วนรัว ๆ */
    BUFFER_MAX_LINES: 20000,
    /** ตอบให้สูงสุดกี่บรรทัดต่อการขอหนึ่งครั้ง — กันดึงทีเดียวหนักเกิน */
    API_MAX_LINES: 2000,

    /**
     * รวบ log ที่สำคัญเขียนลงชีตทุก ๆ เท่านี้ — ห้ามเขียนทีละบรรทัด
     *
     * บอทกับเว็บใช้บัญชี Google ตัวเดียวกัน โควต้าเขียนจึงแชร์กัน (60 ครั้ง/นาที)
     * ถ้า log แย่งโควต้าไป การเขียนยอดนับจะเริ่มพลาด = ยอดหายอีกแบบหนึ่ง
     */
    SHEET_FLUSH_INTERVAL_MS: 60 * 1000,
    /** เขียนลงชีตครั้งละไม่เกินกี่แถว */
    SHEET_MAX_ROWS_PER_FLUSH: 200,
    /** คิวรอเขียนลงชีตได้ไม่เกินกี่แถว — เต็มแล้วทิ้งของเก่าสุด ไม่ให้บวมไม่หยุด */
    SHEET_QUEUE_MAX: 5000,
    /** ไล่ลบแถวเก่าในชีตทุก ๆ เท่านี้ */
    SHEET_CLEANUP_INTERVAL_MS: 60 * 60 * 1000,
    /**
     * เก็บ log ในชีตไว้กี่แถว — เกินกว่านี้ลบแถวบน (เก่าสุด) ทิ้ง
     *
     * นับเป็นจำนวนแถว ไม่ใช่จำนวนวัน เพราะอ่านง่ายกว่าและไม่ต้องแปลงเวลาในเซลล์เลย
     * ของเดิมนับเป็นวันจึงต้องอ่านเวลาจากเซลล์กลับมา ซึ่งถ้า Google แปลงรูปแบบเซลล์
     * การลบจะหยุดที่แถวนั้นแล้วไม่ลบอะไรอีกเลยแบบเงียบ ๆ (เคยเจอมาแล้วตอนสร้างระบบนี้)
     *
     * ของจริงที่ควรย้อนดูนาน ๆ อยู่ในหน่วยความจำบอท 24 ชม. ซึ่งละเอียดกว่าและไม่กินโควต้า
     */
    SHEET_MAX_ROWS: 100,
};

// ---- Bot Config ----
export const BOT = {
    MAX_RESTART_PER_DAY: 8,
    RESTART_RESET_INTERVAL_MS: 24 * 60 * 60 * 1000, // 24 hours
    WATCHDOG_TIMEOUT_MIN: 15,
    WATCHDOG_CHECK_INTERVAL_MS: 60000,
    SELF_PING_INTERVAL_MS: 7 * 60 * 1000,
    GRACEFUL_SHUTDOWN_TIMEOUT_MS: 3000, // Wait before force exit
    SHUTDOWN_FLUSH_TIMEOUT_MS: 5000,    // รอเขียนยอดที่ค้างลงชีตนานสุดเท่านี้ก่อนยอมปิด
    RESTART_DELAY_MS: 15000, // Delay before restart
};

export function validate(): string[] {
    // กุญแจ Google มาได้ 2 ทาง: GOOGLE_JSON_KEY ใน .env หรือไฟล์ credentials.json
    return [...validationErrors, ...checkCredentials()];
}
