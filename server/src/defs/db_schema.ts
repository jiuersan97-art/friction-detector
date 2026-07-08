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
