import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../core/sheet.service', () => ({
    sheetService: {
        getValues: vi.fn(),
        batchUpdateValues: vi.fn(),
        updateValues: vi.fn(),
    },
}));

vi.mock('../../core/config.service', () => ({
    configService: {
        getRegistryConfig: () => registryConfig,
        getPendingSpreadsheetId: () => pendingConfig.spreadsheetId,
        getPendingSheetName: () => pendingConfig.sheetName,
    },
}));

vi.mock('../../core/logger', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
    findEmptyRegistrySlot,
    findDynamicRegistrySlot,
    formatRegistrationDate,
    buildRegistrationUpdates,
    columnContainsUserId,
    findRejoinableRow,
    findRegistryRowByDiscordId,
    findPendingEntry,
    registerMember,
    isAlreadyRegistered,
    findMemberByDiscordId,
    checkPendingStatus,
    checkPreApproved,
} from './welcome.service';
import { sheetService } from '../../core/sheet.service';

// config ที่ mock ไว้อ่านจากตัวแปรสองตัวนี้ เทสแต่ละอันปรับได้ตามต้องการ
let registryConfig = { spreadsheetId: 'reg-1', sheetName: 'NamePD', outSheetName: '' };
let pendingConfig = { spreadsheetId: 'pending-1', sheetName: 'Pending' };

const getValues = sheetService.getValues as Mock;
const batchUpdate = sheetService.batchUpdateValues as Mock;

/** ตอบข้อมูลตาม range ที่ถูกขอ — range ที่ไม่ได้กำหนดไว้ถือว่าว่าง */
function sheetData(data: Record<string, string[][]>): void {
    getValues.mockImplementation(async (_id: string, range: string) => data[range] ?? []);
}

beforeEach(() => {
    vi.clearAllMocks();
    registryConfig = { spreadsheetId: 'reg-1', sheetName: 'NamePD', outSheetName: '' };
    pendingConfig = { spreadsheetId: 'pending-1', sheetName: 'Pending' };
    getValues.mockResolvedValue([]);
    batchUpdate.mockResolvedValue(undefined);
});

// ===========================================================================
// ส่วนที่ 1 — ตัดสินใจล้วน ๆ ไม่แตะ Google
// ===========================================================================

describe('findEmptyRegistrySlot — หาที่ว่างสำหรับคนใหม่', () => {
    it('เจอแถวแรกที่มีรหัสแต่ยังไม่มีชื่อ', () => {
        const rows = [[], [], ['101', 'สมชาย'], ['102', ''], ['103', '']];
        expect(findEmptyRegistrySlot(rows)).toEqual({ row: 4, code: '102' });
    });

    it('ห้ามแตะสองแถวแรกเด็ดขาด — เป็นหัวตาราง ไม่ใช่ข้อมูล', () => {
        // ถ้าลูปเริ่มผิดที่ (i=0 หรือ i=1) เทสนี้จะจับได้ทันที
        // พลาดตรงนี้ = เขียนข้อมูลคนใหม่ทับหัวตาราง
        const rows = [['รหัส', ''], ['—', ''], ['101', '']];
        expect(findEmptyRegistrySlot(rows)).toEqual({ row: 3, code: '101' });
    });

    it('ชื่อที่มีแต่ช่องว่างถือว่าว่าง', () => {
        const rows = [[], [], ['101', '   ']];
        expect(findEmptyRegistrySlot(rows)).toEqual({ row: 3, code: '101' });
    });

    it('ช่องชื่อไม่มีเลย (แถวสั้น) ถือว่าว่าง', () => {
        const rows = [[], [], ['101']];
        expect(findEmptyRegistrySlot(rows)).toEqual({ row: 3, code: '101' });
    });

    it('ไม่มีรหัส = ข้ามไป ไม่ใช่ที่ว่าง', () => {
        const rows = [[], [], ['', ''], ['102', '']];
        expect(findEmptyRegistrySlot(rows)).toEqual({ row: 4, code: '102' });
    });

    it('เต็มหมดทุกแถว → null', () => {
        const rows = [[], [], ['101', 'สมชาย'], ['102', 'สมหญิง']];
        expect(findEmptyRegistrySlot(rows)).toBeNull();
    });

    it('ชีตเปล่า / มีแต่หัวตาราง → null', () => {
        expect(findEmptyRegistrySlot([])).toBeNull();
        expect(findEmptyRegistrySlot([[], []])).toBeNull();
    });

    it('ตัดช่องว่างรอบรหัสออก', () => {
        const rows = [[], [], ['  105  ', '']];
        expect(findEmptyRegistrySlot(rows)).toEqual({ row: 3, code: '105' });
    });
});

