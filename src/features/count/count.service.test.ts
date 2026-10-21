import { describe, it, expect } from 'vitest';
import { findRowById, ensureUserRow, buildCountUpdates, refreshDisplayName } from './count.service';
import type { TagInfo } from '../../types/discord';

const emptyRows: string[][] = [];

const headerOnlyRows = [
    [],
    [],
    ['ชื่อDC', 'User ID', 'Take2', 'คดีปกติ', 'รถยอด', 'คุมสอบ', 'อุ้มเอ๋อ'],
];

const existingRows = [
    [],
    [],
    ['ชื่อDC', 'User ID', 'Take2', 'คดีปกติ', 'รถยอด', 'คุมสอบ', 'อุ้มเอ๋อ'],
    ['John', '111', '5', '3', '0', '0', '0'],
    ['Alice', '222', '2', '1', '0', '0', '0'],
];

const legacyRows = [
    [],
    [],
    ['ชื่อDC', 'User ID', 'Take2', 'คดีปกติ', 'รถยอด', 'คุมสอบ', 'อุ้มเอ๋อ'],
    ['John', '', '5', '3', '0', '0', '0'],   // No User ID (old format)
];

describe('findRowById', () => {
    it('ควรเจอแถวโดย User ID ตรง', () => {
        const idx = findRowById(existingRows, '111');
        expect(idx).toBe(3);
    });

    it('ควรคืน -1 ถ้าไม่เจอ', () => {
        const idx = findRowById(existingRows, '999');
        expect(idx).toBe(-1);
    });

    it('ควรคืน -1 ถ้า rows ว่าง', () => {
        const idx = findRowById(emptyRows, '111');
        expect(idx).toBe(-1);
    });
});

describe('ensureUserRow', () => {
    it('ควรเจอแถวที่มี User ID ตรง', () => {
        const rows = structuredClone(existingRows) as string[][];
        const tag: TagInfo = { id: '111', nickname: 'John', username: 'john_usr' };
        const idx = ensureUserRow(rows, tag);
        expect(idx).toBe(3);
    });

    it('ควรเจอแถวโดยชื่อ (backward compat) และใส่ User ID ให้', () => {
        const rows = structuredClone(legacyRows) as string[][];
        const tag: TagInfo = { id: '111', nickname: 'John', username: 'john_usr' };
        const idx = ensureUserRow(rows, tag);
        expect(idx).toBe(3);
        expect(rows[3][1]).toBe('111');
    });

    it('ควรสร้างแถวใหม่ถ้าไม่เจอ', () => {
        const rows = structuredClone(headerOnlyRows) as string[][];
        const tag: TagInfo = { id: '333', nickname: 'NewPerson', username: 'new_usr' };
        const idx = ensureUserRow(rows, tag);
        expect(idx).toBe(3);
        expect(rows[3][0]).toBe('NewPerson');
        expect(rows[3][1]).toBe('333');
    });

    it('ไม่มีชื่อให้เทียบ แต่รหัสตรง → ต้องเจอแถวที่ถูกต้อง', () => {
        // ตอนหักยอดคนที่ถูกเอาแท็กออก เราจำไว้แค่รหัส ชื่ออาจว่างได้
        const rows = structuredClone(existingRows) as string[][];
        const tag: TagInfo = { id: '222', nickname: '', username: '' };
        expect(ensureUserRow(rows, tag)).toBe(4); // แถวของ Alice
    });

    it('ไม่มีชื่อและรหัสไม่ตรงใคร → ห้ามไปโดนแถวแรกมั่ว', () => {
        // ชื่อว่างเทียบแบบ "มีคำนี้อยู่ไหม" จะเป็นจริงกับทุกชื่อ
        // ถ้าไม่กันไว้ ยอดจะไปบวก/หักผิดคน
        const rows = structuredClone(existingRows) as string[][];
        const before = rows.length;
        const tag: TagInfo = { id: '999', nickname: '', username: '' };
        const idx = ensureUserRow(rows, tag);
        expect(idx).toBe(before);        // สร้างแถวใหม่ต่อท้าย
        expect(rows[3][0]).toBe('John'); // แถวเดิมต้องไม่ถูกแตะ
        expect(rows[4][0]).toBe('Alice');
    });
});

