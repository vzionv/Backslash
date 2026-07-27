import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";

// ─── Users ──────────────────────────────────────────

export const users = sqliteTable(
  "users",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [uniqueIndex("users_email_idx").on(table.email)]
);

// ─── Sessions ───────────────────────────────────────

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex("sessions_token_idx").on(table.token),
    index("sessions_user_idx").on(table.userId),
    index("sessions_expires_idx").on(table.expiresAt),
  ]
);

// ─── Password Reset Tokens ──────────────────────────

export const passwordResetTokens = sqliteTable(
  "password_reset_tokens",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: text("expires_at").notNull(),
    usedAt: text("used_at"),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex("password_reset_tokens_hash_idx").on(table.tokenHash),
    index("password_reset_tokens_user_idx").on(table.userId),
    index("password_reset_tokens_expires_idx").on(table.expiresAt),
  ]
);

// ─── Projects ───────────────────────────────────────

export const projects = sqliteTable(
  "projects",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").default(""),
    engine: text("engine").default("auto").notNull(),
    mainFile: text("main_file").default("main.tex").notNull(),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index("projects_user_idx").on(table.userId),
    index("projects_user_updated_idx").on(table.userId, table.updatedAt),
  ]
);

// ─── Project Files ──────────────────────────────────

export const projectFiles = sqliteTable(
  "project_files",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    mimeType: text("mime_type").default("text/plain"),
    sizeBytes: integer("size_bytes").default(0),
    isDirectory: integer("is_directory", { mode: "boolean" }).default(false),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex("files_project_path_idx").on(table.projectId, table.path),
    index("files_project_idx").on(table.projectId),
  ]
);

// ─── Labels ─────────────────────────────────────────

export const labels = sqliteTable(
  "labels",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex("labels_user_name_idx").on(table.userId, table.name),
  ]
);

// ─── Project Labels ─────────────────────────────────

export const projectLabels = sqliteTable(
  "project_labels",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    labelId: text("label_id")
      .notNull()
      .references(() => labels.id, { onDelete: "cascade" }),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex("project_labels_unique_idx").on(table.projectId, table.labelId),
    index("project_labels_file_idx").on(table.projectId),
    index("project_labels_label_idx").on(table.labelId),
  ]
);

// ─── Builds ─────────────────────────────────────────

export const builds = sqliteTable(
  "builds",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: text("status").default("queued").notNull(),
    engine: text("engine").notNull(),
    logs: text("logs").default(""),
    durationMs: integer("duration_ms"),
    pdfPath: text("pdf_path"),
    exitCode: integer("exit_code"),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    completedAt: text("completed_at"),
  },
  (table) => [
    index("builds_project_idx").on(table.projectId),
    index("builds_project_created_idx").on(table.projectId, table.createdAt),
    index("builds_user_idx").on(table.userId),
    index("builds_status_idx").on(table.status),
  ]
);

// ─── API Keys ───────────────────────────────────────

export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    lastUsedAt: text("last_used_at"),
    requestCount: integer("request_count").default(0).notNull(),
    expiresAt: text("expires_at"),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index("api_keys_user_idx").on(table.userId),
    uniqueIndex("api_keys_hash_idx").on(table.keyHash),
  ]
);

// ─── User AI Settings ───────────────────────────────

export const userAiSettings = sqliteTable(
  "user_ai_settings",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    aiEnabled: integer("ai_enabled", { mode: "boolean" })
      .default(true)
      .notNull(),
    buildProvider: text("build_provider").default("openai").notNull(),
    buildModel: text("build_model").default("gpt-4o-mini").notNull(),
    buildEndpoint: text("build_endpoint"),
    buildApiKey: text("build_api_key"),
    writerProvider: text("writer_provider").default("openai").notNull(),
    writerModel: text("writer_model").default("gpt-4o-mini").notNull(),
    writerEndpoint: text("writer_endpoint"),
    writerApiKey: text("writer_api_key"),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex("user_ai_settings_user_idx").on(table.userId),
    index("user_ai_settings_provider_idx").on(
      table.buildProvider,
      table.writerProvider
    ),
  ]
);

// ─── Project Shares (Collaboration) ─────────────────

export const projectShares = sqliteTable(
  "project_shares",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").default("viewer").notNull(),
    expiresAt: text("expires_at"),
    invitedBy: text("invited_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex("shares_project_user_idx").on(table.projectId, table.userId),
    index("shares_user_idx").on(table.userId),
    index("shares_project_idx").on(table.projectId),
    index("shares_expires_idx").on(table.expiresAt),
  ]
);

export const projectPublicShares = sqliteTable(
  "project_public_shares",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    role: text("role").default("viewer").notNull(),
    expiresAt: text("expires_at"),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex("public_shares_project_idx").on(table.projectId),
    uniqueIndex("public_shares_token_idx").on(table.token),
    index("public_shares_expires_idx").on(table.expiresAt),
  ]
);

// ─── Relations ──────────────────────────────────────

export const usersRelations = relations(users, ({ many }) => ({
  projects: many(projects),
  sessions: many(sessions),
  builds: many(builds),
  apiKeys: many(apiKeys),
  sharedProjects: many(projectShares),
  labels: many(labels),
  aiSettings: many(userAiSettings),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  user: one(users, { fields: [projects.userId], references: [users.id] }),
  files: many(projectFiles),
  builds: many(builds),
  shares: many(projectShares),
  publicShare: many(projectPublicShares),
  labels: many(projectLabels),
}));

export const projectFilesRelations = relations(projectFiles, ({ one }) => ({
  project: one(projects, {
    fields: [projectFiles.projectId],
    references: [projects.id],
  }),
}));

export const buildsRelations = relations(builds, ({ one }) => ({
  project: one(projects, {
    fields: [builds.projectId],
    references: [projects.id],
  }),
  user: one(users, { fields: [builds.userId], references: [users.id] }),
}));

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  user: one(users, { fields: [apiKeys.userId], references: [users.id] }),
}));

export const userAiSettingsRelations = relations(userAiSettings, ({ one }) => ({
  user: one(users, {
    fields: [userAiSettings.userId],
    references: [users.id],
  }),
}));

export const projectSharesRelations = relations(projectShares, ({ one }) => ({
  project: one(projects, {
    fields: [projectShares.projectId],
    references: [projects.id],
  }),
  user: one(users, {
    fields: [projectShares.userId],
    references: [users.id],
  }),
}));

export const projectPublicSharesRelations = relations(
  projectPublicShares,
  ({ one }) => ({
    project: one(projects, {
      fields: [projectPublicShares.projectId],
      references: [projects.id],
    }),
  })
);

export const labelsRelations = relations(labels, ({ one, many }) => ({
  projectLabels: many(projectLabels),
  users: one(users, {
    fields: [labels.userId],
    references: [users.id],
  }),
}));

export const projectLabelsRelations = relations(projectLabels, ({ one }) => ({
  project: one(projects, {
    fields: [projectLabels.projectId],
    references: [projects.id],
  }),
  label: one(labels, {
    fields: [projectLabels.labelId],
    references: [labels.id],
  }),
}));
