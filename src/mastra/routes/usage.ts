import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";
import { createRoute } from "@mastra/server/server-adapter";
import { z } from "zod";
import { workError, workValidationError } from "../errors";
import { getUsageSummary } from "../usage";

const usageDateSchema = z
  .union([z.iso.date(), z.iso.datetime({ offset: true, local: true })])
  // Date-only values denote a local calendar day, not midnight UTC.
  .transform((value) => new Date(value.length === 10 ? `${value}T00:00:00` : value).getTime());

export const usageSummaryRoute = createRoute({
  path: "/work/usage",
  method: "GET",
  responseType: "json",
  queryParamSchema: z
    .object({ from: usageDateSchema.optional(), to: usageDateSchema.optional() })
    .strict(),
  onValidationError: workValidationError,
  handler: async (params) => {
    const resourceId = params.requestContext.get(MASTRA_RESOURCE_ID_KEY) as string;
    if (!resourceId) throw workError("AUTH_REQUIRED");
    const now = Date.now();
    const from = params.from ?? now - 365 * 24 * 60 * 60 * 1000;
    const to = params.to ?? now + 24 * 60 * 60 * 1000;
    if (from >= to) throw workError("VALIDATION_FAILED", { text: "用量统计日期范围无效" });
    return getUsageSummary(resourceId, from, to);
  },
});