describe('findDynamicRegistrySlot — ที่ว่างจากช่วงที่อ่านเพิ่มต่อท้าย', () => {
    it('นับเลขแถวต่อจากช่วงที่อ่านไปแล้วถูกต้อง', () => {
        // อ่าน C:D ได้ 10 แถว แล้วอ่านเพิ่ม C11:C30 → แถวที่ 2 ของช่วงใหม่ = แถว 12 ของชีต
        const dyn = [[''], ['201'], ['202']];
        expect(findDynamicRegistrySlot(dyn, 10)).toEqual({ row: 12, code: '201' });
    });

    it('แถวแรกของช่วงใหม่มีรหัสเลย', () => {
        expect(findDynamicRegistrySlot([['301']], 50)).toEqual({ row: 51, code: '301' });
    });

    it('ช่วงใหม่ว่างเปล่า → null', () => {
        expect(findDynamicRegistrySlot([], 10)).toBeNull();
        expect(findDynamicRegistrySlot([[''], ['']], 10)).toBeNull();
    });

    it('ตัดช่องว่างรอบรหัสออก', () => {
        expect(findDynamicRegistrySlot([[' 401 ']], 5)).toEqual({ row: 6, code: '401' });
    });
});

describe('findRejoinableRow — คนเก่าที่ออกจาก Discord แล้วกลับมา', () => {
    /** แถวเต็ม C:N — index 0 = C (รหัส), 2 = E (mention), 11 = N (สถานะ) */
    const row = (code: string, name: string, mention: string, status = '') => {
        const r = new Array(12).fill('');
        r[0] = code; r[1] = name; r[2] = mention; r[11] = status;
        return r;
    };

    it('เจอแถวที่ ID ตรงกันและสถานะบอกว่าออกจาก Discord', () => {
        const rows = [[], [], row('101', 'สมชาย', '<@111>'), row('102', 'สมหญิง', '<@222>', 'ออกจาก Discord')];
        expect(findRejoinableRow(rows, '222')).toEqual({ row: 4, code: '102' });
    });

    it('ยังอยู่ในกรม (สถานะว่าง) → ไม่ใช่คนกลับมา จะได้ไม่ถูกเขียนทับชื่อตัวเอง', () => {
        const rows = [[], [], row('101', 'สมชาย', '<@111>')];
        expect(findRejoinableRow(rows, '111')).toBeNull();
    });

    it('สถานะเป็นเหตุผลออกแบบอื่น → ไม่ให้กลับมาเอง ต้องผ่านแอดมิน', () => {
        const rows = [[], [], row('101', 'สมชาย', '<@111>', 'ถูกปลดออก')];
        expect(findRejoinableRow(rows, '111')).toBeNull();
    });

    it('คนละ ID → ไม่คืนแถวของคนอื่น', () => {
        const rows = [[], [], row('101', 'สมชาย', '<@111>', 'ออกจาก Discord')];
        expect(findRejoinableRow(rows, '999')).toBeNull();
    });

    it('ข้ามสองแถวแรกที่เป็นหัวตาราง', () => {
        const rows = [row('C', 'D', '<@111>', 'ออกจาก Discord'), row('x', 'y', '<@111>', 'ออกจาก Discord')];
        expect(findRejoinableRow(rows, '111')).toBeNull();
    });

    it('แถวไม่มีรหัส → ข้าม ถึงจะมี ID กับสถานะตรงก็ตาม', () => {
        const rows = [[], [], row('', 'สมชาย', '<@111>', 'ออกจาก Discord')];
        expect(findRejoinableRow(rows, '111')).toBeNull();
    });
});

