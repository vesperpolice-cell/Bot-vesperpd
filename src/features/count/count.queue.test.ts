import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { TagInfo } from '../../types/discord';

vi.mock('../../core/sheet.service', () => ({
    sheetService: {
        getValues: vi.fn(),
        batchUpdateValues: vi.fn(),
        updateValues: vi.fn(),
    },
}));

vi.mock('../../core/config.service', () => ({
    configService: {
        getCountConfig: () => ({
            SPREADSHEET_ID: 'sheet-1',
            SHEET_NAME: 'ยอดเคส',
            CHANNELS: { CHANNEL_1: 'ch1', CHANNEL_2: '', CHANNEL_3: '', CHANNEL_4: '', CHANNEL_5: '' },
        }),
    },
}));

import { processCountBatch, flushPendingCounts, pendingCountOps, flushDelayFor } from './count.service';
import { sheetService } from '../../core/sheet.service';

const getValues = sheetService.getValues as Mock;
const batchUpdate = sheetService.batchUpdateValues as Mock;

const HEADER = ['ชื่อDC', 'User ID', 'Take2', 'คดีปกติ', 'รถยอด', 'คุมสอบ', 'อุ้มเอ๋อ'];
const emptySheet = () => [[], [], [...HEADER]];
const tag = (id: string): TagInfo => ({ id, nickname: `เจ้าหน้าที่${id}`, username: `user${id}` });

beforeEach(async () => {
    // ล้างคิวที่ค้างจากเทสก่อนหน้า ไม่ให้ปนกัน
    getValues.mockResolvedValue(emptySheet());
    batchUpdate.mockResolvedValue(undefined);
    try { await flushPendingCounts(); } catch { /* ไม่สนใจ */ }
    vi.clearAllMocks();
    getValues.mockResolvedValue(emptySheet());
    batchUpdate.mockResolvedValue(undefined);
});

describe('คิวนับเคส — เขียนชีตไม่สำเร็จต้องไม่ทำยอดหาย', () => {
    it('เขียนสำเร็จ → คิวว่าง และเขียนลงชีตจริง', async () => {
        await processCountBatch([tag('111')], 'ch1', false);
        expect(pendingCountOps()).toBe(1);

        await flushPendingCounts();

        expect(pendingCountOps()).toBe(0);
        expect(batchUpdate).toHaveBeenCalledTimes(1);
    });

    it('อ่านชีตไม่ได้ → ยอดต้องยังอยู่ในคิว ไม่หายไป', async () => {
        getValues.mockRejectedValue(new Error('Google ล่ม'));

        await processCountBatch([tag('111')], 'ch1', false);
        await expect(flushPendingCounts()).rejects.toThrow('Google ล่ม');

        expect(pendingCountOps()).toBe(1);
    });

    it('เขียนชีตไม่ได้ → ยอดต้องยังอยู่ในคิว ไม่หายไป', async () => {
        batchUpdate.mockRejectedValue(new Error('โควต้าเต็ม'));

        await processCountBatch([tag('111'), tag('222')], 'ch1', false);
        await expect(flushPendingCounts()).rejects.toThrow('โควต้าเต็ม');

        expect(pendingCountOps()).toBe(2);
    });

    it('พลาดรอบแรก สำเร็จรอบสอง → ยอดต้องครบเท่าเดิม', async () => {
        getValues.mockRejectedValueOnce(new Error('เน็ตสะดุด'));

        await processCountBatch([tag('111')], 'ch1', false);
        await expect(flushPendingCounts()).rejects.toThrow('เน็ตสะดุด');
        expect(pendingCountOps()).toBe(1);

        await flushPendingCounts();
        expect(pendingCountOps()).toBe(0);

        // ยอดที่เขียนลงชีตต้องเป็น 1 ครั้ง ไม่ใช่หายไปหรือกลายเป็น 0
        const updates = batchUpdate.mock.calls[0][1];
        const written = updates.flatMap((u: { values: string[][] }) => u.values);
        expect(written.some((row: string[]) => row[1] === '111' && row[2] === '1')).toBe(true);
    });

    it('ยอดที่เข้ามาระหว่างรอ ต้องรวมกับของเดิม ไม่ทับกัน', async () => {
        getValues.mockRejectedValueOnce(new Error('ล่ม'));

        await processCountBatch([tag('111')], 'ch1', false);
        await expect(flushPendingCounts()).rejects.toThrow();

        await processCountBatch([tag('222')], 'ch1', false);
        expect(pendingCountOps()).toBe(2);

        await flushPendingCounts();
        expect(pendingCountOps()).toBe(0);
    });
});

