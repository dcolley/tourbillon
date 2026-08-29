# Tourbillon Mobile Companion

A React Native mobile companion app for Tourbillon — the open-source AI agent orchestration platform.

## What's Included

This is a **first-cut mobile companion** that connects to your local or remote Tourbillon control plane:

### Features

- **Company Selection** — Browse and select companies from your Tourbillon instance
- **Agents List** — View all agents with their roles, status, and metadata
- **Issues & Inbox** — Browse active issues across the company

### What's NOT Included (Yet)

- Issue detail view
- Creating/editing agents or issues
- Real-time updates (SSE/WebSocket)
- Push notifications
- Agent chat interface
- Observability/metrics
- Offline support

This is a **read-only companion** for now — think of it as a mobile dashboard for monitoring your agent workforce.

## Tech Stack

- **Expo** (~57) — React Native framework with managed workflow
- **React Navigation** v7 — Stack navigation
- **TypeScript** — Full type safety
- **Zod** — Runtime validation (shared with monorepo)

## Prerequisites

- Node.js 20+
- pnpm 9+
- iOS Simulator (macOS) or Expo Go app (iOS/Android)
- Tourbillon control plane running (see root README)

## Getting Started

### 1. Start the Tourbillon Backend

From the repo root:

```bash
# Terminal 1 — Infrastructure
docker compose up -d postgres redis

# Terminal 2 — Web API
pnpm dev
# → http://localhost:3002

# Terminal 3 — Workers (optional for mobile)
pnpm workers:dev
```

### 2. Start the Mobile App

From the repo root or `apps/mobile`:

```bash
cd apps/mobile
pnpm start
```

This opens the Expo DevTools in your browser.

### 3. Run on a Device/Simulator

Choose one:

- **iOS Simulator** (macOS only):
  ```bash
  pnpm ios
  ```

- **Expo Go** (iOS/Android):
  1. Install the Expo Go app from the App Store / Play Store
  2. Scan the QR code from `pnpm start`

- **Android Emulator**:
  ```bash
  pnpm android
  ```

## Configuration

### API Base URL

The mobile app connects to the Tourbillon API. By default it uses `http://localhost:3002`.

To change this (e.g., for a remote server or LAN testing):

1. Edit `apps/mobile/src/api/config.ts`
2. Update `DEV_API_URL` to your server's address:
   ```typescript
   const DEV_API_URL = 'http://192.168.1.100:3002'; // Your local IP
   ```

**For production**, you would:
- Use environment variables via `app.config.js` or EAS Build
- Add a settings screen for users to configure their server URL
- Implement proper authentication (OAuth, API keys, etc.)

### Testing on Real Devices

To test on a real device connected to the same WiFi network:

1. Find your machine's local IP (e.g., `192.168.1.100`)
2. Update `DEV_API_URL` in `apps/mobile/src/api/config.ts`
3. Make sure your Tourbillon web server binds to `0.0.0.0` (it already does via `next dev -H 0.0.0.0`)
4. Scan the QR code with Expo Go

## Authentication

This first-cut app uses the same **cookie-based company selection** as the web app:

- No user accounts (Tourbillon is single-user/local by design)
- Company selection sets an `active_company_id` cookie
- All API calls require this cookie to be set

For a production deployment, you would add:
- Multi-user authentication (e.g., better-auth session tokens)
- API key authentication for mobile clients
- OAuth/SSO integration

## Project Structure

```
apps/mobile/
├── src/
│   ├── api/
│   │   ├── client.ts       # API client with fetch wrapper
│   │   └── config.ts       # API base URL configuration
│   ├── navigation/
│   │   └── RootNavigator.tsx  # React Navigation setup
│   ├── screens/
│   │   ├── CompanySelectScreen.tsx  # Company picker
│   │   ├── AgentsScreen.tsx         # Agents list
│   │   └── IssuesScreen.tsx         # Issues/inbox list
│   └── types/
│       └── index.ts        # Shared types (Company, Agent, Issue)
├── App.tsx                 # Entry point
├── package.json
└── README.md
```

## API Endpoints (Backend)

The mobile app calls these new routes (added to `apps/web/app/api/mobile/`):

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/mobile/companies` | List all companies |
| `POST` | `/api/mobile/companies/:id/select` | Set active company (cookie) |
| `GET` | `/api/mobile/companies/:id/agents` | List agents |
| `GET` | `/api/mobile/companies/:id/issues` | List issues |

These routes reuse existing Tourbillon server-side logic and require the `active_company_id` cookie.

## Type Checking

```bash
pnpm type-check
```

This runs TypeScript in `--noEmit` mode to catch type errors before runtime.

## Known Limitations

1. **No authentication** — Anyone who can reach your API can use it. Fine for local dev, not for production.
2. **Cookies across domains** — If the API is on a different domain, you'll need CORS + `credentials: 'include'` (already done) and matching `sameSite` cookie settings.
3. **No shared types package** — Types are duplicated in `src/types/index.ts`. In a real monorepo, you'd extract these to `@tourbillon/shared` or a new `@tourbillon/api-types` package.
4. **No deep linking** — Can't open specific agents or issues via URL schemes.
5. **No image optimization** — No `expo-image` or `react-native-fast-image`.

## Next Steps (Future PRs)

- [ ] Issue detail screen with comments
- [ ] Agent detail screen
- [ ] Real-time updates via SSE or WebSocket
- [ ] Push notifications for agent events
- [ ] Agent chat interface (mobile equivalent of web chat)
- [ ] Dark mode support
- [ ] Pull-to-refresh on lists
- [ ] Pagination for long lists
- [ ] Error boundary for crash handling
- [ ] Analytics/monitoring
- [ ] EAS Build configuration for App Store / Play Store

## Contributing

This is a minimal first cut. Contributions are welcome! Please:

1. Keep the mobile app **read-only** until we design write APIs
2. Follow the existing patterns (navigation, API client, types)
3. Test on both iOS and Android if possible
4. Update this README with any new features or config

## License

MIT (same as parent repo)
