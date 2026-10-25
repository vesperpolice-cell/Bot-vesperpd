/**
 * ตัวนับ "พยายามเชื่อมต่อ Discord แล้วไม่สำเร็จ" — เก็บลงดิสก์เพื่อให้รอดจากการรีสตาร์ท
 *
 * ทำไมต้องมี: Discord ตอบ 429 ได้ง่ายมากเมื่อถูกยิงซ้ำ ๆ จาก IP เดียวกัน (โฮสต์ฟรีใช้ IP ร่วมกับ
 * service อื่นอีกหลายสิบตัว) และ discord.js แปล 429 เป็น "รอแล้วลองใหม่" แบบไม่จำกัดจำนวนครั้ง
 * ไม่ throw — ดู node_modules/@discordjs/rest/src/lib/handlers/SequentialHandler.ts (branch 429
 * เรียก runRequest ซ้ำโดยไม่ ++retries) ถ้าปล่อยให้โฮสต์รีสตาร์ทวนไปเรื่อย ๆ ก็ยิ่งทุบประตู Discord
 * ถี่ขึ้นเรื่อย ๆ จนหน้าต่างลิมิตยาวขึ้น
 *
 * ตัวนับจึงต้องอยู่บนดิสก์ ไม่ใช่ในหน่วยความจำ — โปรเซสตายแล้วเริ่มใหม่จะได้ไม่นับจาก 0
 * ใช้ path จากผู้เรียก (ไม่ hardcode) เพื่อให้เทสได้ด้วยโฟลเดอร์ชั่วคราว
 */
import fs from 'fs';
import path from 'path';

/** เพดานการพยายาม — ครบแล้วหยุดยิง Discord จนกว่าจะมีคนแก้ต้นเหตุแล้วรีสตาร์ท/deploy ใหม่ */
export const MAX_LOGIN_ATTEMPTS = 2;

export interface LoginAttemptsState {
    attempts: number;
    /** HTTP status ของคำขอล่าสุด (null = ติดต่อไม่ได้เลย) */
    lastStatus: number | null;
    lastError: string | null;
    lastAt: string | null;
}

export interface RecordResult {
    state: LoginAttemptsState;
    /** false = เขียนลงดิสก์ไม่ได้ → ผู้เรียกต้องหยุดทันที ไม่งั้นรีสตาร์ทแล้วจะนับใหม่จาก 0 */
    persisted: boolean;
}

function emptyState(): LoginAttemptsState {
    return { attempts: 0, lastStatus: null, lastError: null, lastAt: null };
}

/** ที่อยู่ไฟล์ตัวนับภายในโฟลเดอร์ที่กำหนด */
export function fileFor(dir: string): string {
    return path.join(dir, 'login-attempts.json');
}

/** อ่านสถานะเดิม — ไฟล์หาย/พัง/ค่าไม่ถูกต้อง ถือว่าเริ่มนับใหม่ (ไม่ throw) */
export function readLoginAttempts(file: string): LoginAttemptsState {
    try {
        const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!raw || typeof raw !== 'object') return emptyState();
        const obj = raw as Record<string, unknown>;
        const attempts = Number(obj.attempts);
        return {
            attempts: Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 0,
            lastStatus: typeof obj.lastStatus === 'number' ? obj.lastStatus : null,
            lastError: typeof obj.lastError === 'string' ? obj.lastError : null,
            lastAt: typeof obj.lastAt === 'string' ? obj.lastAt : null,
        };
    } catch {
        return emptyState();
    }
}

/** ครบเพดานแล้วหรือยัง — true = ห้ามพยายามเชื่อมต่ออีก */
export function isLockedOut(state: LoginAttemptsState): boolean {
    return state.attempts >= MAX_LOGIN_ATTEMPTS;
}

/** บันทึกความล้มเหลวหนึ่งครั้ง (อ่านค่าเดิม + 1) แล้วเขียนลงดิสก์ */
export function recordLoginFailure(
    file: string,
    status: number | null,
    error: string,
    now: Date = new Date(),
): RecordResult {
    const prev = readLoginAttempts(file);
    const state: LoginAttemptsState = {
        attempts: prev.attempts + 1,
        lastStatus: status,
        lastError: error.slice(0, 300),
        lastAt: now.toISOString(),
    };
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(state), 'utf8');
        return { state, persisted: true };
    } catch {
        // ดิสก์อ่านอย่างเดียว/เต็ม — ยังคืน state ให้ผู้เรียกรู้ว่าล้มเหลว แต่บอกว่าเก็บไม่ได้
        return { state, persisted: false };
    }
}

/** ต่อติดแล้ว — ล้างตัวนับทิ้ง */
export function clearLoginAttempts(file: string): void {
    try {
        fs.rmSync(file, { force: true });
    } catch {
        // ลบไม่ได้ก็ไม่เป็นไร รอบหน้าจะเขียนทับด้วยค่าใหม่
    }
}
