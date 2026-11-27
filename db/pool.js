const { Pool } = require('pg');

const poolOptions = {
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX || 5),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  // Hosted PostgreSQL providers commonly require TLS. Local development can opt out.
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: true }
};

const pool = new Pool(poolOptions);

pool.on('error', (error) => {
  console.error('[PostgreSQL] Unexpected idle client error:', error.message);
});

async function query(text, params) {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required. Configure PostgreSQL before using catalogue APIs.');
  }
  return pool.query(text, params);
}

async function checkDatabase() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const result = await query('SELECT NOW() AS database_time, current_database() AS database_name');
  return result.rows[0];
}

module.exports = { pool, query, checkDatabase };