describe('formatRegistrationDate — วันที่แบบที่ชีตใช้', () => {
    it('ไม่เติมศูนย์นำหน้า', () => {
        expect(formatRegistrationDate(new Date(2026, 2, 5))).toBe('5/3/2026');
    });

    it('เลขสองหลักปกติ', () => {
        expect(formatRegistrationDate(new Date(2026, 11, 31))).toBe('31/12/2026');
    });

    it('มกราคมต้องเป็น 1 ไม่ใช่ 0', () => {
        expect(formatRegistrationDate(new Date(2026, 0, 1))).toBe('1/1/2026');
    });
});

describe('buildRegistrationUpdates — เขียนลงช่องไหน', () => {
    const updates = buildRegistrationUpdates('NamePD', 7, '555-1234', '102 [VES-PD] สมหญิง', '123456789012345678', '28/9/2026');

    it('เขียน 3 ช่วงเท่านั้น ไม่มากไม่น้อย', () => {
        expect(updates).toHaveLength(3);
    });

    it('เบอร์โทรลงคอลัมน์ B ของแถวที่ถูกต้อง', () => {
        expect(updates[0]).toEqual({ range: 'NamePD!B7', values: [['555-1234']] });
    });

    it('ชื่อลง D และ mention ลง E ในครั้งเดียว', () => {
        expect(updates[1].range).toBe('NamePD!D7:E7');
        expect(updates[1].values[0][0]).toBe('102 [VES-PD] สมหญิง');
    });

    it('mention ต้องมี \' นำหน้า ไม่งั้น Google ตีความเป็นสูตร', () => {
        expect(updates[1].values[0][1]).toBe("'<@123456789012345678>");
    });

    it('วันที่ลงคอลัมน์ H', () => {
        expect(updates[2]).toEqual({ range: 'NamePD!H7', values: [['28/9/2026']] });
    });

    it('ทุกช่วงต้องอ้างแถวเดียวกันหมด — เขียนคนละแถวคือข้อมูลปนกัน', () => {
        for (const u of buildRegistrationUpdates('NamePD', 42, 'x', 'y', 'z', 'd')) {
            expect(u.range).toMatch(/42/);
        }
    });

    it('เปลี่ยนชื่อชีตแล้ว range ต้องเปลี่ยนตาม', () => {
        const other = buildRegistrationUpdates('ทะเบียนใหม่', 3, '', '', '', '');
        expect(other.every(u => u.range.startsWith('ทะเบียนใหม่!'))).toBe(true);
    });
});

describe('columnContainsUserId — ID นี้อยู่ในคอลัมน์ไหม', () => {
    const rows = [['<@111111111111111111>'], ['<@222222222222222222>'], ['']];

    it('เจอ ID ที่อยู่ในรูป mention', () => {
        expect(columnContainsUserId(rows, '222222222222222222')).toBe(true);
    });

    it('ไม่เจอ → false', () => {
        expect(columnContainsUserId(rows, '999999999999999999')).toBe(false);
    });

    it('คอลัมน์เปล่า → false ไม่พัง', () => {
        expect(columnContainsUserId([], '111')).toBe(false);
        expect(columnContainsUserId([[], ['']], '111')).toBe(false);
    });
});

