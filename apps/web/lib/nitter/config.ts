import path from 'node:path';
import { config as loadDotenv } from 'dotenv';

const DEFAULT_NITTER_URL = 'https://nitter.net';

let rootEnvLoaded = false;

/** Load monorepo root .env when NITTER_URL is missing (Next dev may not inherit shell exports). */
function ensureRootEnvLoaded(): void {
  if (rootEnvLoaded) return;
  rootEnvLoaded = true;

  if (process.env.NITTER_URL?.trim()) return;

  const candidates = [
    path.resolve(process.cwd(), '../../.env'),
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '../../../.env'),
  ];

  for (const envPath of candidates) {
    loadDotenv({ path: envPath });
    if (process.env.NITTER_URL?.trim()) break;
  }
}

export function getNitterUrl(): string | null {
  ensureRootEnvLoaded();
  const raw = process.env.NITTER_URL?.trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, '');
}

export function getNitterUrlOrDefault(): string {
  return getNitterUrl() ?? DEFAULT_NITTER_URL;
}
