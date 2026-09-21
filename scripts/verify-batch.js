#!/usr/bin/env bun
/**
 * Acceptance for the atomic multi-document commit (#15).
 *
 * The assertions that matter are the TORN ones: a commit containing an invalid
 * document must leave NOTHING behind, and a sequenced commit must take a
 * contiguous range so a replica never observes half of it.
 *
 *   bun scripts/verify-batch.js --alias virta
 */
import { execSync } from 'child_process'
const lib = await import(new URL('sandbox-lib.js', import.meta.url).href)
const alias = (() => { const i = process.argv.indexOf('--alias'); return i > -1 ? process.argv[i+1] : 'sandbox' })()
const { projectId } = lib.resolveSandbox(alias)
await lib.assertProbeAllowed(projectId)
const BASE = `https://us-central1-${projectId}.cloudfunctions.net`
const fsq=(m,p,b)=>fetch(`https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${p}`,
  {method:m,headers:{Authorization:`Bearer ${lib.token()}`,'Content-Type':'application/json'},body:b&&JSON.stringify(b)})
const out = execSync(`bun ${new URL('sandbox-token.js', import.meta.url).pathname} --alias ${alias} --role batchtest --grant configurator,author --export`,
  {encoding:'utf-8',cwd:new URL('..', import.meta.url).pathname})
const tok = out.match(/SANDBOX_ID_TOKEN=(\S+)/)[1]
const H={'Content-Type':'application/json',Authorization:`Bearer ${tok}`}
let fails=0,n=0
const ok=(l,c,d='')=>{n++;console.log(`${c?'  ok':'FAIL'}  ${n}. ${l}${d?` — ${d}`:''}`);if(!c)fails++}
const post=(body)=>fetch(`${BASE}/docs`,{method:'POST',headers:H,body:JSON.stringify(body)})
const read=(id)=>fetch(`${BASE}/doc?p=batchtest:event/${id}`,{headers:H})

await fsq('DELETE','grant/batchtest'); await fsq('DELETE','manifest/batchtest@1.0.0')
await fsq('DELETE','system%3Aseq/batchtest%3Aevent')
for (const i of ['a','b','c','d','e','f']) await fsq('DELETE',`batchtest%3Aevent/${i}`)

const M={manifest:1,name:'batchtest',version:'1.0.0',collections:{'batchtest:event':{
  schema:{type:'object',properties:{id:{type:'string'},kind:{type:'string'}},required:['id','kind'],additionalProperties:false},
  envelope:{seq:true},
  access:[{role:'author',read:'ALL',write:'ALL',list:'ALL'}]}}}
const inst=await fetch(`${BASE}/install`,{method:'POST',headers:H,body:JSON.stringify({manifest:M})})
ok('install', inst.status===200, String(inst.status))
await new Promise(r=>setTimeout(r,8000))

// a 4-document commit, virta's cross-project move shape
const c1=await post({writes:[
  {p:'batchtest:event/a',data:{id:'a',kind:'untagged'}},
  {p:'batchtest:event/b',data:{id:'b',kind:'tagged'}},
  {p:'batchtest:event/c',data:{id:'c',kind:'tagged'}},
  {p:'batchtest:event/d',data:{id:'d',kind:'commented'}}]})
const j1=await c1.json()
ok('a 4-document commit lands as one', c1.status===200&&j1.written===4, `${c1.status} ${JSON.stringify(j1).slice(0,110)}`)
ok('it took a CONTIGUOUS sequence range',
   JSON.stringify(j1.results?.map(r=>r.seq))==='[1,2,3,4]', JSON.stringify(j1.results?.map(r=>r.seq)))

// THE torn-write test: one bad document must leave nothing behind
const c2=await post({writes:[
  {p:'batchtest:event/e',data:{id:'e',kind:'created'}},
  {p:'batchtest:event/f',data:{id:'f'}}]})           // missing required `kind`
ok('a commit with one invalid document is refused', c2.status===400, String(c2.status))
const eGone=await read('e'), fGone=await read('f')
ok('and NOTHING from it was written — not even the valid document',
   eGone.status===404&&fGone.status===404, `e=${eGone.status} f=${fGone.status}`)

const afterTear=await fetch(`${BASE}/docs?p=batchtest:event&since=0&c=20`,{headers:H}).then(r=>r.json())
ok('the sequence did not advance for a refused commit',
   JSON.stringify(afterTear.rows.map(r=>r._seq))==='[1,2,3,4]', JSON.stringify(afterTear.rows.map(r=>r._seq)))

// replica never sees half a commit
const c3=await post({writes:[
  {p:'batchtest:event/e',data:{id:'e',kind:'created'}},
  {p:'batchtest:event/f',data:{id:'f',kind:'tagged'}}]})
const j3=await c3.json()
ok('a later commit continues the range', JSON.stringify(j3.results?.map(r=>r.seq))==='[5,6]', JSON.stringify(j3.results?.map(r=>r.seq)))
const delta=await fetch(`${BASE}/docs?p=batchtest:event&since=4&c=20`,{headers:H}).then(r=>r.json())
ok('a replica at the old cursor sees the WHOLE commit, never half',
   JSON.stringify(delta.rows.map(r=>r._seq))==='[5,6]', JSON.stringify(delta.rows.map(r=>r._seq)))

// guards
const dup=await post({writes:[{p:'batchtest:event/a',data:{id:'a',kind:'x'}},{p:'batchtest:event/a',data:{id:'a',kind:'y'}}]})
ok('the same document twice in one commit is refused', dup.status===400 && /appears twice/.test(await dup.text()), String(dup.status))
const anon=await fetch(`${BASE}/docs`,{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({writes:[{p:'batchtest:event/z',data:{id:'z',kind:'x'}}]})})
ok('an unauthorised commit is refused opaquely', anon.status===404||anon.status===403, String(anon.status))
const idem=await post({writes:[{p:'batchtest:event/a',data:{id:'a',kind:'untagged'}}]})
ok('an unchanged document is a no-op inside a commit', idem.status===200 && (await idem.json()).written===0, '')

await fetch(`${BASE}/install?name=batchtest`,{method:'DELETE',headers:H})
for (const i of ['a','b','c','d','e','f']) await fsq('DELETE',`batchtest%3Aevent/${i}`)
await fsq('DELETE','system%3Aseq/batchtest%3Aevent')
console.log(fails?`\n${fails} of ${n} FAILED\n`:`\nall ${n} checks passed\n`)
process.exit(fails?1:0)
