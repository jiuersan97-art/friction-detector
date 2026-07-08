import { Hono } from "hono";
import { db } from "edgespark";
import { users, sessions, frictionEntries, insights, groups, posts, replies, votes, userPreferences } from "./defs/db_schema";
import { eq, desc, asc, sql, and, count as drizzleCount } from "drizzle-orm";
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

// ─── Community ───────────────────────────────────────

/** GET /api/public/groups — list all groups */
app.get("/api/public/groups", async (c) => {
  const rows = await db.select().from(groups).orderBy(desc(groups.memberCount));
  return c.json({ ok: true, groups: rows });
});

/** GET /api/public/groups/:id — get group detail */
app.get("/api/public/groups/:id", async (c) => {
  const id = c.req.param("id");
  const group = await db.select().from(groups).where(eq(groups.id, id)).then((r) => r[0]);
  if (!group) return c.json({ error: "group not found" }, 404);
  return c.json({ ok: true, group });
});

/** POST /api/public/groups/:id/join — join or leave a group (toggle) */
app.post("/api/public/groups/:id/join", async (c) => {
  const token = extractToken(c);
  if (!token) return c.json({ error: "auth required" }, 401);
  const user = await getUserFromToken(token);
  if (!user) return c.json({ error: "invalid session" }, 401);

  const groupId = c.req.param("id");
  const group = await db.select().from(groups).where(eq(groups.id, groupId)).then((r) => r[0]);
  if (!group) return c.json({ error: "group not found" }, 404);

  // Check membership via user_preferences (friction_types stores joined groups)
  const pref = await db.select().from(userPreferences).where(eq(userPreferences.userId, user.id)).then((r) => r[0]);
  const joined = pref ? JSON.parse(pref.frictionTypes || "[]") : [];
  const isMember = joined.includes(groupId);

  if (isMember) {
    // Leave
    const next = joined.filter((g: string) => g !== groupId);
    await db.update(userPreferences).set({ frictionTypes: JSON.stringify(next) }).where(eq(userPreferences.userId, user.id));
    await db.update(groups).set({ memberCount: Math.max(0, group.memberCount - 1) }).where(eq(groups.id, groupId));
    return c.json({ ok: true, joined: false, memberCount: Math.max(0, group.memberCount - 1) });
  } else {
    // Join
    const next = [...joined, groupId];
    if (pref) {
      await db.update(userPreferences).set({ frictionTypes: JSON.stringify(next) }).where(eq(userPreferences.userId, user.id));
    } else {
      await db.insert(userPreferences).values({ userId: user.id, frictionTypes: JSON.stringify(next), createdAt: Date.now() });
    }
    await db.update(groups).set({ memberCount: group.memberCount + 1 }).where(eq(groups.id, groupId));
    return c.json({ ok: true, joined: true, memberCount: group.memberCount + 1 });
  }
});

/** GET /api/public/groups/:id/membership — check if current user joined */
app.get("/api/public/groups/:id/membership", async (c) => {
  const token = extractToken(c);
  if (!token) return c.json({ ok: true, joined: false });
  const user = await getUserFromToken(token);
  if (!user) return c.json({ ok: true, joined: false });

  const groupId = c.req.param("id");
  const pref = await db.select().from(userPreferences).where(eq(userPreferences.userId, user.id)).then((r) => r[0]);
  const joined = pref ? JSON.parse(pref.frictionTypes || "[]") : [];
  return c.json({ ok: true, joined: joined.includes(groupId) });
});

/** GET /api/public/groups/:id/posts — list posts in a group */
app.get("/api/public/groups/:id/posts", async (c) => {
  const groupId = c.req.param("id");
  const limit = Math.min(parseInt(c.req.query("limit") || "20"), 50);
  const rows = await db.select().from(posts).where(eq(posts.groupId, groupId)).orderBy(desc(posts.createdAt)).limit(limit);
  return c.json({ ok: true, posts: rows });
});

