import { Client, Events, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, type ColorResolvable, Interaction, ButtonInteraction } from 'discord.js';
import { configService } from '../../core/config.service';
import { sheetService } from '../../core/sheet.service';
import { registerMember, checkPreApproved, checkPendingStatus, checkInOutDc, findMemberByDiscordId, LEFT_DISCORD_STATUS } from './welcome.service';
import { getTextChannel } from '../../services/utils';
import { logger } from '../../core/logger';

/**
 * สร้าง embed 📝 แบบเดียวกันสำหรับทุกกรณีที่ลงทะเบียนสำเร็จ (ส่งไป Log)
 */
function buildRegEmbed(userId: string, icName: string, icPhone: string, ocAge: string, nickname: string, nickChanged: boolean) {
    return new EmbedBuilder()
        .setColor('#a0c400')
        .setTitle('📝 มีการลงทะเบียนใหม่ผ่านระบบสำเร็จ')
        .setDescription(`ผู้ใช้งาน <@${userId}> ลงทะเบียนเข้าสู่ระบบสำเร็จแล้ว`)
        .addFields(
            { name: '🆔 Discord ID', value: `\`${userId}\``, inline: true },
            { name: '📛 ชื่อ IC', value: icName, inline: true },
            { name: '⚙️ ชื่อในระบบ (คัดลอกไปวางที่ Fivem ใน ⚙️Setting > Player Name ก่อนเข้าประเทศ)', value: `\`${nickname}\``, inline: false },
            { name: '📞 เบอร์ IC', value: icPhone || '—', inline: true },
            { name: '🎂 อายุ OOC', value: ocAge || '—', inline: true },
            { name: '🏷️ ตำแหน่ง', value: 'นักเรียนตำรวจ', inline: true },
            { name: '📱 สถานะการเปลี่ยนชื่อดิส', value: nickChanged ? '✅ สำเร็จ' : '❌ ล้มเหลว', inline: true }
        )
        .setTimestamp();
}

/**
 * สร้าง embed ต้อนรับแบบทั่วไป (ใช้แทนการสร้าง EmbedBuilder ซ้ำ 3 แบบ)
 */
function buildWelcomeEmbedV2(color: ColorResolvable, title: string, description: string, userId: string, avatar: string, memberCount: number, footer: string, isNewMember = false) {
    return new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setDescription(description)
        .setThumbnail(avatar)
        .addFields(
            { name: isNewMember ? '👤 สมาชิกใหม่' : '👤 สมาชิก', value: `<@${userId}>`, inline: true },
            { name: '👥 สมาชิกรวม', value: `${memberCount} คน`, inline: true }
        )
        .setFooter({ text: footer })
        .setTimestamp();
}

/**
 * สร้าง embed สำหรับแจ้งเตือนเมื่อมีคนออกจากเซิร์ฟเวอร์
 */
function buildLeaveEmbed(userId: string, avatar: string, memberCount: number) {
    return new EmbedBuilder()
        .setColor('#808080')
        .setTitle('😭 บ๊ายบาย แล้วพบกันใหม่')
        .setDescription(`สมาชิก <@${userId}> ได้ออกจากเซิร์ฟเวอร์`)
        .setThumbnail(avatar)
        .addFields(
            { name: '👤 ผู้จากไป', value: `<@${userId}>`, inline: true },
            { name: '👥 สมาชิกที่เหลือ', value: `${memberCount} คน`, inline: true }
        )
        .setFooter({ text: 'CasePD • วันนี้' })
        .setTimestamp();
}

