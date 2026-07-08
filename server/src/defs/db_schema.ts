/**
 * App tables for 生活摩擦探测器
 */
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

/** 用户账户 */
export const users = sqliteTable(
  "users",
  {
    id: text().primaryKey(),
    email: text().notNull(),
    passwordHash: text("password_hash").notNull(),
    createdAt: integer("created_at")
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [
    uniqueIndex("users_email_unique").on(table.email),
  ],
);

/** 用户 session */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text().primaryKey(),
    userId: text("user_id").notNull(),
    token: text().notNull(),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at")
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [
    index("sessions_userId_idx").on(table.userId),
    uniqueIndex("sessions_token_unique").on(table.token),
  ],
);

/** 用户的日常摩擦记录 */
export const frictionEntries = sqliteTable(
  "friction_entries",
  {
    id: text().primaryKey(),
    userId: text("user_id").notNull(),
    content: text().notNull(),
    tag: text(), // time | money | tool | habit | other
    createdAt: integer("created_at")
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [
    index("friction_entries_userId_idx").on(table.userId),
    index("friction_entries_createdAt_idx").on(table.createdAt),
  ],
);

/** AI 洞察 */
export const insights = sqliteTable(
  "insights",
  {
    id: text().primaryKey(),
    userId: text("user_id").notNull(),
    type: text().notNull(),
    content: text().notNull(),
    relatedEntryIds: text("related_entry_ids"),
    createdAt: integer("created_at")
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [
    index("insights_userId_idx").on(table.userId),
  ],
);

// ─── Community tables ────────────────────────────────

/** 社区圈子 */
export const groups = sqliteTable(
  "groups",
  {
    id: text().primaryKey(),
    name: text().notNull(),
    type: text().notNull(), // friction tag: time | money | tool | habit | general
    description: text(),
    icon: text(),
    memberCount: integer("member_count").default(0).notNull(),
    createdAt: integer("created_at")
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [
    index("groups_type_idx").on(table.type),
  ],
);

/** 帖子 */
export const posts = sqliteTable(
  "posts",
  {
    id: text().primaryKey(),
    groupId: text("group_id").notNull(),
    userId: text("user_id").notNull(),
    title: text().notNull(),
    content: text().notNull(),
    postType: text("post_type").default("question").notNull(), // question | solution
    upvotes: integer("upvotes").default(0).notNull(),
    downvotes: integer("downvotes").default(0).notNull(),
    replyCount: integer("reply_count").default(0).notNull(),
    createdAt: integer("created_at")
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [
    index("posts_groupId_idx").on(table.groupId),
    index("posts_userId_idx").on(table.userId),
    index("posts_createdAt_idx").on(table.createdAt),
  ],
);

/** 回帖 */
export const replies = sqliteTable(
  "replies",
  {
    id: text().primaryKey(),
    postId: text("post_id").notNull(),
    userId: text("user_id").notNull(),
    content: text().notNull(),
    upvotes: integer("upvotes").default(0).notNull(),
    downvotes: integer("downvotes").default(0).notNull(),
    createdAt: integer("created_at")
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [
    index("replies_postId_idx").on(table.postId),
    index("replies_userId_idx").on(table.userId),
  ],
);

/**
 * 投票记录
 * 状态机：
 *   无记录 → 插入新投票
 *   同类型 → 删除（toggle off）
 *   异类型 → 更新为新类型
 * UNIQUE(target_id, user_id) 保证一人一票
 */
export const votes = sqliteTable(
  "votes",
  {
    id: text().primaryKey(),
    targetId: text("target_id").notNull(), // post or reply ID
    targetType: text("target_type").notNull(), // post | reply
    userId: text("user_id").notNull(),
    type: text().notNull(), // up | down
    createdAt: integer("created_at")
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [
    uniqueIndex("votes_target_user_unique").on(table.targetId, table.userId),
    index("votes_targetId_idx").on(table.targetId),
  ],
);

/** 用户偏好（摩擦类型关注） */
export const userPreferences = sqliteTable(
  "user_preferences",
  {
    userId: text("user_id").primaryKey(),
    frictionTypes: text("friction_types"), // JSON array: ["time","money",...]
    createdAt: integer("created_at")
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
);
