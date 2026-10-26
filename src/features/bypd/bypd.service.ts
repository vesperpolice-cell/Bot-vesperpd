import { EmbedBuilder, Message, Guild, GuildTextBasedChannel } from 'discord.js';
import type { APIEmbed } from 'discord.js';
import { configService } from '../../core/config.service';
import { logger } from '../../core/logger';
import { locks } from '../../core/lock.service';
import { sleep } from '../../services/utils';
import { createRecentSet } from '../../services/recent-set';
import { SYSTEM_TAG } from '../../services/member.service';
import { markProcessed } from '../../services/reactions';
import { hasBypdInEmbed, hasPdInEmbed, hasBypdOrPdInMessage, hasCarryInMessage, hasTake2InMessage } from './bypd.utils';

/** กัน process message ซ้ำ (message.id เดียว) ภายใน 60 วินาที */
const recentMessages = createRecentSet(60000);

/** Tag cache: key = รหัส (เลข 2-3 หลัก), TTL 60 วิ */
const tagCache = new Map<string, { tag: string; expires: number }>();

/** Queue: ส่งทีละ 1 รายงาน BYPD ป้องกัน Discord rate limit */
async function sendWithQueue(ch: GuildTextBasedChannel, guild: Guild, content: string): Promise<boolean> {
    return locks.bypdSend.run(async () => {
        try {
            await sendBypdReport(ch, guild, content);
            return true;
        } catch (err: unknown) {
            logger.error('BYPD', `ส่งรายงานล้มเหลว: ${err instanceof Error ? err.message : String(err)}`);
            return false;
        }
    });
}

/** Queue: ส่งทีละ 1 รายงาน Carry ป้องกัน Discord rate limit */
async function sendWithCarryQueue(ch: GuildTextBasedChannel, guild: Guild, content: string): Promise<boolean> {
    return locks.carrySend.run(async () => {
        try {
            await sendCarryReport(ch, guild, content);
            return true;
        } catch (err: unknown) {
            logger.error('BYPD', `ส่งรายงาน Carry ล้มเหลว: ${err instanceof Error ? err.message : String(err)}`);
            return false;
        }
    });
}

/** Queue: ส่งทีละ 1 รายงาน TAKE2 ป้องกัน Discord rate limit */
async function sendWithTake2Queue(ch: GuildTextBasedChannel, guild: Guild, content: string): Promise<boolean> {
    return locks.take2Send.run(async () => {
        try {
            await sendTake2Report(ch, guild, content);
            return true;
        } catch (err: unknown) {
            logger.error('BYPD', `ส่งรายงาน TAKE2 ล้มเหลว: ${err instanceof Error ? err.message : String(err)}`);
            return false;
        }
    });
}

/** ดึงข้อความจาก embed เดียว */
function extractEmbedContent(embed: APIEmbed): string {
    const texts: string[] = [];
    if (embed.title) texts.push(embed.title);
    if (embed.description) texts.push(embed.description);
    embed.fields?.forEach((f) => { if (f.name) texts.push(f.name); if (f.value) texts.push(f.value); });
    if (embed.footer?.text) texts.push(embed.footer.text);
    return texts.join('\n');
}

async function resolveTags(guild: Guild, content: string): Promise<string[]> {
    const tags: string[] = [];
    const now = Date.now();

    // 1. ดึงรหัส BYPD ก่อน
    const bypdMatch = content.match(/(?:BYPD)\s+((?:\d{2,3}\s*)+)/i);
    const bypdCodes = bypdMatch ? bypdMatch[1].trim().split(/\s+/) : [];

    // 2. ดึงรหัส PD
    const pdMatch = content.match(/(?:PD)\s+((?:\d{2,3}\s*)+)/i);
    const pdCodes = pdMatch ? pdMatch[1].trim().split(/\s+/) : [];

    // รวม BYPD ก่อน แล้วค่อย PD (ตัดรหัสซ้ำด้วย Set)
    const allCodes = [...new Set([...bypdCodes, ...pdCodes])];

    const resolveOne = async (code: string): Promise<string> => {
        const prefix = `${code} ${SYSTEM_TAG}`;

        // 1. เช็ค cache ก่อน
        const cached = tagCache.get(code);
        if (cached && now < cached.expires) return cached.tag;

        // 2. หาจาก members.cache
        let m = guild.members.cache.find((mm) => (mm.nickname || '').startsWith(prefix));

        // 3. ถ้าไม่เจอ → เรียก API
        if (!m) {
            try {
                const f = await guild.members.fetch({ query: code, limit: 10 });
                m = f.find((mm) => (mm.nickname || '').startsWith(prefix));
            } catch (e) { logger.warn('BYPD', String(e)); }
        }

        const tag = m ? `<@${m.user.id}>` : `@${code}`;
        tagCache.set(code, { tag, expires: now + 60000 });
        return tag;
    };

    for (const code of allCodes) {
        tags.push(await resolveOne(code));
    }
    return tags;
}

