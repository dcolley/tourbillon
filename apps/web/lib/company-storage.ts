export const ACTIVE_COMPANY_STORAGE_KEY = 'tourbillon:activeCompanyId';

export function getStoredCompanyId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(ACTIVE_COMPANY_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setStoredCompanyId(id: string): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(ACTIVE_COMPANY_STORAGE_KEY, id);
}

export function clearStoredCompanyId(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(ACTIVE_COMPANY_STORAGE_KEY);
}
