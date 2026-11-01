const T = {
  en: (r,m,s) => `KisanSignal ${s ? 'SEVERE ' : ''}flood alert: heavy rain (up to ${m} mm in a day) is forecast for ${r} in the next 3 days. Move animals, stored grain and equipment to higher ground and clear drains. Follow local authority instructions.`,
  hi: (r,m,s) => `KisanSignal ${s ? 'गंभीर ' : ''}बाढ़ चेतावनी: अगले 3 दिन में ${r} में एक दिन में ${m} मिमी तक भारी बारिश का अनुमान है। पशु, अनाज और उपकरण ऊँची जगह रखें और नालियाँ साफ़ करें। स्थानीय प्रशासन के निर्देश मानें।`,
  es: (r,m,s) => `Alerta ${s ? 'GRAVE ' : ''}de inundación de KisanSignal: se prevé lluvia fuerte (hasta ${m} mm por día) en ${r} en los próximos 3 días. Lleva animales, grano y equipos a terreno alto y limpia los desagües. Sigue las indicaciones de las autoridades.`,
  fr: (r,m,s) => `Alerte inondation ${s ? 'GRAVE ' : ''}KisanSignal : fortes pluies (jusqu’à ${m} mm par jour) prévues à ${r} dans les 3 prochains jours. Mettez animaux, grains et matériel en hauteur et dégagez les drains. Suivez les consignes des autorités.`,
};
export const message = (lang, region, mm, severe) => (T[lang] || T.en)(region, Math.round(mm), severe);
async function forecast(lat, lon, fetchFn) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=precipitation_sum&forecast_days=3&timezone=auto`;
  const response = await fetchFn(url, {signal: AbortSignal.timeout(15_000)});
  if (!response.ok) throw new Error(`forecast ${response.status}`);
  const json = await response.json();
  return Math.max(0, ...(json.daily?.precipitation_sum || []).map(Number).filter(Number.isFinite));
}
export async function runAlerts({db, cfg, send, dry = false, fakeRain = null, fetchFn = fetch}) {
  const users = (await db.query("SELECT * FROM users WHERE alerts=1 AND lat IS NOT NULL AND lon IS NOT NULL AND name!=''")).rows;
  const groups = new Map();
  for (const user of users) {
    const key = `${user.lat.toFixed(1)},${user.lon.toFixed(1)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(user);
  }
  const out = {users: users.length, groups: groups.size, sent: 0, failed: 0, skipped: 0, dry, errors: []};
  const day = Date.now() - 86_400_000;
  for (const [key, list] of groups) {
    let rain;
    try { rain = fakeRain != null ? Number(fakeRain) : await forecast(list[0].lat, list[0].lon, fetchFn); }
    catch (error) { out.errors.push(`${key}: ${error.message}`); continue; }
    const level = rain >= cfg.severe ? 'severe' : rain >= cfg.rain ? 'high' : null;
    if (!level) { out.skipped += list.length; continue; }
    for (const user of list) {
      const recent = (await db.query("SELECT level, COUNT(*)::int AS n FROM alert_log WHERE user_id=$1 AND status='sent' AND ts>$2 GROUP BY level", [user.id, day])).rows;
      const total = recent.reduce((sum, item) => sum + item.n, 0);
      const duplicate = recent.some(item => item.level === level || (item.level === 'severe' && level === 'high'));
      if (duplicate || total >= 2) { out.skipped++; continue; }
      if (out.sent + out.failed >= cfg.maxRun) { out.errors.push('MAX_ALERTS_PER_RUN reached'); return out; }
      const text = message(user.lang, user.region || 'your area', rain, level === 'severe');
      let result = {ok: true, detail: 'dry run'};
      if (!dry) result = await send(user.phone, user.channel, text, {region: user.region || 'your area', level, rain: String(Math.round(rain))});
      await db.query('INSERT INTO alert_log(user_id,region,level,rain,channel,status,detail,ts) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [user.id, user.region, level, rain, user.channel, dry ? 'dry' : result.ok ? 'sent' : 'failed', result.detail, Date.now()]);
      if (dry || result.ok) out.sent++; else out.failed++;
    }
  }
  return out;
}
