# Ounjai review and remediation plan

Review date: 25 September 2026
Baseline: `1dae08b`
Working branch: `codex/ounjai-review-plan`

## Scope

Reviewed authentication, authorization, family and personal finance data, MySQL migrations, receipt handling, Podman Compose, backup/restore, frontend quality, and operational readiness. All integration checks use disposable MySQL/API containers and synthetic data. No production data was modified and Cloudflare Tunnel was not started.

## Findings and disposition

| Priority | Finding | Work completed | Disposition |
| --- | --- | --- | --- |
| P1 | Tunnel startup relied on operator discipline and insecure Compose defaults. | Added a fail-closed Compose preflight and PowerShell validate/start/stop wrapper. Gate checks HTTPS domain format, secure cookies, distinct strong DB passwords, token, SMTP transport/credentials, and Super Admin email. Added unit tests and isolated Compose smoke test. | Code gate is complete. Real domain/DNS, production secrets, operator acceptance, and the final go-live decision remain external prerequisites. Tunnel remains off. |
| P1 | Backup encryption, offsite target, key ownership, schedule, and retention are undecided. | Existing backup/restore remains documented and has been exercised with disposable data. | User explicitly deferred these design choices. Automated/offsite disaster recovery is not complete; revisit when the user chooses a policy. |
| P2 | Real receipt OCR accuracy was not independently verified. | Existing synthetic image workflow and confirmation step remain in place. | User plans to test with their own slip in the app. Do not ask for or retain a slip here. Real-image accuracy is awaiting the user's result. |
| P2 | Frontend lint reported React effect warnings. | Refactored auth/data/form selection state to avoid effect-driven resets and corrected dependencies. | `npm run lint` passes with zero warnings; production build is included in verification. |
| P2 | Route and ledger scenarios lacked one repeatable, isolated verification command. | Added `compose.integration.yaml`, a disposable MySQL/API integration suite, and `scripts/integration.ps1`; suite checks auth/scope, family ledger balances, transfers, permission denial, and account deletion/anonymization behavior. | Integration suite passed; its uniquely named containers, network, and volumes were removed. |
| P2 | Real-device account-deletion acceptance and inbox delivery are not proven by synthetic checks. | Account deletion is covered at API/database level, and SMTP sink coverage is documented in `PLAN.md`. | User-facing, real-account deletion acceptance and confirmation that Gmail delivered mail to the inbox remain outstanding. |

## Verification command

Run the consolidated checks from the repository root:

```powershell
./scripts/verify.ps1
```

It checks API syntax, tunnel-preflight unit and Compose behavior, the disposable MySQL integration suite, frontend lint/build, and Compose configuration. Integration data and named volumes are removed by the script. Do not run production migrations or point this suite at production.

## Remaining actions

1. User reviews real-slip OCR suggestions in the app and reports any amount/date/merchant/category errors.
2. User confirms reset-password email reached the Gmail inbox (including spam folder).
3. Decide backup encryption, key custody, offsite destination, schedule, and retention before claiming complete disaster recovery.
4. Before any public launch, set real production values in the ignored `.env`, validate against the real HTTPS domain, review the data/access policy, and get explicit operator approval. Cloudflare Tunnel stays off until then.

These items require user input or production-domain configuration; they are not silently treated as completed by code tests.
