import { getStore } from "@netlify/blobs";
import OpenAI from "openai";
import crypto from "node:crypto";

const SITE_URL = process.env.URL || "https://laviastudents2025.netlify.app";
const MAX_SOURCE_CHARS = 10000;
const KEEP_UPDATES = 24;

const clean = html => html
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi," ")
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi," ")
  .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi," ")
  .replace(/<!--[\s\S]*?-->/g," ")
  .replace(/<[^>]+>/g," ")
  .replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/&quot;/gi,'"')
  .replace(/&#39;|&apos;/gi,"'").replace(/&lt;/gi,"<").replace(/&gt;/gi,">")
  .replace(/\s+/g," ").trim();

const sha = text => crypto.createHash("sha256").update(text).digest("hex");
const today = () => new Date().toISOString().slice(0,10);

async function loadSources() {
  const r = await fetch(new URL("/data/sources.json", SITE_URL), {cache:"no-store"});
  if (!r.ok) throw new Error(`sources.json ${r.status}`);
  return (await r.json()).filter(s => s?.id && s?.url);
}

async function fetchSource(s) {
  const c = new AbortController();
  const t = setTimeout(()=>c.abort(),10000);
  try {
    const r = await fetch(s.url,{
      signal:c.signal, redirect:"follow",
      headers:{"User-Agent":"LaViaItalyStudyMonitor/2.0 (+https://laviastudents2025.netlify.app)","Accept":"text/html,application/xhtml+xml"}
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = clean(await r.text()).slice(0,MAX_SOURCE_CHARS);
    if (text.length < 180) throw new Error("content too short");
    return {...s,text,hash:sha(text)};
  } finally { clearTimeout(t); }
}

async function seedUpdates() {
  try {
    const r = await fetch(new URL("/data/updates.json",SITE_URL),{cache:"no-store"});
    return r.ok ? await r.json() : [];
  } catch { return []; }
}

export default async () => {
  const sources = await loadSources();
  const rank={critical:0,high:1,normal:2};
  sources.sort((a,b)=>(rank[a.priority]??9)-(rank[b.priority]??9));

  const state=getStore("la-via-source-state-v2");
  const store=getStore("la-via-updates");
  const results=await Promise.allSettled(sources.map(fetchSource));
  const fetched=results.map(r=>r.status==="fulfilled"?r.value:null).filter(Boolean);

  results.forEach((r,i)=>{ if(r.status==="rejected") console.error(`Source failed: ${sources[i].name}`,r.reason?.message||r.reason); });
  if(!fetched.length) return;

  const changed=[]; let hasBaseline=false;
  for(const s of fetched){
    const prev=await state.get(s.id,{type:"json",consistency:"strong"});
    if(prev?.hash){
      hasBaseline=true;
      if(prev.hash!==s.hash) changed.push({...s,previousText:prev.text||""});
    }
    await state.setJSON(s.id,{hash:s.hash,text:s.text,checkedAt:new Date().toISOString(),name:s.name,url:s.url,type:s.type,priority:s.priority});
  }

  if(!hasBaseline){ console.log(`Baseline created for ${fetched.length}/${sources.length} sources.`); return; }
  if(!changed.length) return;
  if(!process.env.OPENAI_API_KEY){ console.error("OPENAI_API_KEY missing"); return; }

  const payload=changed.slice(0,12).map(s=>({
    sourceId:s.id,sourceName:s.name,sourceType:s.type,priority:s.priority,
    defaultCategory:s.category,sourceUrl:s.url,
    previousText:s.previousText.slice(0,7000),currentText:s.text.slice(0,7000)
  }));

  const client=new OpenAI({apiKey:process.env.OPENAI_API_KEY});
  const response=await client.responses.create({
    model:"gpt-5-mini",
    reasoning:{effort:"low"},
    input:[
      {role:"system",content:[{type:"input_text",text:`You verify official study-in-Italy updates for La Via.
Compare PREVIOUS and CURRENT text from the same official page.
Publish only a material NEW change affecting prospective/incoming international students: admissions, Universitaly, visa, embassy procedure, required documents, deadlines, language/B2, tuition, scholarship/DSU, residence permit/Questura, immigration office/Sportello Unico, codice fiscale, SSN, or arrival procedure.
Do not republish facts present in both versions. Ignore layout/cookies/navigation/general news.
Never infer beyond supplied official text.
For university sources, ignore research/general news and publish only student-procedure changes.
Write concise Arabic. confidence=high only when the NEW change is explicit in CURRENT and absent from PREVIOUS. If uncertain: material=false.`}]},
      {role:"user",content:[{type:"input_text",text:JSON.stringify(payload)}]}
    ],
    text:{format:{type:"json_schema",name:"la_via_updates_v2",strict:true,schema:{
      type:"object",additionalProperties:false,properties:{updates:{type:"array",items:{
        type:"object",additionalProperties:false,properties:{
          sourceId:{type:"string"},material:{type:"boolean"},
          category:{type:"string",enum:["Visa","Universitaly","University","Scholarship","Language","Residence","Immigration","General"]},
          urgent:{type:"boolean"},title:{type:"string"},summary:{type:"string"},
          audience:{type:"string"},confidence:{type:"string",enum:["high","medium","low"]},
          effectiveDate:{type:"string"}
        },
        required:["sourceId","material","category","urgent","title","summary","audience","confidence","effectiveDate"]
      }}},required:["updates"]
    }}}
  });

  let parsed; try{ parsed=JSON.parse(response.output_text); } catch(e){ console.error("parse failed",e); return; }
  const sourceMap=new Map(sources.map(s=>[s.id,s]));

  const approved=(parsed.updates||[])
    .filter(u=>u.material===true && u.confidence==="high" && sourceMap.has(u.sourceId))
    .map(u=>{
      const s=sourceMap.get(u.sourceId);
      const date=/^\d{4}-\d{2}-\d{2}$/.test(u.effectiveDate)?u.effectiveDate:today();
      return {
        id:sha(`${u.sourceId}|${u.title}|${date}`).slice(0,16),
        category:u.category||s.category,date,urgent:Boolean(u.urgent),
        title:u.title.trim(),summary:u.summary.trim(),audience:u.audience.trim(),
        sourceUrl:s.url,sourceName:s.name,sourceType:s.type,priority:s.priority,
        published:true,detectedAt:new Date().toISOString()
      };
    });

  if(!approved.length) return;

  let existing=await store.get("published",{type:"json",consistency:"strong"});
  if(!Array.isArray(existing)||!existing.length) existing=await seedUpdates();

  const seen=new Set(), unique=[];
  for(const item of [...approved,...existing]){
    const key=item.id||sha(`${item.sourceUrl}|${item.title}|${item.date}`).slice(0,16);
    if(seen.has(key)) continue;
    seen.add(key); unique.push({...item,id:key});
  }
  unique.sort((a,b)=>String(b.date).localeCompare(String(a.date)));
  await store.setJSON("published",unique.slice(0,KEEP_UPDATES));
  console.log(`Published ${approved.length} verified update(s).`);
};
