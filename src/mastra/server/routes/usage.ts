import { registerApiRoute } from "@mastra/core/server";
import { workError } from "../../errors";
import { getUsageSummary } from "../../usage";

function parseDate(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  // Date-only query values represent the user's local calendar day. Parsing
  // them as an ISO date would silently reinterpret midnight as UTC.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const local = new Date(`${value}T00:00:00`);
    return Number.isFinite(local.getTime()) ? local.getTime() : fallback;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const usageSummaryRoute = registerApiRoute("/work/usage", {
  method: "GET",
  handler: async (c) => {
    const user = c.get("requestContext")?.get("user") as { id?: unknown } | undefined;
    const resourceId = typeof user?.id === "string" ? user.id : "";
    if (!resourceId) throw workError("AUTH_REQUIRED");
    const now = Date.now();
    const from = parseDate(c.req.query("from"), now - 365 * 24 * 60 * 60 * 1000);
    const to = parseDate(c.req.query("to"), now + 24 * 60 * 60 * 1000);
    if (from >= to) throw workError("VALIDATION_FAILED", { text: "用量统计日期范围无效" });
    return c.json(await getUsageSummary(resourceId, from, to));
  },
});