describe('findRegistryRowByDiscordId — หาแถวของคนคนนี้', () => {
    const rows = [
        [],
        [],
        ['101', 'สมชาย', '<@111111111111111111>'],
        ['102', 'สมหญิง', '<@222222222222222222>'],
    ];

    it('เจอแถวพร้อมรหัสและชื่อปัจจุบัน', () => {
        expect(findRegistryRowByDiscordId(rows, '222222222222222222'))
            .toEqual({ row: 4, codeNumber: '102', currentName: 'สมหญิง' });
    });

    it('ห้ามแตะสองแถวแรก', () => {
        const withHeader = [['x', 'y', '<@111111111111111111>'], [], ['101', 'สมชาย', '<@111111111111111111>']];
        expect(findRegistryRowByDiscordId(withHeader, '111111111111111111')?.row).toBe(3);
    });

    it('ไม่เจอ → null', () => {
        expect(findRegistryRowByDiscordId(rows, '999999999999999999')).toBeNull();
    });

    it('แถวที่ยังไม่มีชื่อ → currentName เป็นค่าว่าง ไม่ใช่ undefined', () => {
        const partial = [[], [], ['103', '', '<@333333333333333333>']];
        expect(findRegistryRowByDiscordId(partial, '333333333333333333'))
            .toEqual({ row: 3, codeNumber: '103', currentName: '' });
    });
});

describe('findPendingEntry — คิวรออนุมัติ', () => {
    const rows = [
        ['ลำดับ', 'Discord ID', '?', 'ชื่อ IC', 'เบอร์', 'อายุ', '?', 'สถานะ'],
        ['1', '111111111111111111', '', 'สมชาย', '555-0001', '25', '', 'อนุมัติ'],
        ['2', '222222222222222222', '', 'สมหญิง', '555-0002', '30', '', 'รออนุมัติ'],
    ];

    it('เจอแล้วดึงข้อมูลออกมาจากคอลัมน์ที่ถูกต้อง', () => {
        expect(findPendingEntry(rows, '111111111111111111')).toEqual({
            found: true, status: 'อนุมัติ', icName: 'สมชาย', icPhone: '555-0001', ocAge: '25',
        });
    });

    it('คนที่ยังไม่อนุมัติก็เจอ แต่สถานะไม่ใช่อนุมัติ', () => {
        expect(findPendingEntry(rows, '222222222222222222').status).toBe('รออนุมัติ');
    });

    it('ห้ามแตะแถวหัวตาราง', () => {
        expect(findPendingEntry(rows, 'Discord ID')).toEqual({ found: false });
    });

    it('ไม่เจอ → found: false', () => {
        expect(findPendingEntry(rows, '999999999999999999')).toEqual({ found: false });
    });

    it('เทียบ ID แบบตรงเป๊ะ ไม่ใช่แค่มีอยู่บางส่วน', () => {
        expect(findPendingEntry(rows, '1111').found).toBe(false);
    });

    it('แถวสั้นไม่มีคอลัมน์สถานะ → ได้ค่าว่าง ไม่พัง', () => {
        const short = [['หัว'], ['1', '111111111111111111']];
        expect(findPendingEntry(short, '111111111111111111'))
            .toEqual({ found: true, status: '', icName: '', icPhone: '', ocAge: '' });
    });
});

// ===========================================================================
// ส่วนที่ 2 — ทำงานร่วมกับ Google (ปลอม) ตั้งแต่อ่านจนเขียน
// ===========================================================================