describe('หักยอด — ต้องไม่สร้างแถวขยะ', () => {
    it('หักยอดคนที่ไม่มีแถวในชีต → ต้องข้ามไปเฉย ๆ ไม่สร้างแถวใหม่', async () => {
        // เกิดตอนหักยอดคนที่ออกจากเซิร์ฟไปแล้ว (เราจำไว้แค่รหัส ไม่มีชื่อ)
        // หรือแถวถูกลบออกจากชีตด้วยมือไปก่อน
        await processCountBatch([{ id: '999', nickname: '', username: '' }], 'ch1', true);
        await flushPendingCounts();

        // ไม่มีแถวให้หัก = ไม่ต้องเขียนอะไรลงชีตเลย
        expect(batchUpdate).not.toHaveBeenCalled();
    });

    it('หักยอดคนที่มีแถวอยู่ → หักได้ปกติ', async () => {
        getValues.mockResolvedValue([
            [], [], [...HEADER],
            ['เจ้าหน้าที่111', '111', '5', '', '', '', ''],
        ]);
        await processCountBatch([{ id: '111', nickname: '', username: '' }], 'ch1', true);
        await flushPendingCounts();

        const updates = batchUpdate.mock.calls[0][1];
        const written = updates.flatMap((u: { values: string[][] }) => u.values);
        expect(written.some((row: string[]) => row[1] === '111' && row[2] === '4')).toBe(true);
    });
});

describe('ช่องชื่อในชีต — ต้องตามชื่อเล่นที่ตั้งในเซิร์ฟ', () => {
    const NICK = '00 [VES-PD] Real Yamada';
    const writtenRows = () => {
        const updates = batchUpdate.mock.calls[0][1];
        return updates.flatMap((u: { values: string[][] }) => u.values) as string[][];
    };

    it('แถวเดิมเป็นชื่อบัญชี + คนนั้นมีชื่อในระบบแล้ว → เขียนชื่อใหม่ลงชีตพร้อมยอด', async () => {
        // เคสจริงที่เจอ: ถูกนับยอดก่อนลงทะเบียน ชื่อบัญชีจึงคาอยู่ในชีต
        getValues.mockResolvedValue([[], [], [...HEADER], ['RealYamada', '111', '5', '', '', '', '']]);

        await processCountBatch(
            [{ id: '111', nickname: NICK, username: 'realyamada', hasGuildNickname: true }],
            'ch1',
            false,
        );
        await flushPendingCounts();

        expect(writtenRows().some(row => row[0] === NICK && row[1] === '111' && row[2] === '6')).toBe(true);
    });

    it('หาได้แต่ชื่อบัญชี (ออกจากเซิร์ฟ/ยังไม่มีชื่อเล่น) → ชื่อในชีตต้องไม่ถูกทับ', async () => {
        getValues.mockResolvedValue([[], [], [...HEADER], [NICK, '111', '5', '', '', '', '']]);

        await processCountBatch(
            [{ id: '111', nickname: 'realyamada', username: 'realyamada', hasGuildNickname: false }],
            'ch1',
            false,
        );
        await flushPendingCounts();

        expect(writtenRows().some(row => row[0] === NICK && row[2] === '6')).toBe(true);
    });

    it('แถวใหม่ของคนที่มีชื่อในระบบ → ได้ชื่อเล่นตั้งแต่แถวแรก ไม่ใช่ชื่อบัญชี', async () => {
        await processCountBatch(
            [{ id: '777', nickname: NICK, username: 'realyamada', hasGuildNickname: true }],
            'ch1',
            false,
        );
        await flushPendingCounts();

        expect(writtenRows().some(row => row[0] === NICK && row[1] === '777' && row[2] === '1')).toBe(true);
    });
});

describe('flushDelayFor — ถอยห่างขึ้นเรื่อย ๆ เมื่อพลาดติดกัน', () => {
    it('ยิ่งพลาดยิ่งรอนานขึ้น', () => {
        expect(flushDelayFor(0)).toBe(3000);
        expect(flushDelayFor(1)).toBe(6000);
        expect(flushDelayFor(2)).toBe(12000);
        expect(flushDelayFor(3)).toBe(24000);
        expect(flushDelayFor(4)).toBe(48000);
    });

    it('มีเพดาน ไม่ถอยห่างไปเรื่อย ๆ จนไม่ยอมลองใหม่', () => {
        expect(flushDelayFor(10)).toBe(48000);
        expect(flushDelayFor(999)).toBe(48000);
    });
});
