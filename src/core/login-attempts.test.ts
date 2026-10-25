import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    MAX_LOGIN_ATTEMPTS,
    MAX_RETRY_WAIT_MS,
    NETWORK_RETRY_BACKOFF_MS,
    RETRY_AFTER_FALLBACK_MS,
    clearLoginAttempts,
    fileFor,
    formatWait,
    isLockedOut,
    readLoginAttempts,
    recordLoginFailure,
    retryDelay,
} from './login-attempts';

let dir = '';

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'login-attempts-'));
});

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('login-attempts — ตัวนับการเชื่อมต่อล้มเหลว', () => {
    it('เริ่มจากศูนย์เมื่อยังไม่มีไฟล์', () => {
        const state = readLoginAttempts(fileFor(dir));
        expect(state.attempts).toBe(0);
        expect(state.lastStatus).toBeNull();
        expect(isLockedOut(state)).toBe(false);
    });

    it('นับเพิ่มทีละครั้งและหยุดที่เพดาน', () => {
        const file = fileFor(dir);
        const first = recordLoginFailure(file, 429, 'HTTP 429');
        expect(first.persisted).toBe(true);
        expect(first.state.attempts).toBe(1);
        expect(isLockedOut(first.state)).toBe(false);

        const second = recordLoginFailure(file, 429, 'HTTP 429');
        expect(second.state.attempts).toBe(MAX_LOGIN_ATTEMPTS);
        expect(isLockedOut(second.state)).toBe(true);

        // อ่านซ้ำจากดิสก์ต้องได้ค่าเดิม (รอดจากการรีสตาร์ทของโปรเซส)
        expect(readLoginAttempts(file).attempts).toBe(MAX_LOGIN_ATTEMPTS);
    });

    it('เก็บรายละเอียดล่าสุดไว้ดูย้อนหลัง', () => {
        const file = fileFor(dir);
        recordLoginFailure(file, 0, 'ไม่ตอบภายใน 10000 ms', new Date('2026-10-25T17:30:00.000Z'));
        const state = readLoginAttempts(file);
        expect(state.lastStatus).toBe(0);
        expect(state.lastError).toBe('ไม่ตอบภายใน 10000 ms');
        expect(state.lastAt).toBe('2026-10-25T17:30:00.000Z');
    });

    it('clearLoginAttempts ล้างตัวนับหลังต่อติดสำเร็จ', () => {
        const file = fileFor(dir);
        recordLoginFailure(file, 429, 'HTTP 429');
        clearLoginAttempts(file);
        expect(readLoginAttempts(file).attempts).toBe(0);
        // เรียกซ้ำตอนไม่มีไฟล์ต้องไม่ throw
        expect(() => clearLoginAttempts(file)).not.toThrow();
    });

    it('ไฟล์เสียหายถือว่าเริ่มนับใหม่ ไม่ทำให้บอทล้ม', () => {
        const file = fileFor(dir);
        fs.writeFileSync(file, '{ not json', 'utf8');
        expect(readLoginAttempts(file).attempts).toBe(0);
    });

    it('เขียนไฟล์ไม่ได้ต้องรายงาน persisted=false (ให้ผู้เรียกหยุดทันที)', () => {
        // ส่ง path ของโฟลเดอร์เป็นไฟล์ → เขียนทับโฟลเดอร์ไม่ได้
        const result = recordLoginFailure(dir, 429, 'HTTP 429');
        expect(result.persisted).toBe(false);
        expect(result.state.attempts).toBe(1);
    });
});

describe('login-attempts — เวลารอก่อนลองใหม่', () => {
    it('เคารพ Retry-After ของ Discord (วินาที)', () => {
        // ค่าที่เจอจริงบน Render: Retry-After 3026 วิ
        expect(retryDelay(429, '3026')).toEqual({ ms: 3_026_000, capped: false });
        expect(retryDelay(429, '30')).toEqual({ ms: 30_000, capped: false });
    });

    it('ไม่ยอมรอเกินเพดาน', () => {
        expect(retryDelay(429, '86400')).toEqual({ ms: MAX_RETRY_WAIT_MS, capped: true });
    });

    it('429 ที่ไม่มี Retry-After ใช้ค่าสำรอง', () => {
        expect(retryDelay(429, null).ms).toBe(RETRY_AFTER_FALLBACK_MS);
        expect(retryDelay(429, 'oops').ms).toBe(RETRY_AFTER_FALLBACK_MS);
    });

    it('ติดต่อไม่ได้เลย (status 0) รอสั้น ๆ แล้วลองใหม่', () => {
        expect(retryDelay(0, null).ms).toBe(NETWORK_RETRY_BACKOFF_MS);
        expect(retryDelay(null, null).ms).toBe(NETWORK_RETRY_BACKOFF_MS);
    });

    it('formatWait อ่านง่ายทั้งนาทีและวินาที', () => {
        expect(formatWait(3_026_000)).toBe('50 นาที');
        expect(formatWait(60_000)).toBe('1 นาที');
        expect(formatWait(30_000)).toBe('30 วินาที');
        expect(formatWait(200)).toBe('1 วินาที');
    });
});
