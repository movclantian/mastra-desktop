/** Normalize an API root, never guess a hostname or probe it with a user's credential. */
export function normalizeProviderUrl(
  value: string,
  protocol: "openai" | "anthropic" | "gemini" = "openai",
): string {
  const text = value.trim();
  if (!/^https?:\/\//i.test(text)) throw new Error("Base URL must start with http:// or https://");
  const url = new URL(text);
  if (url.username || url.password || url.search || url.hash)
    throw new Error("Base URL must not contain credentials, query parameters or fragments");
  if (/\s/.test(text) || !url.hostname) throw new Error("Invalid Base URL");
  let path = url.pathname.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  const endpoints =
    protocol === "gemini"
      ? /\/models(?:\/[^/]+:(?:generateContent|streamGenerateContent))?$/
      : protocol === "anthropic"
        ? /\/(?:messages|models)$/
        : /\/(?:chat\/completions|responses|completions|embeddings|models)$/;
  path = path.replace(endpoints, "");
  if (!path) path = protocol === "gemini" ? "/v1beta" : "/v1";
  url.pathname = path;
  return url.toString().replace(/\/+$/, "");
}