describe('buildCountUpdates', () => {
    const SHEET = 'ยอดเคส';

    it('ไม่มีอะไรเปลี่ยน → ไม่ต้องเขียนอะไรเลย', () => {
        const rows = structuredClone(existingRows) as string[][];
        const updates = buildCountUpdates(SHEET, rows, new Set(), rows.length, false);
        expect(updates).toEqual([]);
    });

    it('แก้แถวเดิม → เขียนเฉพาะแถวนั้น ไม่แตะแถวอื่น', () => {
        const rows = structuredClone(existingRows) as string[][];
        rows[4][3] = '9'; // Alice (แถวที่ 5 ของชีต) คอลัมน์ D
        const updates = buildCountUpdates(SHEET, rows, new Set([4]), rows.length, false);
        expect(updates).toHaveLength(1);
        expect(updates[0].range).toBe('ยอดเคส!A5:G5');
        expect(updates[0].values).toEqual([['Alice', '222', '2', '9', '0', '0', '0']]);
    });

    it('แก้หลายแถว → เรียงตามเลขแถว แยก range ละแถว', () => {
        const rows = structuredClone(existingRows) as string[][];
        const updates = buildCountUpdates(SHEET, rows, new Set([4, 3]), rows.length, false);
        expect(updates.map(u => u.range)).toEqual(['ยอดเคส!A4:G4', 'ยอดเคส!A5:G5']);
    });

    it('แถวใหม่ต่อท้าย → รวมเป็นบล็อกเดียว ไม่แตกเป็นรายแถว', () => {
        const rows = structuredClone(existingRows) as string[][];
        rows.push(['Bob', '333', '1', '', '', '', '']);
        rows.push(['Carol', '444', '', '1', '', '', '']);
        const updates = buildCountUpdates(SHEET, rows, new Set([5, 6]), 5, false);
        expect(updates).toHaveLength(1);
        expect(updates[0].range).toBe('ยอดเคส!A6:G7');
        expect(updates[0].values).toHaveLength(2);
    });

    it('แถวเดิม + แถวใหม่ → ได้ทั้งสองแบบในคำสั่งเดียว', () => {
        const rows = structuredClone(existingRows) as string[][];
        rows[3][2] = '6';
        rows.push(['Bob', '333', '1', '', '', '', '']);
        const updates = buildCountUpdates(SHEET, rows, new Set([3, 5]), 5, false);
        expect(updates.map(u => u.range)).toEqual(['ยอดเคส!A4:G4', 'ยอดเคส!A6:G6']);
    });

    it('เขียน header ใหม่ → ต้องลงแถวที่ 3 เสมอ', () => {
        const rows = structuredClone(headerOnlyRows) as string[][];
        const updates = buildCountUpdates(SHEET, rows, new Set(), rows.length, true);
        expect(updates).toHaveLength(1);
        expect(updates[0].range).toBe('ยอดเคส!A3:G3');
        expect(updates[0].values[0][0]).toBe('ชื่อDC');
    });

    it('แถวสั้นกว่า 7 ช่อง → เติมให้ครบ ไม่ส่งค่า undefined ไปที่ Sheet', () => {
        const rows: string[][] = [[], [], ['ชื่อDC', 'User ID'], ['Dave', '555']];
        rows[3][4] = '2'; // เขียนข้ามช่อง ทำให้ index 2,3 เป็นรูโหว่
        const updates = buildCountUpdates(SHEET, rows, new Set([3]), rows.length, false);
        expect(updates[0].values).toEqual([['Dave', '555', '', '', '2', '', '']]);
    });

    it('แถวใหม่ล้วน (ชีตเปล่า) → เริ่มที่แถว 4 ตามโครงสร้างชีต', () => {
        const rows: string[][] = [[], [], ['ชื่อDC', 'User ID', 'Take2', 'คดีปกติ', 'รถยอด', 'คุมสอบ', 'อุ้มเอ๋อ']];
        rows.push(['Eve', '666', '1', '', '', '', '']);
        const updates = buildCountUpdates(SHEET, rows, new Set([3]), 3, true);
        expect(updates.map(u => u.range)).toEqual(['ยอดเคส!A3:G3', 'ยอดเคส!A4:G4']);
    });
});

