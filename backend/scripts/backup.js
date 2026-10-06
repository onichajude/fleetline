// Makes a backup of the database and verifies it can be opened and read.
//   npm run backup                 back up now (safe while the server is running)
//   npm run backup -- --verify F   check an existing backup file
import path from "node:path";
import { backupNow, verifyBackup, BACKUP_DIR } from "../server/maintenance.js";

const i = process.argv.indexOf("--verify");
const file = i > 0 ? path.resolve(process.argv[i + 1]) : backupNow();
const r = verifyBackup(file);
console.log(`${i > 0 ? "Checked" : "Backed up to"} ${file}
  integrity: ${r.integrity}
  rows: ${Object.entries(r.counts).map(([k, v]) => `${k} ${v}`).join(", ")}
  ${r.ok ? "OK - this backup can be restored." : "PROBLEM - do not rely on this backup."}${i > 0 ? "" : `\n  Backups folder: ${BACKUP_DIR}`}`);
process.exit(r.ok ? 0 : 1);
