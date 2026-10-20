import { describe, it, expect } from 'vitest';
import { truncateNickname, makeFullName } from './member.service';

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
