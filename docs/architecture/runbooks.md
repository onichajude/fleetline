# Runbooks

Template areas 14, 15, 16, 20 and 21. Owner: onichajude. Commands run in the `backend` folder unless stated.

## Deploy and roll back

1. Make sure CI is green for the commit you're deploying.
2. On the server, take a backup:

   ```bash
   npm run backup
   ```

   The output must end with "OK - this backup can be restored."
3. Deploy the new commit (`git pull`, then `npm ci`) and restart the service.
4. Check:
   - `GET /api/health` returns `"status":"ok"`.
   - Sign in to the console and see vehicles live.
   - A test driver can start and end a shift.
5. Watch the logs for 30 minutes: no `"level":"error"` lines, and 5xx responses stay under 1%.

**Roll back:** redeploy the previous commit and restart. Database changes are additive, so old code runs on the newer schema. Only restore the database (below) if a release damaged data. A restore loses everything since that backup, so prefer a forward fix when you can.

## Restore from backup

1. Stop the server.
2. Check the backup:

   ```bash
   npm run backup -- --verify data/backups/<file>.db
   ```

3. Move the live file aside (`data/fleetline.db` → `data/fleetline.db.broken`) and also remove `fleetline.db-wal` and `fleetline.db-shm` if present.
4. Copy the backup to `data/fleetline.db` and start the server.
5. Check `/api/health`, sign in, and confirm recent records exist.
6. **Re-apply erasures made after the backup was taken.** In the audit log, find `privacy.erase` entries newer than the backup, and erase those drivers again (Setup → Privacy requests). Otherwise erased personal data comes back.
7. Record the actual recovery time and data loss against the targets (RTO 4 h, RPO 24 h).

**Restore drill:** twice a year, restore the newest backup on a separate machine and time steps 2–5. **Not yet performed.**

## Incident response

1. **Detect:** an uptime alert, `"level":"error"` logs, user reports, or unusual audit entries (many `auth.login_failed`, unexpected exports or erasures).
2. **Contain:**
   - For a suspected account compromise, reset the password and two-step login (Setup → Staff or Drivers), which ends its sessions, and deactivate the account if needed.
   - For a server compromise, take it offline, rotate `JWT_SECRET` (which signs everyone out), and rebuild from a known-good commit and backup.
3. **Preserve evidence:**
   - Copy logs, the audit log (`GET /api/audit`) and the database file before changing anything else.
   - Note times, in UTC.
4. **Assess personal-data impact:**
   - Which drivers or customers, and what data (location history is high sensitivity)?
   - Check the breach notification matrix (pending, area 18) for who must be told and how fast. **Don't assume one deadline applies everywhere.**
5. **Communicate:**
   - Inform the company owner.
   - Inform affected drivers and customers as required.
   - Inform regulators where required.
6. **Review** within 2 weeks: cause, what worked, follow-ups with owners and dates. Update the threat model and this pack.

## Privacy requests

- **Access / copy:** the driver can download their own data from "My stats". Or an admin goes to Setup → Privacy requests → choose driver → **Export data**. Send the file securely (not by plain email attachment).
- **Erasure (driver leaves):**
  1. Make sure their shift has ended.
  2. Export their data first if it might be needed (e.g. a dispute).
  3. Setup → Privacy requests → choose driver → type their username → **Erase personal data**.
  4. Note that backups keep the data until they rotate out (14 days).
- **Correction:** edit their name or phone.
- **Objection / restriction:** deactivate the account and get legal advice.
- **Record:** the audit log keeps `privacy.*` entries. Track request dates against the legal deadline.

## Lost phone or locked-out staff

- **Driver lost their phone:** reset their password (Setup → Drivers → Reset password). This ends the session on the lost phone; queued GPS on that phone stops uploading.
- **Staff member lost their authenticator phone:** another admin goes to Setup → Staff → **Reset two-step**. The staff member sets it up again at their next sign-in.
- **The only admin lost their authenticator.** Don't run `npm run seed`; it wipes all data. With server access:
  1. Set `REQUIRE_STAFF_MFA=false` and restart.
  2. Sign in and create a second admin (Setup → Staff → Add staff).
  3. Have the second admin reset the first admin's two-step login.
  4. Set `REQUIRE_STAFF_MFA=true` and restart.
  5. Record this in the incident log.

  Avoid this situation by keeping two admins (risk R-11).

## Staff onboarding and offboarding

- **Onboard a driver:** add them in Setup → Drivers (or approve their sign-up in Team) and assign a vehicle. They accept the privacy notice on first sign-in.
- **Onboard staff:** an admin goes to Setup → Staff → **Add staff**, chooses dispatcher or admin, and sets a temporary password. The staff member must set up two-step login at first sign-in and should change the password (Setup → Your account).
- **Offboard (same day they leave):**
  1. Deactivate the account, which ends all sessions.
  2. Reassign their vehicle.
  3. Handle any erasure request after their data is no longer needed.
  4. For staff, reset their two-step login.
  5. Review their recent audit entries.

## Quarterly access review

1. List accounts (`GET /api/users`). Confirm every staff and driver account is still needed and has the right role.
2. Deactivate leavers. Check that every staff account has two-step login on.
3. Skim the audit log for exports, erasures, resets and unusual sign-in failures. Record the review date and outcome in the pack.

## Retention and backups (automatic)

- Retention runs at start-up and every 12 hours. Entries appear in the audit log as `system.retention_purge`, and limits are set in `.env`.
- Backups run every `BACKUP_INTERVAL_HOURS` (default 24) into `data/backups`, keeping 14.
- **Copy that folder to separate, encrypted storage daily** (pending setup with hosting).

## Retirement

1. Give drivers and customers at least 30 days' notice.
2. Offer exports: per-driver exports, and the delivery records the company needs.
3. Stop new dispatches, then end all shifts.
4. Delete data under the approved retention rules. Keep only what law requires, in a restricted archive, with a named owner.
5. Revoke credentials: rotate `JWT_SECRET`, delete accounts, remove app store listings and signing keys, and remove API keys for tiles and routing.
6. Shut down hosting, delete backups after their retention, close vendor accounts, and archive the repository.
7. Record the retirement in this pack and gate G8.
