// The Chief is the headless, independently restartable owner of the local
// orchestration backend. Its private status port is also its singleton lock.
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {connect} from 'node:net';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readChiefRuntimePreference} from './chief-runtime-preference.mjs';
import {chiefRecoveryDecision} from './the-chief-policy.mjs';

export function createChief({
  root=resolve(process.env.CHIEF_WORKDIR||fileURLToPath(new URL('..',import.meta.url))),
  backend=resolve(process.env.CHIEF_BACKEND_PATH||resolve(root,'apps/administration-console/server.mjs')),
  chiefPort=4175,backendPort=4173,node=process.execPath,
  initialDelay=5000,interval=10_000,healthTimeout=4000,portTimeout=1500,
}={}){
const preferenceFile=resolve(root,'infrastructure/local-state/chief-runtime-preference.json');
let initialTimer,intervalTimer;
const childAlive=()=>Boolean(child&&child.exitCode===null&&child.signalCode===null);
let child=null,failures=0,restarts=0,lastAction='starting',lastError=null,lastStart=null;
let checking=false,stopping=false;

function portOccupied(port){
  return new Promise(done=>{
    const socket=connect({host:'127.0.0.1',port});let settled=false;
    const finish=value=>{if(settled)return;settled=true;socket.destroy();done(value);};
    socket.setTimeout(portTimeout,()=>finish(true));
    socket.once('connect',()=>finish(true));
    socket.once('error',error=>finish(error.code!=='ECONNREFUSED'));
  });
}

async function backendHealthy(){
  try{
    const response=await fetch(`http://127.0.0.1:${backendPort}/api/runtime-control`,{signal:AbortSignal.timeout(healthTimeout)});
    const body=await response.json();
    return response.ok&&body.ok===true;
  }catch{return false;}
}

async function check(){
  if(checking||stopping)return;
  checking=true;
  try{
    const healthy=await backendHealthy();
    if(stopping)return;
    if(healthy){failures=0;lastAction='healthy';lastError=null;return;}
    failures+=1;
    const occupied=await portOccupied(backendPort);
    // A process we launched may still be doing startup or useful work. Never
    // create a duplicate writer while it is alive, even if HTTP is not ready.
    if(stopping)return;
    const booting=childAlive();
    const decision=chiefRecoveryDecision({healthy,listenerPresent:occupied,booting,failures});
    lastAction=decision;
    if(decision!=='start')return;
    if(!existsSync(backend)){lastError='backend-missing';return;}
    const preference=await readChiefRuntimePreference(preferenceFile);
    if(stopping)return;
    // No console window or chat process is required. Preserve an intentional
    // pause on first boot and the operator's last explicit choice thereafter.
    child=spawn(node,[backend],{cwd:root,detached:true,windowsHide:true,stdio:'ignore',env:{...process.env,CHEVERTON_START_PAUSED:String(preference==='drain'),CHEVERTON_CHIEF_MANAGED:'true'}});
    const launched=child;
    launched.on('error',()=>{
      if(child===launched)child=null;
      lastError='backend-launch-failed';lastAction='backend-launch-failed';
    });
    launched.once('spawn',()=>{
      lastStart=Date.now();restarts+=1;failures=0;lastAction='backend-started';lastError=null;
    });
    launched.unref();
  }catch{lastError='chief-check-failed';}
  finally{checking=false;}
}

const service=createServer((request,response)=>{
  if(request.method!=='GET'||!['/health','/status'].includes(request.url)){
    response.writeHead(404);response.end();return;
  }
  response.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
  response.end(JSON.stringify({ok:true,name:'The Chief',pid:process.pid,backendPid:childAlive()?child.pid:null,action:lastAction,restarts,failures,lastError,lastStart,startedAt:new Date(startedAt).toISOString()}));
});
const startedAt=Date.now();
async function start(){
  await new Promise((accept,reject)=>{
    service.once('error',reject);
    service.listen(chiefPort,'127.0.0.1',()=>{service.removeListener('error',reject);accept();});
  });
  initialTimer=setTimeout(()=>{void check();},initialDelay);
  intervalTimer=setInterval(()=>{void check();},interval);
  return service.address();
}
async function stop(){
  stopping=true;clearTimeout(initialTimer);clearInterval(intervalTimer);
  // Leave the backend running; it owns active work. No queue mutations.
  await new Promise(done=>service.close(done));
}
return {start,stop,check};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const chief=createChief();
  chief.start().catch(error=>{
    console.error(`The Chief could not bind its private port: ${error.code}`);process.exitCode=1;
  });
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{void chief.stop().then(()=>process.exit(0));});
}