/** POST /api/public/groups/:id/posts — create a post */
app.post("/api/public/groups/:id/posts", async (c) => {
  const token = extractToken(c);
  if (!token) return c.json({ error: "auth required" }, 401);
  const user = await getUserFromToken(token);
  if (!user) return c.json({ error: "invalid session" }, 401);

  const groupId = c.req.param("id");
  const group = await db.select().from(groups).where(eq(groups.id, groupId)).then((r) => r[0]);
  if (!group) return c.json({ error: "group not found" }, 404);

  const body = await c.req.json<{ title?: string; content?: string; postType?: string }>();
  const title = body.title?.trim();
  const content = body.content?.trim();
  if (!title || !content) return c.json({ error: "title and content required" }, 400);
  const postType = body.postType === "solution" ? "solution" : "question";

  const postId = nanoid();
  await db.insert(posts).values({
    id: postId, groupId, userId: user.id, title, content, postType,
    upvotes: 0, downvotes: 0, replyCount: 0, createdAt: Date.now(),
  });
  return c.json({ ok: true, id: postId });
});

/** GET /api/public/posts/:id — get a single post with replies */
app.get("/api/public/posts/:id", async (c) => {
  const postId = c.req.param("id");
  const post = await db.select().from(posts).where(eq(posts.id, postId)).then((r) => r[0]);
  if (!post) return c.json({ error: "post not found" }, 404);

  const postReplies = await db.select().from(replies).where(eq(replies.postId, postId)).orderBy(asc(replies.createdAt));
  return c.json({ ok: true, post, replies: postReplies });
});

/** POST /api/public/posts/:id/reply — reply to a post */
app.post("/api/public/posts/:id/reply", async (c) => {
  const token = extractToken(c);
  if (!token) return c.json({ error: "auth required" }, 401);
  const user = await getUserFromToken(token);
  if (!user) return c.json({ error: "invalid session" }, 401);

  const postId = c.req.param("id");
  const post = await db.select().from(posts).where(eq(posts.id, postId)).then((r) => r[0]);
  if (!post) return c.json({ error: "post not found" }, 404);

  const body = await c.req.json<{ content?: string }>();
  const content = body.content?.trim();
  if (!content) return c.json({ error: "content required" }, 400);

  const replyId = nanoid();
  await db.insert(replies).values({
    id: replyId, postId, userId: user.id, content,
    upvotes: 0, downvotes: 0, createdAt: Date.now(),
  });
  // Increment reply count
  await db.update(posts).set({ replyCount: post.replyCount + 1 }).where(eq(posts.id, postId));
  return c.json({ ok: true, id: replyId });
});

/** POST /api/public/posts/:id/vote — vote on a post or reply
 *  状态机：
 *    无记录 → 插入
 *    同类型 → 删除（toggle off）
 *    异类型 → 更新
 */
app.post("/api/public/posts/:id/vote", async (c) => {
  const token = extractToken(c);
  if (!token) return c.json({ error: "auth required" }, 401);
  const user = await getUserFromToken(token);
  if (!user) return c.json({ error: "invalid session" }, 401);

  const targetId = c.req.param("id");
  const body = await c.req.json<{ type?: string }>();
  const voteType = body.type;
  if (voteType !== "up" && voteType !== "down") {
    return c.json({ error: "type must be 'up' or 'down'" }, 400);
  }

  // Determine target type (post or reply)
  const post = await db.select().from(posts).where(eq(posts.id, targetId)).then((r) => r[0]);
  const reply = post ? null : await db.select().from(replies).where(eq(replies.id, targetId)).then((r) => r[0]);
  if (!post && !reply) return c.json({ error: "target not found" }, 404);
  const targetType = post ? "post" : "reply";

  // Check existing vote
  const existing = await db.select().from(votes)
    .where(and(eq(votes.targetId, targetId), eq(votes.userId, user.id)))
    .then((r) => r[0]);

  if (existing) {
    if (existing.type === voteType) {
      // Same type → toggle off (delete)
      await db.delete(votes).where(eq(votes.id, existing.id));
    } else {
      // Different type → switch
      await db.update(votes).set({ type: voteType }).where(eq(votes.id, existing.id));
    }
  } else {
    // No existing vote → insert
    await db.insert(votes).values({
      id: nanoid(), targetId, targetType, userId: user.id, type: voteType, createdAt: Date.now(),
    });
  }

  // Recalculate scores
  const upCount = await db.select({ c: drizzleCount() }).from(votes)
    .where(and(eq(votes.targetId, targetId), eq(votes.type, "up"))).then((r) => r[0]?.c || 0);
  const downCount = await db.select({ c: drizzleCount() }).from(votes)
    .where(and(eq(votes.targetId, targetId), eq(votes.type, "down"))).then((r) => r[0]?.c || 0);

  // Update counts on target
  if (post) {
    await db.update(posts).set({ upvotes: upCount, downvotes: downCount }).where(eq(posts.id, targetId));
  } else {
    await db.update(replies).set({ upvotes: upCount, downvotes: downCount }).where(eq(replies.id, targetId));
  }

  // Check user's current vote
  const userVote = await db.select().from(votes)
    .where(and(eq(votes.targetId, targetId), eq(votes.userId, user.id)))
    .then((r) => r[0]);

  return c.json({
    ok: true,
    upvotes: upCount,
    downvotes: downCount,
    score: upCount - downCount,
    myVote: userVote?.type || null,
  });
});

