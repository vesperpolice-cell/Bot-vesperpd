import { Client, Events, MessageFlags, ChatInputCommandInteraction } from 'discord.js';
import { configService } from '../../core/config.service';
import { isAdmin } from '../../services/permission.service';
import { rateLimiter } from '../../core/ratelimiter';
import { logger } from '../../core/logger';

export function setupReloadFeature(client: Client): void {
    client.on(Events.InteractionCreate, async (i) => {
        if (!i.isChatInputCommand() || i.commandName !== 'reload') return;
        const cmd = i as ChatInputCommandInteraction<'cached'>;
        if (!isAdmin(cmd)) {
            await cmd.reply({ content: '❌ เฉพาะผู้ดูแลระบบเท่านั้น', flags: MessageFlags.Ephemeral });
            return;
        }

        if (!rateLimiter.check(`reload:${cmd.user.id}`, 1, 30000)) {
            await cmd.reply({ content: '⏳ กรุณารอ **30** วินาที', flags: MessageFlags.Ephemeral });
            return;
        }
        await cmd.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            await configService.reload();
            await cmd.editReply({
                embeds: [{
                    color: 0x00c400,
                    title: '✅ Config Reload สำเร็จ',
                    description: 'Config ถูกโหลดใหม่จาก Google Sheet เรียบร้อยแล้ว',
                    fields: [
                        { name: '📊 Count Config', value: configService.isLoaded() ? '✅ พร้อมใช้งาน' : '❌ ไม่พร้อม', inline: true },
                        { name: '📋 Registry Config', value: configService.getRegistryConfig().spreadsheetId ? '✅ พร้อมใช้งาน' : '❌ ไม่พร้อม', inline: true },
                        { name: '👋 Welcome Channel', value: configService.getWelcomeChannelId() ? `✅ \`${configService.getWelcomeChannelId()}\`` : '❌ ไม่ตั้งค่า', inline: false },
                    ],
                    timestamp: new Date().toISOString(),
                    footer: { text: `โดย ${cmd.user.tag}` },
                }],
            });
            logger.info('รีโหลด', `Config รีโหลดโดย ${cmd.user.tag}`);
        } catch (err: unknown) {
            await cmd.editReply({
                embeds: [{
                    color: 0xff4444,
                    title: '❌ Config Reload ล้มเหลว',
                    description: `\`\`\`${err instanceof Error ? err.message : String(err)}\`\`\``,
                    timestamp: new Date().toISOString(),
                }],
            });
        }
    });
}