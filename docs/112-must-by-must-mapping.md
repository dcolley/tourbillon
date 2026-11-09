# #112 Step 2 — Must-by-must mapping (Hold re-gate)

Folded from Test `pr355-112-gate.md` (HOLD @ b86ec24) plus Step 1 M1–M5.

**Head (this commit):** see git. **Base:** `80a17b583e6a6c8d041161adcc33508063a51d2d`.

## Hold musts

| Must | Fix | Test / mutant |
|---|---|---|
| 1 Regression board → GitHub 500 | Extended board-guarded `fakeDb` with top-level insert/delete + `verification` + `lt` | `board → redirect to GitHub` passes; full `run-tests.mjs` head vs base: **0 net-new failures** (45 env fails both) |
| 2 Callback company_user | Signed `scope=company_user` → `user_scope_unsupported`; row intact; 0 exchange/write | `callback company_user signed state…` + mutant `M-callback-skip-company-user` DISCRIMINATES |
| 3 Signed A-state + agent B1 | → `agent_not_in_company` pre-consume | `signed A-state naming agent B1…` + `M-callback-agent-ignores-company` DISCRIMINATES |
| 4 Clock seam gated | `oauthNowMs` ignores `TB112_NOW_MS` when `NODE_ENV` is production (case-insensitive) | `lib/vault-oauth-state-clock.test.ts` (in CI harness) |
| 5 Per-field tamper | agentId, scope, nonce, exp without resign → `invalid_state_signature` | `tamper agentId/scope/nonce/exp without resign…` |

## M1 mutants (current runner)

| id | status |
|---|---|
| M1a–M1f, M1h reorder, M1i–M1k, skip-archived, global-cookie, unconditional-clear | DISCRIMINATES |
| M-callback-skip-company-user | DISCRIMINATES |
| M-callback-agent-ignores-company | DISCRIMINATES |
| M-consume-wall-clock | DISCRIMINATES |
| M-consume-drop-identifier | DISCRIMINATES |
| M1g non-atomic | HARNESS-LIMITED (accepted) |

## Softs done

- S1 M1h = real consume-after-exchange reorder (Test X1)
- S3 Cookie HttpOnly / Path / SameSite asserted
- S4 Identifier predicate + shared-clock consume pinned (with mutants)
- S5 Canaries capture log/warn/error on success, exchange-fail, write-fail
- S6 Case 8 old write-failure variant
- S7 exp-1s uses −599_000 (≈1s remaining)
- S8 DB-error-during-consume via PG trigger
- S9 paused / pending_approval documented as allowed
- S10 SHA-stamped mutant log, raw fail snippets, no leftover `.bak`; mapping moved to `docs/`; case-9 order in PR body
- CI: clock unit added to web harness + scheduler pin

## Softs left / residual

- Authorize agent lookup company filter remains covered by mocked board-guarded (X5); not duplicated in PG
- M1g stays HARNESS-LIMITED
- Full board-guarded suite not added to harness (large); regression fixed in-place; clock unit is in CI

## Suite

- PG: 38/38 pinned ×3
- Mutants: 17 DISCRIMINATES, 1 HARNESS-LIMITED, 0 problems
- Full web `run-tests.mjs`: head 45 fail / base 45 fail; failing-name diff empty
