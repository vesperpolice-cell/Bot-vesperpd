import { Client, Events, Guild } from 'discord.js';
import { silentCatch } from '../../services/utils';
import { configService } from '../../core/config.service';
import { processCountBatch, pendingCountOps } from './count.service';
import { logger } from '../../core/logger';
import { CACHE, COUNT } from '../../config';
import type { TagInfo } from '../../types/discord';
import { displayNameOf, forgetName, lookupName, pruneNameCache } from '../../services/name-resolver';

/**
 * จำว่าโพสไหนนับให้ใครไปแล้ว — เก็บเฉพาะ "รหัสคน" ไม่เก็บชื่อเล่น
 *
 * ชื่อเล่นไม่ต้องจำ เพราะตอนใช้งานจริงดึงจากข้อความสด ๆ ได้อยู่แล้ว
 * เก็บแค่รหัสทำให้จำโพสได้มากขึ้นราว 3 เท่าในหน่วยความจำเท่าเดิม
 */
const messageLog = new Map<string, string[]>();

/**
 * ตัวนับไว้สรุปลง log เป็นระยะ
 *
 * ของเดิมไม่บันทึกอะไรเลยนอกจากตอน error พอยอดในชีตไม่ตรงกับที่กดนับใหม่
 * จึงต้องมานั่งเดาสาเหตุทุกครั้ง ไม่มีร่องรอยว่าบอทตัดสินใจอะไรไปบ้าง
 */
const stats = { added: 0, removed: 0, unnamed: 0, editRefetched: 0, editUnreadable: 0, editOld: 0, editWhileCreating: 0 };

/**
 * ใบที่ "ข้อความใหม่" กำลังจัดการอยู่ตอนนี้
 *
 * ตัวจัดการข้อความใหม่ต้องรอ 2 จังหวะก่อนจะจดลง messageLog ได้ (หาชื่อคน + กด ✅)
 * ระหว่างรอนั้น Discord ส่ง event "ข้อความถูกแก้" ตามมาได้ — ห้องนี้บอทโพสเองและโพสมี embed
 * ซึ่ง Discord จะยิง event แก้ไขตามมาติด ๆ ตอนประมวลผล embed เสร็จ
 *
 * ของเดิมพอ event แก้ไขมาถึงก่อน มันจะเห็นว่า "ไม่รู้จักใบนี้" แล้วจดลง messageLog ไว้เฉย ๆ
 * (ตามดีไซน์ของมัน คือไม่นับ เพราะเดาไม่ได้ว่าของเดิมแท็กใคร)
 * พอตัวจัดการข้อความใหม่กลับมา มันเห็นว่าใบนี้ "มีคนจดไว้แล้ว" เลยเข้าใจผิดว่านับไปแล้ว → เลิกทำ
 *
 * ผลคือใบนั้นติด ✅ แต่ไม่เคยได้ยอด และไม่มี log อะไรเลยเพราะเป็นการ return เงียบ ๆ
 * วัดได้จริงเมื่อ 2 ต.ค. 2026: ต้องนับ 271 ครั้ง บอทนับได้ 253 ขาดไป 18 (6.6%)
 *
 * ทางแก้: "จอง" เลขใบไว้ตั้งแต่ยังไม่มี await คั่น แล้วให้ฝั่งแก้ไขถอยให้
 */
const processing = new Set<string>();

/**
 * ใบนี้ควรเริ่มนับไหม — และถ้าควร ให้ "จอง" ไว้ในจังหวะเดียวกันเลย
 *
 * ต้องเป็นฟังก์ชันเดียวที่ทั้งถามและจอง ห้ามแยกเป็นสองขั้น
 * เพราะถ้ามีอะไรคั่นกลางระหว่าง "ถาม" กับ "จอง" ได้เมื่อไหร่ ช่องว่างก็กลับมาทันที
 * (บั๊กเดิมคือเช็ค messageLog หลัง await ไปแล้ว 2 จังหวะ)
 */
