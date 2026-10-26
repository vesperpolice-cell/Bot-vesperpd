import { Guild } from 'discord.js';
import { COUNT } from '../config';

/**
 * ชื่อคนหนึ่งคนที่หามาได้ พร้อมบอกว่าได้มาจากไหน
 *
 * hasGuildNickname สำคัญกว่าที่คิด: ตัวชื่อ (nickname) เป็น string เฉย ๆ
 * ดูจากค่าไม่ออกว่าเป็น "ชื่อเล่นที่ตั้งในเซิร์ฟ" หรือเป็นชื่อบัญชีที่ fallback มา
 * ฝั่งที่เขียนชีตต้องแยกให้ออก ไม่งั้นจะเผลอเอาชื่อบัญชีไปทับชื่อเล่นดี ๆ ที่มีอยู่แล้ว
 */
export interface ResolvedName {
    nickname: string;
    username: string;
    /** true เฉพาะเมื่อชื่อนี้คือชื่อเล่นที่ถูกตั้งไว้ในเซิร์ฟเวอร์จริง ๆ */
    hasGuildNickname: boolean;
}

/** หาชื่อไม่ได้เลย — ตัวเรียกต้องนับยอดให้อยู่ดี ห้ามทิ้งยอดเพราะไม่รู้ชื่อ */
export const UNKNOWN_NAME: ResolvedName = { nickname: '', username: '', hasGuildNickname: false };

/** ที่มาของชื่อ 3 ทาง เรียงจากถูกสุดไปแพงสุด */
export interface NameSource {
    /** 1) สมุดรายชื่อในเครื่อง — ฟรี ทันที แต่พร่องได้ */
    local(id: string): ResolvedName | null;
    /** 2) ถาม Discord เรื่องสมาชิกในเซิร์ฟ — ได้ชื่อเล่นที่มีรหัสหน้าชื่อ */
    member(id: string): Promise<ResolvedName | null>;
    /** 3) ถาม Discord เรื่องบัญชีผู้ใช้ — ใช้ได้แม้คนนั้นออกจากเซิร์ฟไปแล้ว */
    user(id: string): Promise<ResolvedName | null>;
}

/**
 * ไล่หาชื่อจากเลขไอดี: สมุดในเครื่อง → ถาม Discord เรื่องสมาชิก → ถาม Discord เรื่องบัญชี
 *
 * ปุ่ม "นับข้อความเก่า" ถาม Discord ตรง ๆ อยู่แล้ว แต่การนับสดเดิมดูแค่สมุดในเครื่อง
 * ทำให้สองทางได้ชื่อไม่เท่ากัน — ตรงนี้ทำให้เหมือนกัน
 *
 * หาไม่ได้ทั้ง 3 ทางก็คืนค่าว่าง แล้วไปใส่เลขไอดีไว้ในช่องชื่อ (ดู ensureUserRow)
 * สิ่งที่ห้ามเกิดคือ "ไม่รู้ชื่อแล้วไม่นับยอด"
 */
export async function resolveName(src: NameSource, id: string): Promise<ResolvedName> {
    const fromLocal = src.local(id);
    if (fromLocal) return fromLocal;
    const fromMember = await src.member(id);
    if (fromMember) return fromMember;
    const fromUser = await src.user(id);
    if (fromUser) return fromUser;
    return UNKNOWN_NAME;
}

/** จำชื่อที่หามาได้ไว้ชั่วคราว — value = null คือเคยถามแล้วไม่ได้ */
const nameCache = new Map<string, { value: ResolvedName | null; expires: number }>();

/** เพดานจำนวนรายชื่อที่จำไว้ — กันหน่วยความจำบวมไม่หยุดในเซิร์ฟใหญ่ */
const NAME_CACHE_MAX = 10000;

export function displayNameOf(m: { nickname: string | null; displayName: string; user: { username: string } }): ResolvedName {
    const nick = (m.nickname || '').trim();
    return {
        nickname: nick || (m.displayName || m.user.username).trim(),
        username: m.user.username,
        hasGuildNickname: Boolean(nick),
    };
}

export function nameSourceFor(guild: Guild): NameSource {
    return {
        local: (id) => {
            const m = guild.members.cache.get(id);
            return m ? displayNameOf(m) : null;
        },
        member: async (id) => {
            const m = await guild.members.fetch(id).catch(() => null);
            return m ? displayNameOf(m) : null;
        },
        user: async (id) => {
            const u = await guild.client.users.fetch(id).catch(() => null);
            // ชื่อบัญชี Discord ไม่ใช่ชื่อเล่นในเซิร์ฟ — ห้ามเอาไปทับชื่อในชีต
            return u ? { nickname: u.username.trim(), username: u.username, hasGuildNickname: false } : null;
        },
    };
}

/** หาชื่อพร้อมจำผลไว้ กันถามซ้ำคนเดิมทุกข้อความ */
export async function lookupName(guild: Guild, id: string): Promise<ResolvedName> {
    const hit = nameCache.get(id);
    if (hit && Date.now() < hit.expires) return hit.value ?? UNKNOWN_NAME;

    const found = await resolveName(nameSourceFor(guild), id);
    const ok = Boolean(found.nickname || found.username);
    // กัน cache โตเกินเพดาน — ไล่ทิ้งของหมดอายุก่อน ถ้ายังเกินก็ทิ้งของเก่าสุด
    if (nameCache.size >= NAME_CACHE_MAX) {
        pruneNameCache();
        if (nameCache.size >= NAME_CACHE_MAX) {
            const oldest = nameCache.keys().next().value;
            if (oldest !== undefined) nameCache.delete(oldest);
        }
    }
    nameCache.set(id, {
        value: ok ? found : null,
        expires: Date.now() + (ok ? COUNT.NAME_CACHE_TTL_MS : COUNT.NAME_MISS_TTL_MS),
    });
    return found;
}

/**
 * ลืมชื่อที่จำไว้ของคนนี้ — ใช้ตอนรู้แน่ว่าชื่อเล่นเปลี่ยนแล้ว
 *
 * ไม่ทำแบบนี้ก็ต้องรอ cache หมดอายุ (30 นาที) ชื่อในชีตจึงจะตามความจริง
 * ส่วนการลด TTL ลงทั้งระบบไม่ใช่คำตอบ เพราะจะกลายเป็นถาม Discord ซ้ำ ๆ โดยไม่มีเหตุ
 */
export function forgetName(id: string): void {
    nameCache.delete(id);
}

/** เก็บกวาดชื่อที่หมดอายุ ไม่ให้ค้างในหน่วยความจำไปเรื่อย ๆ */
export function pruneNameCache(): void {
    const now = Date.now();
    for (const [id, entry] of nameCache) if (now >= entry.expires) nameCache.delete(id);
}
