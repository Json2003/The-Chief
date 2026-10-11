import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,readFile,rm,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createChief} from '../the-chief.mjs';
import {saveChiefRuntimePreference} from '../chief-runtime-preference.mjs';

async function listen(server){server.listen(0,'127.0.0.1');await once(server,'listening');return server.address().port;}
async function until(fn){for(let i=0;i<200;i++){if(await fn())return;await delay(25);}throw Error('condition timed out');}
async function fixture(t,options={}){
  const root=await mkdtemp(join(tmpdir(),'chief-integration-'));
  const probe=createServer();const backendPort=await listen(probe);await new Promise(r=>probe.close(r));
  const log=join(root,'starts.jsonl'),preference=join(root,'infrastructure/local-state/chief-runtime-preference.json');
  const previous={...process.env};
  Object.assign(process.env,{CHIEF_TEST_LOG:log,CHIEF_TEST_PORT:String(backendPort),CHIEF_TEST_MODE:options.mode||'healthy'});
  let chiefs=[];
  const make=(extra={})=>{const c=createChief({root,backend:resolve('tests/fixtures/backend.mjs'),backendPort,chiefPort:0,initialDelay:1e8,interval:1e8,healthTimeout:50,...extra});chiefs.push(c);return c;};
  const records=async()=>{try{return (await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(e){if(e.code==='ENOENT')return [];throw e;}};
  t.after(async()=>{
    for(const c of chiefs)await c.stop();
    for(const {pid} of await records()){try{process.kill(pid,'SIGKILL');}catch{}}
    for(const k of ['CHIEF_TEST_LOG','CHIEF_TEST_PORT','CHIEF_TEST_MODE']){if(previous[k]===undefined)delete process.env[k];else process.env[k]=previous[k];}
    await delay(50);await rm(root,{recursive:true,force:true});
  });
  const chief=make();const addr=await chief.start();
  const status=async()=>await (await fetch(`http://127.0.0.1:${addr.port}/status`)).json();
  const fail3=async(c=chief)=>{for(let i=0;i<3;i++)await c.check();};
  return {root,backendPort,chief,make,records,preference,status,fail3,addr};
}

test('real startup waits for three failures, passes pause, and recovers a killed backend',{timeout:15000},async t=>{
  const f=await fixture(t);
  await f.chief.check();await f.chief.check();assert.equal((await f.records()).length,0);
  await f.chief.check();await until(async()=> (await f.records()).length===1);
  const first=(await f.records())[0];assert.equal(first.paused,'true');assert.equal(first.managed,'true');
  await until(async()=>{await f.chief.check();return (await f.status()).action==='healthy';});
  assert.equal((await f.status()).failures,0);
  process.kill(first.pid,'SIGKILL');await until(async()=> (await f.status()).backendPid===null);
  await f.fail3();await until(async()=> (await f.records()).length===2);
  assert.equal((await f.records())[1].paused,'true');
});

test('live child before HTTP bind prevents duplicate launches and overlapping checks',{timeout:15000},async t=>{
  const f=await fixture(t,{mode:'booting'});await f.fail3();await until(async()=> (await f.records()).length===1);
  for(let i=0;i<5;i++)await Promise.all([f.chief.check(),f.chief.check()]);
  assert.equal((await f.records()).length,1);assert.equal((await f.status()).action,'starting');
});

for(const kind of ['healthy','http-error','malformed','hang'])test(`occupied ${kind} backend is never replaced`,{timeout:15000},async t=>{
  const f=await fixture(t);const server=createServer((req,res)=>{
    if(kind==='hang')return;
    res.statusCode=kind==='http-error'?503:200;res.end(kind==='malformed'?'bad':JSON.stringify({ok:true}));
  });
  await new Promise(r=>server.listen(f.backendPort,'127.0.0.1',r));
  t.after(()=>{server.closeAllConnections();server.close();});
  for(let i=0;i<5;i++)await f.chief.check();
  assert.equal((await f.records()).length,0);
  assert.equal((await f.status()).action,kind==='healthy'?'healthy':'occupied-preserve');
});

test('singleton listener rejects a second supervisor and exposes no mutation API',async t=>{
  const f=await fixture(t);const second=f.make({chiefPort:f.addr.port});
  await assert.rejects(second.start(),{code:'EADDRINUSE'});
  const response=await fetch(`http://127.0.0.1:${f.addr.port}/status`,{method:'POST'});assert.equal(response.status,404);
  assert.equal((await f.status()).restarts,0);
});

test('missing backend and OS spawn error are explicit and retryable',async t=>{
  const f=await fixture(t);const missing=f.make({backend:join(f.root,'missing.mjs')});const missingAddr=await missing.start();await f.fail3(missing);
  assert.equal((await (await fetch(`http://127.0.0.1:${missingAddr.port}/status`)).json()).lastError,'backend-missing');
  const broken=f.make({node:join(f.root,'missing-node')});const addr=await broken.start();await f.fail3(broken);
  const status=async()=>await (await fetch(`http://127.0.0.1:${addr.port}/status`)).json();
  await until(async()=> (await status()).lastError==='backend-launch-failed');
  assert.equal((await status()).restarts,0);assert.equal((await status()).backendPid,null);
  await broken.check();await delay(25);assert.equal((await status()).lastError,'backend-launch-failed');
  assert.equal((await f.records()).length,0);
});

for(const saved of ['resume','drain','malformed','invalid'])test(`persisted ${saved} preference is replayed on recovery and supervisor restart`,{timeout:15000},async t=>{
  const f=await fixture(t,{mode:'crash'});
  if(['resume','drain'].includes(saved))await saveChiefRuntimePreference(f.preference,saved);
  else {await mkdir(join(f.root,'infrastructure/local-state'),{recursive:true});await writeFile(f.preference,saved==='malformed'?'broken':'{"action":"unknown"}');}
  const original=await readFile(f.preference,'utf8');
  await f.fail3();await until(async()=> (await f.records()).length===1);
  await until(async()=> (await f.status()).backendPid===null);
  await f.chief.stop();const next=f.make();await next.start();await f.fail3(next);
  await until(async()=> (await f.records()).length===2);
  for(const row of await f.records())assert.equal(row.paused,String(saved!=='resume'));
  assert.equal(await readFile(f.preference,'utf8'),original);
});


test('stopping preserves backend and a new supervisor adopts it without resuming',async t=>{
  const f=await fixture(t);await f.fail3();await until(async()=> (await f.records()).length===1);
  await until(async()=>{await f.chief.check();return (await f.status()).action==='healthy';});
  await f.chief.stop();
  assert.equal((await (await fetch(`http://127.0.0.1:${f.backendPort}/api/runtime-control`)).json()).paused,true);
  const next=f.make();await next.start();await f.fail3(next);assert.equal((await f.records()).length,1);
});

test('newly saved drain overrides an earlier resume on the next recovery',async t=>{
  const f=await fixture(t,{mode:'crash'});await saveChiefRuntimePreference(f.preference,'resume');await f.fail3();
  await until(async()=> (await f.records()).length===1);await until(async()=> (await f.status()).backendPid===null);
  await saveChiefRuntimePreference(f.preference,'drain');await f.fail3();await until(async()=> (await f.records()).length===2);
  assert.deepEqual((await f.records()).map(r=>r.paused),['false','true']);
});

test('scheduled checks start a fixture; stopped supervisors do not recover',async t=>{
  const f=await fixture(t);const timed=f.make({initialDelay:0,interval:50});await timed.start();
  await until(async()=> (await f.records()).length===1);
  await timed.stop();
  const blocked=f.make();await blocked.start();await blocked.stop();await f.fail3(blocked);
  assert.equal((await f.records()).length,1);
});


test('stopping while health fetch is pending suppresses subsequent recovery',async t=>{
  const f=await fixture(t);const server=createServer(()=>{});
  await new Promise(r=>server.listen(f.backendPort,'127.0.0.1',r));
  t.after(()=>{server.closeAllConnections();server.close();});
  await f.chief.check();await f.chief.check();
  const pending=f.chief.check();await f.chief.stop();server.closeAllConnections();await new Promise(r=>server.close(r));await pending;
  assert.equal((await f.records()).length,0);
});