export function claimForCount(
    id: string,
    counted: { has(id: string): boolean },
    inFlight: Set<string>,
): boolean {
    if (counted.has(id) || inFlight.has(id)) return false;
    inFlight.add(id);
    return true;
}

/** กันไม่ให้เตือนเรื่องคนเดิมซ้ำ ๆ จนท่วม log — ล้างทิ้งทุกรอบสรุป */
const warnedUnnamed = new Set<string>();

/** อายุข้อความแบบอ่านง่าย ใช้ในข้อความแจ้งเตือน */
export function formatAge(ms: number): string {
    const mins = Math.max(0, Math.floor(ms / 60000));
    if (mins < 60) return `${mins} นาที`;
    return `${Math.floor(mins / 60)} ชม. ${mins % 60} นาที`;
}

/**
 * เลขที่ดึงมาจาก <@...> หน้าตาเป็น Discord ID จริงไหม (ตัวเลขล้วน 17–20 หลัก)
 *
 * เดิมมีการเช็คว่าหาตัวสมาชิกเจอไหม ซึ่งกรองเลขปลอมออกไปด้วยโดยปริยาย
 * พอเลิกเช็คตัวสมาชิกแล้ว ต้องมีตัวกรองรูปแบบมาแทน ไม่งั้นข้อความที่พิมพ์ <@123> มาเล่น ๆ
 * จะได้แถวใหม่ในชีตโดยที่ไม่มีคนนั้นอยู่จริง (ปุ่มนับใหม่ก็ไม่นับเลขปลอม ต้องให้ตรงกัน)
 */
export function looksLikeDiscordId(id: string): boolean {
    return /^\d{17,20}$/.test(id);
}

/** แท็กที่หาชื่อไม่ได้เลยทั้ง 3 ทาง — ยังนับยอดให้ตามปกติ แค่จดไว้ว่าไม่รู้ชื่อ */
function noteUnnamedTag(id: string): void {
    stats.unnamed++;
    if (warnedUnnamed.has(id)) return;
    warnedUnnamed.add(id);
    logger.warn('นับเคส', `แท็ก ${id} หาชื่อไม่ได้เลย (ทั้งสมุดในเครื่องและถาม Discord) — นับยอดให้ด้วยเลขไอดีตามปกติ`);
}

/**
 * แจ้งให้รู้ว่ามีการแก้ใบที่เก่าเกินกรอบเวลาที่ปกติจะมีคนแก้กัน
 * ไม่ได้ห้ามแก้ และยอดยังอัปเดตตามความจริงเหมือนเดิม — มีไว้เฝ้าดูเท่านั้น
 */
function noteOldEdit(msg: { url: string; createdTimestamp: number }): void {
    const hours = configService.getEditAlertHours();
    if (hours <= 0) return;
    const ageMs = Date.now() - msg.createdTimestamp;
    if (ageMs <= hours * 60 * 60 * 1000) return;
    stats.editOld++;
    logger.warn('นับเคส', `แก้ข้อความที่อายุ ${formatAge(ageMs)} (เกิน ${hours} ชม.) — ยอดอัปเดตให้ตามปกติ`, { ข้อความ: msg.url });
}

