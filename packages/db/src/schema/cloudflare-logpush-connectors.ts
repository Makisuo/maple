import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const cloudflareLogpushConnectors = sqliteTable(
  "cloudflare_logpush_connectors",
  {
    id: text("id").notNull().primaryKey(),
    orgId: text("org_id").notNull(),
    name: text("name").notNull(),
    zoneName: text("zone_name").notNull(),
    serviceName: text("service_name").notNull(),
    dataset: text("dataset").notNull().default("http_requests"),
    secretCiphertext: text("secret_ciphertext").notNull(),
    secretIv: text("secret_iv").notNull(),
    secretTag: text("secret_tag").notNull(),
    secretHash: text("secret_hash").notNull(),
    enabled: integer("enabled", { mode: "number" }).notNull().default(1),
    lastReceivedAt: integer("last_received_at", { mode: "number" }),
    lastError: text("last_error"),
    secretRotatedAt: integer("secret_rotated_at", { mode: "number" }).notNull(),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
  },
  (table) => [
    index("cloudflare_logpush_connectors_org_idx").on(table.orgId),
    index("cloudflare_logpush_connectors_org_enabled_idx").on(
      table.orgId,
      table.enabled,
    ),
    uniqueIndex("cloudflare_logpush_connectors_secret_hash_unique").on(
      table.secretHash,
    ),
  ],
);

export type CloudflareLogpushConnectorRow =
  typeof cloudflareLogpushConnectors.$inferSelect;
export type CloudflareLogpushConnectorInsert =
  typeof cloudflareLogpushConnectors.$inferInsert;
