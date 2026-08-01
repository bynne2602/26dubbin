/**
 * licenseDb.ts — Quản lý license keys phía server
 *
 * License được lưu trong file JSON: licenses.json (cạnh server.cjs khi build)
 * Mỗi license entry:
 * {
 *   key: string,         // license key (hex 32 chars)
 *   hwid: string,        // hardware id của máy được cấp (32 hex chars)
 *   uid: string,         // tên/mã khách hàng
 *   plan: "1d"|"1m"|"1y"|"forever",
 *   iat: number,         // issued at (unix seconds)
 *   exp: number|null,    // expiry (unix seconds), null = forever
 *   revoked: boolean,
 * }
 *
 * SECRET KEY (HMAC_SECRET) phải được đặt trong env LICENSE_SECRET
 * hoặc fallback về DEFAULT_SECRET bên dưới.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";

// ⚠️ Đổi thành secret thực của bạn — phải khớp với scripts/admin-license.mjs
function getSecret(): string {
  const secret = process.env.LICENSE_SECRET?.trim();
  if (!secret) throw new Error("LICENSE_SECRET chưa được cấu hình; từ chối xác thực license để tránh dùng secret mặc định không an toàn.");
  return secret;
}

// ── DB path ──────────────────────────────────────────────────────────────

function getDbPath(): string {
  // Khi packaged: resourcesPath/app/
  // Khi dev: project root
  const base = process.env.DIST_PATH
    ? path.join(process.env.DIST_PATH, "..")
    : process.cwd();
  return path.join(base, "licenses.json");
}

export interface LicenseEntry {
  key: string;
  hwid: string;
  uid: string;
  plan: "1d" | "1m" | "1y" | "forever";
  iat: number;
  exp: number | null;
  revoked: boolean;
}

function loadDb(): LicenseEntry[] {
  const p = getDbPath();
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as LicenseEntry[];
  } catch {
    return [];
  }
}

// ── HMAC verify ──────────────────────────────────────────────────────────

/**
 * Payload được ký: "<hwid>|<uid>|<plan>|<iat>|<exp>"
 * key = HMAC-SHA256(payload, secret).slice(0, 32)
 */
export function generateLicenseKey(
  hwid: string,
  uid: string,
  plan: "1d" | "1m" | "1y" | "forever",
  iat: number,
  exp: number | null
): string {
  const payload = `${hwid}|${uid}|${plan}|${iat}|${exp ?? "forever"}`;
  return crypto
    .createHmac("sha256", getSecret())
    .update(payload)
    .digest("hex")
    .slice(0, 32);
}

// ── Public API ────────────────────────────────────────────────────────────

export interface VerifyResult {
  valid: boolean;
  reason?: string;
  entry?: LicenseEntry;
}

export function verifyLicense(key: string, hwid: string): VerifyResult {
  const db = loadDb();
  const entry = db.find((e) => e.key === key);

  if (!entry) return { valid: false, reason: "Key không tồn tại." };
  if (entry.revoked) return { valid: false, reason: "Key đã bị thu hồi." };

  // Kiểm tra HWID khớp
  if (entry.hwid !== hwid) {
    return { valid: false, reason: "Key này không thuộc thiết bị của bạn." };
  }

  // Kiểm tra chữ ký
  const expected = generateLicenseKey(entry.hwid, entry.uid, entry.plan, entry.iat, entry.exp);
  if (expected !== entry.key) {
    return { valid: false, reason: "Key bị giả mạo hoặc sai secret." };
  }

  // Kiểm tra hết hạn
  if (entry.exp !== null && Math.floor(Date.now() / 1000) > entry.exp) {
    return { valid: false, reason: "Key đã hết hạn." };
  }

  return { valid: true, entry };
}