export function setupWelcomeFeature(client: Client): void {
    client.on(Events.GuildMemberRemove, async (member) => {
        try {
            const ch = getTextChannel(member.guild, configService.getWelcomeChannelId());
            if (!ch) return;

            // อัปเดตคอลัมน์ N ใน NamePD = "ออกจาก Discord"
            try {
                const reg = configService.getRegistryConfig();
                if (reg.spreadsheetId && reg.sheetName) {
                    const rows = await sheetService.getValues(reg.spreadsheetId, `${reg.sheetName}!E:N`, 0);
                    for (let i = 1; i < rows.length; i++) {
                        const discordCell = (rows[i]?.[0] || '').trim();
                        if (discordCell.includes(member.user.id)) {
                            const rowNumber = i + 1;
                            await sheetService.updateValues(reg.spreadsheetId, `${reg.sheetName}!N${rowNumber}`, [[LEFT_DISCORD_STATUS]]);
                            logger.info('ต้อนรับ', `อัปเดตสถานะ GuildMemberRemove: แถว ${rowNumber} = ${LEFT_DISCORD_STATUS}`);
                            break;
                        }
                    }
                }
            } catch (sheetErr) {
                logger.warn('ต้อนรับ', `อัปเดตชีตล้มเหลว (ไม่ใช่ปัญหาสำคัญ): ${sheetErr instanceof Error ? sheetErr.message : String(sheetErr)}`);
            }

            await ch.send({
                embeds: [buildLeaveEmbed(
                    member.user.id,
                    member.user.displayAvatarURL(),
                    member.guild.memberCount
                )]
            });

            logger.info('ต้อนรับ', `GuildMemberRemove: ${member.user.tag}`);
        } catch (e: unknown) {
            logger.error('ต้อนรับ', `GuildMemberRemove error: ${e instanceof Error ? e.message : String(e)}`);
        }
    });

    client.on(Events.GuildMemberAdd, async (member) => {
        try {
            const ch = getTextChannel(member.guild, configService.getWelcomeChannelId());
            if (!ch) return;

            const isOutDc = await checkInOutDc(member.user.id);
            if (isOutDc) {
                await ch.send({
                    embeds: [buildWelcomeEmbedV2(
                        '#808080',
                        'ℹ️ ยินดีต้อนรับอีกครั้ง',
                        `<@${member.user.id}> ยินดีต้อนรับสู่ Vesper PD!\n⚠️ **คุณมีชื่อในระบบที่ถูกถอดออกแล้ว** กรุณาติดต่อ Admin หากต้องการกลับเข้ามาทำงาน`,
                        member.user.id,
                        member.user.displayAvatarURL(),
                        member.guild.memberCount,
                        `${client.user?.username} • อดีตตำรวจ`
                    )],
                    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
                        new ButtonBuilder().setCustomId(`btn_check_status_${member.user.id}`).setLabel('🔍 ตรวจสอบสถานะ').setStyle(ButtonStyle.Secondary)
                    )]
                });
                logger.info('ต้อนรับ', `OutDC rejoin: ${member.user.tag}`);
                return;
            }

            const preApproved = await checkPreApproved(member.user.id);
            if (preApproved.approved && preApproved.icName) {
                const result = await registerMember(preApproved.icName, member.user.id, preApproved.icPhone || '');
                if (result) {
                    let nickChanged = true;
                    try { await member.setNickname(result.nickname); } catch { nickChanged = false; }

                    await ch.send({
                        embeds: [buildWelcomeEmbedV2(
                            '#3aca1d',
                            '🎉 ยินดีต้อนรับสู่ Vesper PD!',
                            `ยินดีต้อนรับ <@${member.user.id}> สู่ Vesper PD!\n📛 **ชื่อในระบบ:** \`${result.nickname}\``,
                            member.user.id,
                            member.user.displayAvatarURL(),
                            member.guild.memberCount,
                            'VES-PD • ยินดีต้อนรับ'
                        )]
                    });

                    const regEmbed = buildRegEmbed(
                        member.user.id,
                        preApproved.icName,
                        preApproved.icPhone || '',
                        preApproved.ocAge || '',
                        result.nickname,
                        nickChanged
                    );

                    const logCh = getTextChannel(member.guild, configService.getLogChannelId());
                    if (logCh) {
                        await logCh.send({ content: `<@${member.user.id}>`, embeds: [regEmbed] });
                    }
                    logger.info('ต้อนรับ', `Auto-register Pre-approved: ${member.user.tag} (${result.nickname})`);
                } else {
                    await ch.send({
                        embeds: [buildWelcomeEmbedV2(
                            '#FFA500',
                            '⚠️ ยินดีต้อนรับ — ไม่สามารถลงทะเบียนอัตโนมัติ',
                            `<@${member.user.id}> ยินดีต้อนรับสู่ Vesper PD!\n❌ ไม่สามารถลงทะเบียนให้คุณได้ (อาจซ้ำหรือข้อมูลไม่ถูกต้อง) กรุณาติดต่อ Admin`,
                            member.user.id,
                            member.user.displayAvatarURL(),
                            member.guild.memberCount,
                            `${client.user?.username} • Auto Approve Failed`
                        )],
                        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
                            new ButtonBuilder().setCustomId(`btn_check_status_${member.user.id}`).setLabel('🔍 ตรวจสอบสถานะ').setStyle(ButtonStyle.Secondary)
                        )]
                    });
                }
            } else {
                await ch.send({
                    embeds: [buildWelcomeEmbedV2(
                        '#3aca1d',
                        '🎉 ยินดีต้อนรับสู่ Vesper PD!',
                        `ยินดีต้อนรับ <@${member.user.id}> สู่ Vesper PD!\n📌 กรุณากรอกใบสมัครที่หน้าเว็บไซต์เพื่อสมัครเป็นตำรวจ\n💡 หากสมัครแล้ว กดปุ่มด้านล่างเพื่อตรวจสอบสถานะ`,
                        member.user.id,
                        member.user.displayAvatarURL(),
                        member.guild.memberCount,
                        `${client.user?.username} • วันนี้`,
                        true
                    )],
                    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
                        new ButtonBuilder().setCustomId(`btn_check_status_${member.user.id}`).setLabel('🔍 ตรวจสอบสถานะ').setStyle(ButtonStyle.Secondary)
                    )]
                });
            }

            logger.info('ต้อนรับ', `ส่งข้อความต้อนรับให้ ${member.user.tag} (preApproved=${preApproved.approved})`);
        } catch (e: unknown) {
            logger.error('ต้อนรับ', `GuildMemberAdd error: ${e instanceof Error ? e.message : String(e)}`);
        }
    });

    // ✅ ปุ่มตรวจสอบสถานะ — เช็คว่าเป็นของคนนั้นหรือไม่
    client.on(Events.InteractionCreate, async (i: Interaction) => {
        try {
            if (!i.isButton()) return;
            const btn = i as ButtonInteraction<'cached'>;

            // ตรวจสอบว่าเป็นปุ่ม btn_check_status หรือไม่ (มี prefix)
            if (!btn.customId.startsWith('btn_check_status')) return;

            // ดึง userId จาก customId (รูปแบบ btn_check_status_<userId>)
            const targetUserId = btn.customId.replace('btn_check_status_', '');

            // ถ้าไม่ใช่ของตัวเอง
            if (btn.user.id !== targetUserId) {
                await btn.reply({ content: '❌ ปุ่มนี้ไม่ใช่ของคุณ', flags: MessageFlags.Ephemeral });
                return;
            }

            await btn.deferReply({ flags: MessageFlags.Ephemeral });

            const userId = btn.user.id;
            const member = btn.guild?.members.cache.get(userId);

            const isOutDc = await checkInOutDc(userId);
            if (isOutDc) {
                await btn.editReply({ content: 'ℹ️ คุณมีชื่อในระบบที่ถูกถอดออกแล้ว กรุณาติดต่อ Admin หากต้องการกลับเข้ามาทำงาน' });
                return;
            }

            // อ่านคิวรออนุมัติครั้งเดียวแล้วใช้ทั้งสองด่าน — ไม่ยิง Pending Sheet ซ้ำสองรอบต่อการกดปุ่ม
            const pendingInfo = await checkPendingStatus(userId);
            const preApproved = await checkPreApproved(userId, pendingInfo);
            if (preApproved.approved && preApproved.icName) {
                await btn.editReply({ content: '✅ พบการอนุมัติ! กำลังลงทะเบียนให้...' });
                const result = await registerMember(preApproved.icName, userId, preApproved.icPhone || '');
                if (result) {
                    let nickChanged = true;
                    if (member) { try { await member.setNickname(result.nickname); } catch { nickChanged = false; } }

                    await btn.editReply({ content: `✅ ลงทะเบียนสำเร็จ!\n📛 **ชื่อในระบบ:** ${result.nickname}` });

                    const regEmbed = buildRegEmbed(
                        userId,
                        preApproved.icName,
                        preApproved.icPhone || '',
                        preApproved.ocAge || '',
                        result.nickname,
                        nickChanged
                    );

                    const logCh = getTextChannel(btn.guild, configService.getLogChannelId());
                    if (logCh) {
                        await logCh.send({ content: `<@${userId}>`, embeds: [regEmbed] });
                    }
                } else {
                    await btn.editReply({ content: '❌ ไม่สามารถลงทะเบียนได้ (อาจซ้ำหรือข้อมูลไม่ถูกต้อง) กรุณาติดต่อ Admin' });
                }
                return;
            }

            if (pendingInfo.found) {
                await btn.editReply({ content: `📋 ใบสมัครของคุณ **${pendingInfo.status}** อยู่ในระบบแล้ว\n${pendingInfo.status === 'รอตรวจ' ? '⏳ กรุณารอ Admin ตรวจสอบ' : ''}` });
                return;
            }

            // ค้นหาใน NamePD ถ้าเจอให้ตั้ง nickname จากคอลัมน์ D
            const memberInfo = await findMemberByDiscordId(userId);
            if (memberInfo) {
                let nickChanged = true;
                if (member) {
                    try { await member.setNickname(memberInfo.currentName); } catch { nickChanged = false; }
                }
                await btn.editReply({
                    content: `✅ คุณมีชื่อในระบบตำรวจอยู่แล้ว\n📛 **ชื่อในระบบ:** \`${memberInfo.currentName}\`${nickChanged ? '' : '\n⚠️ ไม่สามารถเปลี่ยนชื่อเล่นได้'}`,
                });
                return;
            }

            await btn.editReply({ content: '📝 ยังไม่พบข้อมูลของคุณ กรุณากรอกใบสมัครที่หน้าเว็บไซต์ https://mhnk-pd-0-1.onrender.com/register' });
        } catch (e: unknown) {
            logger.error('ต้อนรับ', `Check status button error: ${e instanceof Error ? e.message : String(e)}`);
        }
    });
}