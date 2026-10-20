import { describe, it, expect } from 'vitest';
import { findRow, timeToMinutes, minutesToHHmm, getColumnByDate } from './logtime.service';

describe('timeToMinutes', () => {
    it('ควรแปลง HH:mm:ss เป็นนาที', () => {
        expect(timeToMinutes('08:30:00')).toBe(510);
    });

    it('ควรปัดเศษวินาที', () => {
        expect(timeToMinutes('01:00:30')).toBe(61);
    });

    it('ควรคืน 0 ถ้า input ว่าง', () => {
        expect(timeToMinutes('')).toBe(0);
    });
});

describe('minutesToHHmm', () => {
    it('ควรแปลงนาทีเป็น HH:mm', () => {
        expect(minutesToHHmm(510)).toBe('08:30');
    });

    it('ควรปัดเศษนาที', () => {
        expect(minutesToHHmm(61)).toBe('01:01');
    });

    it('ควรจัดการ 0 นาที', () => {
        expect(minutesToHHmm(0)).toBe('00:00');
    });
});

describe('getColumnByDate', () => {
    it('ควรคืน O สำหรับวันจันทร์ (01/06/2026)', () => {
        expect(getColumnByDate('01/06/2026')).toBe('O');
    });

    it('ควรคืน U สำหรับวันอาทิตย์ (07/06/2026)', () => {
        expect(getColumnByDate('07/06/2026')).toBe('U');
    });

    it('ควรคืน null สำหรับ null input', () => {
        expect(getColumnByDate('')).toBeNull();
    });
});

describe('findRow', () => {
    const mockRows = [
        [],
        [],
        ['001 [VES-PD] John', '', '', '', '', '', '', '', '', ''],         // index 2 (row 3)
        ['002 [VES-PD] Alice', '', '', '', '', '', '', '', '', 'steam:alice'], // index 3 (row 4) — has M (steam)
        ['003 [VES-PD] Bob', '', '', '', '', '', '', '', '', ''],              // index 4 (row 5)
        ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', 'Outsider', 'steam:outsider'], // index 5 (row 6) — has X+Y
    ];

    it('ควรเจอโดย Steam ID ก่อน (M column) — update_time', () => {
        const result = findRow(mockRows, 'Alice', 'steam:alice');
        expect(result.action).toBe('update_time');
        if (result.action === 'update_time') expect(result.row).toBe(4);
    });

    it('ควรเจอโดยชื่อ (D column, M ว่าง) — update_time_steam', () => {
        const result = findRow(mockRows, 'John');
        expect(result.action).toBe('update_time_steam');
        if (result.action === 'update_time_steam') expect(result.row).toBe(3);
    });

    it('ควรเจอโดยชื่อแม้ไม่ส่ง Steam ID', () => {
        const result = findRow(mockRows, 'Bob');
        expect(result.action).toBe('update_time_steam');
        if (result.action === 'update_time_steam') expect(result.row).toBe(5);
    });

    it('ควร skip ถ้าเจอใน X+Y', () => {
        const result = findRow(mockRows, 'Outsider', 'steam:outsider');
        expect(result.action).toBe('skip');
    });

    it('ควร create_new ถ้าไม่เจอใน D หรือ M หรือ X+Y', () => {
        const result = findRow(mockRows, 'NewPerson', 'steam:new');
        expect(result.action).toBe('create_new');
        if (result.action === 'create_new') expect(result.row).toBeGreaterThan(0);
    });

    it('ควร match ชื่อแบบย้อนกลับ (backward match)', () => {
        const shortRows = [
            [],
            [],
            ['001 [VES-PD] Jo', '', '', '', '', '', '', '', '', ''],
        ];
        const result = findRow(shortRows, 'John');
        expect(result.action).toBe('update_time_steam');
        if (result.action === 'update_time_steam') expect(result.row).toBe(3);
    });
});
