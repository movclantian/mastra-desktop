import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import type { MastraAuthRequest } from "@mastra/core/server";
import { getRequestHeader, SimpleAuth } from "@mastra/core/server";
import { getLibsqlClient } from "./storage";

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

export class AuthServiceError extends Error {
  constructor(
    public readonly code: "AUTH_INVALID_CREDENTIALS" | "AUTH_EMAIL_EXISTS" | "AUTH_VALIDATION",
    message: string,
  ) {
    super(message);
    this.name = "AuthServiceError";
  }
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
    throw new AuthServiceError("AUTH_VALIDATION", "请输入 1-80 个字符的名称");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) {
    throw new AuthServiceError("AUTH_VALIDATION", "请输入有效的邮箱地址");
  }
  if (password.length < 8 || password.length > 200) {
    throw new AuthServiceError("AUTH_VALIDATION", "密码长度必须为 8-200 个字符");
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
  const user = rowUser((result.rows[0] ?? {}) as Record<string, unknown>);
  if (user) {
    await client.execute({
      sql: `DELETE FROM ${AUTH_SESSIONS_TABLE} WHERE expires_at <= ?`,
      args: [Date.now()],
    });
  }
  return user;
}

async function findUserById(id: string): Promise<AuthUser | null> {
  await ensureAuthSchema();
  const result = await (await getLibsqlClient()).execute({
    sql: `SELECT id, name, email, role FROM ${AUTH_USERS_TABLE} WHERE id = ? LIMIT 1`,
    args: [id],
  });
  return rowUser((result.rows[0] ?? {}) as Record<string, unknown>);
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

async function issueSession(user: AuthUser): Promise<AuthSession> {
  await ensureAuthSchema();
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
    if (String(error).toLowerCase().includes("unique")) {
      throw new AuthServiceError("AUTH_EMAIL_EXISTS", "该邮箱已经注册");
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
    throw new AuthServiceError("AUTH_INVALID_CREDENTIALS", "邮箱或密码错误");
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
  const suppliedToken = token.trim().replace(/^Bearer\s+/i, "");
  if (suppliedToken) return suppliedToken;

  const authorization = getRequestHeader(request, "Authorization") ?? "";
  if (authorization?.trim()) {
    return authorization.trim().replace(/^Bearer\s+/i, "");
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

// SimpleAuth remains the Mastra auth provider, while users and sessions are
// loaded from the application database instead of an environment token map.
class DatabaseAuth extends SimpleAuth<AuthUser> {
  override async authenticateToken(token: string, request: MastraAuthRequest) {
    const internal = getRequestHeader(request, "x-shutdown-token");
    if (internal) return super.authenticateToken(token, request);
    return findUserBySessionToken(tokenFromRequest(token, request));
  }

  override async authorizeUser(user: AuthUser, request: MastraAuthRequest) {
    if (getRequestHeader(request, "x-shutdown-token")) return user.id === "__system__";
    return Boolean(await findUserById(user.id));
  }
}

const authUsers: Record<string, AuthUser> = {};
const internalToken = process.env.MASTRA_SHUTDOWN_TOKEN?.trim();
if (internalToken) {
  authUsers[internalToken] = {
    id: "__system__",
    name: "Mastra system",
    email: "system@mastra-work.app",
    role: "admin",
  };
}

export const workAuth = new DatabaseAuth({
  tokens: authUsers,
  headers: ["x-shutdown-token"],
  mapUserToResourceId: (user) => user.id,
  protected: ["/api/*", "/chat/*", "/work/*"],
  public: ["/work/auth/login", "/work/auth/register"],
});

export function authUserFromContext(value: unknown): AuthUser | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  return rowUser(row);
}
