import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";
import type {
  ContextWithMastra,
  ICredentialsProvider,
  IUserProvider,
  MastraAuthRequest,
} from "@mastra/core/server";
import { getRequestHeader, getWebRequest, MastraAuthProvider } from "@mastra/core/server";
import { getGuardrailsConfig } from "./agents/guardrails";
import { getMcpConfig } from "./connections/mcp";
import { workError } from "./errors";
import { getMemoryConfig } from "./memory";
import { getLibrarySettings } from "./rag/settings";
import { getLibsqlClient } from "./storage";
import { getWorkspaceConfig } from "./workspace";

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: "admin" | "user";
}

export interface AuthSession {
  token: string;
  user: AuthUser;
}

const AUTH_USERS_TABLE = "auth_users";
const AUTH_SESSIONS_TABLE = "auth_sessions";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
let authSchemaReady: Promise<void> | undefined;

function ensureAuthSchema(): Promise<void> {
  authSchemaReady ??= getLibsqlClient().then(async (client) => {
    await client.execute(`
      CREATE TABLE IF NOT EXISTS ${AUTH_USERS_TABLE} (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL COLLATE NOCASE UNIQUE,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        created_at INTEGER NOT NULL
      )
    `);
    await client.execute(`
      CREATE TABLE IF NOT EXISTS ${AUTH_SESSIONS_TABLE} (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);
    await client.execute(
      `CREATE INDEX IF NOT EXISTS auth_sessions_user ON ${AUTH_SESSIONS_TABLE}(user_id)`,
    );
  });
  return authSchemaReady;
}

function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeName(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 80) : "";
}

function validateRegistration(name: string, email: string, password: string): void {
  if (!name || name.length > 80) {
    throw workError("AUTH_VALIDATION", { text: "请输入 1-80 个字符的名称" });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) {
    throw workError("AUTH_VALIDATION", { text: "请输入有效的邮箱地址" });
  }
  if (password.length < 8 || password.length > 200) {
    throw workError("AUTH_VALIDATION", { text: "密码长度必须为 8-200 个字符" });
  }
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const digest = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${digest}`;
}

function verifyPassword(password: string, encoded: string): boolean {
  const [salt, expectedHex] = encoded.split(":");
  if (!salt || !expectedHex || !/^[0-9a-f]+$/i.test(expectedHex)) return false;
  const expected = Buffer.from(expectedHex, "hex");
  const actual = scryptSync(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function rowUser(row: Record<string, unknown>): AuthUser | null {
  if (typeof row.id !== "string" || typeof row.name !== "string" || typeof row.email !== "string") {
    return null;
  }
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role === "admin" ? "admin" : "user",
  };
}

function hashToken(token: string): string {
  return scryptSync(token, "mastra-work-session", 32).toString("hex");
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; extendedCode?: unknown };
  return (
    candidate.code === "SQLITE_CONSTRAINT_UNIQUE" ||
    candidate.extendedCode === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

async function findUserBySessionToken(token: string): Promise<AuthUser | null> {
  if (!token) return null;
  await ensureAuthSchema();
  const client = await getLibsqlClient();
  const result = await client.execute({
    sql: `SELECT u.id, u.name, u.email, u.role
      FROM ${AUTH_SESSIONS_TABLE} s
      INNER JOIN ${AUTH_USERS_TABLE} u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?`,
    args: [hashToken(token), Date.now()],
  });
  return rowUser((result.rows[0] ?? {}) as Record<string, unknown>);
}

export async function findUserById(id: string): Promise<AuthUser | null> {
  await ensureAuthSchema();
  const result = await (await getLibsqlClient()).execute({
    sql: `SELECT id, name, email, role FROM ${AUTH_USERS_TABLE} WHERE id = ? LIMIT 1`,
    args: [id],
  });
  return rowUser((result.rows[0] ?? {}) as Record<string, unknown>);
}

/** 列出全部注册账户(会话所有权迁移的目标候选,见 /work/threads/:id/transfer) */
export async function listAuthUsers(): Promise<AuthUser[]> {
  await ensureAuthSchema();
  const result = await (await getLibsqlClient()).execute({
    sql: `SELECT id, name, email, role FROM ${AUTH_USERS_TABLE} ORDER BY created_at ASC`,
  });
  return result.rows.flatMap((row) => {
    const user = rowUser(row as Record<string, unknown>);
    return user ? [user] : [];
  });
}

async function findUserByEmail(email: string): Promise<{
  user: AuthUser;
  passwordHash: string;
} | null> {
  await ensureAuthSchema();
  const result = await (await getLibsqlClient()).execute({
    sql: `SELECT id, name, email, role, password_hash passwordHash
      FROM ${AUTH_USERS_TABLE} WHERE email = ? LIMIT 1`,
    args: [email],
  });
  const row = (result.rows[0] ?? {}) as Record<string, unknown>;
  const user = rowUser(row);
  return user && typeof row.passwordHash === "string"
    ? { user, passwordHash: row.passwordHash }
    : null;
}

async function sweepExpiredSessions(): Promise<void> {
  await (await getLibsqlClient()).execute({
    sql: `DELETE FROM ${AUTH_SESSIONS_TABLE} WHERE expires_at <= ?`,
    args: [Date.now()],
  });
}

async function issueSession(user: AuthUser): Promise<AuthSession> {
  await ensureAuthSchema();
  await sweepExpiredSessions();
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  await (await getLibsqlClient()).execute({
    sql: `INSERT INTO ${AUTH_SESSIONS_TABLE} (token_hash, user_id, created_at, expires_at)
      VALUES (?, ?, ?, ?)`,
    args: [hashToken(token), user.id, now, now + SESSION_TTL_MS],
  });
  return { token, user };
}

export async function registerAuthUser(input: {
  name: unknown;
  email: unknown;
  password: unknown;
}): Promise<AuthSession> {
  const name = normalizeName(input.name);
  const email = normalizeEmail(input.email);
  const password = typeof input.password === "string" ? input.password : "";
  validateRegistration(name, email, password);
  await ensureAuthSchema();
  const user: AuthUser = { id: randomUUID(), name, email, role: "user" };
  try {
    await (await getLibsqlClient()).execute({
      sql: `INSERT INTO ${AUTH_USERS_TABLE}
        (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      args: [user.id, user.email, user.name, hashPassword(password), user.role, Date.now()],
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw workError("AUTH_EMAIL_EXISTS", { text: "该邮箱已经注册" });
    }
    throw error;
  }
  return issueSession(user);
}

export async function loginAuthUser(input: {
  email: unknown;
  password: unknown;
}): Promise<AuthSession> {
  const email = normalizeEmail(input.email);
  const password = typeof input.password === "string" ? input.password : "";
  const record = email ? await findUserByEmail(email) : null;
  if (!record || !verifyPassword(password, record.passwordHash)) {
    throw workError("AUTH_INVALID_CREDENTIALS", { text: "邮箱或密码错误" });
  }
  return issueSession(record.user);
}

export async function revokeAuthSession(token: string | undefined): Promise<void> {
  if (!token) return;
  await ensureAuthSchema();
  await (await getLibsqlClient()).execute({
    sql: `DELETE FROM ${AUTH_SESSIONS_TABLE} WHERE token_hash = ?`,
    args: [hashToken(token)],
  });
}

function tokenFromRequest(token: string, request: MastraAuthRequest): string {
  const suppliedToken = token.trim();
  if (suppliedToken) return suppliedToken;

  const authorization = getRequestHeader(request, "Authorization")?.trim();
  if (authorization) {
    return authorization.replace(/^Bearer\s+/i, "");
  }
  const cookie = getRequestHeader(request, "Cookie") ?? "";
  const match = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("mastra-token="));
  const value = match?.slice("mastra-token=".length) ?? "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const systemUser: AuthUser = {
  id: "__system__",
  name: "Mastra system",
  email: "system@mastra-work.app",
  role: "admin",
};

function isShutdownRequest(request: MastraAuthRequest): boolean {
  const expected = process.env.MASTRA_SHUTDOWN_TOKEN;
  const supplied = getRequestHeader(request, "x-shutdown-token");
  const raw = getWebRequest(request);
  if (
    !expected ||
    !supplied ||
    !raw ||
    raw.method !== "POST" ||
    new URL(raw.url).pathname !== "/work/shutdown"
  )
    return false;
  const actual = Buffer.from(supplied);
  const secret = Buffer.from(expected);
  return actual.length === secret.length && timingSafeEqual(actual, secret);
}

class DatabaseAuth
  extends MastraAuthProvider<AuthUser>
  implements ICredentialsProvider<AuthUser>, IUserProvider<AuthUser>
{
  // The desktop database provider is local credentials auth. Mark it as
  // SimpleAuth-compatible so Studio exposes its login method without an EE
  // license while the provider still enforces the database session checks.
  readonly isSimpleAuth = true;

  async signIn(email: string, password: string, _request: Request) {
    const session = await loginAuthUser({ email, password });
    return {
      user: session.user,
      token: session.token,
      cookies: [
        `mastra-token=${encodeURIComponent(session.token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
      ],
    };
  }

  override async authenticateToken(token: string, request: MastraAuthRequest) {
    if (getRequestHeader(request, "x-shutdown-token")) {
      return isShutdownRequest(request) ? systemUser : null;
    }
    return findUserBySessionToken(tokenFromRequest(token, request));
  }

  async getCurrentUser(request: Request) {
    return this.authenticateToken("", request);
  }

  async getUser(userId: string) {
    return userId === systemUser.id ? systemUser : findUserById(userId);
  }

  async getUsers(userIds: string[]) {
    return Promise.all(userIds.map((userId) => this.getUser(userId)));
  }

  async signUp(): Promise<never> {
    throw workError("AUTH_VALIDATION", { text: "请通过桌面登录页注册" });
  }

  isSignUpEnabled() {
    return false;
  }

  getClearSessionHeaders() {
    return { "Set-Cookie": "mastra-token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" };
  }

  override async authorizeUser(user: AuthUser, request: MastraAuthRequest) {
    if (user.id === systemUser.id) return isShutdownRequest(request);
    if (getRequestHeader(request, "x-shutdown-token")) return false;
    return Boolean(await findUserById(user.id));
  }
}

export const workAuth = new DatabaseAuth({
  name: "database-auth",
  mapUserToResourceId: (user) => user.id,
  protected: ["/api/*", "/chat/*", "/work/*"],
  public: ["/work/auth/login", "/work/auth/register"],
});

export function authUserFromContext(value: unknown): AuthUser | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  return rowUser(row);
}

const RESOURCE_OWNERSHIP_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

type ResourceOwnershipContext = {
  req: {
    method: string;
    query: (name: string) => string | undefined;
    header: (name: string) => string | undefined;
    raw: Request;
  };
};

function jsonResourceIds(body: unknown): unknown[] {
  if (!body || typeof body !== "object") return [];

  const record = body as Record<string, unknown>;
  const resourceIds: unknown[] = [];
  if ("resourceId" in record) resourceIds.push(record.resourceId);

  const memory = record.memory;
  if (memory && typeof memory === "object" && "resource" in memory) {
    resourceIds.push((memory as Record<string, unknown>).resource);
  }
  return resourceIds.filter((value) => value !== undefined);
}

async function readJsonResourceIds(request: Request): Promise<unknown[] | undefined> {
  try {
    return jsonResourceIds(await request.clone().json());
  } catch {
    // Let the route perform its canonical JSON validation.
    return undefined;
  }
}

async function readFormResourceIds(request: Request): Promise<string[] | undefined> {
  try {
    const resource = (await request.clone().formData()).get("resourceId");
    return typeof resource === "string" ? [resource] : [];
  } catch {
    // Let the route perform its canonical multipart validation.
    return undefined;
  }
}

async function assertResourceIdOwnership(
  c: ResourceOwnershipContext,
  user: AuthUser,
): Promise<boolean> {
  const queryResource = c.req.query("resourceId");
  if (queryResource && queryResource !== user.id) return false;
  if (!RESOURCE_OWNERSHIP_METHODS.has(c.req.method)) return true;

  const contentType = c.req.header("content-type") ?? "";
  let resourceIds: unknown[] | undefined;
  if (contentType.includes("multipart/form-data")) {
    resourceIds = await readFormResourceIds(c.req.raw);
  } else {
    resourceIds = await readJsonResourceIds(c.req.raw);
  }

  if (!resourceIds) return true;
  return resourceIds.every((resourceId) => resourceId === user.id);
}

export async function workRequestContextMiddleware(
  c: ContextWithMastra,
  next: () => Promise<void>,
) {
  const isWorkRoute = c.req.path.startsWith("/work/");
  const isPublicWorkRoute =
    c.req.path === "/work/auth/login" || c.req.path === "/work/auth/register";
  const requestContext = c.get("requestContext");
  let user = requestContext?.get("user") as AuthUser | undefined;
  if (!user) {
    try {
      user = (await workAuth.authenticateToken("", c.req.raw)) ?? undefined;
      if (user) requestContext?.set("user", user);
    } catch {
      // Treat failed token lookup as anonymous; protected work routes reject below.
    }
  }
  if (!user) {
    if ((isWorkRoute && !isPublicWorkRoute) || c.req.path.startsWith("/api/memory/")) {
      throw workError("AUTH_REQUIRED");
    }
    await next();
    return;
  }

  // The authenticated principal is the only tenant authority. Reject
  // client-supplied ids before any route can query storage with them.
  if (!(await assertResourceIdOwnership(c, user))) {
    return c.json({ error: "resourceId does not belong to the authenticated user" }, 403);
  }

  requestContext.set("user", user);
  requestContext.set("userId", user.id);
  requestContext.set(MASTRA_RESOURCE_ID_KEY, user.id);
  await Promise.all([
    getWorkspaceConfig(user.id),
    getMemoryConfig(user.id),
    getGuardrailsConfig(user.id),
    getMcpConfig(user.id),
    getLibrarySettings(user.id),
  ]);
  await next();
}
