import { registerApiRoute } from "@mastra/core/server";
import { authUserFromContext, loginAuthUser, registerAuthUser, revokeAuthSession } from "../auth";
import { workError } from "../errors";

async function readJson<T extends Record<string, unknown>>(c: {
  req: { json: <T>() => Promise<T> };
}): Promise<T> {
  try {
    return await c.req.json<T>();
  } catch {
    throw workError("VALIDATION_INVALID_JSON");
  }
}

export const authLoginRoute = registerApiRoute("/work/auth/login", {
  method: "POST",
  requiresAuth: false,
  handler: async (c) => {
    return c.json(await loginAuthUser(await readJson<{ email: unknown; password: unknown }>(c)));
  },
});

export const authRegisterRoute = registerApiRoute("/work/auth/register", {
  method: "POST",
  requiresAuth: false,
  handler: async (c) => {
    return c.json(
      await registerAuthUser(
        await readJson<{ name: unknown; email: unknown; password: unknown }>(c),
      ),
      201,
    );
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
