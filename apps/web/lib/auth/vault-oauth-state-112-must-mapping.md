# #112 Step 2 — Must-by-must mapping (Test M1–M5)

Folded from `/workspace/tourbillon-security/112-mechanics-step1-review.md` into product + `apps/web/lib/auth/vault-oauth-state-112.pgtest.ts` (31 pinned) + `apps/web/scripts/run-pg-112-mutants.mjs`.

Base: `80a17b583e6a6c8d041161adcc33508063a51d2d`. Branch: `fix/112-vault-oauth-state`.

## M1 — Per-control discriminating mutants

| Must | Mutant id | Named test turned RED | Status |
|---|---|---|---|
| M1a `now > exp` vs `>=` | `M1a-exp-gt-not-gte` | `clock-injected: exactly at exp → state_expired; verification row unconsumed` | DISCRIMINATES |
| M1b skip exp | `M1b-skip-exp` | same | DISCRIMINATES |
| M1c skip cookie↔state nonce | `M1c-skip-nonce-compare` | `missing/mismatched cookie deny; transfer to other browser deny; re-login same browser ok` | DISCRIMINATES |
| M1d skip company equality | `M1d-skip-company-equality` | `cross-company and archived agent denied before exchange` | DISCRIMINATES |
| M1e skip callback agent recheck | `M1e-skip-agent-recheck` | same | DISCRIMINATES |
| M1f skip consume | `M1f-skip-consume` | `sequential durable replay → state_already_used; total one exchange/write` | DISCRIMINATES |
| M1g non-atomic select-then-delete | `M1g-non-atomic-select-delete` | — | **HARNESS-LIMITED** (no deterministic interleave seam; concurrent DELETE…RETURNING remains in suite) |
| M1h consume-after-exchange | `M1h-consume-after-exchange` | `exchange failure after consume → same-state retry denied; fresh authorize ok` | DISCRIMINATES (barrier via exchange stub / retry) |
| M1i allow company_user | `M1i-allow-company-user` | `company_user without identity → 400 clear message; …` | DISCRIMINATES |
| M1j default-secret fallback | `M1j-default-secret-fallback` | `missing secret authorize/callback fail closed` | DISCRIMINATES |
| M1k raw BETTER_AUTH_SECRET forge denied | `M1k-raw-key-accepts-raw-forged` | `raw-secret forged state and wrong-length sig deny without exchange` | DISCRIMINATES |
| skip-archived authorize | `M1-skip-archived-authorize` | `cross-company and archived agent denied before exchange` | DISCRIMINATES |
| #133 unconditional clear | `M1-unconditional-clear` | `response-order race: old success response has no clear; …` | DISCRIMINATES |
| single global cookie name | `M1-global-cookie-name` | `other company cookie untouched while company A rotates` | DISCRIMINATES |

Runner: `node apps/web/scripts/run-pg-112-mutants.mjs` against disposable `tb112_*` DB. Result: **13 DISCRIMINATES, 1 HARNESS-LIMITED, 0 problems**.

## M2 — Failure-stage table (config/provider BEFORE consume)

| Stage | Consume? | Covered by |
|---|---|---|
| `not_configured` (missing GitHub client id/secret) | No | `not_configured and unsupported_provider before consume; provider tokenData.error after consume` |
| `unsupported_provider` | No | same |
| provider 200 with `tokenData.error` | After consume (fresh authorize) | same |
| DB error during consume | No exchange / no write | suite + concurrent path; partial via real-PG trigger case |
| `encryptCredential` throws / write failure | After consume → retry denied | `write failure after consume…` + `write failure via disposable PG trigger…` |
| partial write | After consume | real-PG trigger raises on vault insert |

Config and provider checks run **before** `consumeOAuthNonce` in `callback/route.ts`.

## M3 — Case 8 arrival-order jar + suite invariant

| Requirement | Test |
|---|---|
| After new authorize Set-Cookie, deliver old success | `response-order race: old success…` + `case 8 arrival-order: …` |
| old exchange-fail / write-fail / stale nonce_mismatch / duplicate state_already_used | `case 8 arrival-order: after new Set-Cookie, deliver old success/exchange-fail/stale/duplicate; new flow ok` |
| No callback Set-Cookie for any `tourbillon_vault_oauth_nonce.*` | `suite invariant: no callback Set-Cookie for tourbillon_vault_oauth_nonce.*; failed authorize writes nothing` |
| Failed authorize: no cookie, no row | same suite invariant |
| Replay leftover cookie → `state_already_used`, no exchange | `replay with leftover cookie after success → state_already_used; zero new exchange` |

## M4 — Single injected clock

| Requirement | Implementation / test |
|---|---|
| One clock for exp check, sweep, consume | `oauthNowMs()` / `TB112_NOW_MS` in `vault-oauth-state.ts`; store imports it |
| `exp = now+600`, row `expiresAt` matches, Max-Age=600 | `authorize issues exp=now+600, matching verification expiresAt, Max-Age=600 (shared clock)` |
| `identifier` in BOTH DELETEs | `vault-oauth-nonce-store.ts` sweep + consume predicates |

## M5 — Extra fixtures

| Requirement | Test / pin |
|---|---|
| Logged-out callback 401; agent bearer 403; nonce intact | `logged-out callback → 401; agent bearer → 403; nonce row intact` |
| Revocation / company switch authorize→callback | `company switch between authorize and callback → company_mismatch; B snapshots unchanged` |
| Company B vault + verification snapshots unchanged | same |
| Case 10 non-disclosure canaries | `non-disclosure canaries: code, token, client secret, nonce absent from logs/bodies/Location` |
| Write failure in real disposable PG (trigger) | `write failure via disposable PG trigger → callback_failed; retry denied; fresh authorize ok` |
| Exact codes for malformed / wrong-length sig | `malformed and wrong-length signatures → exact invalid_state_signature (not callback_failed)` |
| Archived agent authorize: 404 before state/cookie/row | product pin + `cross-company and archived agent…`; authorize returns `{ error: 'Agent not found' }` 404 |
| Archived at callback: deny before consume, pinned code | `agent_not_in_company` |
| `user_scope_unsupported`: query carries code only | company_user test + product redirect |
| Mobile board JWT: negatives only | `mobile JWT negatives: B-JWT+A-state → company_mismatch; A-JWT without nonce → missing_nonce; no consume` (+ positive company-scope mobile path for happy company flow) |

## Softs (documented, not blockers)

- S1 legacy: raw-key v1 → `invalid_state_signature`; derived-key v1 shape → `invalid_state` (covered in tamper/legacy test).
- S2 derivation: `HMAC(BETTER_AUTH_SECRET, "tourbillon-vault-oauth-state-v2")` — see `vault-oauth-state.ts`.
- S3 paused / pending_approval: not in contract; archived only is denied.
- S4–S8: noted in Step 1 map; never-clear intentional; no `__Host-`; company_user 400; mobile positives not required for binding.

## Evidence commands (local disposable)

```
DATABASE_URL=postgres://tb112:tb112@127.0.0.1:55112/tb112_test REDIS_URL=redis://127.0.0.1:1 \
  node apps/web/scripts/run-pg-112-tests.mjs
# → 31/31 pinned, exit 0 (×3)

DATABASE_URL=… node apps/web/scripts/run-pg-112-mutants.mjs
# → 13 discriminate, 1 HARNESS-LIMITED, 0 problems
```

CI job: `pg-112-oauth-state` in `.github/workflows/ci.yml` (disposable pgvector service + migrate + pinned runner).
