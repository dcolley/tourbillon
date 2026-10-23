/**
 * UI-1: which top-level view the user prefers. `/` redirects to it.
 * Stored in localStorage under `tourbillon.view`; anything other than a known view
 * (missing, invalid, storage unavailable) means the default, the assistant view.
 */
export const VIEW_PREFERENCE_STORAGE_KEY = 'tourbillon.view';

export const APP_VIEWS = ['assistant', 'control'] as const;

export type AppView = (typeof APP_VIEWS)[number];

export const DEFAULT_APP_VIEW: AppView = 'assistant';

export const APP_VIEW_LABELS: Record<AppView, string> = {
  assistant: 'Assistant',
  control: 'Control Pane',
};

/** Landing path for each view. */
export const APP_VIEW_HOME_PATHS: Record<AppView, string> = {
  assistant: '/assistant',
  control: '/dashboard',
};

export function isAppView(value: unknown): value is AppView {
  return typeof value === 'string' && (APP_VIEWS as readonly string[]).includes(value);
}

export function readViewPreference(): AppView {
  if (typeof window === 'undefined') return DEFAULT_APP_VIEW;
  try {
    const raw = window.localStorage.getItem(VIEW_PREFERENCE_STORAGE_KEY);
    if (isAppView(raw)) return raw;
  } catch {
    // storage unavailable (privacy mode, quota): fall back to the default
  }
  return DEFAULT_APP_VIEW;
}

export function writeViewPreference(view: AppView): void {
  if (typeof window === 'undefined' || !isAppView(view)) return;
  try {
    window.localStorage.setItem(VIEW_PREFERENCE_STORAGE_KEY, view);
  } catch {
    // ignore
  }
}

export function viewHomePath(view: AppView): string {
  return APP_VIEW_HOME_PATHS[isAppView(view) ? view : DEFAULT_APP_VIEW];
}

/** Where `/` sends the user: the landing path of the stored view. */
export function homeRedirectPath(): string {
  return viewHomePath(readViewPreference());
}
