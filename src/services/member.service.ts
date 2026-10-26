import { Guild, GuildMember } from 'discord.js';

/** ป้ายของระบบที่คั่นกลางชื่อเล่น — รวมไว้ที่เดียว เปลี่ยนแบรนด์ทีหลังจะได้แก้จุดเดียว */
export const SYSTEM_TAG = '[VES-PD]';

/**
 * ชื่อนี้เป็น "ชื่อในระบบ" ของคนในหรือไม่ — รูปแบบ `รหัส [VES-PD] ชื่อ IC`
 *
 * ใช้ตัดสินว่าจะเอาชื่อเล่นนี้ไปอัปเดตช่องชื่อในชีตได้ไหม
 * คนนอกที่ตั้งชื่อเล่นอิสระจะไม่เข้าเงื่อนไข ชื่อเดิมในชีตจึงไม่ถูกแตะ
 */
export function isSystemNickname(name: string): boolean {
    const n = (name || '').trim();
    const at = n.indexOf(` ${SYSTEM_TAG} `);
    // ต้องมีรหัสนำหน้า และมีชื่อ IC ตามหลังป้ายจริง ๆ
    return at > 0 && n.length > at + SYSTEM_TAG.length + 2;
}

export function findMembersByCode(guild: Guild, codes: string[]): { found: GuildMember[]; notFound: string[] } {
    const found: GuildMember[] = [];
    const notFound: string[] = [];
    for (const code of codes) {
        const prefix = `${code} ${SYSTEM_TAG}`;
        const matches = guild.members.cache.filter(m => (m.nickname || '').startsWith(prefix));
        if (matches.size > 0) {
            for (const [, m] of matches) {
                if (!found.some(f => f.id === m.id)) found.push(m);
            }
        } else {
            notFound.push(code);
        }
    }
    return { found, notFound };
}

export function truncateNickname(fullName: string, maxLen = 32): string {
    if (fullName.length <= maxLen) return fullName;
    const prefixMatch = fullName.match(/^(.+? \[VES-PD\] )/);
    if (prefixMatch) {
        const prefix = prefixMatch[1];
        const icPart = fullName.slice(prefix.length);
        const available = maxLen - prefix.length;
        if (available > 0) return prefix + icPart.slice(0, available);
    }
    return fullName.slice(0, maxLen);
}

export function makeFullName(codeNumber: string, icName: string): string {
    return `${codeNumber} ${SYSTEM_TAG} ${icName}`;
}