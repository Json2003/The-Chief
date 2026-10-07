// The Chief is the headless, independently restartable owner of the local
// orchestration backend. Its private status port is also its singleton lock.
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {connect} from 'node:net';
import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readChiefRuntimePreference} from './chief-runtime-preference.mjs';
import {chiefRecoveryDecision} from './the-chief-policy.mjs';
import {ROUTES,consoleKeyFile,createGate,ensureIntakeKey,forwardToConsole,handleGateway,intakeKeyFile,readKey} from './chief-gateway.mjs';

const root=resolve(process.env.CHIEF_WORKDIR||fileURLToPath(new URL('..',import.meta.url)));
const backend=resolve(process.env.CHIEF_BACKEND_PATH||resolve(root,'apps/administration-console/server.mjs'));
const preferenceFile=resolve(root,'infrastructure/local-state/chief-runtime-preference.json');
const chiefPort=4175,backendPort=4173;
const node=process.execPath;
let child=null,failures=0,restarts=0,lastAction='starting',lastError=null,lastStart=null;
let checking=false,stopping=false;

function portOccupied(port){
  return new Promise(done=>{
    const socket=connect({host:'127.0.0.1',port});let settled=false;
    const finish=value=>{if(settled)return;settled=true;socket.destroy();done(value);};
    socket.setTimeout(1500,()=>finish(true));
    socket.once('connect',()=>finish(true));
    socket.once('error',error=>finish(error.code!=='ECONNREFUSED'));
  });
}

async function backendHealthy(){
  try{
    const response=await fetch(`http://127.0.0.1:${backendPort}/api/runtime-control`,{signal:AbortSignal.timeout(4000)});
    const body=await response.json();
    return response.ok&&body.ok===true;
  }catch{return false;}
}

async function check(){
  if(checking||stopping)return;
  checking=true;
  try{
    const healthy=await backendHealthy();
    if(healthy){failures=0;lastAction='healthy';lastError=null;return;}
    failures+=1;
    const occupied=await portOccupied(backendPort);
    // A process we launched may still be doing startup or useful work. Never
    // create a duplicate writer while it is alive, even if HTTP is not ready.
    const booting=Boolean(child&&child.exitCode===null);
    const decision=chiefRecoveryDecision({healthy,listenerPresent:occupied,booting,failures});
    lastAction=decision;
    if(decision!=='start')return;
    if(!existsSync(backend)){lastError='backend-missing';return;}
    const preference=await readChiefRuntimePreference(preferenceFile);
    // No console window or chat process is required. Preserve an intentional
    // pause on first boot and the operator's last explicit choice thereafter.
    child=spawn(node,[backend],{cwd:root,detached:true,windowsHide:true,stdio:'ignore',env:{...process.env,CHEVERTON_START_PAUSED:String(preference==='drain'),CHEVERTON_CHIEF_MANAGED:'true'}});
    child.on('error',()=>{lastError='backend-launch-failed';});
    child.unref();
    lastStart=Date.now();restarts+=1;failures=0;lastAction='backend-started';
  }catch{lastError='chief-check-failed';}
  finally{checking=false;}
}

// Front door for task inputs and pause/resume. The Chief reads the console key
// at request time and never logs or returns it. If the intake key cannot be
// created, the gateway stays closed (authorize fails) and supervision continues.
let uiHtml=null;
try{uiHtml=readFileSync(new URL('./chief-ui.html',import.meta.url),'utf8');}catch{}
let intakeKey=null;
try{intakeKey=ensureIntakeKey(intakeKeyFile());}catch{lastError='intake-key-unavailable';}
const gate=createGate({maxInFlight:Number(process.env.CHIEF_MAX_IN_FLIGHT)||6});
const gateway={intakeKey,gate,port:chiefPort,consolePort:backendPort,
  // Repeated console failures stop new work. Resuming needs an explicit acknowledgement.
  onTrip:async()=>{
    try{
      const key=readKey(consoleKeyFile());
      if(key)await forwardToConsole({route:ROUTES['POST /control/drain'],consoleKey:key,port:backendPort});
      lastAction='breaker-drained';
    }catch{lastError='breaker-drain-failed';}
  }};

const service=createServer(async(request,response)=>{
  try{if(await handleGateway(request,response,gateway))return;}
  catch{if(!response.headersSent){response.writeHead(500);}response.end();return;}
  // The page holds no secrets; every call it makes still needs the intake key.
  if(request.method==='GET'&&['/','/ui'].includes(request.url)){
    if(![`127.0.0.1:${chiefPort}`,`localhost:${chiefPort}`].includes(request.headers.host)||!uiHtml){response.writeHead(404);response.end();return;}
    response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Frame-Options':'DENY','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"});
    response.end(uiHtml);return;
  }
  if(request.method!=='GET'||!['/health','/status'].includes(request.url)){
    response.writeHead(404);response.end();return;
  }
  response.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
  response.end(JSON.stringify({ok:true,name:'The Chief',pid:process.pid,backendPid:child?.exitCode===null?child.pid:null,action:lastAction,restarts,lastError,intake:{ready:Boolean(intakeKey),...gate.state},startedAt:new Date(startedAt).toISOString()}));
});
const startedAt=Date.now();
service.on('error',error=>{console.error(`The Chief could not bind its private port: ${error.code}`);process.exitCode=1;});
service.listen(chiefPort,'127.0.0.1',()=>{
  // Existing backend may be between process creation and HTTP bind.
  setTimeout(()=>{void check();},5000).unref();
  setInterval(()=>{void check();},10_000);
});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{
  stopping=true;service.close(()=>process.exit(0));
  // The backend is intentionally left running: it owns active work and can
  // be re-adopted by a restarted Chief without an interrupted task.
});
