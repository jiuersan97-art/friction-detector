import type { Context, Hono } from "hono";
import { secret } from "edgespark";
import { createRemoteJWKSet, jwtVerify } from "jose";

type BloomeSecretName =
  | "BLOOME_JWKS_URL"
  | "BLOOME_ISSUER"
  | "EDGESPARK_PROJECT_ID"
  | "BLOOME_BRIDGE_SECRET";

let bloomeJwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function requireBloomeSecret(name: BloomeSecretName): string {
  const value = secret.get(name);
  if (!value) throw new Error(`Missing EdgeSpark secret: ${name}`);
  return value;
}

function getBloomeJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (!bloomeJwks) {
    bloomeJwks = createRemoteJWKSet(new URL(requireBloomeSecret("BLOOME_JWKS_URL")));
  }
  return bloomeJwks;
}

export type BloomeUser = {
  id: string;
  email: string | null;
  name: string;
};

function base64UrlEncode(input: string | ArrayBuffer): string {
  const bytes =
    typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return atob(padded);
}

async function hmac(data: string): Promise<string> {
  const sessionSecret = requireBloomeSecret("BLOOME_BRIDGE_SECRET");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(sessionSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64UrlEncode(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
}

async function signBloomeSession(user: BloomeUser, expiresAt: number): Promise<string> {
  const payload = base64UrlEncode(JSON.stringify({ ...user, exp: expiresAt }));
  return `${payload}.${await hmac(payload)}`;
}

async function verifyBloomeSession(token: string): Promise<BloomeUser | null> {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  if ((await hmac(payload)) !== signature) return null;

  try {
    const data = JSON.parse(base64UrlDecode(payload)) as BloomeUser & { exp?: unknown };
    if (typeof data.exp !== "number" || data.exp < Date.now()) return null;
    if (!data.id || typeof data.id !== "string") return null;
    return {
      id: data.id,
      email: typeof data.email === "string" ? data.email : null,
      name: typeof data.name === "string" && data.name ? data.name : "Bloome User",
    };
  } catch {
    return null;
  }
}

export async function getBloomeUser(c: Context): Promise<BloomeUser | null> {
  const auth = c.req.header("authorization") || "";
  const token = auth.match(/^Bearer\s+(.+)$/i)?.[1];
  return token ? verifyBloomeSession(token) : null;
}

export function installBloomeBridge(app: Hono) {
  app.get("/api/public/_bloome/health", (c) => {
    return c.json({
      ok: true,
      bridge: "bloome",
      projectId: secret.get("EDGESPARK_PROJECT_ID"),
    });
  });

  app.post("/api/public/_bloome/silent-sign-in", async (c) => {
    const auth = c.req.header("authorization") || "";
    const jwt = auth.match(/^Bearer\s+(.+)$/i)?.[1] || "";
    if (!jwt) return c.json({ error: "missing_jwt" }, 400);

    const verified = await jwtVerify(jwt, getBloomeJwks(), {
      issuer: requireBloomeSecret("BLOOME_ISSUER"),
      audience: requireBloomeSecret("EDGESPARK_PROJECT_ID"),
    }).catch(() => null);
    if (!verified) return c.json({ error: "invalid_jwt" }, 401);

    const bloomeUserId = String(verified.payload.sub || "");
    if (!bloomeUserId) return c.json({ error: "missing_subject" }, 401);

    const expiresAt = Date.now() + 60 * 60 * 1000;
    const email = typeof verified.payload.email === "string" ? verified.payload.email : null;
    const name =
      typeof verified.payload.name === "string"
        ? verified.payload.name
        : `Bloome User ${bloomeUserId.slice(0, 8)}`;
    const user = { id: bloomeUserId, email, name };
    const token = await signBloomeSession(user, expiresAt);

    return c.json({
      token,
      user,
      bloomeUser: user,
      expiresAt: new Date(expiresAt).toISOString(),
    });
  });
}
