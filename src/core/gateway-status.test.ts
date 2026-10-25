import { describe, it, expect } from 'vitest';
import { Status } from 'discord.js';
import { allShardsReady, closeCodeName, isFatalLoginError, isUnrecoverableClose, shardIsReady, shardStatusName } from './gateway-status';

describe('gateway-status — สถานะการเชื่อมต่อ', () => {
    it('shardIsReady เป็น true เฉพาะสถานะ Ready', () => {
        expect(shardIsReady(Status.Ready)).toBe(true);
        expect(shardIsReady(Status.Connecting)).toBe(false);
        expect(shardIsReady(Status.Reconnecting)).toBe(false);
        expect(shardIsReady(Status.Disconnected)).toBe(false);
    });

    it('allShardsReady เป็น false เมื่อยังไม่มี shard เลย', () => {
        expect(allShardsReady([])).toBe(false);
    });

    it('allShardsReady เป็น false ถ้ามี shard ใดไม่พร้อม', () => {
        expect(allShardsReady([{ status: Status.Ready }, { status: Status.Resuming }])).toBe(false);
    });

    it('allShardsReady เป็น true เมื่อทุก shard พร้อม', () => {
        expect(allShardsReady([{ status: Status.Ready }, { status: Status.Ready }])).toBe(true);
    });

    it('shardStatusName คืนชื่อสถานะและ UNKNOWN เมื่อไม่รู้จัก', () => {
        expect(shardStatusName(Status.Ready)).toBe('Ready');
        expect(shardStatusName(Status.Reconnecting)).toBe('Reconnecting');
        expect(shardStatusName(999)).toBe('UNKNOWN');
    });
});

describe('gateway-status — close code', () => {
    it('จัด code ที่ต่อใหม่ไม่ได้เป็น unrecoverable', () => {
        expect(isUnrecoverableClose(4004)).toBe(true); // token ผิด
        expect(isUnrecoverableClose(4013)).toBe(true); // intents ไม่ถูกต้อง
        expect(isUnrecoverableClose(4014)).toBe(true); // intents ไม่ได้เปิดใน portal
    });

    it('ไม่จัด code ที่ต่อใหม่ได้เป็น unrecoverable', () => {
        expect(isUnrecoverableClose(1000)).toBe(false); // ปิดปกติ
        expect(isUnrecoverableClose(1006)).toBe(false); // เน็ตหลุด
        expect(isUnrecoverableClose(4000)).toBe(false); // unknown error (ต่อใหม่ได้)
    });

    it('closeCodeName คืนชื่อของ code และ UNKNOWN เมื่อไม่รู้จัก', () => {
        expect(closeCodeName(4004)).toBe('AuthenticationFailed');
        expect(closeCodeName(4014)).toBe('DisallowedIntents');
        expect(closeCodeName(9999)).toBe('UNKNOWN');
        expect(closeCodeName(1006)).toBe('UNKNOWN');
    });
});

describe('gateway-status — login error', () => {
    it('recognizes errors ที่ต้องแก้ที่ต้นเหตุ', () => {
        expect(isFatalLoginError('An invalid token was provided.')).toBe(true);
        expect(isFatalLoginError('Used disallowed intents')).toBe(true);
    });

    it('ไม่ตีความ error ชั่วคราวว่า fatal', () => {
        expect(isFatalLoginError('getaddrinfo ENOTFOUND discord.com')).toBe(false);
        expect(isFatalLoginError('socket hang up')).toBe(false);
    });
});