/** สรุปลง log แล้วเริ่มนับรอบใหม่ — ถ้าไม่มีอะไรเกิดขึ้นเลยก็ไม่ต้องรบกวน */
function logSummary(): void {
    const s = stats;
    if (!s.added && !s.removed && !s.unnamed && !s.editRefetched && !s.editUnreadable && !s.editOld && !s.editWhileCreating) return;
    logger.info('นับเคส', 'สรุปรอบ', {
        นับเพิ่ม: s.added,
        หักออก: s.removed,
        แท็กที่ไม่รู้ชื่อ: s.unnamed,
        แก้ข้อความแล้วต้องไปดึงเนื้อหาใหม่: s.editRefetched,
        แก้ข้อความแต่อ่านเนื้อหาไม่ได้เลย: s.editUnreadable,
        แก้ข้อความที่เก่าเกินกำหนด: s.editOld,
        แก้ไขชนตอนกำลังนับใบใหม่: s.editWhileCreating,
        คิวที่ยังไม่ได้เขียนลงชีต: pendingCountOps(),
    });
    s.added = 0; s.removed = 0; s.unnamed = 0;
    s.editRefetched = 0; s.editUnreadable = 0; s.editOld = 0; s.editWhileCreating = 0;
    warnedUnnamed.clear();

    // เก็บกวาดชื่อที่หมดอายุ ไม่ให้ค้างในหน่วยความจำไปเรื่อย ๆ
    pruneNameCache();
}

/**
 * ดึงคนที่ถูกแท็กออกจากข้อความ — นับด้วย "เลขไอดี" เป็นหลัก ไม่ใช่ตัวคน
 *
 * ของเดิมบังคับว่าต้องหาตัวสมาชิกใน cache เจอก่อนจึงจะนับ หาไม่เจอก็ทิ้งแท็กนั้นเงียบ ๆ
 * ซึ่งไม่จำเป็นเลย เพราะชีตค้นแถวด้วยเลขไอดีในคอลัมน์ B อยู่แล้ว ไม่ต้องรู้ชื่อก็นับได้
 * ชื่อจำเป็นแค่ตอนสร้างแถวใหม่ให้คนที่ยังไม่มีในชีต (ดู ensureUserRow)
 *
 * ถ้าสมุดรายชื่อในเครื่องไม่มี ก็ถาม Discord ต่อ (เหมือนที่ปุ่มนับข้อความเก่าทำ)
 * จะได้ชื่อจริงแม้คนนั้นออกจากเซิร์ฟไปแล้ว ไม่ต้องลงเลขไอดีในช่องชื่อถ้าไม่จำเป็น
 */
async function getTagsFromMessage(content: string, guild: Guild): Promise<TagInfo[]> {
    const tags: TagInfo[] = [];
    const seen = new Set<string>();
    const regex = /<@!?(\d+)>/g;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(content)) !== null) {
        const id = m[1];
        if (seen.has(id)) continue;
        seen.add(id);
        // ข้ามเลขที่ไม่ใช่ Discord ID — แต่ต้องบอกไว้ใน log ห้ามทิ้งแบบเงียบ ๆ
        if (!looksLikeDiscordId(id)) {
            logger.warn('นับเคส', `ข้ามแท็ก <@${id}> เพราะไม่ใช่ Discord ID (ต้องเป็นตัวเลข 17–20 หลัก)`);
            continue;
        }
        const name = await lookupName(guild, id);
        if (!name.nickname && !name.username) noteUnnamedTag(id);
        tags.push({ id, nickname: name.nickname, username: name.username, hasGuildNickname: name.hasGuildNickname });
    }
    return tags;
}

function allowedChannelIds(cfg: ReturnType<typeof configService.getCountConfig>): string[] {
    const ch = cfg.CHANNELS;
    return [ch.CHANNEL_1, ch.CHANNEL_2, ch.CHANNEL_3, ch.CHANNEL_4, ch.CHANNEL_5].filter(Boolean);
}

export interface TagDelta {
    added: TagInfo[];
    removedIds: string[];
}

/**
 * ส่วนต่างของแท็กระหว่างของเดิมกับของใหม่ ใช้ตอนมีคนแก้ข้อความ
 *
 * knownIds = undefined แปลว่าไม่เคยเห็นข้อความนี้ใน messageLog — คืนส่วนต่างเปล่า
 * เพราะเราไม่รู้ว่าเดิมแท็กใครไว้ ถ้าเหมาว่าแท็กปัจจุบันทั้งหมดคือ "ของที่เพิ่งเพิ่ม"
 * คะแนนจะไปซ้ำกับที่นับไปแล้วตอนข้อความถูกส่งครั้งแรก
 */
