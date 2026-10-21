/**
 * Shared types for Discord bot interactions.
 * Centralizes all custom type definitions to avoid duplication.
 */

/**
 * Tag info extracted from a message mention.
 */
export interface TagInfo {
    id: string;
    nickname: string;
    username: string;
    /**
     * true เฉพาะเมื่อ nickname เป็นชื่อเล่นที่ถูกตั้งไว้ในเซิร์ฟเวอร์จริง ๆ
     *
     * ดูจากตัวค่าแยกไม่ออกว่าเป็นชื่อเล่นหรือชื่อบัญชี Discord ที่ fallback มา
     * ฝั่งเขียนชีตต้องรู้ ไม่งั้นจะเอาชื่อบัญชีไปทับชื่อในระบบที่ดีอยู่แล้ว
     */
    hasGuildNickname?: boolean;
}

/**
 * Constants used across features.
 */
export const CONSTANTS = {
    /** Count sheet column indices (A=0, B=1, C=2, D=3, E=4, F=5, G=6) */
    COUNT_HEADER: ['ชื่อDC', 'User ID', 'Take2', 'คดีปกติ', 'รถยอด', 'คุมสอบ', 'อุ้มเอ๋อ'],
    /** Data starts at row index 3 (0-based) */
    COUNT_DATA_START: 3,
};