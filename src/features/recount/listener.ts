import { Client, Events, MessageFlags, ButtonInteraction, ModalSubmitInteraction, ChatInputCommandInteraction } from 'discord.js';
import { configService } from '../../core/config.service';
import { manualRecount } from '../count/count.service';
import { countStates } from '../count/count.state';
import { createPanelEmbed, buildPanelComponents } from './panel.service';
import { replyAndDelete, silentCatch } from '../../services/utils';
import { isAdmin } from '../../services/permission.service';
import { buildCountModal, buildWelcomeModal, buildBypdModal, buildTake2Modal, buildRegistryModal } from './modals';
import { logger } from '../../core/logger';
import { resendStates } from './resend.state';
import { processBypd } from '../bypd/bypd.service';
import { hasBypdOrPdInMessage, hasCarryInMessage, hasTake2InMessage } from '../bypd/bypd.utils';
import { processProctor } from '../proctor/proctor.service';
import { hasProctorInMessage } from '../proctor/proctor.utils';

const PANEL_IDS = new Set([
    'btn_recount_manual', 'btn_cfg_count', 'btn_cfg_welcome', 'btn_cfg_bypd', 'btn_cfg_take2', 'btn_cfg_registry',
    'btn_refresh_config', 'btn_resend_bypd',
    'modal_cfg_count', 'modal_cfg_welcome', 'modal_cfg_bypd', 'modal_cfg_take2', 'modal_cfg_registry',
]);

const MODAL_BUTTONS = ['btn_cfg_count', 'btn_cfg_welcome', 'btn_cfg_bypd', 'btn_cfg_take2', 'btn_cfg_registry'];

/**
 * แผงควบคุมในห้องค้างอยู่กับสถานะรอบก่อนหรือเปล่า
 *
 * สถานะ "กำลังทำงาน" เก็บไว้ในหน่วยความจำ บอทรีสตาร์ทแล้วหายหมด
 * แต่ข้อความแผงที่ค้างอยู่ในห้องยังเขียนว่า "หยุดทำงาน" เหมือนเดิม
 * ถ้าปล่อยไว้ พอผู้ใช้กดตั้งใจจะหยุด ระบบกลับไปเริ่มงานใหม่แทน
 */
export function isStalePanelLabel(label: string | null | undefined, running: boolean): boolean {
    return !running && (label ?? '').includes('หยุด');
}

function isStalePanel(btn: ButtonInteraction<'cached'>, running: boolean): boolean {
    const label = typeof btn.component?.label === 'string' ? btn.component.label : '';
    return isStalePanelLabel(label, running);
}

