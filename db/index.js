const path = require('path');
const { Pool } = require('pg');
const { drizzle } = require('drizzle-orm/node-postgres');
const { migrate } = require('drizzle-orm/node-postgres/migrator');
const schema = require('./schema');

/** Connect and apply pending migrations. Returns null when DATABASE_URL is not set. */
async function connect() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  const pool = new Pool({ connectionString: url, max: 5, idleTimeoutMillis: 30_000 });
  // Neon closes idle connections; without a listener that error would crash the process.
  pool.on('error', (err) => console.warn('Postgres pool error:', err.message));
  const db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.join(__dirname, '..', 'drizzle') });
  return db;
}

module.exports = { connect, ...schema };
