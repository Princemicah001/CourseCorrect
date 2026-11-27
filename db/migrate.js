const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');

const envPath = path.join(__dirname, '..', '.env');
if (fsSync.existsSync(envPath)) {
  fsSync.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach((line) => {
    const value = line.trim();
    if (!value || value.startsWith('#')) return;
    const index = value.indexOf('=');
    if (index < 1) return;
    const key = value.slice(0, index).trim();
    const parsed = value.slice(index + 1).trim().replace(/^[\"']|[\"']$/g, '');
    if (!process.env[key]) process.env[key] = parsed;
  });
}

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required. Add it to .env or the process environment.');
}

const { pool } = require('./pool');

async function migrate() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const sql = await fs.readFile(schemaPath, 'utf8');
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    console.log('[PostgreSQL] Schema migration completed.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(async (error) => {
  console.error('[PostgreSQL] Migration failed:', error.message);
  await pool.end();
  process.exitCode = 1;
});