export function diffTags(knownIds: string[] | undefined, next: TagInfo[]): TagDelta {
    if (!knownIds) return { added: [], removedIds: [] };
    const oldIds = new Set(knownIds);
    const newIds = new Set(next.map(x => x.id));
    return {
        added: next.filter(x => !oldIds.has(x.id)),
        removedIds: knownIds.filter(id => !newIds.has(id)),
    };
}

export type EditPlan =
    | { action: 'skip' }
    | { action: 'record'; tagIds: string[] }
    | { action: 'apply'; added: TagInfo[]; removedIds: string[]; tagIds: string[] };

/**
 * event "แก้ข้อความ" เข้ามาแล้วควรทำอะไรต่อ
 *
 * contentReadable = false แปลว่าอ่านเนื้อหาไม่ได้เลย (ดึงตัวจริงจาก Discord ก็ยังไม่ได้)
 * กรณีนั้นต้อง "ไม่ทำอะไร" เท่านั้น ห้ามตีความว่าแท็กถูกลบแล้วไปหักยอด
 *
 * นี่คือต้นเหตุที่ยอดในชีตหายเองทีละนิดในห้องที่คนโพสเยอะ:
 * discord.js จำเนื้อหาข้อความไว้แค่ 200 ใบต่อห้อง แต่ messageLog จำได้ 2,000 ใบ
 * ใบที่ตกอยู่ในช่องว่างนี้ พอมี event แก้ไขเข้ามา บอทจะอ่านได้ 0 แท็ก
 * ของเดิมเหมาว่า "แท็กถูกเอาออกหมดแล้ว" แล้วหักยอดทุกคนในใบนั้นทิ้ง ทั้งที่ไม่มีใครลบแท็กเลย
 */
export function planEdit(known: string[] | undefined, contentReadable: boolean, newTags: TagInfo[]): EditPlan {
    if (!contentReadable) return { action: 'skip' };
    const tagIds = newTags.map(t => t.id);
    if (!known) return { action: 'record', tagIds };
    const { added, removedIds } = diffTags(known, newTags);
    return { action: 'apply', added, removedIds, tagIds };
}

/**
 * คนที่ถูกเอาออกจากแท็ก — เราจำไว้แค่รหัส ต้องหาข้อมูลคนกลับมาเพื่อส่งให้ระบบนับ
 * หาไม่เจอ (เช่นลาออกไปแล้ว) ก็ยังหักยอดได้ เพราะแถวในชีตค้นด้วยรหัสเป็นหลักอยู่แล้ว
 */
function toRemovedTags(ids: string[], guild: Guild): TagInfo[] {
    return ids.map(id => {
        const member = guild.members.cache.get(id);
        // ใช้ตัวเดียวกับฝั่งนับเพิ่ม เพื่อให้ธง hasGuildNickname มีความหมายเหมือนกันทั้งสองทาง
        const name = member ? displayNameOf(member) : null;
        return {
            id,
            nickname: name?.nickname ?? '',
            username: name?.username ?? '',
            hasGuildNickname: name?.hasGuildNickname ?? false,
        };
    });
}

function cleanupLog(): void {
    if (messageLog.size > CACHE.MESSAGE_LOG_MAX_SIZE) {
        const keys = [...messageLog.keys()].slice(0, Math.floor(messageLog.size / 2));
        for (const k of keys) messageLog.delete(k);
    }
}

