import { sheetService } from './sheet.service';
import { SHEETS, COUNT } from '../config';
import { logger } from './logger';

/**
 * อ่านจำนวนชั่วโมงจากชีต — ค่าว่างหรือพิมพ์ผิดให้ใช้ค่า default
 * ห้ามปล่อยให้ค่าเพี้ยนจากชีตทำให้ตรรกะเวลาพัง
 */
export function parseHours(raw: string | undefined, fallback: number): number {
    const t = (raw ?? '').trim();
    if (!t) return fallback;
    const n = Number(t);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export class ConfigService {
    private data: Record<string, string> = {};
    private loaded = false;
    private countConfig = { SPREADSHEET_ID: '', SHEET_NAME: '', CHANNELS: { CHANNEL_1: '', CHANNEL_2: '', CHANNEL_3: '', CHANNEL_4: '', CHANNEL_5: '' } };
    private registryConfig = { spreadsheetId: '', sheetName: '', outSheetName: '' };
    private pendingSpreadsheetId = '';
    private pendingSheetName = '';
    private welcomeChannelId = '';
    private logChannelId = '';
    private logtimeChannelId = '';
    private logCaseChannelId = '';
    private bypdSendChannelId = '';
    private carrySendChannelId = '';
    private take2SendChannelId = '';
    private logTake2ChannelId = '';
    private proctorSendChannelId = '';
    private editTagMode = '';
    private editAlertHours = COUNT.EDIT_ALERT_HOURS_DEFAULT;
    async load(bypassCache = false): Promise<void> {
        try {
            const ttl = bypassCache ? 0 : 30000;
            const rows = await sheetService.getValues(SHEETS.CONFIG_SHEET_ID, `${SHEETS.CONFIG_SHEET_NAME}!A:B`, ttl);
            this.applyRows(rows);
            this.loaded = true;
            logger.info('CONFIG', 'โหลด Config จาก Google Sheet สำเร็จ');
        } catch (error) {
            logger.error('CONFIG', 'โหลด Config จาก Google Sheet ไม่สำเร็จ', { error: String(error) });
            this.loaded = false;
            throw error;
        }
    }

    /** แปลงแถว A:B (ที่อ่านได้ หรือที่กำลังจะเขียน) ให้เป็นค่าตั้งต้นทั้งหมด */
    private applyRows(rows: string[][]): void {
        this.data = {};
        for (const row of rows) { if (row[0]) this.data[row[0]] = row[1] ? row[1].trim() : ''; }
        const parts = (this.data.COUNT_CHANNEL_IDS || '').split(',');
        this.countConfig = { SPREADSHEET_ID: this.data.SPREADSHEET_ID || '', SHEET_NAME: this.data.SHEET_NAME || '', CHANNELS: { CHANNEL_1: (parts[0] || this.data.CHANNEL_ID_1 || '').trim(), CHANNEL_2: (parts[1] || this.data.CHANNEL_ID_2 || '').trim(), CHANNEL_3: (parts[2] || this.data.CHANNEL_ID_3 || '').trim(), CHANNEL_4: (parts[3] || this.data.CHANNEL_ID_4 || '').trim(), CHANNEL_5: (parts[4] || this.data.CHANNEL_ID_5 || '').trim() } };
        this.registryConfig = { spreadsheetId: this.data.REGISTRY_SPREADSHEET_ID || '', sheetName: this.data.REGISTRY_SHEET_NAME || '', outSheetName: this.data.REGISTRY_OUT_SHEET_NAME || '' };
        this.pendingSpreadsheetId = this.data.PENDING_SPREADSHEET_ID || this.data.REGISTRY_SPREADSHEET_ID || '';
        this.pendingSheetName = this.data.PENDING_SHEET_NAME || 'Pending';
        this.welcomeChannelId = this.data.WELCOME_CHANNEL_ID || '';
        this.logChannelId = this.data.LOG_CHANNEL_ID || '';
        this.logtimeChannelId = this.data.LOGTIME_CHANNEL_ID || '';
        this.logCaseChannelId = this.data.LOGCASE_CHANNEL_ID || '';
        this.bypdSendChannelId = this.data.BYPD_SEND_CHANNEL_ID || '';
        this.carrySendChannelId = this.data.CARRY_SEND_CHANNEL_ID || '';
        this.take2SendChannelId = this.data.TAKE2_SEND_CHANNEL_ID || '';
        this.logTake2ChannelId = this.data.LOGTAKE2_CHANNEL_ID || '';
        this.proctorSendChannelId = this.data.PROCTOR_SEND_CHANNEL_ID || '';
        this.editTagMode = this.data.EDIT_TAG_MODE || '';
        this.editAlertHours = parseHours(this.data.EDIT_ALERT_HOURS, COUNT.EDIT_ALERT_HOURS_DEFAULT);
    }

    async reload(): Promise<void> { this.loaded = false; return this.load(true); }
    isLoaded(): boolean { return this.loaded; }
    getCountConfig() { return this.countConfig; }
    getRegistryConfig() { return this.registryConfig; }
    getWelcomeChannelId(): string { return this.welcomeChannelId; }
    getLogChannelId(): string { return this.logChannelId; }
    getLogtimeChannelId(): string { return this.logtimeChannelId; }
    getLogCaseChannelId(): string { return this.logCaseChannelId; }
    getBypdSendChannelId(): string { return this.bypdSendChannelId; }
    getCarrySendChannelId(): string { return this.carrySendChannelId; }
    getTake2SendChannelId(): string { return this.take2SendChannelId; }
    getLogTake2ChannelId(): string { return this.logTake2ChannelId; }
    getProctorSendChannelId(): string { return this.proctorSendChannelId; }
    getPendingSpreadsheetId(): string { return this.pendingSpreadsheetId; }
    getPendingSheetName(): string { return this.pendingSheetName; }
    getEditTagMode(): string { return this.editTagMode; }
    /** กี่ชั่วโมงที่ถือว่า "ยังอยู่ในกรอบที่คนแก้กันปกติ" — เกินกว่านี้แค่แจ้งเตือน ไม่ได้ห้าม */
    getEditAlertHours(): number { return this.editAlertHours; }
    async writeConfigKeys(updates: [string, string][]): Promise<void> {
        const rows = await sheetService.getValues(SHEETS.CONFIG_SHEET_ID, `${SHEETS.CONFIG_SHEET_NAME}!A:B`, 0);
        const map = new Map<string, string>();
        for (const row of rows) { if (row[0]) map.set(row[0], row[1] || ''); }
        for (const [key, value] of updates) map.set(key, value);
        const nextRows = Array.from(map.entries()).map(([k, v]) => [k, v]);
        await sheetService.updateValues(SHEETS.CONFIG_SHEET_ID, `${SHEETS.CONFIG_SHEET_NAME}!A1`, nextRows);
        // ใช้ข้อมูลที่เพิ่งเขียนเลย แทนการ reload อ่านซ้ำ — ลด 1 คำขอต่อการตั้งค่า
        this.applyRows(nextRows);
    }
}
export const configService = new ConfigService();