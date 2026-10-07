import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {INTAKE_HEADER,ROUTES,parseAllowedHosts,authorize,createGate,ensureIntakeKey,handleGateway,readKey} from '../chief-gateway.mjs';

const CONSOLE_KEY='c'.repeat(43);

test('only intake, pause/resume and status are reachable',()=>{
  assert.deepEqual(Object.keys(ROUTES).sort(),['GET /console/status','POST /control/drain','POST /control/resume','POST /intake/chat','POST /intake/command']);
  const targets=new Set(Object.values(ROUTES).map(route=>route.target));
  assert.deepEqual([...targets].sort(),['/api/chat','/api/command','/api/runtime-control']);
  for(const route of Object.values(ROUTES))assert.ok(!/approv|vault|email|payment|stripe|gmail|sms|settings/.test(route.target));
});

test('authorize needs loopback host, no foreign origin and the intake key',()=>{
  const key='k'.repeat(43);
  const good={host:'127.0.0.1:4175',[INTAKE_HEADER]:key};
  assert.equal(authorize(good,key),true);
  assert.equal(authorize({...good,host:'evil.example:4175'},key),false);
  assert.equal(authorize({...good,origin:'http://127.0.0.1:4175'},key),true);
  assert.equal(authorize({...good,origin:'http://evil.example'},key),false);
  assert.equal(authorize({...good,origin:'http://127.0.0.1:9999'},key),false);
  assert.equal(authorize({...good,'sec-fetch-site':'cross-site'},key),false);
  assert.equal(authorize({host:good.host},key),false);
  assert.equal(authorize({...good,[INTAKE_HEADER]:'x'.repeat(43)},key),false);
  assert.equal(authorize(good,null),false);
});

test('gate caps in-flight work and trips its breaker',()=>{
  const gate=createGate({maxInFlight:2,breakerThreshold:2});
  const a=gate.enter(),b=gate.enter();
  assert.equal(gate.enter().code,'at-capacity');
  assert.equal(a.leave(true),false);
  assert.equal(b.leave(false),false);
  const c=gate.enter();
  assert.equal(c.leave(false),true);
  assert.equal(gate.enter().code,'breaker-tripped');
  gate.reset();
  assert.equal(gate.enter().ok,true);
});

test('intake key is created once and never overwritten',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'chief-key-'));
  try{
    const file=join(directory,'nested','chief-intake.key');
    const first=ensureIntakeKey(file);
    assert.match(first,/^[A-Za-z0-9_-]{43}$/);
    assert.equal(ensureIntakeKey(file),first);
    assert.equal(readKey(file),first);
  }finally{await rm(directory,{recursive:true,force:true});}
});

