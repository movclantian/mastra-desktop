import type { BrowserSearchEngine } from "../../../../../shared/browser-contract";

export function resolveBrowserOmniboxInput(
  rawInput: string,
  searchEngine: BrowserSearchEngine = "bing",
): { kind: "navigate" | "search"; url: string } | null {
  const input = rawInput.trim();
  if (!input || input.length > 8_192) return null;

  const parseWebUrl = (value: string): URL | null => {
    try {
      const url = new URL(value);
      if (
        (url.protocol !== "http:" && url.protocol !== "https:") ||
        url.username !== "" ||
        url.password !== ""
      ) {
        return null;
      }
      return url;
    } catch {
      return null;
    }
  };

  const search = (): { kind: "search"; url: string } => ({
    kind: "search",
    url:
      searchEngine === "baidu"
        ? `https://www.baidu.com/s?wd=${encodeURIComponent(input)}`
        : searchEngine === "google"
          ? `https://www.google.com/search?q=${encodeURIComponent(input)}`
          : `https://www.bing.com/search?q=${encodeURIComponent(input)}`,
  });

  if (/^https?:/i.test(input)) {
    const url = parseWebUrl(input);
    if (url) return { kind: "navigate", url: url.toString() };
    try {
      const attemptedUrl = new URL(input);
      if (attemptedUrl.username || attemptedUrl.password) return null;
    } catch {
      // A malformed URL is treated as search text, like a browser address bar.
    }
    return search();
  }

  if (/^[a-z][a-z\d+.-]*:\/\//i.test(input)) return search();
  if (/\s/u.test(input)) return search();

  const candidate = parseWebUrl(`https://${input}`);
  if (!candidate) return search();

  const hostname = candidate.hostname.toLowerCase();
  const labels = hostname.split(".");
  const isIpv4 =
    labels.length === 4 && labels.every((label) => /^\d{1,3}$/.test(label) && Number(label) <= 255);
  const isIpv6 = hostname.startsWith("[") && hostname.endsWith("]") && hostname.includes(":");
  const isLocalhost = hostname === "localhost" || hostname.endsWith(".localhost");
  const isDomain =
    labels.length > 1 &&
    labels.every(
      (label) =>
        label.length > 0 &&
        /^[a-z\d-]+$/i.test(label) &&
        !label.startsWith("-") &&
        !label.endsWith("-"),
    );

  if (!isLocalhost && !isIpv4 && !isIpv6 && !isDomain) return search();

  if (isLocalhost || isIpv4 || isIpv6) {
    const localUrl = parseWebUrl(`http://${input}`);
    return localUrl ? { kind: "navigate", url: localUrl.toString() } : null;
  }

  return { kind: "navigate", url: candidate.toString() };
}
