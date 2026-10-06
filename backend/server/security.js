// Security controls: authenticator-app codes (TOTP, RFC 6238), the audit log, and the driver privacy notice.
import crypto from "node:crypto";
import { one, all, run } from "./db.js";

/* ---------- TOTP (RFC 6238, SHA-1, 30 s, 6 digits) ---------- */
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32Encode(buf) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export const newTotpSecret = () => base32Encode(crypto.randomBytes(20));

export function totpCode(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const off = h[h.length - 1] & 15;
  const bin = ((h[off] & 127) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 1e6).padStart(6, "0");
}
export const currentStep = (t = Date.now()) => Math.floor(t / 30e3);

/** Returns the matching time step (allowing one step of clock drift), or null. */
export function verifyTotp(secret, code, t = Date.now()) {
  const c = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(c) || !secret) return null;
  const now = currentStep(t);
  for (const s of [now, now - 1, now + 1]) {
    const expected = Buffer.from(totpCode(secret, s)), given = Buffer.from(c);
    if (crypto.timingSafeEqual(expected, given)) return s;
  }
  return null;
}
export const otpauthUri = (secret, username, issuer = "Fleetline") =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(username)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

/** Staff (admins and dispatchers) must use an authenticator app unless REQUIRE_STAFF_MFA=false. */
export const staffMfaRequired = () => (process.env.REQUIRE_STAFF_MFA ?? "true").toLowerCase() !== "false";

/* ---------- audit log (append-only through the API) ---------- */
/**
 * Records a security-relevant action. `req` supplies the actor, IP and request id.
 * Never put passwords, codes, tokens or GPS coordinates in `details`.
 */
export function audit(req, action, { type = null, id = null, details = null, actor = null } = {}) {
  const who = actor || req?.user || null;
  run(`INSERT INTO audit_log (at, actor_id, actor_username, action, target_type, target_id, details, ip, request_id)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    Date.now(), who?.id ?? null, who?.username ?? null, action, type, id == null ? null : String(id),
    details ? JSON.stringify(details).slice(0, 2000) : null, req?.ip ?? null, req?.id ?? null);
}
export function auditEntries({ limit = 100, before = null, action = null } = {}) {
  const where = [], params = [];
  if (before) { where.push("id < ?"); params.push(before); }
  if (action) { where.push("action LIKE ?"); params.push(`${action}%`); }
  return all(`SELECT * FROM audit_log ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`, ...params, Math.min(500, limit))
    .map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null }));
}

/* ---------- driver privacy notice ---------- */
// Bump the version whenever the text changes in substance; drivers must accept the new version.
export const PRIVACY_NOTICE = {
  version: "2026-10-06",
  title: "How Fleetline uses your location",
  points: [
    "While you are on shift, the app sends your vehicle's location to dispatch every few seconds. It stops when you end your shift.",
    "Dispatch uses it to plan and track deliveries, mark stops as arrived, and keep drivers and goods safe. Speeding alerts are based on these readings.",
    "Your trips, deliveries, on-time rate and pre-trip checks are used for your performance page and for team rankings that your employer can see.",
    "Location history is deleted automatically after the retention period your employer sets (180 days by default). Alerts and audit records are kept longer.",
    "You can ask your employer for a copy of your data or for it to be deleted when you leave. Some business records may have to be kept by law.",
  ],
};
export const privacyStatus = (userId) => {
  const u = one("SELECT privacy_ack_version, privacy_ack_at FROM users WHERE id = ?", userId);
  return { required: u?.privacy_ack_version !== PRIVACY_NOTICE.version, accepted_version: u?.privacy_ack_version ?? null, accepted_at: u?.privacy_ack_at ?? null };
};