describe('registerMember — ลงทะเบียนจริงตั้งแต่ต้นจนจบ', () => {
    it('เขียนเบอร์ / ชื่อ / mention / วันที่ ลงแถวที่ถูกต้อง', async () => {
        sheetData({
            'NamePD!E:E': [['<@999999999999999999>']],
            'NamePD!C:N': [[], [], ['101', 'สมชาย'], ['102', '']],
        });

        const result = await registerMember('สมหญิง', '123456789012345678', '555-1234');

        expect(result).toEqual({ nickname: '102 [VES-PD] สมหญิง', wasTruncated: false });
        expect(batchUpdate).toHaveBeenCalledTimes(1);

        const [spreadsheetId, updates] = batchUpdate.mock.calls[0];
        expect(spreadsheetId).toBe('reg-1');
        expect(updates[0]).toEqual({ range: 'NamePD!B4', values: [['555-1234']] });
        expect(updates[1].range).toBe('NamePD!D4:E4');
        expect(updates[1].values[0]).toEqual(['102 [VES-PD] สมหญิง', "'<@123456789012345678>"]);
        expect(updates[2]).toEqual({ range: 'NamePD!H4', values: [[formatRegistrationDate(new Date())]] });
    });

    it('สมัครซ้ำ → ไม่เขียนอะไรลงชีตเลย', async () => {
        sheetData({
            'NamePD!E:E': [['<@123456789012345678>']],
            'NamePD!C:N': [[], [], ['102', '']],
        });

        expect(await registerMember('สมหญิง', '123456789012345678', '555')).toBeNull();
        expect(batchUpdate).not.toHaveBeenCalled();
    });

    it('เคยอยู่ใน OutDC → นับเป็นสมัครซ้ำ ไม่เขียนทับ', async () => {
        registryConfig = { spreadsheetId: 'reg-1', sheetName: 'NamePD', outSheetName: 'OutDC' };
        sheetData({
            'NamePD!E:E': [],
            'OutDC!E:E': [['<@123456789012345678>']],
            'NamePD!C:N': [[], [], ['102', '']],
        });

        expect(await registerMember('สมหญิง', '123456789012345678', '555')).toBeNull();
        expect(batchUpdate).not.toHaveBeenCalled();
    });

    it('ไม่มีแถวว่างที่มีรหัส → ไม่เขียน และคืน null', async () => {
        sheetData({
            'NamePD!E:E': [],
            'NamePD!C:N': [[], [], ['101', 'สมชาย'], ['102', 'สมหญิง']],
        });

        expect(await registerMember('สมศักดิ์', '123456789012345678', '555')).toBeNull();
        expect(batchUpdate).not.toHaveBeenCalled();
    });

    it('C:D ไม่มีที่ว่าง → ต้องอ่านช่วงต่อท้ายแล้วใช้แถวนั้น', async () => {
        sheetData({
            'NamePD!E:E': [],
            'NamePD!C:N': [[], [], ['101', 'สมชาย']],   // 3 แถว เต็มหมด
            'NamePD!C4:C23': [['104']],                  // รหัสถูกเติมไว้เกินช่วงแรก
        });

        const result = await registerMember('สมปอง', '123456789012345678', '555');

        expect(result?.nickname).toBe('104 [VES-PD] สมปอง');
        expect(batchUpdate.mock.calls[0][1][0].range).toBe('NamePD!B4');
    });

    it('ชื่อยาวเกิน 32 ตัว → ตัดให้พอดี และบอกว่าถูกตัด', async () => {
        sheetData({
            'NamePD!E:E': [],
            'NamePD!C:N': [[], [], ['102', '']],
        });

        const longName = 'สมหญิงศรีสวัสดิ์วัฒนาพงศ์เจริญรุ่งเรืองยิ่ง';
        const result = await registerMember(longName, '123456789012345678', '555');

        expect(result?.wasTruncated).toBe(true);
        expect(result!.nickname.length).toBeLessThanOrEqual(32);
        // ชื่อที่เขียนลงชีตต้องเป็นตัวที่ถูกตัดแล้ว ไม่ใช่ตัวเต็ม
        expect(batchUpdate.mock.calls[0][1][1].values[0][0]).toBe(result!.nickname);
    });

    it('ยังไม่ได้ตั้งค่าชีตทะเบียน → ไม่เขียน และคืน null', async () => {
        registryConfig = { spreadsheetId: '', sheetName: '', outSheetName: '' };

        expect(await registerMember('สมหญิง', '123456789012345678', '555')).toBeNull();
        expect(batchUpdate).not.toHaveBeenCalled();
    });

    it('เขียนชีตไม่สำเร็จ → คืน null ไม่โยน error ออกมาให้บอทล้ม', async () => {
        sheetData({
            'NamePD!E:E': [],
            'NamePD!C:N': [[], [], ['102', '']],
        });
        batchUpdate.mockRejectedValue(new Error('โควต้าเต็ม'));

        await expect(registerMember('สมหญิง', '123456789012345678', '555')).resolves.toBeNull();
    });

    it('ออกจาก Discord แล้วกลับมา → ได้แถวและรหัสเดิมคืน ไม่ใช่ "สมัครซ้ำ"', async () => {
        const left = new Array(12).fill('');
        left[0] = '00'; left[1] = '00 [VES-PD] vesperpolice'; left[2] = '<@123456789012345678>'; left[11] = 'ออกจาก Discord';
        sheetData({
            // ID ยังอยู่ในคอลัมน์ E ของแถวเดิม — ด่านสมัครซ้ำต้องไม่ปฏิเสธเขา
            'NamePD!E:E': [[], [], ['<@123456789012345678>']],
            'NamePD!C:N': [[], [], left, ['01', '']],
        });

        const result = await registerMember('vesperpolice', '123456789012345678', '78096');

        // รหัส 00 เดิม ไม่ใช่ 01 ที่เป็นช่องว่างถัดไป
        expect(result?.nickname).toBe('00 [VES-PD] vesperpolice');
        const updates = batchUpdate.mock.calls[0][1];
        expect(updates[0].range).toBe('NamePD!B3');
        expect(updates[1].range).toBe('NamePD!D3:E3');
    });

    it('กลับเข้ามาแล้วต้องล้างสถานะ N ทิ้ง ไม่ให้แถวยังบอกว่าออกไปแล้ว', async () => {
        const left = new Array(12).fill('');
        left[0] = '00'; left[2] = '<@123456789012345678>'; left[11] = 'ออกจาก Discord';
        sheetData({
            'NamePD!E:E': [[], [], ['<@123456789012345678>']],
            'NamePD!C:N': [[], [], left],
        });

        await registerMember('vesperpolice', '123456789012345678', '78096');

        const updates = batchUpdate.mock.calls[0][1];
        expect(updates).toContainEqual({ range: 'NamePD!N3', values: [['']] });
    });

    it('คนใหม่ปกติ → ไม่ไปยุ่งกับคอลัมน์ N ของแถวนั้น', async () => {
        sheetData({
            'NamePD!E:E': [],
            'NamePD!C:N': [[], [], ['102', '']],
        });

        await registerMember('สมหญิง', '123456789012345678', '555');

        const updates = batchUpdate.mock.calls[0][1];
        expect(updates.some((u: { range: string }) => u.range.includes('!N'))).toBe(false);
    });

    it('ไม่ใส่เบอร์โทร → เขียนช่องว่างลง B ไม่ใช่ undefined', async () => {
        sheetData({
            'NamePD!E:E': [],
            'NamePD!C:N': [[], [], ['102', '']],
        });

        await registerMember('สมหญิง', '123456789012345678');

        // C:D มี 3 แถว แถวว่างอยู่ index 2 → แถวที่ 3 ของชีต
        expect(batchUpdate.mock.calls[0][1][0]).toEqual({ range: 'NamePD!B3', values: [['']] });
    });
});

