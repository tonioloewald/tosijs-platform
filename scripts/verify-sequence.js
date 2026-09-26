#!/usr/bin/env bun
/**
 * Acceptance for monotonic sequences and the delta cursor (#14), against a
 * real deployed host.
 *
 * The assertion that matters is #4/#5: EIGHT CONCURRENT writes get unique,
 * contiguous sequence numbers. A counter read outside the transaction that
 * writes the document passes every serial test and fails this one — two
 * writers read the same value, commit the same `_seq`, and a replica resuming
 * from that number silently skips one of them.
 *
 * Targets an alias, sandbox-guarded like every script here:
 *   bun scripts/verify-sequence.js --alias virta
 */
import { execSync } from 'child_process'
const lib = await import(new URL('sandbox-lib.js', import.meta.url).href)
const alias = (() => {
  const i = process.argv.indexOf('--alias')
  return i > -1 ? process.argv[i + 1] : 'sandbox'
})()
const { projectId } = lib.resolveSandbox(alias)
await lib.assertProbeAllowed(projectId)
const BASE = `https://us-central1-${projectId}.cloudfunctions.net`
const fsq = (m,p,b)=>fetch(`https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${p}`,
  {method:m,headers:{Authorization:`Bearer ${lib.token()}`,'Content-Type':'application/json'},body:b&&JSON.stringify(b)})
const out = execSync(`bun ${new URL('sandbox-token.js', import.meta.url).pathname} --alias ${alias} --role seqtest --grant configurator,author --export`,
  {encoding:'utf-8',cwd:new URL('..', import.meta.url).pathname})
const tok = out.match(/SANDBOX_ID_TOKEN=(\S+)/)[1]
const H = {'Content-Type':'application/json',Authorization:`Bearer ${tok}`}
let fails=0, n=0
const ok=(l,c,d='')=>{n++;console.log(`${c?'  ok':'FAIL'}  ${n}. ${l}${d?` — ${d}`:''}`);if(!c)fails++}

// clean
await fsq('DELETE','grant/seqtest'); await fsq('DELETE','manifest/seqtest@1.0.0')
await fsq('DELETE','system%3Aseq/seqtest%3Aevent')
for (let i=1;i<=12;i++) await fsq('DELETE',`seqtest%3Aevent/e${i}`)
await fsq('DELETE','seqtest%3Aevent/race')

const M={manifest:1,name:'seqtest',version:'1.0.0',collections:{'seqtest:event':{
  schema:{type:'object',properties:{id:{type:'string'},kind:{type:'string'}},required:['id'],additionalProperties:false},
  envelope:{seq:true}, immutable:true,
  access:[{role:'author',read:'ALL',write:'ALL',list:'ALL'}]}}}
const inst=await fetch(`${BASE}/install`,{method:'POST',headers:H,body:JSON.stringify({manifest:M})})
ok('a manifest may declare envelope.seq', inst.status===200, `${inst.status} ${(await inst.text()).slice(0,70)}`)
await new Promise(r=>setTimeout(r,8000))

// CONCURRENT writes — the case a counter exists for.
const writes = await Promise.all([1,2,3,4,5,6,7,8].map(i =>
  fetch(`${BASE}/doc`,{method:'POST',headers:H,
    body:JSON.stringify({p:`seqtest:event/e${i}`,data:{id:`e${i}`,kind:'created'}})})))
ok('8 concurrent writes all commit', writes.every(r=>r.status===200), writes.map(r=>r.status).join(','))

const all = await fetch(`${BASE}/docs?p=seqtest:event&since=0&c=50`,{headers:H}).then(r=>r.json())
const seqs = all.rows.map(r=>r._seq)
ok('every document got a _seq', seqs.every(s=>typeof s==='number'), JSON.stringify(seqs))
ok('sequences are UNIQUE — no two writers shared one', new Set(seqs).size===seqs.length, `${new Set(seqs).size} of ${seqs.length}`)
ok('they are contiguous 1..8 — no gaps a replica would read as missed events',
   JSON.stringify([...seqs].sort((a,b)=>a-b))===JSON.stringify([1,2,3,4,5,6,7,8]), JSON.stringify(seqs))
ok('returned in _seq order', JSON.stringify(seqs)===JSON.stringify([...seqs].sort((a,b)=>a-b)), JSON.stringify(seqs))

