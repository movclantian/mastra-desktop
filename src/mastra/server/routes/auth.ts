import { registerApiRoute } from "@mastra/core/server";
import {
  authUserFromContext,
  loginAuthUser,
  registerAuthUser,
  revokeAuthSession,
} from "../../auth";
import { workError } from "../../errors";

async function readJson<T extends Record<string, unknown>>(c: {
  req: { json: <T>() => Promise<T> };
}): Promise<T> {
  try {
    return await c.req.json<T>();
  } catch {
    throw workError("VALIDATION_INVALID_JSON");
  }
}

function rethrowAuthError(error: unknown): never {
  if (error instanceof Error && "code" in error) {
    const code = (error as { code: string }).code;
    if (code === "AUTH_INVALID_CREDENTIALS") throw workError("AUTH_INVALID_CREDENTIALS");
    if (code === "AUTH_EMAIL_EXISTS") throw workError("AUTH_EMAIL_EXISTS");
    if (code === "AUTH_VALIDATION") throw workError("AUTH_VALIDATION", { text: error.message });
  }
  throw error;
}

export const authLoginRoute = registerApiRoute("/work/auth/login", {
  method: "POST",
  requiresAuth: false,
  handler: async (c) => {
    try {
      return c.json(await loginAuthUser(await readJson<{ email: unknown; password: unknown }>(c)));
    } catch (error) {
      rethrowAuthError(error);
    }
  },
});

export const authRegisterRoute = registerApiRoute("/work/auth/register", {
  method: "POST",
  requiresAuth: false,
  handler: async (c) => {
    try {
      return c.json(
        await registerAuthUser(
          await readJson<{ name: unknown; email: unknown; password: unknown }>(c),
        ),
        201,
      );
    } catch (error) {
      rethrowAuthError(error);
    }
  },
});

export const authLogoutRoute = registerApiRoute("/work/auth/logout", {
  method: "POST",
  handler: async (c) => {
    const authorization = c.req.header("authorization") ?? "";
    await revokeAuthSession(authorization.replace(/^Bearer\s+/i, "").trim());
    return c.json({ ok: true });
  },
});

export const authMeRoute = registerApiRoute("/work/auth/me", {
  method: "GET",
  handler: (c) => {
    const user = authUserFromContext(c.get("requestContext")?.get("user"));
    if (!user) throw workError("AUTH_REQUIRED");
    return c.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  },
});
