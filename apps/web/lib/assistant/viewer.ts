/**
 * UI-2: who is looking at the assistant view, for per-user state (thread pins).
 *
 * Board access is a single operator principal today (board session cookie or board JWT, #105);
 * neither carries a user id until per-user login lands (#107). Until then every board request
 * maps to the same key, so pins are stored per user but there is one board user. When login
 * lands, return the signed-in user's id here; the pin table needs no change.
 */
export const BOARD_OPERATOR_USER_KEY = 'board';

export async function assistantViewerKey(): Promise<string> {
  return BOARD_OPERATOR_USER_KEY;
}
