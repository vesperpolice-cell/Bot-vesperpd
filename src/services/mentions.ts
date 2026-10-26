/**
 * ตัวช่วยดึง Discord ID จากข้อความ — รวมตรรกะการแกะ mention ที่เคยเขียนซ้ำหลายไฟล์
 * รองรับทั้ง `<@id>` และ `<@!id>` ตามที่ Discord ส่งมา
 */

/** ดึง Discord ID ทั้งหมดจากข้อความ — ไม่มีซ้ำ ตามลำดับที่ปรากฏ */
export function extractMentionIds(content: string): string[] {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const m of content.match(/<@!?(\d+)>/g) || []) {
        const id = m.match(/\d+/)?.[0];
        if (id && !seen.has(id)) {
            seen.add(id);
            ids.push(id);
        }
    }
    return ids;
}

/** Discord ID ตัวแรกที่ถูกแท็กในข้อความ — ไม่มีคืน null */
export function firstMentionId(content: string): string | null {
    return extractMentionIds(content)[0] ?? null;
}
