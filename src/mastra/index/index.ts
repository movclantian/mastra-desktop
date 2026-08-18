import { chatRoute } from "@mastra/ai-sdk";
import { Mastra } from "@mastra/core/mastra";
import { PinoLogger } from "@mastra/loggers";
import { MastraStorageExporter, Observability, SensitiveDataFilter } from "@mastra/observability";
import { mastraWorkAgent } from "../agents/overview";
import { workRoutes } from "../server/custom-api-routes";
import { appStorage } from "../storage";

export const mastra = new Mastra({
  agents: { mastraWorkAgent },
  server: {
    cors: {
      origin: "*", // Restrict this to your app's origin in production
      allowMethods: ["*"],
      allowHeaders: ["*"],
    },
    apiRoutes: [
      chatRoute({
        path: "/chat/:agentId",
      }),
      ...workRoutes,
    ],
  },
  storage: appStorage,
  logger: new PinoLogger({
    name: "Mastra",
    level: "info",
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: "mastra-work",
        exporters: [new MastraStorageExporter()],
        spanOutputProcessors: [new SensitiveDataFilter()],
      },
    },
  }),
});
