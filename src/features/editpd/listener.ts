import { Client, Events, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, MessageFlags, EmbedBuilder, ChatInputCommandInteraction, ModalSubmitInteraction } from 'discord.js';
import { configService } from '../../core/config.service';
import { findMemberByDiscordId, updateMemberName, updateMemberPhone } from '../welcome/welcome.service';
import { truncateNickname, makeFullName } from '../../services/member.service';
import { logger } from '../../core/logger';
import { silentCatch } from '../../services/utils';

export function setupEditPdFeature(client: Client): void {
    client.on(Events.InteractionCreate, async (i) => {
        if (i.isChatInputCommand() && i.commandName === 'editpd') {
            const cmd = i as ChatInputCommandInteraction<'cached'>;
            await cmd.showModal(
                new ModalBuilder().setCustomId('modal_edit_pd').setTitle('📝 แก้ไขโปรไฟล์ตำรวจ')
                    .addComponents(
                        new ActionRowBuilder<TextInputBuilder>().addComponents(
                            new TextInputBuilder().setCustomId('input_ic_name').setLabel('ชื่อ IC ใหม่').setStyle(TextInputStyle.Short).setPlaceholder('กรุณากรอกชื่อ IC ใหม่ (ถ้าไม่เปลี่ยนปล่อยว่าง)').setRequired(false).setMaxLength(100),
                        ),
                    )
                    .addComponents(
                        new ActionRowBuilder<TextInputBuilder>().addComponents(
                            new TextInputBuilder().setCustomId('input_ic_phone').setLabel('เบอร์โทร IC ใหม่').setStyle(TextInputStyle.Short).setPlaceholder('กรุณากรอกเบอร์โทรใหม่ (ถ้าไม่เปลี่ยนปล่อยว่าง)').setRequired(false).setMaxLength(20),
                        ),
                    )
                    .addComponents(
                        new ActionRowBuilder<TextInputBuilder>().addComponents(
                            new TextInputBuilder().setCustomId('input_ooc_age').setLabel('อายุ OOC ใหม่').setStyle(TextInputStyle.Short).setPlaceholder('กรุณากรอกอายุใหม่ (ถ้าไม่เปลี่ยนปล่อยว่าง)').setRequired(false).setMaxLength(3),
                        ),
                    ),
            ).catch(silentCatch('EditPD'));
            return;
        }
        if (i.isModalSubmit() && i.customId === 'modal_edit_pd') {
            const modal = i as ModalSubmitInteraction<'cached'>;
            await modal.deferReply({ flags: MessageFlags.Ephemeral });
            try {
                const newName = modal.fields.getTextInputValue('input_ic_name').trim();
                const newPhone = modal.fields.getTextInputValue('input_ic_phone').trim();
                const newAge = modal.fields.getTextInputValue('input_ooc_age').trim();
                const uid = modal.user.id;
                const changed: string[] = [];
                // ค้นหา embed ใน Log Channel (ทางเลือก — ถ้าไม่มี Log channel หรือไม่เจอ embed ก็ไม่ error)
                const logChId = configService.getLogChannelId();
                let embedMsg: import('discord.js').Message | null = null;
                if (logChId) {
                    const logCh = modal.guild.channels.cache.get(logChId);
                    if (logCh && logCh.isTextBased()) {
                        const msgs = await logCh.messages.fetch({ limit: 100 });
                        for (const msg of msgs.values()) {
                            if (msg.embeds.length > 0) {
                                const f = msg.embeds[0].fields?.find((x: { name: string; value: string }) => x.name.includes('Discord ID'));
                                if (f && f.value.replace(/`/g, '').trim() === uid) embedMsg = msg;
                            }
                        }
                    }
                }
                // ค้นหาใน NamePD ก่อนเสมอ (รองรับการกรอกแค่ชื่อหรือแค่เบอร์)
                let info: { row: number; codeNumber: string; currentName: string } | null = null;
                if (newName || newPhone) {
                    info = await findMemberByDiscordId(uid);
                }

                // ไม่เจอชื่อในชีต = เขียนอะไรลงชีตไม่ได้เลย ต้องบอกตรง ๆ
                // ของเดิมข้ามการเขียนไปเงียบ ๆ แล้วยังตอบว่า "อัปเดตสำเร็จ"
                if ((newName || newPhone) && !info) {
                    await modal.editReply({
                        content: '❌ ไม่พบชื่อคุณในชีตลงทะเบียน จึงยังแก้ไขให้ไม่ได้\nกรุณาติดต่อ Admin เพื่อตรวจสอบข้อมูลในระบบ',
                    });
                    return;
                }

                // แก้ชื่อลง NamePD + Nickname
                if (newName && info) {
                    const full = makeFullName(info.codeNumber, newName);
                    await updateMemberName(info.row, full);
                    try { await modal.member.setNickname(truncateNickname(full)); } catch (e) { logger.warn('EditPD', String(e)); }
                    changed.push(`ชื่อ IC → **${newName}**`);
                }

                // แก้เบอร์โทรลง NamePD คอลัมน์ B
                if (newPhone && info) {
                    await updateMemberPhone(info.row, newPhone);
                    changed.push(`เบอร์โทร → **${newPhone}**`);
                }

                // อายุเก็บไว้ในกล่องข้อความ Discord อย่างเดียว ไม่ได้ลงชีต — บอกให้ตรงตามจริง
                if (newAge) {
                    changed.push(`อายุ → **${newAge}** _(แสดงในกล่องข้อความเท่านั้น ไม่ได้บันทึกลงชีต)_`);
                }

                // อัปเดต embed ใน Log Channel (ทางเลือก — ถ้าไม่เจอ ไม่ error)
                if (embedMsg && (newName || newPhone || newAge)) {
                    let e = EmbedBuilder.from(embedMsg.embeds[0]);
                    if (newName) {
                        e = e.spliceFields(1, 1, { name: '📛 ชื่อ IC', value: newName, inline: true });
                        if (info) {
                            const full = makeFullName(info.codeNumber, newName);
                            e = e.spliceFields(2, 1, { name: '⚙️ ชื่อในระบบ (คัดลอกไปวางที่ Fivem ใน ⚙️Setting > Player Name ก่อนเข้าประเทศ)', value: `\`${truncateNickname(full)}\``, inline: false });
                        }
                    }
                    if (newPhone) {
                        e = e.spliceFields(3, 1, { name: '📞 เบอร์โทร IC', value: newPhone, inline: true });
                    }
                    if (newAge) {
                        e = e.spliceFields(4, 1, { name: '🎂 อายุ OOC', value: `${newAge} ปี`, inline: true });
                    }
                    await embedMsg.edit({ embeds: [e] });
                }
                if (changed.length === 0) {
                    await modal.editReply({ content: '⚠️ ไม่มีการเปลี่ยนแปลง' });
                    return;
                }
                await modal.editReply({ content: '✅ อัปเดตสำเร็จ!\n' + changed.join('\n') });
            } catch (e: unknown) {
                logger.error('แก้PD', `ผิดพลาด: ${e instanceof Error ? e.message : String(e)}`);
                await modal.editReply({ content: '❌ เกิดข้อผิดพลาด' });
            }
        }
    });
}