export function setupRecountFeature(client: Client): void {
    client.on(Events.InteractionCreate, async (i) => {
        // --- /recount command ---
        if (i.isChatInputCommand() && i.commandName === 'recount') {
            const cmd = i as ChatInputCommandInteraction<'cached'>;
            if (!isAdmin(cmd)) {
                await cmd.reply({ content: '❌ เฉพาะผู้ดูแลระบบ', flags: MessageFlags.Ephemeral });
                return;
            }
            await cmd.deferReply({ flags: MessageFlags.Ephemeral });
            await cmd.channel?.send({ embeds: [createPanelEmbed()], components: buildPanelComponents(cmd.guildId || 'global') });
            await replyAndDelete(cmd, '✅ วางแผงควบคุมในห้องนี้แล้ว');
            return;
        }

        // ------------------------------------------
        // BUTTON HANDLING
        // ------------------------------------------
        if (i.isButton() && PANEL_IDS.has(i.customId)) {
            const btn = i as ButtonInteraction<'cached'>;
            if (!isAdmin(btn)) {
                await btn.reply({ content: '❌ เฉพาะผู้ดูแลระบบ', flags: MessageFlags.Ephemeral });
                return;
            }

            // Modal buttons → showModal ทันที (ห้าม defer)
            if (MODAL_BUTTONS.includes(btn.customId)) {
                const modals: Record<string, ReturnType<typeof buildCountModal>> = {
                    'btn_cfg_count': buildCountModal(),
                    'btn_cfg_welcome': buildWelcomeModal(),
                    'btn_cfg_bypd': buildBypdModal(),
                    'btn_cfg_take2': buildTake2Modal(),
                    'btn_cfg_registry': buildRegistryModal(),
                };
                await btn.showModal(modals[btn.customId]).catch(silentCatch('Recount'));
                return;
            }

            // ⭐ เริ่มนับข้อความเก่า → รองรับการหยุด
            if (btn.customId === 'btn_recount_manual') {
                if (countStates.isRunning()) {
                    countStates.stop();
                    try { await btn.deferUpdate(); } catch { /* ignore */ }
                    await refreshPanel(btn);
                    return;
                }
                // ปุ่มเขียนว่า "หยุดทำงาน" แต่ไม่มีอะไรทำงานอยู่จริง = แผงค้างจากรอบก่อน
                // (บอทรีสตาร์ทระหว่างนับ สถานะในหน่วยความจำหายไป แต่ข้อความในห้องยังเป็นของเดิม)
                // รีเฟรชแผงให้ตรงความจริง ไม่เริ่มงานใหม่ เพราะผู้ใช้ตั้งใจจะกด "หยุด"
                if (isStalePanel(btn, false)) {
                    try { await btn.deferUpdate(); } catch { /* ignore */ }
                    await refreshPanel(btn);
                    return;
                }
                const abort = new AbortController();
                countStates.start(abort);
                await refreshPanel(btn);
                try {
                    await manualRecount(client, btn, abort.signal);
                } catch (e: unknown) {
                    logger.error('RECOUNT', `Manual recount error: ${e instanceof Error ? e.message : String(e)}`);
                } finally {
                    // ต้องเคลียร์เสมอ ไม่งั้นถ้านับพังกลางคัน สถานะจะค้างเป็น "กำลังนับ"
                    // แล้วปุ่มจะติดอยู่ที่ "หยุดทำงาน" จนกว่าจะมีคนมากดซ้ำ
                    countStates.stop();
                }
                await refreshPanel(btn);
                return;
            }

            // 🔄 รีเฟรช config → deferUpdate + แก้ไข embed เดิม
            if (btn.customId === 'btn_refresh_config') {
                try { await btn.deferUpdate(); } catch { return; }
                await configService.reload();
                try { await btn.editReply({ embeds: [createPanelEmbed()], components: buildPanelComponents(btn.guildId || 'global') }); } catch (e) { logger.warn('Recount', String(e)); }
                return;
            }

            // 🔄 ส่งย้อนหลัง BYPD → deferReply (ต้อง reply ใหม่)
            if (btn.customId === 'btn_resend_bypd') {
                try { await btn.deferReply({ flags: MessageFlags.Ephemeral }); } catch { return; }
                const guildId = btn.guildId || 'global';
                const state = resendStates.get(guildId);
                if (state?.isRunning) {
                    resendStates.stop(guildId);
                    await refreshPanel(btn);
                    await btn.editReply({ content: `⏹️ หยุดทำงานแล้ว\n📊 ส่งสำเร็จ: ${state.totalSent} | ล้มเหลว: ${state.totalFailed}` });
                    return;
                }
                // แผงค้างจากรอบก่อน — รีเฟรชให้ตรงความจริง ไม่เริ่มส่งย้อนหลังรอบใหม่โดยที่ผู้ใช้ไม่ได้ตั้งใจ
                if (isStalePanel(btn, false)) {
                    await refreshPanel(btn);
                    await btn.editReply({ content: '🔄 แผงควบคุมค้างอยู่กับรอบก่อน (บอทรีสตาร์ทระหว่างทำงาน)\n✅ รีเฟรชให้แล้ว กดใหม่ได้เลย' });
                    return;
                }
                const abort = new AbortController();
                resendStates.set(guildId, { isRunning: true, abortController: abort, totalSent: 0, totalFailed: 0, scanned: 0, bypdSent: 0, carrySent: 0, take2Sent: 0, currentChannel: '' });
                await refreshPanel(btn);
                await btn.editReply({ content: '🔄 กำลังส่งย้อนหลัง BYPD...\n⏳ กำลังเริ่มสแกน...' });
                try {
                    const r = await runResendMissed(btn, abort.signal, guildId);
                    resendStates.set(guildId, { isRunning: false, abortController: null, totalSent: r.sent, totalFailed: r.failed, scanned: 0, bypdSent: 0, carrySent: 0, take2Sent: 0, currentChannel: '' });
                    await refreshPanel(btn);
                    await replyAndDelete(btn, r.message);
                } catch (err: unknown) {
                    resendStates.stop(guildId);
                    await refreshPanel(btn);
                    await btn.editReply({ content: `❌ เกิดข้อผิดพลาด: ${err instanceof Error ? err.message : String(err)}` });
                }
                return;
            }
        }

        // ------------------------------------------
        // MODAL SUBMIT HANDLING
        // ------------------------------------------
        if (i.isModalSubmit() && PANEL_IDS.has(i.customId)) {
            const modal = i as ModalSubmitInteraction<'cached'>;
            if (!isAdmin(modal)) {
                await modal.reply({ content: '❌ เฉพาะผู้ดูแลระบบ', flags: MessageFlags.Ephemeral });
                return;
            }
            try { await modal.deferReply({ flags: MessageFlags.Ephemeral }); } catch { return; }
            try {
                const save = async (keys: [string, string][]) => {
                    await configService.writeConfigKeys(keys);
                    if (modal.message) {
                        try { await modal.message.edit({ embeds: [createPanelEmbed()], components: buildPanelComponents(modal.guildId || 'global') }); } catch (e) { logger.warn('Recount', String(e)); }
                    }
                };
                switch (modal.customId) {
                    case 'modal_cfg_count': {
                        const raw = modal.fields.getTextInputValue('input_all_channels').split(',');
                        await save([
                            ['SPREADSHEET_ID', modal.fields.getTextInputValue('input_spreadsheet_id').trim()],
                            ['SHEET_NAME', modal.fields.getTextInputValue('input_sheet_name').trim()],
                            ...([1, 2, 3, 4, 5] as const).map((n, idx) => [`CHANNEL_ID_${n}`, (raw[idx] || '').trim()] as [string, string]),
                        ]);
                        await replyAndDelete(modal, '✅ บันทึกตั้งค่านับเคสแล้ว');
                        break;
                    }
                    case 'modal_cfg_welcome':
                        await save([
                            ['WELCOME_CHANNEL_ID', modal.fields.getTextInputValue('input_welcome_channel').trim()],
                            ['LOG_CHANNEL_ID', modal.fields.getTextInputValue('input_log_channel').trim()],
                            ['LOGTIME_CHANNEL_ID', modal.fields.getTextInputValue('input_logtime_channel').trim()],
                        ]);
                        await replyAndDelete(modal, '✅ บันทึกตั้งค่าต้อนรับแล้ว');
                        break;
                    case 'modal_cfg_bypd':
                        await save([
                            ['LOGCASE_CHANNEL_ID', modal.fields.getTextInputValue('input_logcase_channel').trim()],
                            ['BYPD_SEND_CHANNEL_ID', modal.fields.getTextInputValue('input_bypd_send').trim()],
                            ['CARRY_SEND_CHANNEL_ID', modal.fields.getTextInputValue('input_carry_send').trim()],
                            ['PROCTOR_SEND_CHANNEL_ID', modal.fields.getTextInputValue('input_proctor_send').trim()],
                        ]);
                        await replyAndDelete(modal, '✅ บันทึกตั้งค่าระบบคดีแล้ว');
                        break;
                    case 'modal_cfg_take2':
                        await save([
                            ['LOGTAKE2_CHANNEL_ID', modal.fields.getTextInputValue('input_logtake2_channel').trim()],
                            ['TAKE2_SEND_CHANNEL_ID', modal.fields.getTextInputValue('input_take2_send').trim()],
                        ]);
                        await replyAndDelete(modal, '✅ บันทึกตั้งค่า TAKE2แล้ว');
                        break;
                    case 'modal_cfg_registry':
                        await save([
                            ['REGISTRY_SPREADSHEET_ID', modal.fields.getTextInputValue('input_registry_sheet_id').trim()],
                            ['REGISTRY_SHEET_NAME', modal.fields.getTextInputValue('input_registry_sheet_name').trim()],
                            ['REGISTRY_OUT_SHEET_NAME', modal.fields.getTextInputValue('input_registry_out_sheet').trim()],
                        ]);
                        await replyAndDelete(modal, '✅ บันทึกตั้งค่าชีต PD แล้ว');
                        break;
                }
            } catch (e: unknown) {
                logger.error('RECOUNT', `Modal error: ${e instanceof Error ? e.message : String(e)}`);
                try { await modal.editReply({ content: '❌ เกิดข้อผิดพลาด' }); } catch (e) { logger.warn('Recount', String(e)); }
            }
        }
    });
}

