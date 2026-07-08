import { Hono } from "hono";
import { db } from "edgespark";
import { users, sessions, frictionEntries, insights } from "./defs/db_schema";
import { eq, desc, asc } from "drizzle-orm";
import { installBloomeBridge } from "./bloome-bridge";
import { nanoid } from "./utils";

const app = new Hono();
installBloomeBridge(app);

// ─── Auth ────────────────────────────────────────────

app.post("/api/public/signup", async (c) => {
  const body = await c.req.json<{ email?: string; password?: string }>();
  const email = body.email?.trim().toLowerCase();
  const password = body.password?.trim();

  if (!email || !password || password.length < 6) {
    return c.json({ error: "email and password (min 6 chars) required" }, 400);
  }

  const existing = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .then((rows) => rows[0]);
  if (existing) {
    return c.json({ error: "email already registered" }, 409);
  }

  const userId = nanoid();
  const passwordHash = await hashPassword(password);

  await db.insert(users).values({
    id: userId,
    email,
    passwordHash,
    createdAt: Date.now(),
  });

  const sessionToken = nanoid(32);
  const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
  await db.insert(sessions).values({
    id: nanoid(),
    userId,
    token: sessionToken,
    expiresAt,
    createdAt: Date.now(),
  });

  return c.json({ ok: true, userId, token: sessionToken, expiresAt });
});

app.post("/api/public/login", async (c) => {
  const body = await c.req.json<{ email?: string; password?: string }>();
  const email = body.email?.trim().toLowerCase();
  const password = body.password?.trim();

  if (!email || !password) {
    return c.json({ error: "email and password required" }, 400);
  }

  const user = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .then((rows) => rows[0]);
  if (!user) {
    return c.json({ error: "invalid credentials" }, 401);
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    return c.json({ error: "invalid credentials" }, 401);
  }

  const sessionToken = nanoid(32);
  const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
  await db.insert(sessions).values({
    id: nanoid(),
    userId: user.id,
    token: sessionToken,
    expiresAt,
    createdAt: Date.now(),
  });

  return c.json({ ok: true, userId: user.id, token: sessionToken, expiresAt });
});

// ─── Session helper ──────────────────────────────────

async function getUserFromToken(
  token: string,
): Promise<{ id: string; email: string } | null> {
  const session = await db
    .select()
    .from(sessions)
    .where(eq(sessions.token, token))
    .then((rows) => rows[0]);
  if (!session || session.expiresAt < Date.now()) return null;

  const user = await db
    .select()
    .from(users)
    .where(eq(users.id, session.userId))
    .then((rows) => rows[0]);
  if (!user) return null;

  return { id: user.id, email: user.email };
}

function extractToken(c: any): string | null {
  const auth = c.req.header("authorization") || "";
  return auth.match(/^Bearer\s+(.+)$/i)?.[1] || null;
}

// ─── Entries ─────────────────────────────────────────

app.post("/api/public/entries", async (c) => {
  const token = extractToken(c);
  if (!token) return c.json({ error: "auth required" }, 401);

  const user = await getUserFromToken(token);
  if (!user) return c.json({ error: "invalid session" }, 401);

  const body = await c.req.json<{ content?: string; tag?: string }>();
  const content = body.content?.trim();
  if (!content) return c.json({ error: "content required" }, 400);

  const validTags = ["time", "money", "tool", "habit", "other"];
  const tag = validTags.includes(body.tag || "") ? body.tag! : "other";

  const entryId = nanoid();
  await db.insert(frictionEntries).values({
    id: entryId,
    userId: user.id,
    content,
    tag,
    createdAt: Date.now(),
  });

  return c.json({ ok: true, id: entryId });
});

app.get("/api/public/entries", async (c) => {
  const token = extractToken(c);
  if (!token) return c.json({ error: "auth required" }, 401);

  const user = await getUserFromToken(token);
  if (!user) return c.json({ error: "invalid session" }, 401);

  const limit = Math.min(parseInt(c.req.query("limit") || "30"), 100);

  const rows = await db
    .select()
    .from(frictionEntries)
    .where(eq(frictionEntries.userId, user.id))
    .orderBy(desc(frictionEntries.createdAt))
    .limit(limit);

  return c.json({ ok: true, entries: rows });
});

// ─── Insights (rule engine) ──────────────────────────