/** GET /api/public/posts/:id/votes — get vote status for current user */
app.get("/api/public/posts/:id/votes", async (c) => {
  const targetId = c.req.param("id");
  const upCount = await db.select({ c: drizzleCount() }).from(votes)
    .where(and(eq(votes.targetId, targetId), eq(votes.type, "up"))).then((r) => r[0]?.c || 0);
  const downCount = await db.select({ c: drizzleCount() }).from(votes)
    .where(and(eq(votes.targetId, targetId), eq(votes.type, "down"))).then((r) => r[0]?.c || 0);

  let myVote = null;
  const token = extractToken(c);
  if (token) {
    const user = await getUserFromToken(token);
    if (user) {
      myVote = await db.select().from(votes)
        .where(and(eq(votes.targetId, targetId), eq(votes.userId, user.id)))
        .then((r) => r[0]?.type || null);
    }
  }

  return c.json({ ok: true, upvotes: upCount, downvotes: downCount, score: upCount - downCount, myVote });
});

/** GET /api/public/users/me/posts — get current user's posts */
app.get("/api/public/users/me/posts", async (c) => {
  const token = extractToken(c);
  if (!token) return c.json({ error: "auth required" }, 401);
  const user = await getUserFromToken(token);
  if (!user) return c.json({ error: "invalid session" }, 401);

  const rows = await db.select().from(posts).where(eq(posts.userId, user.id)).orderBy(desc(posts.createdAt)).limit(20);
  return c.json({ ok: true, posts: rows });
});

/** GET /api/public/users/me/groups — get current user's joined groups */
app.get("/api/public/users/me/groups", async (c) => {
  const token = extractToken(c);
  if (!token) return c.json({ error: "auth required" }, 401);
  const user = await getUserFromToken(token);
  if (!user) return c.json({ error: "invalid session" }, 401);

  const pref = await db.select().from(userPreferences).where(eq(userPreferences.userId, user.id)).then((r) => r[0]);
  const joinedIds = pref ? JSON.parse(pref.frictionTypes || "[]") : [];
  if (joinedIds.length === 0) return c.json({ ok: true, groups: [] });

  const joinedGroups = await db.select().from(groups).where(sql`${groups.id} IN ${joinedIds}`);
  return c.json({ ok: true, groups: joinedGroups });
});

/** POST /api/public/seed-groups — seed default groups (dev only) */
app.post("/api/public/seed-groups", async (c) => {
  const defaultGroups = [
    { name: "时间黑洞", type: "time", description: "那些不知不觉吞噬你时间的事", icon: "⏰" },
    { name: "隐形消费", type: "money", description: "月底才发现的钱都去哪了", icon: "💸" },
    { name: "工具吐槽", type: "tool", description: "不好用的工具和更好的替代方案", icon: "🔧" },
    { name: "习惯陷阱", type: "habit", description: "明知道不好但改不掉的日常", icon: "🔄" },
    { name: "自由讨论", type: "general", description: "任何摩擦都可以聊", icon: "💬" },
  ];

  const existing = await db.select().from(groups).then((r) => r.length);
  if (existing > 0) return c.json({ ok: true, message: "groups already seeded", count: existing });

  for (const g of defaultGroups) {
    await db.insert(groups).values({
      id: nanoid(), name: g.name, type: g.type, description: g.description,
      icon: g.icon, memberCount: 0, createdAt: Date.now(),
    });
  }
  return c.json({ ok: true, message: "seeded", count: defaultGroups.length });
});

export default app;