describe('isAlreadyRegistered — อ่านจากชีตถูกใบถูกช่วง', () => {
    it('ไม่มี outSheetName → อ่านแค่ชีตหลัก', async () => {
        sheetData({ 'NamePD!E:E': [] });

        await isAlreadyRegistered('123456789012345678');

        expect(getValues).toHaveBeenCalledTimes(1);
        expect(getValues).toHaveBeenCalledWith('reg-1', 'NamePD!E:E', 10000);
    });

    it('มี outSheetName → อ่านทั้งสองใบ', async () => {
        registryConfig = { spreadsheetId: 'reg-1', sheetName: 'NamePD', outSheetName: 'OutDC' };
        sheetData({ 'NamePD!E:E': [], 'OutDC!E:E': [] });

        await isAlreadyRegistered('123456789012345678');

        expect(getValues).toHaveBeenCalledWith('reg-1', 'OutDC!E:E', 10000);
    });

    it('bypassCache → ขอแบบไม่ใช้ cache (ttl 0)', async () => {
        sheetData({ 'NamePD!E:E': [] });

        await isAlreadyRegistered('123456789012345678', true);

        expect(getValues).toHaveBeenCalledWith('reg-1', 'NamePD!E:E', 0);
    });

    it('ยังไม่ตั้งค่าชีต → false โดยไม่ยิง Google', async () => {
        registryConfig = { spreadsheetId: '', sheetName: '', outSheetName: '' };

        expect(await isAlreadyRegistered('123456789012345678')).toBe(false);
        expect(getValues).not.toHaveBeenCalled();
    });
});

