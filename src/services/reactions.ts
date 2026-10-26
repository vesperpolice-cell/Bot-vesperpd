import { Message } from 'discord.js';
import { logger } from '../core/logger';

/** อิโมจิตัวเลข 2–10 ใช้บอกจำนวนรายการที่ประมวลผลในข้อความเดียว */
const COUNT_EMOJIS: Record<number, string> = {
    2: '2️⃣', 3: '3️⃣', 4: '4️⃣', 5: '5️⃣',
    6: '6️⃣', 7: '7️⃣', 8: '8️⃣', 9: '9️⃣', 10: '🔟',
};

/**
 * ติด ✅ (บอกว่าประมวลผลแล้ว) และตามด้วยอิโมจิจำนวน ถ้ามากกว่า 1
 * เดิมเขียนซ้ำใน BYPD กับ Proctor — รวมไว้ที่เดียว
 */
export async function markProcessed(message: Message, count: number, context: string): Promise<void> {
    if (count <= 0) return;
    try { await message.react('✅'); } catch (e) { logger.warn(context, String(e)); }
    if (count > 1) {
        const emoji = COUNT_EMOJIS[count];
        if (emoji) {
            try { await message.react(emoji); } catch (e) { logger.warn(context, String(e)); }
        }
    }
}
