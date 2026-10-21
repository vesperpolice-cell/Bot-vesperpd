import { describe, it, expect } from 'vitest';
import { displayNameOf, resolveName, UNKNOWN_NAME, type NameSource, type ResolvedName } from './name-resolver';

describe('resolveName — ไล่หาชื่อ 3 ทาง', () => {
    const NAME: ResolvedName = { nickname: '30 [VES-PD] Ralph Shelby', username: 'ralph', hasGuildNickname: true };
    const ALT: ResolvedName = { nickname: 'ralph', username: 'ralph', hasGuildNickname: false };

    /** นับว่าแต่ละทางถูกเรียกกี่ครั้ง เพื่อยืนยันว่าไม่ยิง Discord เกินจำเป็น */
    const makeSrc = (local: ResolvedName | null, member: ResolvedName | null, user: ResolvedName | null) => {
        const calls = { local: 0, member: 0, user: 0 };
        const src: NameSource = {
            local: () => { calls.local++; return local; },
            member: async () => { calls.member++; return member; },
            user: async () => { calls.user++; return user; },
        };
        return { src, calls };
    };

    it('สมุดในเครื่องมีชื่อ → ใช้เลย ห้ามยิงถาม Discord', async () => {
        const { src, calls } = makeSrc(NAME, null, null);
        await expect(resolveName(src, '111')).resolves.toEqual(NAME);
        expect(calls.member).toBe(0);
        expect(calls.user).toBe(0);
    });

    it('สมุดไม่มี แต่ถาม Discord เรื่องสมาชิกได้ → ใช้ชื่อนั้น ไม่ต้องถามบัญชีต่อ', async () => {
        const { src, calls } = makeSrc(null, NAME, ALT);
        await expect(resolveName(src, '111')).resolves.toEqual(NAME);
        expect(calls.member).toBe(1);
        expect(calls.user).toBe(0);
    });

    it('ออกจากเซิร์ฟแล้ว (ไม่ใช่สมาชิก) → ยังได้ชื่อจากบัญชีผู้ใช้', async () => {
        const { src, calls } = makeSrc(null, null, ALT);
        await expect(resolveName(src, '111')).resolves.toEqual(ALT);
        expect(calls.user).toBe(1);
    });

    it('ไม่ได้เลยทั้ง 3 ทาง → คืนค่าว่าง (ตัวเรียกต้องนับยอดให้อยู่ดี)', async () => {
        const { src } = makeSrc(null, null, null);
        await expect(resolveName(src, '111')).resolves.toEqual(UNKNOWN_NAME);
    });

    it('ลำดับต้องเป็น สมุด → สมาชิก → บัญชี เสมอ', async () => {
        const order: string[] = [];
        const src: NameSource = {
            local: () => { order.push('local'); return null; },
            member: async () => { order.push('member'); return null; },
            user: async () => { order.push('user'); return null; },
        };
        await resolveName(src, '111');
        expect(order).toEqual(['local', 'member', 'user']);
    });
});

describe('displayNameOf — ต้องบอกให้ได้ว่าชื่อนี้เป็นชื่อเล่นในเซิร์ฟจริงไหม', () => {
    /*
     * ธงนี้เป็นตัวตัดสินว่าจะเอาชื่อไปอัปเดตช่องชื่อในชีตได้ไหม (ดู refreshDisplayName)
     * ถ้าธงเพี้ยน ชื่อบัญชี Discord จะไปทับชื่อในระบบที่ดีอยู่แล้ว
     */
    const member = (nickname: string | null, displayName: string, username: string) =>
        ({ nickname, displayName, user: { username } });

    it('มีชื่อเล่นในเซิร์ฟ → ใช้ชื่อเล่นนั้น และปักธงว่าเป็นชื่อเล่นจริง', () => {
        expect(displayNameOf(member('00 [VES-PD] Real Yamada', 'Yamada', 'yamada'))).toEqual({
            nickname: '00 [VES-PD] Real Yamada',
            username: 'yamada',
            hasGuildNickname: true,
        });
    });

    it('ไม่มีชื่อเล่น → ได้ชื่อ global มาใช้ แต่ห้ามปักธง', () => {
        expect(displayNameOf(member(null, 'Yamada', 'yamada'))).toEqual({
            nickname: 'Yamada',
            username: 'yamada',
            hasGuildNickname: false,
        });
    });

    it('ไม่มีทั้งชื่อเล่นและชื่อ global → ตกไปใช้ชื่อบัญชี และห้ามปักธง', () => {
        expect(displayNameOf(member(null, '', 'yamada'))).toEqual({
            nickname: 'yamada',
            username: 'yamada',
            hasGuildNickname: false,
        });
    });

    it('ชื่อเล่นเป็นช่องว่างล้วน → ไม่ถือว่ามีชื่อเล่น', () => {
        expect(displayNameOf(member('   ', 'Yamada', 'yamada'))).toEqual({
            nickname: 'Yamada',
            username: 'yamada',
            hasGuildNickname: false,
        });
    });

    it('ตัดช่องว่างหัวท้ายของชื่อเล่นออก', () => {
        expect(displayNameOf(member('  00 [VES-PD] Real Yamada  ', 'Yamada', 'yamada')).nickname)
            .toBe('00 [VES-PD] Real Yamada');
    });
});
