# Mobile Auth Test Plan

## Unit Tests

### `verifyMobileToken()`
- [ ] Returns `null` when no `X-Company-Token` header present
- [ ] Returns `companyId` for valid JWT token
- [ ] Returns `null` for invalid/expired token
- [ ] Returns `null` for malformed token

### `POST /api/mobile/companies`
- [ ] Returns 400 when `companyId` missing
- [ ] Returns 404 when company doesn't exist
- [ ] Returns 200 with valid JWT when company exists
- [ ] JWT contains correct `companyId` claim
- [ ] JWT is valid for 30 days

## Integration Tests

### `/api/chat/agents` with mobile token
- [ ] Returns 401 when no auth provided
- [ ] Returns agents list when valid `X-Company-Token` provided
- [ ] Returns agents for correct company (matches token claim)

### `/api/issues/list` with mobile token
- [ ] Returns 401 when no auth provided
- [ ] Defaults to `filter=active` when no filter param
- [ ] Returns only active issues (todo/in_progress/in_review/blocked)
- [ ] Respects `filter` query parameter
- [ ] Returns issues for correct company (matches token claim)

## Mobile Client Tests

### `ApiClient`
- [ ] Loads session token from SecureStore on init
- [ ] Sends `X-Company-Token` header on all requests after login
- [ ] Stores new token in SecureStore after `selectCompany()`
- [ ] Clears token from SecureStore on `clearSession()`

### Screens
- [ ] CompanySelectScreen saves token and navigates on success
- [ ] AgentsScreen loads agents using existing `/api/chat/agents`
- [ ] IssuesScreen loads active issues using `/api/issues/list?filter=active`
