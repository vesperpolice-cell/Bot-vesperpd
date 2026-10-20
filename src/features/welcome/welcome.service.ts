import { sheetService } from '../../core/sheet.service';
import { configService } from '../../core/config.service';
import { logger } from '../../core/logger';
import { locks } from '../../core/lock.service';
import { truncateNickname, makeFullName } from '../../services/member.service';

// ---------------------------------------------------------------------------
// ส่วนตัดสินใจล้วน ๆ — ไม่แตะ Google, ไม่แตะ config
// แยกออกมาเพื่อให้เทสได้ตรง ๆ ว่า "ข้อมูลแบบนี้ ต้องเลือกแถวไหน / เขียนช่องไหน"
// ---------------------------------------------------------------------------

export interface RegistrySlot {
    /** เลขแถวแบบที่ Google ใช้ (เริ่มนับ 1) เอาไปต่อเป็น range ได้เลย */
    row: number;
    code: string;
}

/**
 * สถานะที่บอทเขียนลงคอลัมน์ N ตอนคนออกจากเซิร์ฟเวอร์
 *
 * ตัวเดียวกับที่ listener เขียนและที่ registerMember อ่านเพื่อรู้ว่าใคร "กลับมา"
 * ถ้าแยกเป็นข้อความสองที่เมื่อไหร่ การกลับเข้ามาจะพังเงียบ ๆ ทันที
 */
export const LEFT_DISCORD_STATUS = 'ออกจาก Discord';

/**
 * หาแถวแรกที่ "มีรหัสประจำตัวแล้ว แต่ยังไม่มีชื่อ" = ที่ว่างสำหรับคนใหม่
 *
 * rows มาจาก range C:D → index 0 = คอลัมน์ C (รหัส), index 1 = คอลัมน์ D (ชื่อ)
 * เริ่มที่ index 2 เพราะข้อมูลจริงเริ่มแถว 3 ของชีต (สองแถวแรกเป็นหัวตาราง)
 */
export function findEmptyRegistrySlot(rows: string[][]): RegistrySlot | null {
    for (let i = 2; i < rows.length; i++) {
        if (rows[i][0] && (!rows[i][1] || rows[i][1].trim() === '')) {
            return { row: i + 1, code: rows[i][0].trim() };
        }
    }
    return null;
}

/**
 * หาที่ว่างจากช่วงที่อ่านเพิ่มต่อท้าย เผื่อรหัสถูกเติมไว้เกินช่วงที่ C:D อ่านเจอ
 *
 * dyn มาจาก range C{n+1}:C{n+20} → มีแต่คอลัมน์ C ไม่มีคอลัมน์ D ให้เทียบ
 * จึงถือว่าแถวไหนมีรหัสก็ว่างทั้งหมด
 */
export function findDynamicRegistrySlot(dyn: string[][], scannedRowCount: number): RegistrySlot | null {
    for (let j = 0; j < dyn.length; j++) {
        if (dyn[j][0]) {
            return { row: scannedRowCount + j + 1, code: dyn[j][0].trim() };
        }
    }
    return null;
}

/**
 * แถวของคนที่เคยลงทะเบียนไว้ แล้วออกจาก Discord ไป — ให้กลับมาใช้แถวเดิมได้
 *
 * rows มาจาก range C:N → index 0 = C (รหัส), 2 = E (mention), 11 = N (สถานะ)
 * เริ่มที่ index 2 ด้วยเหตุผลเดียวกับ findEmptyRegistrySlot: สองแถวแรกเป็นหัวตาราง
 *
 * ต้องครบทั้งสามเงื่อนไข — มีรหัส, เป็น Discord ID คนนี้, และสถานะบอกว่าออกไปแล้ว
 * ถ้าไม่เช็คสถานะด้วย คนที่ยังอยู่ในกรมจะถูกนับเป็น "กลับมา" แล้วถูกเขียนทับชื่อตัวเอง
 */
export function findRejoinableRow(rows: string[][], userId: string): RegistrySlot | null {
    for (let i = 2; i < rows.length; i++) {
        const row = rows[i];
        if (!row?.[0]) continue;
        if (!(row[2] || '').includes(userId)) continue;
        if ((row[11] || '').trim() !== LEFT_DISCORD_STATUS) continue;
        return { row: i + 1, code: row[0].trim() };
    }
    return null;
}

/** วันที่แบบไม่เติมศูนย์นำหน้า เช่น 5/3/2026 — ตรงกับที่ชีตใช้อยู่เดิม */
export function formatRegistrationDate(d: Date): string {
    return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
}

export interface SheetRangeUpdate {
    range: string;
    values: string[][];
}

