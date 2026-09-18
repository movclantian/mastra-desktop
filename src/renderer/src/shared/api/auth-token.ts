export const AUTH_TOKEN_KEY = "mastra-work:auth-token";

export function getAuthToken(): string | null {
  try {
    return sessionStorage.getItem(AUTH_TOKEN_KEY) ?? localStorage.getItem(AUTH_TOKEN_KEY);
  } catch {
    return null;
  }
}
