#!/usr/bin/env bun
/**
 * Acceptance for stamped provenance and required attribution (#18).
 *
 * The assertion that matters is #4: two agents minted by ONE human share a
 * `uid` — a token attenuates its human's authority, so it must — and are told
 * apart only by their label. If provenance recorded the uid alone, every
 * agent's writes would be indistinguishable from their owner's and from each
 * other's.
 *
 *   bun scripts/verify-provenance.js --alias virta
 */
import { execSync } from 'child_process'
const lib = await import(new URL('sandbox-lib.js', import.meta.url).href)
const alias = (() => { const i = process.argv.indexOf('--alias'); return i > -1 ? process.argv[i + 1] : 'sandbox' })()
const { projectId } = lib.resolveSandbox(alias)
await lib.assertProbeAllowed(projectId)
const BASE = `https://us-central1-${projectId}.cloudfunctions.net`
const fsq=(m,p,b)=>fetch(`https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${p}`,
  {method:m,headers:{Authorization:`Bearer ${lib.token()}`,'Content-Type':'application/json'},body:b&&JSON.stringify(b)})
const out=execSync(`bun ${new URL('sandbox-token.js', import.meta.url).pathname} --alias ${alias} --role prov --grant configurator,author --export`,
  {encoding:'utf-8',cwd:new URL('..', import.meta.url).pathname})
const human=out.match(/SANDBOX_ID_TOKEN=(\S+)/)[1]
const H={'Content-Type':'application/json',Authorization:`Bearer ${human}`}
let f=0,n=0; const ok=(l,c,d='')=>{n++;console.log(`${c?'  ok':'FAIL'}  ${n}. ${l}${d?` — ${d}`:''}`);if(!c)f++}

await fsq('DELETE','grant/provtest'); await fsq('DELETE','manifest/provtest@1.0.0')
for (const i of ['h','a1','a2']) await fsq('DELETE',`provtest%3Aevent/${i}`)
const M={manifest:1,name:'provtest',version:'1.0.0',collections:{'provtest:event':{
  schema:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false},
  envelope:{requireAttribution:true},
  access:[{role:'public',read:'ALL',list:'ALL'},{role:'author',write:'ALL'}]}}}
const inst=await fetch(`${BASE}/install`,{method:'POST',headers:H,body:JSON.stringify({manifest:M})})
ok('install with requireAttribution', inst.status===200, String(inst.status))
await new Promise(r=>setTimeout(r,8000))

// two agents of ONE human
const mk=async(label)=>(await (await fetch(`${BASE}/token`,{method:'POST',headers:H,
  body:JSON.stringify({label,caveats:{roles:['author']}})})).json()).secret
const t1=await mk('ci × virta'), t2=await mk('macbook × virta')
const put=(tok,id)=>fetch(`${BASE}/doc`,{method:'POST',
  headers:{'Content-Type':'application/json',Authorization:`Bearer ${tok}`},
  body:JSON.stringify({p:`provtest:event/${id}`,data:{id}})})
await put(human,'h'); await put(t1,'a1'); await put(t2,'a2')
const get=async id=>(await (await fetch(`${BASE}/doc?p=provtest:event/${id}`)).json())._by
const h=await get('h'), a1=await get('a1'), a2=await get('a2')
ok('a human write is attributed', h?.uid && h?.name && !h?.token, JSON.stringify(h))
ok('an agent write carries token AND label', a1?.token && a1?.label==='ci × virta', JSON.stringify(a1))
ok('two agents share a uid but NOT a label — they differentiate', a1.uid===a2.uid && a1.label!==a2.label, `${a1.label} / ${a2.label}`)
ok('the human is still identifiable behind the agent', a1.uid===h.uid && a1.name===h.name, `${a1.name}`)
const anon=await fetch(`${BASE}/doc`,{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({p:'provtest:event/z',data:{id:'z'}})})
ok('an anonymous write is refused where attribution is required', anon.status===403||anon.status===404, String(anon.status))
const forge=await fetch(`${BASE}/doc`,{method:'PUT',headers:{'Content-Type':'application/json',Authorization:`Bearer ${t1}`},
  body:JSON.stringify({p:'provtest:event/a1',data:{id:'a1',_by:{uid:'someone-else',label:'not me'}}})})
const after=await get('a1')
ok('a caller cannot forge _by', after.label==='ci × virta'&&after.uid!=='someone-else', JSON.stringify(after))
await fetch(`${BASE}/install?name=provtest`,{method:'DELETE',headers:H})
for (const i of ['h','a1','a2']) await fsq('DELETE',`provtest%3Aevent/${i}`)
console.log(f ? `\n${f} of ${n} FAILED\n` : `\nall ${n} checks passed\n`)
process.exit(f ? 1 : 0)
