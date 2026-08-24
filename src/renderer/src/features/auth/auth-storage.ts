import type { AuthSession, AuthUser } from "@/api/auth-api";
import type { RememberedAccount } from "./types";

export const AUTH_TOKEN_KEY = "mastra-work:auth-token";
export const AUTH_SESSION_KEY = "mastra-work:remembered-session";
export const AUTH_ACCOUNTS_KEY = "mastra-work:remembered-accounts";
export const AUTH_AUTO_LOGIN_KEY = "mastra-work:auto-login";
export const AUTH_COOKIE_KEY = "mastra-token";

function readStorage<T>(storage: Storage, key: string, fallback: T): T {
  try {
    const value = storage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function getRememberedAccounts(): RememberedAccount[] {
  const accounts = readStorage<unknown[]>(localStorage, AUTH_ACCOUNTS_KEY, []);
  return accounts.filter(
    (account): account is RememberedAccount =>
      typeof account === "object" &&
      account !== null &&
      typeof (account as RememberedAccount).email === "string" &&
      typeof (account as RememberedAccount).name === "string",
  );
}

export function rememberAccount(user: AuthUser): void {
  const next = [
    { email: user.email, name: user.name },
    ...getRememberedAccounts().filter((account) => account.email !== user.email),
  ].slice(0, 5);
  localStorage.setItem(AUTH_ACCOUNTS_KEY, JSON.stringify(next));
}

export function getStoredSession(): AuthSession | null {
  const session = readStorage<AuthSession | null>(localStorage, AUTH_SESSION_KEY, null);
  return session?.token && session.user?.id ? session : null;
}

export function getStoredToken(): string | null {
  return sessionStorage.getItem(AUTH_TOKEN_KEY) ?? getStoredSession()?.token ?? null;
}

export function syncAuthCookie(token: string | null): void {
  if (typeof document === "undefined") return;
  // biome-ignore lint/suspicious/noDocumentCookie: cookie sync required for API authentication in Electron renderer
  document.cookie = token
    ? `${AUTH_COOKIE_KEY}=${token}; Path=/; SameSite=Lax`
    : `${AUTH_COOKIE_KEY}=; Path=/; Max-Age=0; SameSite=Lax`;
}
