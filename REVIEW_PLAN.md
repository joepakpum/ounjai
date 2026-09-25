# Ounjai review and remediation plan

Review started: 25 September 2026

Baseline: commit `1dae08b` in an isolated worktree.
Scope: application code, authorization and data handling, MySQL migrations, Podman Compose, backup/restore instructions, and available frontend checks. This is a source/configuration review; it does not certify public-domain readiness.

## Summary

The repository contains the expected private-by-default deployment shape: the web and MySQL ports bind to loopback, the API is internal to Compose, and Cloudflare Tunnel is an opt-in profile. The account deletion policy and family-history behavior are documented and implemented. The production API was previously reported healthy on MySQL, but that runtime was not changed or used for this review.

No confirmed exploitable application-code defect was established in the checks below. The findings are operational or verification gaps that must be resolved before claiming complete production readiness. The Cloudflare Tunnel remains off.

## Findings and work plan

| Priority | Finding and evidence | Impact | Remediation | Verification / dependency | Status |
| --- | --- | --- | --- | --- | --- |
| P1 | Public-deployment settings rely on operator discipline: [`compose.yaml`](compose.yaml) defaults `MYSQL_PASSWORD` and `MYSQL_ROOT_PASSWORD`, `APP_BASE_URL` to localhost, and `COOKIE_SECURE` to false; the `cloudflared` profile is enabled by profile plus token. [`README.md`](README.md) lists required overrides but there is no preflight that rejects unsafe tunnel configuration. | A tunnel started with incomplete `.env` can expose a service with insecure defaults or incorrect cookie behavior. Local port bindings reduce exposure in the default profile, but are not a deployment guard. | Add a deployment preflight that refuses tunnel startup unless HTTPS `APP_BASE_URL`, secure cookies, non-default DB credentials, and a non-empty token are set. Keep credentials in untracked `.env`; do not enable the profile as part of this review. | Verify rejection for each missing/unsafe setting and acceptance for a disposable valid configuration. Requires an explicit domain and operator-supplied secrets before production acceptance. | Planned; tunnel stays off |
| P1 | Backup output is not encrypted and is not scheduled/offsite: [`scripts/backup.ps1`](scripts/backup.ps1), [`OPERATIONS.md`](OPERATIONS.md). The user explicitly deferred destination, encryption key, schedule, and retention decisions. | Local backup files contain the entire database and receipt images, so access to the backup directory grants access to sensitive financial information. A host loss can also lose all copies. | Decide encrypted destination, key custody, schedule, and retention; then implement and test policy. Until then, limit filesystem access and do not claim automated disaster recovery. | Requires user decisions; test encryption, checksum, restore, retention, and failure recovery before marking complete. | Waiting for user decision |
| P2 | Real receipt quality is unverified. OCR/backup checks documented in [`PLAN.md`](PLAN.md) and [`OPERATIONS.md`](OPERATIONS.md) used synthetic images; user said they can provide a slip but none is in this repository/task. | OCR may misread amounts or Thai dates on real receipts. The confirmation step is a key financial safety control. | Run OCR against a user-provided image with sensitive details redacted; record field-level accuracy and correct parsing issues. Never save a transaction without user confirmation. | Requires user-provided image; test amount/date/merchant/category suggestions and rejection/edit flows. | Waiting for image |
| P2 | Frontend lint reports 13 `react(set-state-in-effect)` warnings and one missing `setSignedInUser` dependency warning in [`web/src/App.tsx`](web/src/App.tsx:139). | Effects that immediately set state can cause extra renders; an incomplete dependency list can leave auth UI stale after callback identity changes. This is a maintainability/behavior risk, not proof of a current user-visible defect. | Review each affected effect; derive state during render where possible, move state changes to event/data-load callbacks, and correct dependencies without changing auth behavior. | `npm run lint` with zero warnings for touched code, production build, and UI checks for login, family selection, receipt upload, and transaction reload. | Planned |
| P2 | No real-device acceptance of multi-user account deletion and family transfer is recorded; previous coverage is synthetic MySQL/API fixture testing. | Edge cases around family ownership, attribution, receipts, and audit history may differ from a household's actual data. | Review flow with a disposable family and synthetic transactions/receipts; confirm the user-facing copy and export/deletion behavior. Do not run deletion on production accounts. | Disposable account and MySQL fixture only; user review of final copy before domain access. | Planned |
| P2 | Route/permission and ledger integration coverage is documented in [`PLAN.md`](PLAN.md), but this checkout does not contain a repeatable consolidated command for those scenario suites. | Future changes can regress financial totals or scope checks without a quick, repeatable signal. | Consolidate existing disposable-MySQL checks into documented scripts/commands, then add transaction, transfer, family-role, account-deletion, and migration-upgrade cases to the routine verification workflow. | Keep all fixtures isolated; confirm cleanup and never point scenario checks at production. | Planned |

## Review sequence

1. Close the P1 deployment gate in code and docs, without turning on Tunnel.
2. Make the frontend lint warnings actionable, preserving current flows.
3. Consolidate disposable-MySQL verification and run it against isolated fixtures.
4. Complete receipt OCR and account-deletion acceptance when user inputs are available.
5. Resolve backup design with the user, implement it, and rehearse restore.
6. Re-run API syntax checks, frontend lint/build, Podman build/health checks, and confirm the Tunnel service is stopped.

## Checks completed for this review

- Read `AGENT.md`, `PLAN.md`, `README.md`, `OPERATIONS.md`, `compose.yaml`, API route/authentication code, migrations, and backup/restore script.
- Confirmed Compose defaults bind MySQL and web to `127.0.0.1`, API is not host-published, and Cloudflare is only under the `tunnel` profile.
- Ran `npm run lint` in `web/`: it completed with 14 warnings (13 set-state-in-effect and one missing dependency); no errors were reported.
- Ran `node --check api/server.js` and `npm run build` in `web/`: both passed.
- Checked the current Podman container list; no `saving-cloudflared` container is running.
- No production database or user records were changed. Cloudflare Tunnel was not started.

## User decisions / external inputs still needed

- Backup destination, encryption/key custody, schedule, and retention remain deferred by the user.
- A redacted real receipt image is needed for OCR accuracy review.
- Final domain, secret values, and operator acceptance are required for a deployment preflight success case; secrets must remain in `.env` and outside Git.
- The reset-password SMTP request was accepted by the handler in a previous task; user confirmation of inbox/spam delivery is still outstanding.