/** Discord ปฏิเสธกล่องรายงานทั้งใบถ้ามีช่องไหนว่างเปล่า และจำกัดช่องละ 1024 ตัวอักษร */
const EMBED_FIELD_MAX = 1024;

/**
 * ใส่ค่าลงช่อง — ถ้าค่าที่อ่านได้เป็นค่าว่าง ให้คง '-' ที่ตั้งไว้ตอนแรก
 *
 * ของเดิมทับค่าเริ่มต้นทุกครั้งแม้อ่านได้ค่าว่าง (เช่นบรรทัด "คดี :" ที่ไม่มีอะไรตามหลัง)
 * พอมีช่องว่าง Discord ปฏิเสธทั้งกล่อง → รายงานใบนั้นไม่ถูกส่งเลย และไม่ติด ✅
 * ทำให้กดส่งย้อนหลังกี่ครั้งก็พลาดซ้ำแบบเดิม คดีนั้นส่งไม่ได้ตลอดกาล
 */
function setField(target: Record<string, string>, key: string, value: string | undefined): void {
    const v = (value ?? '').trim();
    if (!v) return;
    target[key] = v.length > EMBED_FIELD_MAX ? `${v.slice(0, EMBED_FIELD_MAX - 1)}…` : v;
}

export function parseDetails(content: string): Record<string, string> {
    const lines = content.split('\n');
    const r: Record<string, string> = { officer: '-', offender: '-', caseInfo: '-', jail: '-', fine: '-', time: '-' };
    for (const raw of lines) {
        const l = raw.replace(/\*\*/g, '').trim(); if (!l) continue;
        if (l.includes('ผู้ต้องหา')) { const m = l.match(/ผู้ต้องหา\s+(.+?)(?:\s+ถูกจับโดย|$)/); if (m) setField(r, 'offender', m[1]); }
        if (l.includes('เจ้าหน้าที่')) { const m = l.match(/เจ้าหน้าที่\s+(.+)/); if (m) setField(r, 'officer', m[1]); }
        if (l.includes('คดี :')) setField(r, 'caseInfo', l.split('คดี :')[1]);
        if (l.includes('จำคุก :')) setField(r, 'jail', l.split('จำคุก :')[1]);
        if (l.includes('ค่าปรับ :')) setField(r, 'fine', l.split('ค่าปรับ :')[1]);
        if (l.includes('/') && l.includes(':')) { const t = l.match(/\d{2}\/\d{2}\/\d{4}\s*-\s*\d{2}:\d{2}:\d{2}/); if (t) setField(r, 'time', t[0]); }
    }
    return r;
}

/** ส่ง report BYPD หนึ่งคดี (1 embed หรือ 1 content) */
async function sendBypdReport(ch: GuildTextBasedChannel, guild: Guild, content: string): Promise<void> {
    const tags = await resolveTags(guild, content);
    const det = parseDetails(content);
    await ch.send({
        content: tags.join(' ') || '-',
        embeds: [new EmbedBuilder()
            .setTitle('📋 รายงานคดี BYPD')
            .setColor(0x3b82f6)
            .addFields(
                { name: '👮 เจ้าหน้าที่', value: det.officer, inline: true },
                { name: '🔴 ผู้ต้องหา', value: det.offender, inline: true },
                { name: '📁 คดี', value: det.caseInfo, inline: false },
                { name: '🔒 จำคุก', value: det.jail, inline: true },
                { name: '💰 ค่าปรับ', value: det.fine, inline: true },
                { name: '🕐 เวลา', value: det.time, inline: true }
            )
            .setTimestamp()
        ]
    });
}

