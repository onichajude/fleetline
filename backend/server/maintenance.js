// Data retention and backups.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { db, run, DATA_DIR } from "./db.js";

const DAY = 864e5;
export const RETENTION = {
  positionsDays: Number(process.env.POSITION_RETENTION_DAYS || 180),
  alertsDays: Number(process.env.ALERT_RETENTION_DAYS || 365),
  auditDays: Number(process.env.AUDIT_RETENTION_DAYS || 730),
};

/** Deletes data older than its retention period. Returns how many rows went from each table. */
export function purgeExpired(now = Date.now()) {
  const out = {
    positions: run("DELETE FROM positions WHERE recorded_at < ?", now - RETENTION.positionsDays * DAY).changes,
    alerts: run("DELETE FROM alerts WHERE created_at < ?", now - RETENTION.alertsDays * DAY).changes,
    audit_log: run("DELETE FROM audit_log WHERE at < ?", now - RETENTION.auditDays * DAY).changes,
  };
  if (out.positions + out.alerts + out.audit_log > 0) {
    run(`INSERT INTO audit_log (at, action, details) VALUES (?, 'system.retention_purge', ?)`, now, JSON.stringify(out));
  }
  return out;
}

export const BACKUP_DIR = process.env.BACKUP_DIR || path.join(DATA_DIR, "backups");

/** Writes a consistent copy of the live database (safe while the server runs) and keeps the newest `keep`. */
export function backupNow({ keep = Number(process.env.BACKUP_KEEP || 14), dir = BACKUP_DIR } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const file = path.join(dir, `fleetline-${stamp}.db`);
  if (fs.existsSync(file)) fs.rmSync(file);
  db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
  const old = fs.readdirSync(dir).filter((f) => /^fleetline-\d{8}-\d{6}\.db$/.test(f)).sort().reverse().slice(keep);
  for (const f of old) fs.rmSync(path.join(dir, f));
  return file;
}

/** Opens a backup read-only and checks it is intact and holds the core tables. */
export function verifyBackup(file) {
  const b = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = b.prepare("PRAGMA integrity_check").get().integrity_check;
    const count = (t) => b.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
    const counts = Object.fromEntries(["users", "vehicles", "routes", "route_stops", "positions", "audit_log"].map((t) => [t, count(t)]));
    return { ok: integrity === "ok" && counts.users > 0, integrity, counts };
  } finally { b.close(); }
}