async function withGateway(run,{status=200,failBody=false}={}){
  const directory=await mkdtemp(join(tmpdir(),'chief-gw-'));
  const consoleKeyPath=join(directory,'session.key');
  await writeFile(consoleKeyPath,CONSOLE_KEY);
  const intakeKey='i'.repeat(43);
  const calls=[],gate=createGate({maxInFlight:2,breakerThreshold:2});
  let trips=0;
  const fetchImpl=async(url,init)=>{
    calls.push({url,method:init.method,key:init.headers['x-cheverton-console-key'],body:init.body});
    if(failBody)throw Error('down');
    return {status,text:async()=>JSON.stringify({ok:status<400})};
  };
  const server=createServer((request,response)=>{
    handleGateway(request,response,{intakeKey,gate,fetchImpl,consoleKeyPath,port:server.address().port,onTrip:()=>{trips+=1;}})
      .then(handled=>{if(!handled){response.writeHead(404);response.end();}});
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const port=server.address().port;
  const call=(path,{method='POST',body='{}',key=intakeKey,headers={}}={})=>fetch(`http://127.0.0.1:${port}${path}`,{method,body:method==='POST'?body:undefined,headers:{[INTAKE_HEADER]:key,'content-type':'application/json',...headers}});
  try{await run({call,calls,gate,trips:()=>trips});}
  finally{await new Promise(done=>server.close(done));await rm(directory,{recursive:true,force:true});}
}

test('authorized intake is forwarded with the console key',()=>withGateway(async({call,calls})=>{
  const response=await call('/intake/command',{body:JSON.stringify({text:'summarize the queue'})});
  assert.equal(response.status,200);
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,'http://127.0.0.1:4173/api/command');
  assert.equal(calls[0].key,CONSOLE_KEY);
  assert.equal(JSON.parse(calls[0].body).text,'summarize the queue');
}));

test('missing or wrong intake key is refused and nothing is forwarded',()=>withGateway(async({call,calls})=>{
  assert.equal((await call('/intake/command',{key:'z'.repeat(43)})).status,401);
  assert.equal((await call('/control/resume',{key:'z'.repeat(43)})).status,401);
  assert.equal((await call('/intake/command',{headers:{origin:'http://evil.example'}})).status,401);
  assert.equal(calls.length,0);
}));

test('unlisted console routes return 404 and are never forwarded',()=>withGateway(async({call,calls})=>{
  for(const path of ['/api/task-approvals','/api/vault/status','/api/email/gmail/connect','/api/approvals/sms/request'])assert.equal((await call(path)).status,404);
  assert.equal(calls.length,0);
}));

test('oversized and malformed bodies are rejected before forwarding',()=>withGateway(async({call,calls})=>{
  assert.equal((await call('/intake/command',{body:JSON.stringify({text:'x'.repeat(9000)})})).status,413);
  assert.equal((await call('/intake/command',{body:'not json'})).status,400);
  assert.equal((await call('/intake/command',{body:'[1]'})).status,400);
  assert.equal(calls.length,0);
}));

test('pause and resume send only a fixed action',()=>withGateway(async({call,calls})=>{
  await call('/control/drain',{body:JSON.stringify({action:'resume',extra:'ignored'})});
  await call('/control/resume');
  assert.deepEqual(calls.map(c=>JSON.parse(c.body)),[{action:'drain'},{action:'resume'}]);
  assert.equal(calls[0].url,'http://127.0.0.1:4173/api/runtime-control');
}));

test('console failures trip the breaker, auto-drain, and resume needs acknowledgement',()=>withGateway(async({call,calls,gate,trips})=>{
  assert.equal((await call('/intake/command')).status,502);
  assert.equal((await call('/intake/command')).status,502);
  assert.equal(trips(),1);
  assert.equal(gate.state.tripped,true);
  assert.equal((await call('/intake/command')).status,503);
  assert.equal((await call('/control/resume')).status,409);
  assert.equal(calls.length,2);
},{failBody:true}));

test('acknowledged resume clears the breaker',()=>withGateway(async({call,gate})=>{
  gate.enter().leave(false);gate.enter().leave(false);
  assert.equal(gate.state.tripped,true);
  const response=await call('/control/resume',{body:JSON.stringify({acknowledgeBreaker:true})});
  assert.equal(response.status,200);
  assert.equal(gate.state.tripped,false);
}));

test('status route is read-only and uses no body',()=>withGateway(async({call,calls})=>{
  const response=await call('/console/status',{method:'GET'});
  assert.equal(response.status,200);
  assert.equal(calls[0].method,'GET');
  assert.equal(calls[0].body,undefined);
}));

test('the gateway source never logs or returns the console key',async()=>{
  const source=await readFile(new URL('../chief-gateway.mjs',import.meta.url),'utf8');
  assert.ok(!/console\.(log|error|warn)/.test(source));
});

test('remote hosts are exact names from the allowlist only',()=>{
  assert.deepEqual(parseAllowedHosts('chief.tail1234.ts.net, Phone.Example.com:8443'),['chief.tail1234.ts.net','phone.example.com:8443']);
  assert.deepEqual(parseAllowedHosts('*,localhost,10.0.0.5,evil,*.example.com,http://x.com'),[]);
  const key='k'.repeat(43),extra=['chief.tail1234.ts.net'];
  const remote={host:'chief.tail1234.ts.net',[INTAKE_HEADER]:key};
  assert.equal(authorize(remote,key,4175,extra),true);
  assert.equal(authorize({...remote,origin:'https://chief.tail1234.ts.net'},key,4175,extra),true);
  assert.equal(authorize({...remote,origin:'https://evil.example'},key,4175,extra),false);
  assert.equal(authorize(remote,key,4175,[]),false);
  assert.equal(authorize({...remote,host:'other.ts.net'},key,4175,extra),false);
  assert.equal(authorize({...remote,[INTAKE_HEADER]:'x'.repeat(43)},key,4175,extra),false);
});