/** ส่ง report Carry หนึ่งคดี (1 embed หรือ 1 content) */
async function sendCarryReport(ch: GuildTextBasedChannel, guild: Guild, content: string): Promise<void> {
    const tags = await resolveTags(guild, content);
    const det = parseDetails(content);
    await ch.send({
        content: tags.join(' ') || '-',
        embeds: [new EmbedBuilder()
            .setTitle('📋 รายงานคดีอุ้มห่อ')
            .setColor(0xf59e0b)
            .addFields(
                { name: '👮 เจ้าหน้าที่', value: det.officer, inline: true },
                { name: '🔴 ผู้ต้องหา', value: det.offender, inline: true },
                { name: '📁 คดี', value: det.caseInfo, inline: false },
                { name: '🔒 จำคุก', value: det.jail, inline: true },
                { name: '💰 ค่าปรับ', value: det.fine, inline: true },
                { name: '🕐 เวลา', value: det.time, inline: true }
            )
            .setTimestamp()
        ]
    });
}

/** ส่ง report TAKE2 แบบ Embed */
async function sendTake2Report(ch: GuildTextBasedChannel, guild: Guild, content: string): Promise<void> {
    const tags = await resolveTags(guild, content);
    const det = parseDetails(content);
    const embedText = [
        '**รายงานการใช้งาน Take2**',
        `เจ้าหน้าที่ : ${det.officer}`,
        `ผู้ต้องหา : ${det.offender}`,
        content.includes('ใช้งาน Take2') ? 'ผู้ต้องหาได้ใช้งาน Take2' : '',
        `เวลา ${det.time}`,
    ].filter(line => line.trim() !== '').join('\n');
    await ch.send({
        content: tags.join(' ') || '-',
        embeds: [new EmbedBuilder()
            .setColor(0x8b5cf6)
            .setDescription(embedText)
            .setTimestamp()
        ]
    });
}

export async function processBypd(message: Message): Promise<boolean> {
    // ป้องกัน process message ID ซ้ำ
    if (recentMessages.seenRecently(message.id)) return false;

    const guild = message.guild; if (!guild) return false;

    // ตรวจว่ามีคำว่า "TAKE2" หรือไม่ (ลำดับแรก)
    const isTake2 = hasTake2InMessage(message);
    // ตรวจว่ามีคำว่า "อุ้มห่อ" หรือไม่
    const isCarry = !isTake2 && hasCarryInMessage(message);

    let chId: string;
    if (isTake2) {
        chId = configService.getTake2SendChannelId();
    } else if (isCarry) {
        chId = configService.getCarrySendChannelId();
    } else {
        chId = configService.getBypdSendChannelId();
    }
    const ch = guild.channels.cache.get(chId);
    if (!ch || !ch.isTextBased()) return false;

    let count = 0;

    // 1. เช็ค message.content
    if (message.content?.trim() && hasBypdOrPdInMessage(message)) {
        let ok: boolean;
        if (isTake2) {
            ok = await sendWithTake2Queue(ch as GuildTextBasedChannel, guild, message.content.trim());
        } else if (isCarry) {
            ok = await sendWithCarryQueue(ch as GuildTextBasedChannel, guild, message.content.trim());
        } else {
            ok = await sendWithQueue(ch as GuildTextBasedChannel, guild, message.content.trim());
        }
        if (ok) count++;
        await sleep(1000);
    }

    // 2. วนลูปทุก embed (1 embed = 1 คดี)
    for (const embed of message.embeds) {
        const embedJson = embed.toJSON();
        if (hasBypdInEmbed(embedJson) || hasPdInEmbed(embedJson)) {
            let ok: boolean;
            if (isTake2) {
                ok = await sendWithTake2Queue(ch as GuildTextBasedChannel, guild, extractEmbedContent(embedJson));
            } else if (isCarry) {
                ok = await sendWithCarryQueue(ch as GuildTextBasedChannel, guild, extractEmbedContent(embedJson));
            } else {
                ok = await sendWithQueue(ch as GuildTextBasedChannel, guild, extractEmbedContent(embedJson));
            }
            if (ok) count++;
            await sleep(1000);
        }
    }

    if (count > 0) {
        // ✅ reaction แรก = บอกว่าระบบ process แล้ว (สำหรับระบบส่งย้อนหลัง)
        // อิโมจิที่ 2 = บอกจำนวนคดี (ถ้ามากกว่า 1)
        await markProcessed(message, count, 'BYPD');
        let logType = '';
        if (isTake2) logType = ' (TAKE2)';
        else if (isCarry) logType = ' (อุ้มห่อ)';
        logger.info('BYPD', `ส่ง ${count} คดี${logType} จากข้อความ ${message.id}`);
    }
    return count > 0;
}