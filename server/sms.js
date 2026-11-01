// Message delivery. SMS_PROVIDER = console | twilio | msg91
const E=process.env;
export const providerName=()=>(E.SMS_PROVIDER||'console').toLowerCase();
const digits=p=>p.replace(/\D/g,'');
async function post(url,opt){try{const r=await fetch(url,{...opt,signal:AbortSignal.timeout(15000)});const t=await r.text();return{ok:r.ok,detail:r.ok?'ok':`${r.status} ${t.slice(0,200)}`}}catch(e){return{ok:false,detail:String(e.message||e)}}}
function twilio(to,channel,body){
  const sid=E.TWILIO_SID,tok=E.TWILIO_TOKEN;if(!sid||!tok)return{ok:false,detail:'Twilio not configured'};
  const wa=channel==='whatsapp',from=wa?E.TWILIO_WHATSAPP_FROM:E.TWILIO_FROM;if(!from)return{ok:false,detail:'Twilio sender not configured'};
  const p=new URLSearchParams({To:(wa?'whatsapp:':'')+to,Body:body});
  p.set(from.startsWith('MG')?'MessagingServiceSid':'From',from);
  return post(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,{method:'POST',headers:{authorization:'Basic '+Buffer.from(sid+':'+tok).toString('base64'),'content-type':'application/x-www-form-urlencoded'},body:p});
}
export async function sendOtp(to,code){
  const pv=providerName();
  if(pv==='console'){console.log(`[sms:console] OTP for ${to}: ${code}`);return{ok:true,detail:'console'}}
  if(pv==='twilio')return twilio(to,'sms',`Your KisanSignal code is ${code}. It is valid for 5 minutes. Do not share it.`);
  if(pv==='msg91'){
    if(!E.MSG91_AUTHKEY||!E.MSG91_OTP_TEMPLATE_ID)return{ok:false,detail:'MSG91 not configured'};
    return post(`https://control.msg91.com/api/v5/otp?template_id=${encodeURIComponent(E.MSG91_OTP_TEMPLATE_ID)}&mobile=${digits(to)}&otp=${code}`,{method:'POST',headers:{authkey:E.MSG91_AUTHKEY,'content-type':'application/json'},body:'{}'});
  }
  return{ok:false,detail:'Unknown SMS_PROVIDER'};
}
// vars = {region, level, rain} for template-based providers (MSG91 / India DLT)
export async function sendAlert(to,channel,body,vars){
  const pv=providerName();
  if(pv==='console'){console.log(`[alert:console] ${channel} ${to}: ${body}`);return{ok:true,detail:'console'}}
  if(pv==='twilio')return twilio(to,channel,body);
  if(pv==='msg91'){
    if(!E.MSG91_AUTHKEY||!E.MSG91_ALERT_TEMPLATE_ID)return{ok:false,detail:'MSG91 alert template not configured'};
    return post('https://control.msg91.com/api/v5/flow',{method:'POST',headers:{authkey:E.MSG91_AUTHKEY,'content-type':'application/json'},body:JSON.stringify({template_id:E.MSG91_ALERT_TEMPLATE_ID,short_url:'0',recipients:[{mobiles:digits(to),...vars}]})});
  }
  return{ok:false,detail:'Unknown SMS_PROVIDER'};
}
