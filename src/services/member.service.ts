import { Guild, GuildMember } from 'discord.js';

export function findMembersByCode(guild: Guild, codes: string[]): { found: GuildMember[]; notFound: string[] } {
    const found: GuildMember[] = [];
    const notFound: string[] = [];
    for (const code of codes) {
        const prefix = `${code} [VES-PD]`;
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
    return `${codeNumber} [VES-PD] ${icName}`;
}