describe('นับได้แม้ไม่รู้ชื่อคน (คนที่ออกจากเซิร์ฟไปแล้ว)', () => {
    it('มีแถวอยู่แล้วและรหัสตรง → เจอแถวเดิม ไม่ต้องรู้ชื่อเลย', () => {
        const rows = structuredClone(existingRows) as string[][];
        const tag: TagInfo = { id: '222', nickname: '', username: '' };
        expect(ensureUserRow(rows, tag)).toBe(4);
        expect(rows.length).toBe(5); // ห้ามสร้างแถวเกินมา
    });

    it('ไม่มีแถวและไม่รู้ชื่อ → สร้างแถวใหม่โดยใส่เลขไอดีไว้ในช่องชื่อ ห้ามทิ้งยอด', () => {
        const rows = structuredClone(existingRows) as string[][];
        const tag: TagInfo = { id: '999', nickname: '', username: '' };
        const idx = ensureUserRow(rows, tag);
        expect(rows[idx][0]).toBe('999'); // ช่องชื่อใส่เลขไอดีไว้ก่อน ไม่ปล่อยว่าง
        expect(rows[idx][1]).toBe('999');
    });

    it('ชื่อเล่นว่างแต่มี username ที่ไม่ตรงใคร → ห้ามไปโดนแถวแรกมั่ว', () => {
        // includes('') เป็นจริงกับทุกชื่อ ถ้ากันแค่ตอนว่างทั้งคู่ ยอดจะไปบวกผิดคน
        const rows = structuredClone(existingRows) as string[][];
        const before = rows.length;
        const tag: TagInfo = { id: '999', nickname: '', username: 'zzz_ไม่ตรงใครเลย' };
        expect(ensureUserRow(rows, tag)).toBe(before);
        expect(rows[3][0]).toBe('John');
        expect(rows[4][0]).toBe('Alice');
    });

    it('ชื่อเล่นว่างแต่ username ตรงกับชื่อในชีต → ยังหาแถวเดิมเจอตามเดิม', () => {
        const rows = structuredClone(existingRows) as string[][];
        const tag: TagInfo = { id: '999', nickname: '', username: 'alice' };
        expect(ensureUserRow(rows, tag)).toBe(4);
    });
});

