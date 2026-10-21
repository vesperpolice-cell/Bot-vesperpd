import { describe, it, expect } from 'vitest';
import { truncateNickname, makeFullName, isSystemNickname } from './member.service';

describe('makeFullName', () => {
    it('ควรสร้างชื่อเต็มตาม format', () => {
        expect(makeFullName('001', 'Somchai')).toBe('001 [VES-PD] Somchai');
    });
});

describe('truncateNickname', () => {
    it('ไม่ควรตัดถ้าชื่อสั้นกว่า 32', () => {
        const name = makeFullName('001', 'Som');
        expect(truncateNickname(name)).toBe(name);
    });

    it('ควรตัดเฉพาะส่วน IC ถ้าชื่อยาวเกิน 32', () => {
        const longIc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        const name = makeFullName('001', longIc);
        const result = truncateNickname(name);
        expect(result.length).toBeLessThanOrEqual(32);
        expect(result).toMatch(/^001 \[VES-PD\] /);
    });

    it('ควรคืนค่า 32 ตัวแรกถ้าไม่มี prefix', () => {
        const long = 'A'.repeat(50);
        expect(truncateNickname(long)).toBe(long.slice(0, 32));
    });
});

describe('isSystemNickname — ด่านกันไม่ให้ชื่อที่ไม่ใช่ของคนในไปทับชื่อในชีต', () => {
    it('ชื่อในระบบตามรูปแบบ → ผ่าน', () => {
        expect(isSystemNickname('00 [VES-PD] Real Yamada')).toBe(true);
        expect(isSystemNickname(makeFullName('001', 'Somchai'))).toBe(true);
    });

    it('ชื่อที่ถูกตัดตามลิมิต 32 ตัวอักษรของ Discord → ยังต้องผ่าน', () => {
        expect(isSystemNickname(truncateNickname(makeFullName('001', 'ก'.repeat(40))))).toBe(true);
    });

    it('ชื่อเล่นอิสระของคนนอก → ไม่ผ่าน', () => {
        expect(isSystemNickname('Real Yamada')).toBe(false);
        expect(isSystemNickname('ป้าข้างบ้าน')).toBe(false);
    });

    it('มีป้ายแต่ไม่มีรหัสนำหน้า → ไม่ผ่าน', () => {
        expect(isSystemNickname('[VES-PD] Real Yamada')).toBe(false);
    });

    it('มีป้ายแต่ไม่มีชื่อตามหลัง → ไม่ผ่าน', () => {
        expect(isSystemNickname('00 [VES-PD]')).toBe(false);
        expect(isSystemNickname('00 [VES-PD] ')).toBe(false);
    });

    it('ค่าว่าง → ไม่ผ่าน (ห้ามล้างชื่อในชีตทิ้ง)', () => {
        expect(isSystemNickname('')).toBe(false);
        expect(isSystemNickname('   ')).toBe(false);
    });
});
