import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import jwt from "jsonwebtoken";
import { DATA_DIR, one } from "./db.js";
import { staffMfaRequired } from "./security.js";

function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const file = path.join(DATA_DIR, ".jwt-secret");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  const s = crypto.randomBytes(48).toString("hex");
  fs.writeFileSync(file, s, { mode: 0o600 });
  return s;
}
const SECRET = loadSecret();
const TOKEN_TTL = process.env.TOKEN_TTL || "14d";

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 32);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}
export function verifyPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored).split("$");
  if (alg !== "scrypt") return false;
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, "hex"), 32);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, "hex"));
}

export const signToken = (user) => jwt.sign({ sub: user.id, role: user.role, ver: user.token_version ?? 0 }, SECRET, { expiresIn: TOKEN_TTL });

export const MIN_PASSWORD = 8;
/** Returns an error message for an unacceptable new password, or null. */
export function passwordProblem(pw, username = "") {
  if (typeof pw !== "string" || pw.length < MIN_PASSWORD) return `Passwords need at least ${MIN_PASSWORD} characters.`;
  if (pw.length > 200) return "Passwords can be at most 200 characters.";
  if (username && pw.toLowerCase() === String(username).toLowerCase()) return "Choose a password that isn't your username.";
  return null;
}

/** Returns the active user for a token, or null. */
export function userFromToken(token) {
  try {
    const p = jwt.verify(token, SECRET);
    const u = one("SELECT id, name, username, role, phone, active, approval, token_version, mfa_enabled FROM users WHERE id = ?", p.sub);
    if (!u || !u.active || u.approval !== "approved" || (p.ver ?? 0) !== u.token_version) return null;
    delete u.token_version; delete u.approval;
    u.mfa_enabled = !!u.mfa_enabled;
    return u;
  } catch { return null; }
}

function authenticate(roles, { allowWithoutMfa = false } = {}) {
  return (req, res, next) => {
    const h = req.headers.authorization || "";
    const user = userFromToken(h.startsWith("Bearer ") ? h.slice(7) : "");
    if (!user) return res.status(401).json({ error: "Sign in again: your session has expired." });
    if (roles.length && !roles.includes(user.role)) return res.status(403).json({ error: "Your account can't do that." });
    // Privileged accounts must use an authenticator app before they can do anything else.
    if (!allowWithoutMfa && user.role !== "driver" && !user.mfa_enabled && staffMfaRequired()) {
      return res.status(403).json({ error: "Set up two-step sign-in to continue.", code: "mfa_setup_required" });
    }
    req.user = user;
    next();
  };
}
export const requireAuth = (...roles) => authenticate(roles);
/** For the few endpoints a staff member needs in order to set up two-step sign-in. */
export const requireAuthAllowNoMfa = (...roles) => authenticate(roles, { allowWithoutMfa: true });

// Simple in-memory login throttle: 8 failures per username+IP per 10 minutes.
const fails = new Map();
export function loginThrottled(key) {
  const f = fails.get(key);
  return f && f.count >= 8 && Date.now() - f.first < 10 * 60e3;
}
export function noteLoginFailure(key) {
  const f = fails.get(key);
  if (!f || Date.now() - f.first > 10 * 60e3) fails.set(key, { count: 1, first: Date.now() });
  else f.count++;
}
export const clearLoginFailures = (key) => fails.delete(key);
