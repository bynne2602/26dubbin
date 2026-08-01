import { ADMIN_HTML_V2 } from "./admin-html-v2";

interface LicenseKv { get<T=string>(key:string,type?:"json"):Promise<T|null>; put(key:string,value:string):Promise<void>; list(options?:{prefix?:string}):Promise<{keys:Array<{name:string}>}> }
interface RateLimit { limit(options:{key:string}):Promise<{success:boolean}> }
interface Env { LICENSE_KV:LicenseKv; TTS_RATE_LIMITER:RateLimit; LICENSE_SECRET:string; ADMIN_PASSWORD:string; ADMIN_SECRET:string }
type Plan="1d"|"3d"|"7d"|"1m"|"3m"|"1y"|"forever";
type License={key:string;hwid:string;uid:string;plan:Plan;iat:number;exp:number|null;revoked:boolean};
const durations:Record<Plan,number|null>={"1d":86400,"3d":259200,"7d":604800,"1m":2592000,"3m":7776000,"1y":31536000,"forever":null};
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store","access-control-allow-origin":"*"}});
const hwid=(value:unknown)=>String(value||"").trim().toLowerCase().replace(/[^a-z0-9_-]/g,"").slice(0,128);
const hex=(value:ArrayBuffer)=>[...new Uint8Array(value)].map(x=>x.toString(16).padStart(2,"0")).join("");
async function sha(value:string){return hex(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value)))}
async function sign(env:Env,value:string){const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(env.LICENSE_SECRET),{name:"HMAC",hash:"SHA-256"},false,["sign"]);return hex(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(value))).slice(0,32)}
function equal(a:string,b:string){if(!a||!b||a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0}
function authorized(req:Request,env:Env){const value=(req.headers.get("authorization")||"").replace(/^Bearer\s+/i,"");return equal(value,env.ADMIN_PASSWORD||"")||equal(value,env.ADMIN_SECRET||"")}
async function createLicense(env:Env,id:string,uid:string,plan:Plan){const iat=Math.floor(Date.now()/1000),seconds=durations[plan],exp=seconds===null?null:iat+seconds;const key=await sign(env,`${id}|${uid}|${plan}|${iat}|${exp??"forever"}`);const entry:License={key,hwid:id,uid,plan,iat,exp,revoked:false};await env.LICENSE_KV.put(`license:${key}`,JSON.stringify(entry));const index=JSON.parse(await env.LICENSE_KV.get("index")||"[]") as string[];if(!index.includes(key))await env.LICENSE_KV.put("index",JSON.stringify([...index,key]));return entry}
async function history(env:Env){const index=JSON.parse(await env.LICENSE_KV.get("index")||"[]") as string[];return (await Promise.all(index.map(key=>env.LICENSE_KV.get<License>(`license:${key}`,"json")))).filter(Boolean).reverse()}
async function verify(env:Env,keyValue:unknown,hwidValue:unknown){const key=String(keyValue||"").trim(),entry=await env.LICENSE_KV.get<License>(`license:${key}`,"json");if(!entry)return {valid:false,reason:"Key không tồn tại."};if(entry.revoked)return {valid:false,reason:"Key đã bị thu hồi."};if(hwid(entry.hwid)!==hwid(hwidValue))return {valid:false,reason:"Key không thuộc thiết bị này."};const expected=await sign(env,`${entry.hwid}|${entry.uid}|${entry.plan}|${entry.iat}|${entry.exp??"forever"}`);if(expected!==entry.key)return {valid:false,reason:"Key không hợp lệ."};if(entry.exp!==null&&Date.now()/1000>entry.exp)return {valid:false,reason:"Key đã hết hạn."};return {valid:true,entry}}

export default {async fetch(req:Request,env:Env){
  const url=new URL(req.url);
  if(req.method==="OPTIONS")return new Response(null,{headers:{"access-control-allow-origin":"*","access-control-allow-headers":"content-type,authorization","access-control-allow-methods":"GET,POST,OPTIONS"}});
  if(url.pathname==="/admin"&&req.method==="GET")return new Response(ADMIN_HTML_V2,{headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store"}});
  if(url.pathname==="/api/trial/request"&&req.method==="POST"){
    const body=await req.json().catch(()=>({})) as {hwid?:string},id=hwid(body.hwid);if(id.length<8)return json({error:"Hardware ID không hợp lệ."},400);
    const trialId=(await sha(id)).slice(0,40),key=`trial:${trialId}`;if(await env.LICENSE_KV.get(key))return json({error:"Thiết bị này đã đăng ký trải nghiệm."},409);
    await env.LICENSE_KV.put(key,JSON.stringify({id:trialId,hwid:id,status:"pending",createdAt:Date.now()}));return json({ok:true,message:"Đã gửi yêu cầu dùng thử 1 ngày, vui lòng chờ admin duyệt."},201);
  }
  if(url.pathname==="/api/license/verify"&&req.method==="POST"){const body=await req.json().catch(()=>({})) as {key?:string;hwid?:string};return json(await verify(env,body.key,body.hwid))}
  if(url.pathname==="/api/tts/authorize"&&req.method==="POST"){const body=await req.json().catch(()=>({})) as {key?:string;hwid?:string},checked=await verify(env,body.key,body.hwid);if(!checked.valid)return json(checked,403);const identity=await sha(`${String(body.key||"").trim()}:${hwid(body.hwid)}`),limit=await env.TTS_RATE_LIMITER.limit({key:identity});if(!limit.success)return json({valid:false,reason:"Bạn đang gửi quá nhiều yêu cầu. Vui lòng chờ một phút."},429);return json({valid:true})}
  if(url.pathname.startsWith("/admin/")&&!authorized(req,env))return json({error:"Mật khẩu admin không đúng."},401);
  if(url.pathname==="/admin/issue"&&req.method==="POST"){
    const body=await req.json().catch(()=>({})) as {hwid?:string;uid?:string;plan?:Plan;trialId?:string};const id=hwid(body.hwid);if(id.length<8)return json({error:"Hardware ID không hợp lệ."},400);let plan=body.plan;
    if(body.trialId){const trial=await env.LICENSE_KV.get<any>(`trial:${body.trialId}`,"json");if(!trial||trial.hwid!==id||trial.status!=="pending")return json({error:"Yêu cầu trial không hợp lệ hoặc đã được duyệt."},409);plan="1d";trial.status="approved";trial.approvedAt=Date.now();await env.LICENSE_KV.put(`trial:${body.trialId}`,JSON.stringify(trial))}
    if(!plan||!(plan in durations))return json({error:"Gói không hợp lệ."},400);const entry=await createLicense(env,id,String(body.uid||"customer").slice(0,80),plan);return json({ok:true,entry,key:entry.key,token:entry.key});
  }
  if(url.pathname==="/admin/revoke"&&req.method==="POST"){const body=await req.json().catch(()=>({})) as {key?:string},key=String(body.key||"").trim(),entry=await env.LICENSE_KV.get<License>(`license:${key}`,"json");if(!entry)return json({error:"Key không tồn tại."},404);entry.revoked=true;await env.LICENSE_KV.put(`license:${key}`,JSON.stringify(entry));return json({ok:true,entry})}
  if(url.pathname==="/admin/history")return json({items:await history(env)});
  if(url.pathname==="/admin/trials"){const list=await env.LICENSE_KV.list({prefix:"trial:"}),items=(await Promise.all(list.keys.map(x=>env.LICENSE_KV.get<any>(x.name,"json")))).filter(Boolean).sort((a,b)=>b.createdAt-a.createdAt);return json({items})}
  return json({error:"Not found"},404);
}};