async function refreshPanel(interaction: ButtonInteraction<'cached'>): Promise<void> {
    try {
        if (interaction.message) {
            await interaction.message.edit({ embeds: [createPanelEmbed()], components: buildPanelComponents(interaction.guildId || 'global') });
        }
    } catch (e) { logger.warn('Recount', String(e)); }
}

interface ResendResult {
    sent: number;
    failed: number;
    message: string;
}

async function runResendMissed(interaction: ButtonInteraction<'cached'>, abortSignal: AbortSignal, guildId: string): Promise<ResendResult> {
    const logCaseId = configService.getLogCaseChannelId();
    const logTake2Id = configService.getLogTake2ChannelId();
    const guild = interaction.guild;
    if (!logCaseId && !logTake2Id) return { sent: 0, failed: 0, message: '❌ ไม่พบห้อง Log' };
    let scanned = 0, bypdSent = 0, carrySent = 0, take2Sent = 0, failed = 0, bypdAlready = 0, carryAlready = 0, take2Already = 0;
    let proctorSent = 0, proctorAlready = 0;

    const updateProgress = async (channelName: string) => {
        resendStates.set(guildId, {
            ...resendStates.get(guildId)!,
            scanned,
            bypdSent,
            carrySent,
            take2Sent,
            currentChannel: channelName,
        });
        try {
            await interaction.editReply({
                content: `📂 กำลังสแกน: ${channelName}\n📊 สแกน: ${scanned} | BYPD: ${bypdSent} | Carry: ${carrySent} | TAKE2: ${take2Sent} | ❌ ${failed}`,
            });
        } catch { /* ignore rate limit */ }
    };

    const scanChannel = async (channelId: string) => {
        if (!guild) return;
        const logChannel = guild.channels.cache.get(channelId);
        if (!logChannel || !logChannel.isTextBased()) return;
        const channelName = `#${logChannel.name}`;
        await updateProgress(channelName);
        let lastId: string | undefined;
        let batchCount = 0;
        while (true) {
            if (abortSignal.aborted) break;
            const messages = await logChannel.messages.fetch({ limit: 100, before: lastId });
            if (messages.size === 0) break;
            const batch = [...messages.values()].reverse();
            for (const msg of batch) {
                const hasBypd = hasBypdOrPdInMessage(msg);
                const hasProctor = hasProctorInMessage(msg);
                const hasCheck = msg.reactions.cache.some((r) => r.emoji.name === '✅');
                if (hasBypd && !hasCheck) {
                    try {
                        const isTake2 = hasTake2InMessage(msg);
                        const isCarry = !isTake2 && hasCarryInMessage(msg);
                        await processBypd(msg);
                        if (isTake2) take2Sent++;
                        else if (isCarry) carrySent++;
                        else bypdSent++;
                    } catch { failed++; }
                    await new Promise(r => setTimeout(r, 500));
                } else if (hasBypd && hasCheck) {
                    if (hasTake2InMessage(msg)) take2Already++;
                    else if (hasCarryInMessage(msg)) carryAlready++;
                    else bypdAlready++;
                }
                if (hasProctor && !hasCheck) {
                    try { await processProctor(msg); proctorSent++; } catch { failed++; }
                    await new Promise(r => setTimeout(r, 500));
                } else if (hasProctor && hasCheck) {
                    proctorAlready++;
                }
            }
            scanned += batch.length;
            batchCount++;
            if (batchCount % 1 === 0) await updateProgress(channelName);
            lastId = messages.last()?.id;
        }
    };
    if (logCaseId) await scanChannel(logCaseId);
    if (logTake2Id && !abortSignal.aborted) await scanChannel(logTake2Id);
    const totalSent = bypdSent + carrySent + take2Sent;
    return {
        sent: totalSent,
        failed,
        message: abortSignal.aborted
            ? `⏹️ หยุดส่งย้อนหลังแล้ว\n📊 สแกน: ${scanned}\n📊 BYPD: ${bypdSent} | Carry: ${carrySent} | TAKE2: ${take2Sent} | Proctor: ${proctorSent} | ❌ ${failed}\n📊 เคยแล้ว: BYPD ${bypdAlready} | Carry ${carryAlready} | TAKE2 ${take2Already} | Proctor ${proctorAlready}`
            : `✅ ส่งย้อนหลังเสร็จสิ้น\n📊 สแกน: ${scanned}\n📊 BYPD: ${bypdSent} | Carry: ${carrySent} | TAKE2: ${take2Sent} | Proctor: ${proctorSent} | ❌ ${failed}\n📊 เคยแล้ว: BYPD ${bypdAlready} | Carry ${carryAlready} | TAKE2 ${take2Already} | Proctor ${proctorAlready}`,
    };
}