describe('refreshDisplayName — ช่องชื่อต้องตามชื่อเล่นในเซิร์ฟ', () => {
    /*
     * ของเดิมเขียนช่องชื่อครั้งเดียวตอนสร้างแถว แล้วไม่เคยอัปเดตอีก
     * ใครถูกนับยอดก่อนลงทะเบียน ชื่อบัญชี Discord จะคาอยู่ในชีตตลอดไป
     * กฎคือชื่อในชีตต้อง "ดีขึ้นหรือเท่าเดิม" ห้ามถอยหลังเป็นชื่อบัญชี
     */
    const nick = '00 [VES-PD] Real Yamada';
    const rowsWith = (name: string) => [[], [], [...headerOnlyRows[2]], [name, '111', '5', '', '', '', '']];

    it('ชื่อเล่นในระบบ + แถวเดิมเป็นชื่อ DC → เปลี่ยนให้เป็นชื่อเล่น', () => {
        const rows = rowsWith('RealYamada');
        const tag: TagInfo = { id: '111', nickname: nick, username: 'realyamada', hasGuildNickname: true };
        expect(refreshDisplayName(rows, 3, tag)).toBe(true);
        expect(rows[3][0]).toBe(nick);
        expect(rows[3].slice(1)).toEqual(['111', '5', '', '', '', '']); // ห้ามแตะยอด
    });

    it('ชื่อเหมือนเดิมอยู่แล้ว → ไม่นับว่าเปลี่ยน (กันเขียนชีตฟรี ๆ)', () => {
        const rows = rowsWith(nick);
        const tag: TagInfo = { id: '111', nickname: nick, username: 'realyamada', hasGuildNickname: true };
        expect(refreshDisplayName(rows, 3, tag)).toBe(false);
    });

    it('ชื่อที่ได้มาไม่ใช่ชื่อเล่นในเซิร์ฟ (ชื่อบัญชี/ชื่อ global) → ห้ามทับ', () => {
        const rows = rowsWith(nick);
        const tag: TagInfo = { id: '111', nickname: 'RealYamada', username: 'realyamada', hasGuildNickname: false };
        expect(refreshDisplayName(rows, 3, tag)).toBe(false);
        expect(rows[3][0]).toBe(nick);
    });

    it('คนออกจากเซิร์ฟไปแล้ว (ไม่มีชื่อเล่นให้ดึง) → คงชื่อเดิมในชีตไว้', () => {
        const rows = rowsWith(nick);
        const tag: TagInfo = { id: '111', nickname: '', username: '', hasGuildNickname: false };
        expect(refreshDisplayName(rows, 3, tag)).toBe(false);
        expect(rows[3][0]).toBe(nick);
    });

    it('คนนอกที่ตั้งชื่อเล่นอิสระ (ไม่ใช่รูปแบบในระบบ) → ไม่แตะชื่อเดิม', () => {
        const rows = rowsWith('Yamada');
        const tag: TagInfo = { id: '111', nickname: 'ป้าข้างบ้าน', username: 'aunty', hasGuildNickname: true };
        expect(refreshDisplayName(rows, 3, tag)).toBe(false);
        expect(rows[3][0]).toBe('Yamada');
    });

    it('ธงไม่ได้ถูกส่งมาเลย (ของเก่าที่ยังไม่รู้จักธง) → ถือว่าไม่ใช่ชื่อเล่น ห้ามทับ', () => {
        const rows = rowsWith('RealYamada');
        const tag: TagInfo = { id: '111', nickname: nick, username: 'realyamada' };
        expect(refreshDisplayName(rows, 3, tag)).toBe(false);
    });

    it('แถวที่ยังไม่มี 7 ช่อง → เขียนชื่อได้ ไม่พัง', () => {
        const rows: string[][] = [[], [], [...headerOnlyRows[2]], ['Old', '111']];
        const tag: TagInfo = { id: '111', nickname: nick, username: 'realyamada', hasGuildNickname: true };
        expect(refreshDisplayName(rows, 3, tag)).toBe(true);
        expect(rows[3]).toEqual([nick, '111']);
    });

    it('ชี้ไปที่แถวที่ไม่มีอยู่ → เงียบ ๆ ไม่ทำอะไร', () => {
        const rows = rowsWith(nick);
        const tag: TagInfo = { id: '111', nickname: nick, username: 'realyamada', hasGuildNickname: true };
        expect(refreshDisplayName(rows, 99, tag)).toBe(false);
    });

    it('แถวใหม่ที่เพิ่งสร้างด้วยชื่อเล่นอยู่แล้ว → ไม่ต้องเขียนซ้ำ', () => {
        const rows = structuredClone(headerOnlyRows) as string[][];
        const tag: TagInfo = { id: '777', nickname: nick, username: 'realyamada', hasGuildNickname: true };
        const idx = ensureUserRow(rows, tag);
        expect(rows[idx][0]).toBe(nick);
        expect(refreshDisplayName(rows, idx, tag)).toBe(false);
    });
});
