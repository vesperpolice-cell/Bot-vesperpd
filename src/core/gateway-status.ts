import { Status, GatewayCloseCodes } from 'discord.js';

/**
 * ตัดสิน "การเชื่อมต่อ Discord" จากข้อมูลดิบ (สถานะ shard / close code)
 *
 * แยกออกมาเป็นฟังก์ชันบริสุทธิ์เพื่อให้เทสได้โดยไม่ต้องมี client จริง
 *
 * ทำไมไม่ใช้ client.isReady():
 * discord.js ตั้ง ws.status = Status.Ready ครั้งเดียวตอนต่อติดครั้งแรก
 * แล้วไม่เคยตั้งกลับเป็นค่าอื่นอีก แม้ shard จะหลุดหรือถูกปิดถาวรก็ยังคืน true
 * ถ้าเอาค่านั้นไปคุม watchdog กับ /health จะได้ไฟเขียวค้างทั้งที่บอทตายไปแล้ว
 */

/** shard นี้พร้อมรับ event จริงไหม */
export function shardIsReady(status: Status | number): boolean {
    return status === Status.Ready;
}

/**
 * ทุก shard พร้อมไหม
 *
 * shards ว่าง = ยังไม่เคยต่อติด (หรือ client ถูกทำลายไปแล้ว) ถือว่ายังไม่พร้อม
 */
export function allShardsReady(shards: ReadonlyArray<{ status: Status | number }>): boolean {
    return shards.length > 0 && shards.every(s => shardIsReady(s.status));
}

/** ชื่อของสถานะ shard ไว้ใส่ log/health (เช่น Ready, Connecting) แทนตัวเลข */
export function shardStatusName(status: Status | number): string {
    const name = (Status as unknown as Record<number, string | undefined>)[status];
    return name ?? 'UNKNOWN';
}

/**
 * close code ที่ Discord ไม่ยอมให้ต่อใหม่
 *
 * ต่ออีกกี่ครั้งก็ไม่ติด ต้องแก้ที่ต้นเหตุ (token / intents / shard config) แล้วสตาร์ทโปรเซสใหม่
 */
const UNRECOVERABLE_CLOSE_CODES = new Set<number>([
    GatewayCloseCodes.AuthenticationFailed, // 4004 token ผิด ถูกเปลี่ยน หรือถูกรีเซ็ต
    GatewayCloseCodes.InvalidShard,         // 4010 shard id ไม่ถูกต้อง
    GatewayCloseCodes.ShardingRequired,     // 4011 ต้องเปิด sharding
    GatewayCloseCodes.InvalidAPIVersion,    // 4012 gateway version ที่ขอไม่มีอยู่
    GatewayCloseCodes.InvalidIntents,       // 4013 intents ที่ส่งไปไม่ถูกต้อง
    GatewayCloseCodes.DisallowedIntents,    // 4014 intents ไม่ได้เปิดใน Developer Portal
]);

export function isUnrecoverableClose(code: number): boolean {
    return UNRECOVERABLE_CLOSE_CODES.has(code);
}

/** ชื่อของ close code ไว้ใส่ log — ไม่มีในตารางก็คืน UNKNOWN (เช่น 1006 เน็ตหลุด) */
export function closeCodeName(code: number): string {
    const name = (GatewayCloseCodes as unknown as Record<number, string | undefined>)[code];
    return name ?? 'UNKNOWN';
}

/**
 * error ตอน login ที่แก้ยังไงก็ไม่หาย ต้องไปแก้ที่ Developer Portal หรือ .env
 * ใช้แยกข้อความ log ให้คนอ่านรู้ว่าต้องทำอะไรต่อ ไม่ใช่ลองใหม่ไปเรื่อย ๆ
 */
export function isFatalLoginError(message: string): boolean {
    const m = message.toLowerCase();
    return m.includes('invalid token')
        || m.includes('privileged intent')
        || m.includes('disallowed intent');
}
