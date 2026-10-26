import { GuildMember, Interaction, Message, PermissionsBitField } from 'discord.js';
import { configService } from '../core/config.service';
import { firstMentionId } from './mentions';

/**
 * Permission service — centralized permission checking.
 * Reads EDIT_TAG_MODE from Google Sheet config.
 * 
 * EDIT_TAG_MODE formats:
 *   - 'all' → ทุกคนใช้ได้
 *   - '484012084577828875,123456789' → เฉพาะ User IDs เหล่านี้ + เจ้าของคดี
 *   - '' (ว่าง) → เฉพาะเจ้าของคดีเท่านั้น
 */
/** ตรวจว่า interaction มาจากผู้ดูแลระบบหรือไม่ — รวมการเช็กซ้ำจากทุกคำสั่งแอดมินไว้ที่เดียว */
export function isAdmin(interaction: { memberPermissions: Readonly<PermissionsBitField> | null }): boolean {
    return Boolean(interaction.memberPermissions?.has('Administrator'));
}

export class PermissionService {
    /**
     * Check if user has permission to use Edit Tags.
     * Priority: 1) Owner of case (first mention) 2) Config-based check
     */
    static canEditTag(interaction: Interaction, targetMessage: Message): boolean {
        // Priority 1: Is this user the case owner (first mention)?
        if (PermissionService.isCaseOwner(interaction, targetMessage)) {
            return true;
        }

        // Priority 2: Check EDIT_TAG_MODE from Sheet
        const mode = (configService.getEditTagMode() || '').trim();

        // 'all' = ทุกคนใช้ได้
        if (mode.toLowerCase() === 'all') {
            return true;
        }

        // ถ้าเป็น list of IDs → เช็คว่า user อยู่ในลิสต์
        if (mode) {
            const ids = mode.split(',').map(id => id.trim()).filter(Boolean);
            if (ids.includes(interaction.user.id)) {
                return true;
            }
        }

        // Fallback: Admin
        const member = 'member' in interaction ? interaction.member as GuildMember | null : null;
        if (member?.permissions?.has('Administrator')) {
            return true;
        }

        return false;
    }

    /**
     * Check if the interaction user is the first mention in the message (case owner).
     */
    static isCaseOwner(interaction: Interaction, targetMessage: Message): boolean {
        return firstMentionId(targetMessage.content || '') === interaction.user.id;
    }
}