/**
 * ช่องที่ต้องเขียนตอนลงทะเบียนสำเร็จ — B เบอร์, D ชื่อ, E mention, H วันที่
 *
 * mention นำหน้าด้วย ' เพื่อบังคับให้ Google เก็บเป็นข้อความ ไม่ตีความเป็นสูตร
 * เขียนผิดช่องตรงนี้ = ทับข้อมูลกำลังพลคนอื่น จึงต้องมีเทสคุมไว้
 */
export function buildRegistrationUpdates(
    sheetName: string,
    row: number,
    icPhone: string,
    nickname: string,
    userId: string,
    date: string,
): SheetRangeUpdate[] {
    return [
        { range: `${sheetName}!B${row}`, values: [[icPhone]] },
        { range: `${sheetName}!D${row}:E${row}`, values: [[nickname, `'<@${userId}>`]] },
        { range: `${sheetName}!H${row}`, values: [[date]] },
    ];
}

/**
 * คอลัมน์เดียวที่อ่านมา (เช่น E:E) มี Discord ID นี้อยู่ไหม
 *
 * ใช้ includes ไม่ใช่เทียบเท่ากันตรง ๆ เพราะคอลัมน์ E เก็บเป็น <@123456> ไม่ใช่เลขล้วน
 */
export function columnContainsUserId(rows: string[][], userId: string): boolean {
    return rows.some(row => row[0] && row[0].toString().includes(userId));
}

/**
 * แถวของ Discord ID นี้ในชีตทะเบียน
 * rows มาจาก range C:E → index 0 = C (รหัส), 1 = D (ชื่อ), 2 = E (mention)
 */
export function findRegistryRowByDiscordId(
    rows: string[][],
    userId: string,
): { row: number; codeNumber: string; currentName: string } | null {
    for (let i = 2; i < rows.length; i++) {
        if (rows[i]?.[2] && rows[i][2].trim().includes(userId)) {
            return { row: i + 1, codeNumber: (rows[i][0] || '').trim(), currentName: (rows[i][1] || '').trim() };
        }
    }
    return null;
}

export interface PendingEntry {
    found: boolean;
    status?: string;
    icName?: string;
    icPhone?: string;
    ocAge?: string;
}

/**
 * แถวของ Discord ID นี้ในชีตคิวรออนุมัติ
 * rows มาจาก range A:H → B = Discord ID, D = ชื่อ IC, E = เบอร์, F = อายุ, H = สถานะ
 * เริ่มที่ index 1 เพราะแถวแรกเป็นหัวตาราง
 */
export function findPendingEntry(rows: string[][], discordId: string): PendingEntry {
    for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if ((row[1] || '').trim() === discordId) {
            return {
                found: true,
                status: (row[7] || '').trim(),
                icName: (row[3] || '').trim(),
                icPhone: (row[4] || '').trim(),
                ocAge: (row[5] || '').trim(),
            };
        }
    }
    return { found: false };
}

/**
 * ตรวจสอบสถานะ Pending Sheet สำหรับ Discord ID ที่กำหนด
 */
export async function checkPendingStatus(discordId: string): Promise<PendingEntry> {
    const spreadsheetId = configService.getPendingSpreadsheetId();
    const sheetName = configService.getPendingSheetName();
    if (!spreadsheetId || !sheetName) return { found: false };
    try {
        const rows = await sheetService.getValues(spreadsheetId, `${sheetName}!A:H`, 0);
        return findPendingEntry(rows, discordId);
    } catch {
        return { found: false };
    }
}

/**
 * ตรวจสอบว่า Discord ID นี้ถูก Pre-approved (ผ่าน Admin Approve ใน Pending Sheet) หรือยัง
 */
export async function checkPreApproved(discordId: string): Promise<{ approved: boolean; icName?: string; icPhone?: string; ocAge?: string }> {
    const result = await checkPendingStatus(discordId);
    if (result.found && result.status === 'อนุมัติ') {
        logger.info('Pre-Approved', `พบ ${discordId} ผ่านการอนุมัติแล้ว (IC: ${result.icName})`);
        return { approved: true, icName: result.icName, icPhone: result.icPhone, ocAge: result.ocAge };
    }
    return { approved: false };
}

export async function isAlreadyRegistered(userId: string, bypassCache = false): Promise<boolean> {
    const reg = configService.getRegistryConfig();
    if (!reg.spreadsheetId || !reg.sheetName) return false;
    const ttl = bypassCache ? 0 : 10000;
    const rows = await sheetService.getValues(reg.spreadsheetId, `${reg.sheetName}!E:E`, ttl);
    if (columnContainsUserId(rows, userId)) return true;
    if (reg.outSheetName) {
        const outRows = await sheetService.getValues(reg.spreadsheetId, `${reg.outSheetName}!E:E`, ttl);
        return columnContainsUserId(outRows, userId);
    }
    return false;
}