export function setupCountFeature(client: Client): void {
    client.once(Events.ClientReady, async () => {
        try {
            for (const g of client.guilds.cache.values()) await g.members.fetch();
            logger.info('นับเคส', 'แคชสมาชิกเรียบร้อย');
        } catch (e: unknown) {
            logger.error('นับเคส', `แคชผิดพลาด: ${e instanceof Error ? e.message : String(e)}`);
        }
    });

    /*
     * ชื่อเล่นเปลี่ยน → ลืมชื่อที่จำไว้ทันที
     *
     * ไม่มีตัวนี้ก็ต้องรอ cache หมดอายุ (30 นาที) ชื่อในชีตจึงจะตามความจริง
     * คนเพิ่งลงทะเบียนเสร็จแล้วรับคดีต่อเลยเป็นเรื่องปกติ — ครึ่งชั่วโมงนานเกินไป
     */
    client.on(Events.GuildMemberUpdate, (oldM, newM) => {
        if (oldM.nickname === newM.nickname) return;
        forgetName(newM.id);
        logger.info('นับเคส', `ชื่อเล่นเปลี่ยน: ${oldM.nickname ?? '(ไม่มี)'} → ${newM.nickname ?? '(ไม่มี)'} — ชื่อในชีตจะอัปเดตตอนได้ยอดครั้งถัดไป`);
    });

    client.on(Events.MessageCreate, async (message) => {
        try {
            const cfg = configService.getCountConfig();
            if (!configService.isLoaded() || !cfg.CHANNELS) return;
            if (!message.guild || !allowedChannelIds(cfg).includes(message.channel.id)) return;

            /*
             * จองใบนี้ก่อน — ต้องทำตั้งแต่ยังไม่มี await คั่น
             *
             * ของเดิมเช็ค messageLog หลังกด ✅ ซึ่งมี await คั่นอยู่ 2 จังหวะก่อนหน้า
             * ระหว่างนั้น event "แก้ข้อความ" แทรกเข้ามาจดใบนี้ลง messageLog ได้
             * แล้วตัวนี้จะเข้าใจผิดว่า "นับไปแล้ว" จึงเลิกทำเงียบ ๆ ทั้งที่ยังไม่เคยนับ
             */
            if (!claimForCount(message.id, messageLog, processing)) return;

            try {
                const tags = await getTagsFromMessage(message.content, message.guild);
                if (tags.length === 0) return;
                await message.react('✅').catch(silentCatch('Count'));
                messageLog.set(message.id, tags.map(t => t.id));
                cleanupLog();
                stats.added += tags.length;
                await processCountBatch(tags, message.channel.id, false);
            } finally {
                // ต้องปล่อยเสมอ ไม่งั้นใบนี้จะถูกล็อกไว้ตลอดอายุโปรเซส
                processing.delete(message.id);
            }
        } catch (e: unknown) {
            logger.error('นับเคส', `MessageCreate: ${e instanceof Error ? e.message : String(e)}`);
        }
    });

    client.on(Events.MessageDelete, async (message) => {
        try {
            const cfg = configService.getCountConfig();
            if (!configService.isLoaded() || !cfg.CHANNELS) return;
            const ids = messageLog.get(message.id);
            if (!ids || !message.guild) return;
            messageLog.delete(message.id);
            cleanupLog();
            stats.removed += ids.length;
            await processCountBatch(toRemovedTags(ids, message.guild), message.channel.id, true);
        } catch (e: unknown) {
            logger.error('นับเคส', `MessageDelete: ${e instanceof Error ? e.message : String(e)}`);
        }
    });

    // กำหนด cleanup อัตโนมัติทุก 24 ชั่วโมง
    setInterval(cleanupLog, CACHE.COUNT_CLEANUP_INTERVAL_MS);
    cleanupLog(); // เรียกครั้งแรกตอน start

    // สรุปสถิติการนับลง log เป็นระยะ — ไว้ไล่ย้อนว่ายอดเพี้ยนเพราะอะไร ไม่ต้องเดาอีก
    setInterval(logSummary, COUNT.SUMMARY_INTERVAL_MS);

    client.on(Events.MessageUpdate, async (_oldM, newM) => {
        try {
            const cfg = configService.getCountConfig();
            if (!configService.isLoaded() || !cfg.CHANNELS || !newM.guild || !newM.channel) return;

            // ของเดิมไม่ได้กรองห้องตรงนี้ ทำให้แก้ข้อความห้องไหนในเซิร์ฟเวอร์ก็เข้าคิวนับหมด
            // สุดท้ายถูกข้ามตอน flush ก็จริง แต่ flush อ่าน Sheet ไปเรียบร้อยแล้วทุกครั้ง = เปลืองโควต้าเปล่า ๆ
            if (!allowedChannelIds(cfg).includes(newM.channel.id)) return;

            /*
             * ฝั่ง "ข้อความใหม่" กำลังจัดการใบนี้อยู่ — ถอยให้มันทำจนจบ
             *
             * ที่ต้องถอยเพราะถ้าจดลง messageLog ตรงนี้ ฝั่งโน้นจะเข้าใจผิดว่านับไปแล้วแล้วเลิกทำ
             * event ที่ชนกันแบบนี้เกือบทั้งหมดคือ Discord แจ้งว่าประมวลผล embed เสร็จ
             * ไม่ใช่คนแก้แท็กจริง ข้ามไปจึงไม่ทำให้ยอดเพี้ยน — ฝั่งสร้างจะจดสถานะล่าสุดให้เอง
             */
            if (processing.has(newM.id)) {
                stats.editWhileCreating++;
                return;
            }

            noteOldEdit(newM);

            const known = messageLog.get(newM.id);

            /*
             * ต้องอ่านเนื้อหาให้ได้ก่อน แล้วค่อยตัดสินใจเรื่องยอด (เหตุผลเต็มอยู่ที่ planEdit)
             * มองไม่เห็นก็ไปดึงตัวจริงจาก Discord มาอ่าน → ยอด "ถูกต้อง" ไม่ใช่แค่ "ไม่ผิด"
             * ดึงไม่ได้จริง ๆ → ปล่อยให้ planEdit สั่ง skip ห้ามเดาว่าแท็กถูกลบ
             */
            let content = newM.content;
            let readable = !newM.partial && content !== null;
            if (!readable) {
                try {
                    content = (await newM.fetch()).content;
                    readable = true;
                    stats.editRefetched++;
                } catch {
                    stats.editUnreadable++;
                    logger.warn('นับเคส', `แก้ข้อความ ${newM.id}: อ่านเนื้อหาไม่ได้และดึงตัวจริงไม่ได้ — ไม่แตะยอด`);
                }
            }

            const newTags = readable ? await getTagsFromMessage(content ?? '', newM.guild) : [];
            const plan = planEdit(known, readable, newTags);
            if (plan.action === 'skip') return;

            // ไม่เคยเห็นข้อความนี้ (messageLog อยู่ใน memory ล้วน บอทรีสตาร์ทแล้วหายหมด)
            // → บันทึกสถานะปัจจุบันไว้เฉย ๆ ไม่นับ เพื่อไม่ให้คะแนนซ้ำกับตอนที่นับไปแล้ว
            //    ถ้ายอดเพี้ยนจริงยังใช้ /recount รื้อนับใหม่ได้เสมอ
            if (plan.action === 'record') {
                messageLog.set(newM.id, plan.tagIds);
                cleanupLog();
                return;
            }

            if (plan.added.length > 0) {
                stats.added += plan.added.length;
                await processCountBatch(plan.added, newM.channel.id, false);
            }
            if (plan.removedIds.length > 0) {
                stats.removed += plan.removedIds.length;
                await processCountBatch(toRemovedTags(plan.removedIds, newM.guild), newM.channel.id, true);
            }

            messageLog.set(newM.id, plan.tagIds);
        } catch (e: unknown) {
            logger.error('นับเคส', `MessageUpdate: ${e instanceof Error ? e.message : String(e)}`);
        }
    });
}