// the delta cursor
const p1 = await fetch(`${BASE}/docs?p=seqtest:event&since=0&c=3`,{headers:H}).then(r=>r.json())
ok('a page reports more:true when the server caps it', p1.rows.length===3 && p1.more===true, JSON.stringify({n:p1.rows.length,cursor:p1.cursor,more:p1.more}))
const p2 = await fetch(`${BASE}/docs?p=seqtest:event&since=${p1.cursor}&c=3`,{headers:H}).then(r=>r.json())
ok('resuming from the cursor continues without overlap or gap',
   p2.rows[0]._seq===p1.cursor+1, `${p1.cursor} → ${p2.rows.map(r=>r._seq).join(',')}`)
const tail = await fetch(`${BASE}/docs?p=seqtest:event&since=8&c=3`,{headers:H}).then(r=>r.json())
ok('caught up: empty page, more:false, cursor held', tail.rows.length===0&&tail.more===false&&tail.cursor===8, JSON.stringify(tail))

// a new write is picked up from the held cursor
await fetch(`${BASE}/doc`,{method:'POST',headers:H,body:JSON.stringify({p:'seqtest:event/e9',data:{id:'e9',kind:'tagged'}})})
const after = await fetch(`${BASE}/docs?p=seqtest:event&since=8&c=3`,{headers:H}).then(r=>r.json())
ok('a later write appears at the held cursor', after.rows.length===1&&after.rows[0]._seq===9, JSON.stringify(after.rows.map(r=>r._seq)))

// a no-op must not burn a sequence number
const same = await fetch(`${BASE}/doc`,{method:'PUT',headers:H,body:JSON.stringify({p:'seqtest:event/e9',data:{id:'e9',kind:'tagged'}})})
const afterNoop = await fetch(`${BASE}/docs?p=seqtest:event&since=9&c=3`,{headers:H}).then(r=>r.json())
// (This check used to be a tautology — `c ? x : x` — so a wrong status,
// e.g. 409 on an identical re-PUT to an immutable collection, still passed.)
const sameBody = await same.text().catch(()=>'')
ok('an unchanged PUT answers 200 unchanged — a no-op, not a refusal',
   same.status===200 && /unchanged/.test(sameBody), `${same.status} ${sameBody.slice(0,60)}`)
ok('and burns no sequence', afterNoop.rows.length===0, `rows after=${afterNoop.rows.length}`)

// RACE (#1184): concurrent creates of ONE id on an immutable, sequenced
// collection. /doc used to read existence outside its commit, so several
// creates could all see "missing" and all commit — the later ones
// re-sequencing the earlier. Now exactly one lands, once, at one _seq.
const racers = await Promise.all([1,2,3,4,5].map(i =>
  fetch(`${BASE}/doc`,{method:'POST',headers:H,
    body:JSON.stringify({p:'seqtest:event/race',data:{id:'race',kind:`attempt-${i}`}})})))
const raceStatuses = racers.map(r=>r.status)
ok('concurrent creates of one id: exactly ONE succeeds',
   raceStatuses.filter(s=>s===200).length===1, raceStatuses.join(','))
ok('the others are refused, not silently overwritten',
   raceStatuses.filter(s=>s!==200).every(s=>s===403||s===409), raceStatuses.join(','))
const raceRows = (await fetch(`${BASE}/docs?p=seqtest:event&since=0&c=50`,{headers:H}).then(r=>r.json())).rows.filter(r=>r.id==='race')
ok('the raced document appears ONCE, at one sequence number', raceRows.length===1, JSON.stringify(raceRows.map(r=>r._seq)))
const rewrite = await fetch(`${BASE}/doc`,{method:'PUT',headers:H,
  body:JSON.stringify({p:'seqtest:event/race',data:{id:'race',kind:'rewritten'}})})
ok('a changed rewrite of an immutable event is refused (409)', rewrite.status===409, String(rewrite.status))

// an unsequenced collection says so rather than returning nothing
const un = await fetch(`${BASE}/docs?p=post&since=0&c=5`,{headers:H})
ok('an unsequenced collection is a clear error, not an empty page',
   un.status===400 && /not-sequenced/.test(await un.text()), String(un.status))

await fetch(`${BASE}/install?name=seqtest`,{method:'DELETE',headers:H})
for (let i=1;i<=12;i++) await fsq('DELETE',`seqtest%3Aevent/e${i}`)
await fsq('DELETE','seqtest%3Aevent/race')
await fsq('DELETE','system%3Aseq/seqtest%3Aevent')
console.log(fails ? `\n${fails} of ${n} FAILED\n` : `\nall ${n} checks passed\n`)
process.exit(fails ? 1 : 0)
