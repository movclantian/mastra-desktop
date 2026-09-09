export const SEARCH_SELECTION_KEY = "mastra-work:search-selection";
export const ACTIVE_THREAD_KEY = "mastra-work:active-thread";
export const MODE_KEY = "mastra-work:mode";
export const PERMISSION_RULES_KEY = "mastra-work:permission-rules";

export function userStorageKey(key: string, userId: string): string {
  return `${key}:${encodeURIComponent(userId)}`;
}

export function readJson<T>(key: string, fallback: T): T {
  const raw = localStorage.getItem(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJson<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage quota exceeded or disabled errors.
  }
}