app.get("/api/public/insights", async (c) => {
  const token = extractToken(c);
  if (!token) return c.json({ error: "auth required" }, 401);

  const user = await getUserFromToken(token);
  if (!user) return c.json({ error: "invalid session" }, 401);

  const entries = await db
    .select()
    .from(frictionEntries)
    .where(eq(frictionEntries.userId, user.id))
    .orderBy(asc(frictionEntries.createdAt));

  if (entries.length < 3) {
    return c.json({
      ok: true,
      insights: [],
      message: `再记录 ${3 - entries.length} 条就能看到洞察`,
      entryCount: entries.length,
    });
  }

  const generatedInsights = analyzeEntries(entries);

  const existingInsights = await db
    .select()
    .from(insights)
    .where(eq(insights.userId, user.id));
  const existingTypes = new Set(existingInsights.map((i) => i.type));

  for (const insight of generatedInsights) {
    if (!existingTypes.has(insight.type)) {
      await db.insert(insights).values({
        id: nanoid(),
        userId: user.id,
        type: insight.type,
        content: insight.content,
        relatedEntryIds: JSON.stringify(insight.relatedEntryIds || []),
        createdAt: Date.now(),
      });
    }
  }

  const allInsights = await db
    .select()
    .from(insights)
    .where(eq(insights.userId, user.id))
    .orderBy(desc(insights.createdAt))
    .limit(10);

  return c.json({ ok: true, insights: allInsights, entryCount: entries.length });
});

// ─── Rule Engine ─────────────────────────────────────

interface RawInsight {
  type: string;
  content: string;
  relatedEntryIds?: string[];
}

function analyzeEntries(entries: any[]): RawInsight[] {
  const result: RawInsight[] = [];

  // Frequency
  const totalDays = entries.length > 1
    ? (entries[entries.length - 1].createdAt - entries[0].createdAt) / (24 * 60 * 60 * 1000)
    : 1;
  const pace = (entries.length / Math.max(totalDays, 1)).toFixed(1);
  result.push({
    type: "frequency",
    content: `你已经记录了 ${entries.length} 条摩擦，平均每天 ${pace} 条。`,
    relatedEntryIds: entries.slice(-5).map((e: any) => e.id),
  });

  // Tag pattern
  const tagCounts: Record<string, number> = {};
  for (const e of entries) {
    const tag = e.tag || "other";
    tagCounts[tag] = (tagCounts[tag] || 0) + 1;
  }
  const sortedTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]);
  if (sortedTags.length > 0) {
    const [topTag, topCount] = sortedTags[0];
    const tagLabel: Record<string, string> = {
      time: "时间浪费",
      money: "隐性消费",
      tool: "工具不顺手",
      habit: "不良习惯",
      other: "其他摩擦",
    };
    const pct = Math.round((topCount / entries.length) * 100);
    result.push({
      type: "pattern",
      content: `你 ${pct}% 的摩擦跟「${tagLabel[topTag] || topTag}」有关。`,
      relatedEntryIds: entries
        .filter((e: any) => (e.tag || "other") === topTag)
        .slice(0, 5)
        .map((e: any) => e.id),
    });
  }

  // Suggestion
  if (sortedTags.length > 0) {
    const [topTag] = sortedTags[0];
    const suggestions: Record<string, string> = {
      time: "试试番茄工作法或时间块——把「算了」的时间段切出来，专门处理。",
      money: "记一周账，重点标记「顺手买」和「忘了关」的订阅。",
      tool: "花 10 分钟搜一下你最常用的工具有没有更快的替代方案。",
      habit: "选一个最小的「算了」场景，连续 7 天用不同方式应对，观察变化。",
      other: "下次遇到「算了」的瞬间，花 5 秒写下：如果不受限，我理想的做法是什么？",
    };
    result.push({
      type: "suggestion",
      content: suggestions[topTag] || suggestions.other,
    });
  }

  // Streak
  const daySet = new Set(
    entries.map((e: any) => new Date(e.createdAt).toISOString().slice(0, 10)),
  );
  let streak = 0;
  const today = new Date();
  for (let i = 0; i < 30; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    if (daySet.has(d.toISOString().slice(0, 10))) streak++;
    else break;
  }
  if (streak >= 3) {
    result.push({
      type: "streak",
      content: `连续 ${streak} 天记录，坚持得很好。数据越多，洞察越准。`,
    });
  }

  return result;
}

// ─── Password helpers ────────────────────────────────

async function hashPassword(password: string): Promise<string> {
  const salt = nanoid(16);
  const data = new TextEncoder().encode(salt + password);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const hex = Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${salt}:${hex}`;
}

async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [salt, expectedHash] = stored.split(":");
  if (!salt || !expectedHash) return false;
  const data = new TextEncoder().encode(salt + password);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const hex = Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex === expectedHash;
}

export default app;
