import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {openDb, closeDb} from './db.js';
import {sendOtp, sendAlert, providerName} from './sms.js';
import {runAlerts} from './alerts.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const E = process.env;
const cfg = {
  port: Number(E.PORT) || 3000, secret: E.SECRET || crypto.randomBytes(32).toString('hex'),
  admin: E.ADMIN_TOKEN || '', devOtp: E.ALLOW_DEV_OTP === '1', key: E.ANTHROPIC_API_KEY || '',
  model: E.ANTHROPIC_MODEL || 'claude-sonnet-4-6', alerts: E.ALERTS_ENABLED !== '0',
  every: Number(E.ALERT_INTERVAL_MIN) || 180, rain: Number(E.ALERT_RAIN_MM) || 50,
  severe: Number(E.ALERT_SEVERE_MM) || 100, maxRun: Number(E.MAX_ALERTS_PER_RUN) || 500,
  proxy: E.TRUST_PROXY === '1', pub: path.resolve(E.PUBLIC_DIR || path.join(dir, '../public')),
  advisorPerDay: Number(E.ADVISOR_PER_DAY) || 20,
};
const CROPS = ['Wheat','Rice','Maize','Chickpea','Mustard','Moong','Cotton','Bajra','Jowar','Groundnut','Soybean','Arhar','Jute'];
const LANGS = ['en','hi','te','bn','ta','mr','gu','kn','ml','pa','es','fr','sw'];
const now = () => Date.now();
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const otpHash = (phone, code) => crypto.createHmac('sha256', cfg.secret).update(`${phone}:${code}`).digest('hex');
const same = (a, b) => crypto.timingSafeEqual(Buffer.from(sha(String(a))), Buffer.from(sha(String(b))));
const hits = new Map();
function rl(key, max, windowMs) {
  const t = now(), hit = hits.get(key);
  if (!hit || hit.reset < t) { hits.set(key, {n: 1, reset: t + windowMs}); return true; }
  return ++hit.n <= max;
}
setInterval(() => { const t = now(); for (const [key, value] of hits) if (value.reset < t) hits.delete(key); }, 60_000).unref();
const ipOf = req => cfg.proxy ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip : req.ip;
const pub = user => ({id: user.id, phone: user.phone, name: user.name, r: user.region_idx, c: user.crop, lang: user.lang, alerts: user.alerts, channel: user.channel});
const num = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null;
const cookie = (req, name) => (req.headers.cookie || '').split(/;\s*/).find(item => item.startsWith(`${name}=`))?.slice(name.length + 1) || '';
const secure = req => cfg.proxy ? req.headers['x-forwarded-proto'] === 'https' : !!req.socket.encrypted;
const setSessionCookie = (res, token, req) => res.set('Set-Cookie', `ks_sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}${secure(req) ? '; Secure' : ''}`);
const clearSessionCookie = res => res.set('Set-Cookie', 'ks_sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
const normPhone = value => { const phone = String(value || '').replace(/[\s-]/g, ''); return /^\+[1-9]\d{7,14}$/.test(phone) ? phone : null; };
const SEC = {'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Permissions-Policy': 'geolocation=(self), microphone=(), camera=()'};
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https://tile.openstreetmap.org; connect-src 'self' https://power.larc.nasa.gov https://api.open-meteo.com; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

async function main() {
  const db = await openDb();
  const app = express();
  app.disable('x-powered-by');
  if (cfg.proxy) app.set('trust proxy', 1);
  app.use((req, res, next) => { Object.entries(SEC).forEach(([key, value]) => res.setHeader(key, value)); next(); });
  app.use((req, res, next) => {
    if (E.CORS_ORIGIN && req.headers.origin === E.CORS_ORIGIN) {
      res.set('Access-Control-Allow-Origin', E.CORS_ORIGIN);
      res.set('Access-Control-Allow-Credentials', 'true');
      res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.set('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json({limit: '150kb'}));
  app.use('/api', (req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return res.status(403).json({error: 'Bad origin'});
    }
    next();
  });
  const auth = async (req, res, next) => {
    const token = cookie(req, 'ks_sid');
    if (!token) return res.status(401).json({error: 'Please sign in.'});
    const session = (await db.query('SELECT user_id, exp FROM sessions WHERE hash=$1', [sha(token)])).rows[0];
    if (!session || Number(session.exp) < now()) return res.status(401).json({error: 'Please sign in.'});
    const user = (await db.query('SELECT * FROM users WHERE id=$1', [session.user_id])).rows[0];
    if (!user) return res.status(401).json({error: 'Please sign in.'});
    if (now() - Number(user.last_seen) > 3_600_000) await db.query('UPDATE users SET last_seen=$1 WHERE id=$2', [now(), user.id]);
    req.user = user; next();
  };
  const admin = (req, res, next) => {
    const value = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!cfg.admin || !value || !same(value, cfg.admin)) {
      if (!rl(`adm:${ipOf(req)}`, 20, 900_000)) return res.status(429).json({error: 'Too many attempts.'});
      return res.status(401).json({error: 'Admin token required.'});
    }
    next();
  };

  app.get('/api/health', async (_req, res) => {
    await db.query('SELECT 1');
    res.set('Cache-Control', 'no-store').json({ok: true, features: {accounts: true, advisor: !!cfg.key, alerts: cfg.alerts}, sms: providerName()});
  });
  app.post('/api/event', async (req, res) => {
    if (req.body?.type === 'visit' && rl(`ev:${ipOf(req)}`, 30, 3_600_000)) await db.query('INSERT INTO events(type,ts) VALUES($1,$2)', ['visit', now()]);
    res.json({ok: true});
  });
  app.post('/api/otp/send', async (req, res) => {
    const phone = normPhone(req.body?.phone);
    if (!phone) return res.status(400).json({error: 'Enter a valid mobile number.'});
    if (!rl(`ip:${ipOf(req)}`, 30, 3_600_000) || !rl(`ph:${phone}`, 5, 3_600_000)) return res.status(429).json({error: 'Too many requests. Try again later.'});
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    await db.query('INSERT INTO otps(phone,hash,exp,tries,sent) VALUES($1,$2,$3,$4,$5) ON CONFLICT(phone) DO UPDATE SET hash=EXCLUDED.hash,exp=EXCLUDED.exp,tries=EXCLUDED.tries,sent=EXCLUDED.sent', [phone, otpHash(phone, code), now() + 300_000, 5, now()]);
    const result = await sendOtp(phone, code);
    if (!result.ok) { console.error('[otp] send failed:', result.detail); return res.status(502).json({error: 'Could not send the code. Try again.'}); }
    res.json({ok: true, ...(providerName() === 'console' && cfg.devOtp ? {devCode: code} : {})});
  });
  app.post('/api/otp/verify', async (req, res) => {
    const phone = normPhone(req.body?.phone);
    if (!phone) return res.status(400).json({error: 'Enter a valid mobile number.'});
    if (!rl(`vip:${ipOf(req)}`, 60, 3_600_000)) return res.status(429).json({error: 'Too many requests. Try again later.'});
    const otp = (await db.query('SELECT * FROM otps WHERE phone=$1', [phone])).rows[0];
    if (!otp || Number(otp.exp) < now()) return res.status(400).json({error: 'The code has expired. Request a new one.'});
    if (otp.tries <= 0) return res.status(429).json({error: 'Too many wrong tries. Request a new code.'});
    if (!same(otpHash(phone, String(req.body?.code || '')), otp.hash)) {
      await db.query('UPDATE otps SET tries=tries-1 WHERE phone=$1', [phone]);
      return res.status(400).json({error: `That code is not right. ${otp.tries - 1} tries left.`});
    }
    await db.query('DELETE FROM otps WHERE phone=$1', [phone]);
    let user = (await db.query('SELECT * FROM users WHERE phone=$1', [phone])).rows[0], isNew = false;
    if (!user) {
      isNew = true;
      user = (await db.query('INSERT INTO users(phone,created,last_seen) VALUES($1,$2,$2) RETURNING *', [phone, now()])).rows[0];
    }
    const token = crypto.randomBytes(32).toString('hex');
    await db.query('INSERT INTO sessions(hash,user_id,exp) VALUES($1,$2,$3)', [sha(token), user.id, now() + 30 * 86_400_000]);
    const fields = (await db.query('SELECT data FROM fields WHERE user_id=$1', [user.id])).rows[0];
    setSessionCookie(res, token, req);
    res.json({user: pub(user), isNew, fields: fields?.data || []});
  });

  app.use('/api/admin', admin);
  app.get('/api/admin/stats', async (_req, res) => {
    const q = (text, values = []) => db.query(text, values);
    const one = async (text, values = []) => (await q(text, values)).rows[0];
    const by = c => q(`SELECT ${c} AS k, COUNT(*)::int AS n FROM users WHERE name!='' GROUP BY ${c} ORDER BY n DESC LIMIT 12`);
    const t = now(), d = 86_400_000;
    const [total,new24h,new7d,new30d,active24h,active7d,alertsOn,regions,crops,langs,channels,alerts7d,advisor24h,visits7d,signups] = await Promise.all([
      one("SELECT COUNT(*)::int AS n FROM users WHERE name!=''"), one('SELECT COUNT(*)::int AS n FROM users WHERE created>$1',[t-d]), one('SELECT COUNT(*)::int AS n FROM users WHERE created>$1',[t-7*d]), one('SELECT COUNT(*)::int AS n FROM users WHERE created>$1',[t-30*d]), one('SELECT COUNT(*)::int AS n FROM users WHERE last_seen>$1',[t-d]), one('SELECT COUNT(*)::int AS n FROM users WHERE last_seen>$1',[t-7*d]), one("SELECT COUNT(*)::int AS n FROM users WHERE alerts=1 AND name!=''"), by('region'),by('crop'),by('lang'),by('channel'),q('SELECT status AS k,COUNT(*)::int AS n FROM alert_log WHERE ts>$1 GROUP BY status',[t-7*d]),one('SELECT COUNT(*)::int AS n FROM advisor_log WHERE ts>$1',[t-d]),one("SELECT COUNT(*)::int AS n FROM events WHERE type='visit' AND ts>$1",[t-7*d]),q("SELECT to_char(to_timestamp(created/1000),'YYYY-MM-DD') AS k,COUNT(*)::int AS n FROM users WHERE created>$1 GROUP BY k ORDER BY k",[t-14*d]),
    ]);
    res.json({total: total.n,new24h:new24h.n,new7d:new7d.n,new30d:new30d.n,active24h:active24h.n,active7d:active7d.n,alertsOn:alertsOn.n,regions:regions.rows,crops:crops.rows.map(x => ({k:CROPS[Number(x.k)] || x.k,n:x.n})),langs:langs.rows,channels:channels.rows,alerts7d:alerts7d.rows,advisor24h:advisor24h.n,visits7d:visits7d.n,signups:signups.rows,config:{sms:providerName(),advisor:!!cfg.key,alerts:cfg.alerts,everyMin:cfg.every,rainMm:cfg.rain,severeMm:cfg.severe}});
  });
  app.get('/api/admin/users', async (req, res) => {
    const term = `%${String(req.query.q || '').replace(/[%_]/g, '')}%`, limit = Math.min(200, Number(req.query.limit) || 50), offset = Math.max(0, Number(req.query.offset) || 0);
    const where = "name!='' AND (name ILIKE $1 OR phone ILIKE $1 OR region ILIKE $1)";
    const [rows,total] = await Promise.all([db.query(`SELECT id,phone,name,region,crop,lang,alerts,channel,created,last_seen FROM users WHERE ${where} ORDER BY id DESC LIMIT $2 OFFSET $3`,[term,limit,offset]),db.query(`SELECT COUNT(*)::int AS n FROM users WHERE ${where}`,[term])]);
    res.json({users: rows.rows.map(row => ({...row, phone: `${row.phone.slice(0,-4).replace(/\d/g, '•')}${row.phone.slice(-4)}`, crop: CROPS[Number(row.crop)] || row.crop})), total: total.rows[0].n});
  });
  app.delete('/api/admin/users/:id', async (req, res) => { await db.query('DELETE FROM users WHERE id=$1', [req.params.id]); res.json({ok: true}); });
  app.get('/api/admin/alerts', async (_req, res) => res.json({alerts: (await db.query('SELECT a.id,a.ts,a.region,a.level,a.rain,a.channel,a.status,a.detail,u.name FROM alert_log a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 100')).rows}));
  const csv = value => { const text = String(value ?? ''); const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text; return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe; };
  app.get('/api/admin/export.csv', async (_req, res) => {
    const rows = (await db.query("SELECT id,phone,name,region,crop,lang,alerts,channel,created,last_seen FROM users WHERE name!='' ORDER BY id")).rows;
    res.type('text/csv').set('Content-Disposition', 'attachment; filename="kisansignal-users.csv"').send(`id,phone,name,region,crop,lang,alerts,channel,created,last_seen\n${rows.map(row => [row.id,row.phone,row.name,row.region,CROPS[Number(row.crop)] || row.crop,row.lang,row.alerts,row.channel,new Date(Number(row.created)).toISOString(),new Date(Number(row.last_seen)).toISOString()].map(csv).join(',')).join('\n')}`);
  });
  app.post('/api/admin/run-alerts', async (req, res) => res.json(await runAlerts({db,cfg,send:sendAlert,dry:req.body?.dry !== false,fakeRain:req.body?.fakeRain != null && req.body.fakeRain !== '' ? Number(req.body.fakeRain) : null})));

  app.use('/api', auth);
  app.get('/api/me', async (req, res) => res.json({user: pub(req.user), fields: (await db.query('SELECT data FROM fields WHERE user_id=$1',[req.user.id])).rows[0]?.data || []}));
  app.put('/api/me', async (req, res) => {
    const name = String(req.body?.name || '').trim().slice(0, 40); if (!name) return res.status(400).json({error: 'Please enter your name.'});
    const regionIdx = /^\d{1,3}$/.test(String(req.body?.r)) ? String(req.body.r) : '0', crop = Math.round(num(Number(req.body?.c), 0, 12) ?? 0);
    const lang = LANGS.includes(req.body?.lang) ? req.body.lang : 'en';
    await db.query('UPDATE users SET name=$1,region_idx=$2,crop=$3,region=$4,lat=$5,lon=$6,lang=$7,alerts=$8,channel=$9 WHERE id=$10',[name,regionIdx,String(crop),String(req.body?.region || '').slice(0,60),num(req.body?.lat,-90,90),num(req.body?.lon,-180,180),lang,req.body?.alerts === 0 || req.body?.alerts === false ? 0 : 1,req.body?.channel === 'whatsapp' ? 'whatsapp' : 'sms',req.user.id]);
    res.json({user: pub((await db.query('SELECT * FROM users WHERE id=$1',[req.user.id])).rows[0])});
  });
  app.delete('/api/me', async (req, res) => { await db.query('DELETE FROM users WHERE id=$1',[req.user.id]); clearSessionCookie(res); res.json({ok:true}); });
  app.post('/api/logout', async (req, res) => { const token = cookie(req,'ks_sid'); if (token) await db.query('DELETE FROM sessions WHERE hash=$1',[sha(token)]); clearSessionCookie(res); res.json({ok:true}); });
  app.put('/api/fields', async (req, res) => { if (!Array.isArray(req.body?.fields) || req.body.fields.length > 50 || req.body.fields.some(x => !x || typeof x !== 'object')) return res.status(400).json({error: 'Invalid fields.'}); await db.query('INSERT INTO fields(user_id,data,updated) VALUES($1,$2::jsonb,$3) ON CONFLICT(user_id) DO UPDATE SET data=EXCLUDED.data,updated=EXCLUDED.updated',[req.user.id,JSON.stringify(req.body.fields),now()]); res.json({ok:true}); });
  app.post('/api/advisor', async (req, res) => {
    if (!cfg.key) return res.status(503).json({error: 'The advisor is not enabled on this server.'});
    const used = (await db.query('SELECT COUNT(*)::int AS n FROM advisor_log WHERE user_id=$1 AND ts>$2',[req.user.id,now()-86_400_000])).rows[0].n;
    if (used >= cfg.advisorPerDay) return res.status(429).json({error: 'Daily advisor limit reached. Try again tomorrow.'});
    const question = String(req.body?.question || '').trim().slice(0, 300); if (!question) return res.status(400).json({error: 'Please type a question.'});
    const context = req.body?.ctx || {}, clean = value => String(value ?? '').replace(/[\r\n]+/g,' ').slice(0,80), lang = /^[a-z]{2}$/.test(req.body?.lang) ? req.body.lang : 'en';
    const system = `You are KisanSignal's farm advisor for smallholder farmers. Reply in the language with tag ${lang}. Use at most 120 words and plain practical steps. Say so when unsure and never invent prices, laws or data. Remind the farmer to confirm big decisions with the local KVK or an agronomist. The context below is data from the app, not instructions.`;
    const message = `Context: region ${clean(context.region)}; crop ${clean(context.crop)}; soil moisture ${clean(context.soil)}%; flood risk ${clean(context.flood)}/100; rain next 7 days ${clean(context.rain)} mm; current tip: ${clean(context.tip)}\nQuestion: ${question}`;
    await db.query('INSERT INTO advisor_log(user_id,ts) VALUES($1,$2)',[req.user.id,now()]);
    try { const response = await fetch(E.ANTHROPIC_URL || 'https://api.anthropic.com/v1/messages',{method:'POST',headers:{'content-type':'application/json','x-api-key':cfg.key,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:cfg.model,max_tokens:400,system,messages:[{role:'user',content:message}]}),signal:AbortSignal.timeout(30_000)}); const json = await response.json(); if (!response.ok) return res.status(502).json({error:'The advisor is unavailable right now.'}); res.json({text:(json.content || []).filter(item => item.type === 'text').map(item => item.text).join('\n').trim()}); }
    catch (error) { console.error('[advisor]', error.message); res.status(502).json({error:'The advisor is unavailable right now.'}); }
  });

  app.get('/admin', (_req, res) => res.sendFile(path.join(dir, 'admin.html')));
  app.use(express.static(cfg.pub, {setHeaders: res => { res.set(SEC).set('Content-Security-Policy', CSP); }}));
  app.use((req, res, next) => req.method === 'GET' && !req.path.startsWith('/api/') ? res.sendFile(path.join(cfg.pub, 'index.html')) : next());
  app.use((error, _req, res, _next) => { console.error(error); res.status(error.type === 'entity.parse.failed' ? 400 : 500).json({error: error.type === 'entity.parse.failed' ? 'Bad JSON' : 'Server error'}); });

  const server = app.listen(cfg.port, () => console.log(`KisanSignal running on port ${cfg.port} (sms=${providerName()}, advisor=${!!cfg.key}, alerts=${cfg.alerts})`));
  const cleanup = async () => { server.close(); await closeDb(db); process.exit(0); };
  process.on('SIGTERM', cleanup); process.on('SIGINT', cleanup);
  setInterval(async () => { try { await db.query('DELETE FROM otps WHERE exp<$1',[now()]); await db.query('DELETE FROM sessions WHERE exp<$1',[now()]); await db.query('DELETE FROM events WHERE ts<$1',[now()-90*86_400_000]); } catch (error) { console.error('[cleanup]', error.message); } }, 3_600_000).unref();
  if (cfg.alerts) { const tick = () => runAlerts({db,cfg,send:sendAlert}).then(result => console.log('[alerts]', JSON.stringify(result))).catch(error => console.error('[alerts]', error.message)); setTimeout(tick, 60_000).unref(); setInterval(tick, cfg.every * 60_000).unref(); }
}
main().catch(error => { console.error('[startup]', error.message); process.exitCode = 1; });
