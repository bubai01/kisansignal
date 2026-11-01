import pg from 'pg';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const {Pool} = pg;
const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql');

export async function openDb(databaseUrl = process.env.DATABASE_URL) {
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const pool = new Pool({
    connectionString: databaseUrl,
    max: Number(process.env.PG_POOL_MAX || 5),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: process.env.PGSSL === 'disable' ? false : {rejectUnauthorized: false},
  });
  await pool.query(await fs.readFile(schemaPath, 'utf8'));
  await pool.query('SELECT 1');
  return pool;
}

export async function closeDb(pool) {
  if (pool) await pool.end();
}
