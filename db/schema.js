const { pgTable, text, timestamp, jsonb, primaryKey, customType } = require('drizzle-orm/pg-core');

const bytea = customType({
  dataType: () => 'bytea',
  toDriver: (value) => value,
  fromDriver: (value) => (Buffer.isBuffer(value) ? value : Buffer.from(value)),
});

// A published, view-only 3D snapshot. Immutable once created.
const shares = pgTable('shares', {
  id: text('id').primaryKey(),
  title: text('title').notNull().default(''),
  scene: jsonb('scene').notNull(),
  deleteTokenHash: text('delete_token_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Flattened sheet textures (and a poster image for link previews), kept apart so share lookups never load blobs.
const shareTextures = pgTable(
  'share_textures',
  {
    shareId: text('share_id')
      .notNull()
      .references(() => shares.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    mime: text('mime').notNull(),
    data: bytea('data').notNull(),
  },
  (t) => [primaryKey({ columns: [t.shareId, t.key] })],
);

module.exports = { shares, shareTextures };
