import { MASTRA_SERVER_URL } from "@/shared/api";
import { getStoredToken } from "./auth-storage";

let fetchInstalled = false;

export function installAuthenticatedFetch(): void {
  if (fetchInstalled) return;
  fetchInstalled = true;
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const target =
      typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
    const token = getStoredToken();
    let isMastraRequest = false;
    try {
      isMastraRequest =
        new URL(target, window.location.href).origin === new URL(MASTRA_SERVER_URL).origin;
    } catch {
      isMastraRequest = false;
    }
    if (!token || !isMastraRequest) return originalFetch(input, init);
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    if (!headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
    return originalFetch(input, { ...init, headers });
  };
}
