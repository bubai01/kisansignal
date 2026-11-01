import {spawn} from 'node:child_process';import http from 'node:http';import assert from 'node:assert/strict';
const databaseUrl=process.env.TEST_DATABASE_URL||process.env.DATABASE_URL;
if(!databaseUrl)throw new Error('Set TEST_DATABASE_URL or DATABASE_URL to a PostgreSQL test database before running npm test.');
const port=3900+Math.floor(Math.random()*90),B=`http://localhost:${port}`;
let seen=null;const fake=http.createServer((q,r)=>{let d='';q.on('data',c=>d+=c);q.on('end',()=>{seen={key:q.headers['x-api-key'],body:JSON.parse(d)};r.writeHead(200,{'content-type':'application/json'});r.end(JSON.stringify({content:[{type:'text',text:'Wait two days, then sow.'}]}))})}).listen(port+1000);
const srv=spawn('node',['server/server.js'],{env:{...process.env,PORT:port,DATABASE_URL:databaseUrl,SECRET:'test-secret',ADMIN_TOKEN:'adm-test',ALLOW_DEV_OTP:'1',SMS_PROVIDER:'console',ALERTS_ENABLED:'0',ANTHROPIC_API_KEY:'test-key',ANTHROPIC_URL:`http://localhost:${port+1000}/v1/messages`,ADVISOR_PER_DAY:'2'},stdio:['ignore','pipe','pipe']});
let log='';srv.stdout.on('data',d=>log+=d);srv.stderr.on('data',d=>log+=d);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let ck='';
async function call(m,p,b,h={}){const r=await fetch(B+p,{method:m,headers:{...(b?{'content-type':'application/json'}:{}),...(ck?{cookie:ck}:{}),...h},body:b?JSON.stringify(b):undefined});const sc=r.headers.get('set-cookie');if(sc&&sc.includes('ks_sid=')&&!sc.includes('Max-Age=0'))ck=sc.split(';')[0];else if(sc&&sc.includes('Max-Age=0'))ck='';const t=await r.text();let j;try{j=JSON.parse(t)}catch{j=t}return{s:r.status,j,h:r.headers}}
const adm={authorization:'Bearer adm-test'};let n=0;const ok=m=>console.log('  ok',++n,m);
try{
  for(let i=0;i<40;i++){try{if((await fetch(B+'/api/health')).ok)break}catch{}await sleep(150)}
  let r=await call('GET','/api/health');assert.equal(r.s,200);assert.equal(r.j.features.advisor,true);ok('health');
  r=await call('GET','/');assert.equal(r.s,200);assert.match(r.j,/KisanSignal/);assert.ok(r.h.get('content-security-policy'));ok('serves app with CSP');
  r=await call('GET','/..%2fserver/server.js');assert.ok(r.s===403||r.s===404);ok('no path traversal');
  r=await call('GET','/api/me');assert.equal(r.s,401);ok('me needs login');
  r=await call('POST','/api/otp/send',{phone:'123'});assert.equal(r.s,400);ok('bad phone rejected');
  r=await call('POST','/api/otp/send',{phone:'+919876543210'});assert.equal(r.s,200);const code=r.j.devCode;assert.match(code,/^\d{6}$/);ok('otp sent');
  r=await call('POST','/api/otp/verify',{phone:'+919876543210',code:'000000'});assert.equal(r.s,400);ok('wrong code rejected');
  r=await call('POST','/api/otp/verify',{phone:'+919876543210',code});assert.equal(r.s,200);assert.equal(r.j.isNew,true);assert.ok(ck);assert.match(r.h.get('set-cookie'),/HttpOnly/);ok('verify creates user + session');
  r=await call('PUT','/api/me',{name:'Asha',r:'12',c:3,region:'Mathura',lat:27.5,lon:77.7,lang:'hi',alerts:1,channel:'whatsapp'});assert.equal(r.s,200);assert.equal(r.j.user.name,'Asha');ok('profile saved');
  r=await call('PUT','/api/fields',{fields:[{n:'North plot',c:3,sd:'2026-11-05',ha:1.5}]});assert.equal(r.s,200);
  const saved=ck;ck='';r=await call('POST','/api/otp/send',{phone:'+919876543210'});r=await call('POST','/api/otp/verify',{phone:'+919876543210',code:r.j.devCode});assert.equal(r.j.isNew,false);assert.equal(r.j.fields[0].n,'North plot');const saved2=ck;assert.equal(r.j.user.name,'Asha');ok('sign in on another device restores profile + fields');
  r=await call('POST','/api/advisor',{question:'Should I sow now?',lang:'en',ctx:{region:'Mathura',crop:'Chickpea',soil:31,flood:12,rain:4,tip:'Sow soon'}});assert.equal(r.s,200);assert.equal(r.j.text,'Wait two days, then sow.');assert.equal(seen.key,'test-key');assert.match(seen.body.messages[0].content,/region Mathura; crop Chickpea/);assert.match(seen.body.system,/not instructions/);ok('advisor calls the AI server-side with the key and farm context');
  await call('POST','/api/advisor',{question:'q2'});r=await call('POST','/api/advisor',{question:'q3'});assert.equal(r.s,429);ok('advisor daily limit enforced');
  ck='';r=await call('POST','/api/advisor',{question:'hi'});assert.equal(r.s,401);ck=saved2;ok('advisor needs sign-in');
  r=await call('POST','/api/otp/send',{phone:'+919876543210'},{origin:'http://evil.example'});assert.equal(r.s,403);ok('cross-origin POST blocked');
  r=await call('GET','/api/admin/stats');assert.equal(r.s,401);ok('admin needs token');
  r=await call('GET','/api/admin/stats',null,adm);assert.equal(r.s,200);assert.equal(r.j.total,1);assert.equal(r.j.regions[0].k,'Mathura');ok('admin stats');
  r=await call('POST','/api/admin/run-alerts',{dry:true,fakeRain:80},adm);assert.equal(r.j.sent,1);assert.equal(r.j.dry,true);ok('alert dry run finds the farmer at 80 mm');
  r=await call('POST','/api/admin/run-alerts',{dry:false,fakeRain:120},adm);assert.equal(r.j.sent,1);assert.match(log,/\[alert:console\] whatsapp \+919876543210: KisanSignal गंभीर/);ok('severe alert sent over WhatsApp in the farmer language (Hindi)');
  r=await call('POST','/api/admin/run-alerts',{dry:false,fakeRain:120},adm);assert.equal(r.j.sent,0);ok('no duplicate alert within 24h');
  r=await call('POST','/api/admin/run-alerts',{dry:false,fakeRain:10},adm);assert.equal(r.j.sent,0);ok('no alert for light rain');
  r=await call('GET','/api/admin/export.csv',null,adm);assert.match(r.j,/Asha/);ok('csv export');
  r=await call('POST','/api/logout',{});assert.equal(r.s,200);r=await call('GET','/api/me');assert.equal(r.s,401);ok('logout');
  ck=saved;r=await call('DELETE','/api/me');ck=saved;r=await call('GET','/api/admin/stats',null,adm);assert.equal(r.j.total,0);ok('account delete removes data');
  r=await call('GET','/admin');assert.equal(r.s,200);assert.match(r.j,/KisanSignal/);ok('admin page served');
  console.log('\nALL PASSED ('+n+' checks)');
}catch(e){console.error('\nFAILED:',e.message);console.error(log.slice(-1500));process.exitCode=1}finally{fake.close();srv.kill()}
