import {
  type BrowserSearchEngine,
  BrowserSearchEngineSchema,
} from "../../../shared/browser-contract";

const STORAGE_KEY_PREFIX = "mastra-work:browser-search-engine";
const CHANGE_EVENT = "mastra:browser-search-engine-changed";

function storageKey(userId: string): string {
  return `${STORAGE_KEY_PREFIX}:${encodeURIComponent(userId)}`;
}

export function getBrowserSearchEnginePreference(userId: string): BrowserSearchEngine {
  try {
    const saved = localStorage.getItem(storageKey(userId));
    const parsed = BrowserSearchEngineSchema.safeParse(saved);
    return parsed.success ? parsed.data : "bing";
  } catch {
    return "bing";
  }
}

export function setBrowserSearchEnginePreference(
  userId: string,
  engine: BrowserSearchEngine,
): void {
  const parsed = BrowserSearchEngineSchema.safeParse(engine);
  if (!parsed.success) return;
  try {
    localStorage.setItem(storageKey(userId), parsed.data);
  } catch {
    // Keep the current renderer usable when storage is unavailable.
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(CHANGE_EVENT, { detail: { userId, engine: parsed.data } }),
    );
  }
}

export function subscribeBrowserSearchEnginePreference(
  userId: string,
  onChange: (engine: BrowserSearchEngine) => void,
): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handleChange = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (!detail || typeof detail !== "object") return;
    const value = detail as { userId?: unknown; engine?: unknown };
    const engine = BrowserSearchEngineSchema.safeParse(value.engine);
    if (value.userId === userId && engine.success) onChange(engine.data);
  };
  window.addEventListener(CHANGE_EVENT, handleChange);
  return () => window.removeEventListener(CHANGE_EVENT, handleChange);
}