describe('findMemberByDiscordId — อ่านช่วง C:E', () => {
    it('ขอช่วง C:E แบบไม่ใช้ cache', async () => {
        sheetData({ 'NamePD!C:E': [[], [], ['101', 'สมชาย', '<@111111111111111111>']] });

        const found = await findMemberByDiscordId('111111111111111111');

        expect(getValues).toHaveBeenCalledWith('reg-1', 'NamePD!C:E', 0);
        expect(found).toEqual({ row: 3, codeNumber: '101', currentName: 'สมชาย' });
    });

    it('ยังไม่ตั้งค่าชีต → null โดยไม่ยิง Google', async () => {
        registryConfig = { spreadsheetId: '', sheetName: '', outSheetName: '' };

        expect(await findMemberByDiscordId('111111111111111111')).toBeNull();
        expect(getValues).not.toHaveBeenCalled();
    });
});

describe('checkPendingStatus / checkPreApproved — คิวรออนุมัติ', () => {
    it('อ่านช่วง A:H จากชีต Pending', async () => {
        sheetData({ 'Pending!A:H': [['หัว'], ['1', '111111111111111111', '', 'สมชาย', '555', '25', '', 'อนุมัติ']] });

        const r = await checkPendingStatus('111111111111111111');

        expect(getValues).toHaveBeenCalledWith('pending-1', 'Pending!A:H', 0);
        expect(r.found).toBe(true);
        expect(r.icName).toBe('สมชาย');
    });

    it('สถานะอนุมัติ → ผ่าน พร้อมข้อมูลที่กรอกไว้แล้ว', async () => {
        sheetData({ 'Pending!A:H': [['หัว'], ['1', '111111111111111111', '', 'สมชาย', '555', '25', '', 'อนุมัติ']] });

        expect(await checkPreApproved('111111111111111111')).toEqual({
            approved: true, icName: 'สมชาย', icPhone: '555', ocAge: '25',
        });
    });

    it('สถานะอื่น → ไม่ผ่าน', async () => {
        sheetData({ 'Pending!A:H': [['หัว'], ['1', '111111111111111111', '', 'สมชาย', '555', '25', '', 'รออนุมัติ']] });

        expect(await checkPreApproved('111111111111111111')).toEqual({ approved: false });
    });

    it('อ่านชีตพัง → ถือว่าไม่เจอ ไม่โยน error', async () => {
        getValues.mockRejectedValue(new Error('Google ล่ม'));

        await expect(checkPendingStatus('111111111111111111')).resolves.toEqual({ found: false });
        await expect(checkPreApproved('111111111111111111')).resolves.toEqual({ approved: false });
    });

    it('ยังไม่ตั้งค่าชีต Pending → ไม่เจอ โดยไม่ยิง Google', async () => {
        pendingConfig = { spreadsheetId: '', sheetName: '' };

        expect(await checkPendingStatus('111111111111111111')).toEqual({ found: false });
        expect(getValues).not.toHaveBeenCalled();
    });
});
