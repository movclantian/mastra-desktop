import { createRoute } from "@mastra/server/server-adapter";
import { z } from "zod";
import {
  authLoginSchema,
  authRegistrationSchema,
  authUserFromContext,
  loginAuthUser,
  registerAuthUser,
  revokeAuthSession,
} from "../auth";
import { workError, workValidationError } from "../errors";

export const authLoginRoute = createRoute({
  queryParamSchema: z.object({}).strict(),
  path: "/work/auth/login",
  responseType: "json",
  onValidationError: workValidationError,
  method: "POST",
  bodySchema: authLoginSchema.transform((credentials) => ({ credentials })),
  requiresAuth: false,
  handler: async (params) => {
    return await loginAuthUser(params.credentials);
  },
});

export const authRegisterRoute = createRoute({
  queryParamSchema: z.object({}).strict(),
  path: "/work/auth/register",
  responseType: "json",
  onValidationError: workValidationError,
  method: "POST",
  bodySchema: authRegistrationSchema.transform((credentials) => ({ credentials })),
  requiresAuth: false,
  handler: async (params) => {
    return await registerAuthUser(params.credentials);
  },
});

export const authLogoutRoute = createRoute({
  queryParamSchema: z.object({}).strict(),
  bodySchema: z.object({}).strict().optional(),
  path: "/work/auth/logout",
  responseType: "json",
  onValidationError: workValidationError,
  method: "POST",
  handler: async (params) => {
    const authorization = params.request?.headers.get("authorization") ?? "";
    await revokeAuthSession(authorization.replace(/^Bearer\s+/i, "").trim());
    return { ok: true };
  },
});

export const authMeRoute = createRoute({
  queryParamSchema: z.object({}).strict(),
  path: "/work/auth/me",
  responseType: "json",
  onValidationError: workValidationError,
  method: "GET",
  handler: async (params) => {
    const user = authUserFromContext(params.requestContext?.get("user"));
    if (!user) throw workError("AUTH_REQUIRED");
    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
      },
    };
  },
});