export async function registerMember(icName: string, userId: string, icPhone = ''): Promise<{ nickname: string; wasTruncated: boolean } | null> {
    return locks.sheetMutation.run(async () => {
        try {
            const reg = configService.getRegistryConfig();
            if (!reg.spreadsheetId || !reg.sheetName) return null;

            const rows = await sheetService.getValues(reg.spreadsheetId, `${reg.sheetName}!C:N`, 0);

            /* คนเก่าที่ออกจาก Discord แล้วกลับเข้ามา ได้แถวและรหัสเดิมคืน
               ต้องตัดสินก่อนเช็คสมัครซ้ำ เพราะ Discord ID ของเขายังอยู่ในคอลัมน์ E
               ของแถวนั้น — ด่านซ้ำจึงปฏิเสธเขาทุกครั้งถ้าถามทีหลัง */
            const rejoin = findRejoinableRow(rows, userId);

            if (!rejoin && await isAlreadyRegistered(userId, true)) {
                logger.warn('สมัคร', `ผู้ใช้ ${userId} สมัครซ้ำ — ข้าม`);
                return null;
            }

            let slot = rejoin;
            if (!slot) {
                slot = findEmptyRegistrySlot(rows);
            }

            if (!slot) {
                const dyn = await sheetService.getValues(reg.spreadsheetId, `${reg.sheetName}!C${rows.length + 1}:C${rows.length + 20}`, 0);
                slot = findDynamicRegistrySlot(dyn, rows.length);
            }

            if (!slot) {
                logger.warn('สมัคร', 'ไม่พบแถวว่างที่มีรหัส');
                return null;
            }

            const fullNickname = makeFullName(slot.code, icName);
            const truncatedNick = truncateNickname(fullNickname);
            const formattedDate = formatRegistrationDate(new Date());

            const updates = buildRegistrationUpdates(reg.sheetName, slot.row, icPhone, truncatedNick, userId, formattedDate);
            /* ล้างสถานะทิ้ง ไม่งั้นแถวยังประกาศว่า "ออกจาก Discord" ทั้งที่เจ้าตัวกลับมาแล้ว
               และจะถูกนับเป็นคนกลับมาซ้ำได้อีกเรื่อย ๆ */
            if (rejoin) {
                updates.push({ range: `${reg.sheetName}!N${slot.row}`, values: [['']] });
            }

            await sheetService.batchUpdateValues(reg.spreadsheetId, updates);
            logger.info('สมัคร', rejoin
                ? `กลับเข้า Discord ${fullNickname} ใช้รหัสเดิม แถว ${slot.row}`
                : `ลงทะเบียน ${fullNickname} เบอร์ ${icPhone} แถว ${slot.row}`);
            return { nickname: truncatedNick, wasTruncated: fullNickname.length > 32 };

        } catch (error) {
            logger.error('สมัคร', `เกิดข้อผิดพลาด: ${error}`);
            return null;
        }
    });
}

/**
 * ตรวจสอบว่า Discord ID นี้อยู่ใน OutDC (ถูกถอดออกจากระบบ) หรือไม่
 */
export async function checkInOutDc(userId: string): Promise<boolean> {
    const reg = configService.getRegistryConfig();
    if (!reg.spreadsheetId || !reg.outSheetName) return false;
    try {
        const rows = await sheetService.getValues(reg.spreadsheetId, `${reg.outSheetName}!E:E`, 0);
        return columnContainsUserId(rows, userId);
    } catch {
        return false;
    }
}

export async function findMemberByDiscordId(userId: string): Promise<{ row: number; codeNumber: string; currentName: string } | null> {
    const reg = configService.getRegistryConfig();
    if (!reg.spreadsheetId || !reg.sheetName) return null;
    const rows = await sheetService.getValues(reg.spreadsheetId, `${reg.sheetName}!C:E`, 0);
    return findRegistryRowByDiscordId(rows, userId);
}

export async function updateMemberName(row: number, newFullName: string): Promise<void> {
    const reg = configService.getRegistryConfig();
    if (!reg.spreadsheetId || !reg.sheetName) return;
    const truncated = truncateNickname(newFullName);
    await sheetService.updateValues(reg.spreadsheetId, `${reg.sheetName}!D${row}`, [[truncated]]);
    logger.info('แก้ชื่อ', `อัปเดตแถว ${row} ชื่อเป็น ${truncated}`);
}

export async function updateMemberPhone(row: number, newPhone: string): Promise<void> {
    const reg = configService.getRegistryConfig();
    if (!reg.spreadsheetId || !reg.sheetName) return;
    await sheetService.updateValues(reg.spreadsheetId, `${reg.sheetName}!B${row}`, [[newPhone]]);
    logger.info('แก้เบอร์', `อัปเดตแถว ${row} เบอร์เป็น ${newPhone}`);
}
