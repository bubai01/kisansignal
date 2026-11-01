const V='ks-v2',SHELL=['./','index.html','manifest.webmanifest','icon.svg','icon-192.png','icon-512.png'];
const LIVE=['power.larc.nasa.gov','api.open-meteo.com'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(V).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==V).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{
  const r=e.request;if(r.method!=='GET')return;const u=new URL(r.url);if(u.origin===location.origin&&(u.pathname.startsWith('/api/')||u.pathname.startsWith('/admin')))return;
  if(LIVE.includes(u.hostname)){ // live data: network first, last good copy offline
    e.respondWith(fetch(r).then(x=>{const c=x.clone();caches.open(V).then(h=>h.put(r,c));return x}).catch(()=>caches.match(r)));return}
  // app shell, fonts, map tiles: show cached copy fast, refresh in background
  e.respondWith(caches.match(r).then(hit=>{const net=fetch(r).then(x=>{if(x&&(x.ok||x.type==='opaque')){const c=x.clone();caches.open(V).then(h=>h.put(r,c))}return x}).catch(()=>hit);return hit||net}));
});
