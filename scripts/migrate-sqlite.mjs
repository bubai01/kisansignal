import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import process from 'node:process';
import pg from 'pg';
import {openDb, closeDb} from '../server/db.js';

const source = process.argv[2] || process.env.SQLITE_PATH || path.resolve('data/kisansignal.db');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const sqlite = new DatabaseSync(source, {readOnly: true});
const db = await openDb();
const client = await db.connect();
try {
  await client.query('BEGIN');
  const rows = table => sqlite.prepare(`SELECT * FROM ${table}`).all();
  for (const row of rows('users')) await client.query('INSERT INTO users(id,phone,name,region,region_idx,crop,lat,lon,lang,alerts,channel,created,last_seen) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(id) DO NOTHING', [row.id,row.phone,row.name,row.region,row.region_idx,row.crop,row.lat,row.lon,row.lang,row.alerts,row.channel,row.created,row.last_seen]);
  for (const row of rows('otps')) await client.query('INSERT INTO otps(phone,hash,exp,tries,sent) VALUES($1,$2,$3,$4,$5) ON CONFLICT(phone) DO UPDATE SET hash=EXCLUDED.hash,exp=EXCLUDED.exp,tries=EXCLUDED.tries,sent=EXCLUDED.sent', [row.phone,row.hash,row.exp,row.tries,row.sent]);
  for (const row of rows('sessions')) await client.query('INSERT INTO sessions(hash,user_id,exp) VALUES($1,$2,$3) ON CONFLICT(hash) DO NOTHING', [row.hash,row.user_id,row.exp]);
  for (const row of rows('fields')) await client.query('INSERT INTO fields(user_id,data,updated) VALUES($1,$2::jsonb,$3) ON CONFLICT(user_id) DO UPDATE SET data=EXCLUDED.data,updated=EXCLUDED.updated', [row.user_id,row.data,row.updated]);
  for (const row of rows('alert_log')) await client.query('INSERT INTO alert_log(id,user_id,region,level,rain,channel,status,detail,ts) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING', [row.id,row.user_id,row.region,row.level,row.rain,row.channel,row.status,row.detail,row.ts]);
  for (const row of rows('events')) await client.query('INSERT INTO events(id,type,ts) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING', [row.id,row.type,row.ts]);
  for (const row of rows('advisor_log')) await client.query('INSERT INTO advisor_log(id,user_id,ts) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING', [row.id,row.user_id,row.ts]);
  for (const sequence of ['users_id_seq','alert_log_id_seq','events_id_seq','advisor_log_id_seq']) await client.query(`SELECT setval('${sequence}', GREATEST((SELECT COALESCE(MAX(id), 1) FROM ${sequence.replace('_id_seq','')}), 1))`);
  await client.query('COMMIT');
  console.log(`Migrated SQLite database ${source} to PostgreSQL without modifying the source file.`);
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  sqlite.close();
  await closeDb(db);
}
