import { EmbedBuilder, Message, Guild, GuildTextBasedChannel } from 'discord.js';
import type { APIEmbed } from 'discord.js';
import { configService } from '../../core/config.service';
import { logger } from '../../core/logger';
import { locks } from '../../core/lock.service';
import { sleep } from '../../services/utils';
import { createRecentSet } from '../../services/recent-set';
import { firstMentionId } from '../../services/mentions';

/** กัน process message ซ้ำ (message.id เดียว) ภายใน 60 วินาที */
const recentMessages = createRecentSet(60000);

async function sendWithQueue(ch: GuildTextBasedChannel, guild: Guild, embed: APIEmbed): Promise<boolean> {
    return locks.proctorSend.run(async () => {
        try {
            await sendProctorReport(ch, guild, embed);
            return true;
        } catch (err: unknown) {
            logger.error('PROCTOR', `ส่งรายงานล้มเหลว: ${err instanceof Error ? err.message : String(err)}`);
            return false;
        }
    });
}

function getFieldValue(embed: APIEmbed, nameContains: string): string {
    const field = embed.fields?.find((f) => f.name.includes(nameContains));
    return field ? field.value.replace(/\*\*/g, '').trim() : '-';
}

async function sendProctorReport(ch: GuildTextBasedChannel, guild: Guild, embed: APIEmbed): Promise<void> {
    // อ่านค่าจาก embed fields โดยตรง (name + value อยู่ใน field เดียวกัน)
    const proctorRaw = getFieldValue(embed, 'ผู้คุมสอบ');
    const applicant = getFieldValue(embed, 'ผู้สอบ');
    const date = getFieldValue(embed, 'วันที่สอบ');
    const discordIdRaw = getFieldValue(embed, 'Discord ID ผู้สอบ');

    // Resolve proctor mention
    const proctorId = firstMentionId(proctorRaw);
    let proctorVal = proctorRaw;
    if (proctorId) {
        const member = guild.members.cache.get(proctorId) || await guild.members.fetch(proctorId).catch(() => null);
        proctorVal = member ? `<@${member.user.id}>` : proctorRaw;
    }

    // Resolve applicant Discord ID
    const applicantId = firstMentionId(discordIdRaw);
    let applicantVal = discordIdRaw;
    if (applicantId) {
        const member = guild.members.cache.get(applicantId) || await guild.members.fetch(applicantId).catch(() => null);
        applicantVal = member ? `<@${member.user.id}>` : discordIdRaw;
    }

    await ch.send({
        content: proctorVal,
        embeds: [new EmbedBuilder()
            .setTitle('📋 บันทึกการคุมสอบ Proctor')
            .setColor(0x1DC9B7)
            .addFields(
                { name: '👮 ผู้คุมสอบ', value: proctorVal, inline: false },
                { name: '👤 ผู้สอบ', value: applicant, inline: true },
                { name: '📅 วันที่สอบ', value: date, inline: true },
                { name: '🆔 Discord ID ผู้สอบ', value: applicantVal, inline: false }
            )
            .setTimestamp()
        ]
    });
}

export async function processProctor(message: Message): Promise<boolean> {
    if (recentMessages.seenRecently(message.id)) return false;

    const guild = message.guild;
    if (!guild) return false;

    const chId = configService.getProctorSendChannelId();
    if (!chId) return false;

    const ch = guild.channels.cache.get(chId);
    if (!ch || !ch.isTextBased()) return false;

    let count = 0;

    // Process only embeds (Proctor data comes via webhook embed)
    for (const embed of message.embeds) {
        const embedJson = embed.toJSON();
        const title = embedJson.title || '';
        const fieldsText = embedJson.fields?.map((f) => `${f.name} ${f.value}`).join(' ') || '';
        if (title.toUpperCase().includes('PROCTOR') || fieldsText.toUpperCase().includes('PROCTOR')) {
            const ok = await sendWithQueue(ch as GuildTextBasedChannel, guild, embedJson);
            if (ok) count++;
            await sleep(1000);
        }
    }

    if (count > 0) {
        try { await message.react('✅'); } catch (e) { logger.warn('PROCTOR', String(e)); }
        if (count > 1) {
            const emojiMap: Record<number, string> = {
                2: '2️⃣', 3: '3️⃣', 4: '4️⃣', 5: '5️⃣',
                6: '6️⃣', 7: '7️⃣', 8: '8️⃣', 9: '9️⃣', 10: '🔟',
            };
            const emoji = emojiMap[count];
            if (emoji) {
                try { await message.react(emoji); } catch (e) { logger.warn('PROCTOR', String(e)); }
            }
        }
        logger.info('PROCTOR', `ส่ง ${count} รายการ จากข้อความ ${message.id}`);
    }

    return count > 0;
}