/**
 * licenseAuth.ts — Client-side license authentication
 *
 * Flow:
 * 1. Lấy HWID từ server local (/api/license/hwid) — Electron truyền qua env
 * 2. User nhập license key
 * 3. Gọi POST /api/license/verify { key, hwid } → { valid, reason, entry }
 * 4. Nếu valid → lưu { key, hwid, entry } vào localStorage
 * 5. Mỗi lần app khởi động → verify lại (nếu key đã lưu)
 */

const LS_KEY = "license_key";
const LS_ENTRY = "license_entry";

const LICENSE_SERVER = "https://dubbintool-license.bynne2602.workers.dev";

export interface LicenseEntry {
  key: string;
  hwid: string;
  uid: string;
  plan: "1d" | "3d" | "7d" | "1m" | "3m" | "1y" | "forever";
  iat: number;
  exp: number | null;
  revoked: boolean;
}

export interface VerifyResult {
  valid: boolean;
  reason?: string;
  entry?: LicenseEntry;
}

// ── HWID ─────────────────────────────────────────────────────────────────

let _hwid: string | null = null;

export async function getHwid(): Promise<string> {
  if (_hwid) return _hwid;
  try {
    // Lấy từ Express local (Electron inject HWID qua env)
    const res = await fetch("/api/license/hwid");
    const data = await res.json();
    _hwid = data.hwid ?? "web-mode";
  } catch {
    _hwid = "web-mode";
  }
  return _hwid!;
}

// ── Verify via Cloudflare Worker ──────────────────────────────────────────

export async function verifyLicenseKey(key: string): Promise<VerifyResult> {
  const hwid = await getHwid();
  try {
    const res = await fetch(`${LICENSE_SERVER}/api/license/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: key.trim(), hwid }),
    });
    return await res.json() as VerifyResult;
  } catch (e: any) {
    return { valid: false, reason: `Không kết nối được server: ${e?.message}` };
  }
}

// ── LocalStorage helpers ──────────────────────────────────────────────────

export function saveLicense(key: string, entry: LicenseEntry): void {
  localStorage.setItem(LS_KEY, key);
  localStorage.setItem(LS_ENTRY, JSON.stringify(entry));
}

export function loadSavedLicense(): { key: string; entry: LicenseEntry } | null {
  const key = localStorage.getItem(LS_KEY);
  const raw = localStorage.getItem(LS_ENTRY);
  if (!key || !raw) return null;
  try {
    return { key, entry: JSON.parse(raw) as LicenseEntry };
  } catch {
    return null;
  }
}

export function clearLicense(): void {
  localStorage.removeItem(LS_KEY);
  localStorage.removeItem(LS_ENTRY);
  localStorage.removeItem("is_logged_in");
}

/** Kiểm tra license đã lưu khi khởi động — verify lại qua API */
export async function checkSavedLicense(): Promise<VerifyResult> {
  const saved = loadSavedLicense();
  if (!saved) return { valid: false, reason: "Chưa có license." };
  // Re-verify qua API (kiểm tra revoke, hết hạn,...)
  return verifyLicenseKey(saved.key);
}

/** Trả về chuỗi thời hạn còn lại */
export function getRemainingLabel(entry: LicenseEntry): string {
  if (entry.exp === null) return "Vĩnh viễn";
  const diff = entry.exp - Math.floor(Date.now() / 1000);
  if (diff <= 0) return "Đã hết hạn";
  const days = Math.floor(diff / 86400);
  const hours = Math.floor((diff % 86400) / 3600);
  if (days > 0) return `Còn ${days} ngày ${hours} giờ`;
  const mins = Math.floor((diff % 3600) / 60);
  return `Còn ${hours} giờ ${mins} phút`;
}

const PLAN_LABELS: Record<string, string> = {
  "1d": "1 Ngày", "3d": "3 Ngày", "7d": "7 Ngày", "1m": "1 Tháng", "3m": "3 Tháng", "1y": "1 Năm", "forever": "Vĩnh Viễn",
};
export function getPlanLabel(plan: string): string {
  return PLAN_LABELS[plan] ?? plan;
}
