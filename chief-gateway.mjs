// The Chief's local intake and control gateway. It is the single front door for
// task inputs and pause/resume, and it holds the console key so callers never do.
// It forwards only the routes listed in ROUTES. Approvals, external actions,
// vault, email, payments and settings are deliberately not reachable here.
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';

export const INTAKE_HEADER='x-chief-intake-key';
export const CONSOLE_KEY_HEADER='x-cheverton-console-key';
const KEY_PATTERN=/^[A-Za-z0-9_-]{43}$/;

// Chief route -> console route. Anything not listed is a 404 from The Chief.
export const ROUTES=Object.freeze({
  'POST /intake/command':Object.freeze({method:'POST',target:'/api/command',limit:8192,work:true}),
  'POST /intake/chat':Object.freeze({method:'POST',target:'/api/chat',limit:96000,work:true}),
  'POST /control/drain':Object.freeze({method:'POST',target:'/api/runtime-control',limit:256,action:'drain'}),
  'POST /control/resume':Object.freeze({method:'POST',target:'/api/runtime-control',limit:256,action:'resume'}),
  'GET /console/status':Object.freeze({method:'GET',target:'/api/runtime-control'})
});

export function consoleKeyFile(env=process.env){
  if(env.CHEVERTON_CONSOLE_KEY_FILE)return env.CHEVERTON_CONSOLE_KEY_FILE;
  const base=env.LOCALAPPDATA||join(env.USERPROFILE||env.HOME||'.','AppData','Local');
  return join(base,'Cheverton','console','session.key');
}
// Same owner-only folder as the console key, so it inherits that folder's access rules.
export const intakeKeyFile=(env=process.env)=>env.CHIEF_INTAKE_KEY_FILE||join(dirname(consoleKeyFile(env)),'chief-intake.key');

export function readKey(file){
  try{const key=readFileSync(file,'utf8').trim();return KEY_PATTERN.test(key)?key:null;}catch{return null;}
}
export function ensureIntakeKey(file){
  const existing=readKey(file);
  if(existing)return existing;
  mkdirSync(dirname(file),{recursive:true});
  const key=randomBytes(32).toString('base64url');
  writeFileSync(file,key,{encoding:'utf8',mode:0o600});
  return key;
}

// Loopback host only, no foreign browser origins (blocks CSRF and DNS rebinding),
// and the intake key. The Chief's own page may call it (same origin).
export function authorize(headers,intakeKey,port=4175){
  const hosts=[`127.0.0.1:${port}`,`localhost:${port}`];
  if(!hosts.includes(headers.host))return false;
  if(headers.origin&&!hosts.some(host=>headers.origin===`http://${host}`))return false;
  if(headers['sec-fetch-site']==='cross-site')return false;
  const given=headers[INTAKE_HEADER];
  if(typeof given!=='string'||typeof intakeKey!=='string'||!KEY_PATTERN.test(intakeKey))return false;
  const a=Buffer.from(given),b=Buffer.from(intakeKey);
  return a.length===b.length&&timingSafeEqual(a,b);
}

// Hard cap on concurrent forwarded work, plus a breaker that stops intake after
// repeated console failures. A tripped breaker needs an explicit acknowledgement to resume.
export function createGate({maxInFlight=6,breakerThreshold=5}={}){
  let inFlight=0,failures=0,tripped=false;
  return {
    get state(){return {inFlight,failures,tripped,maxInFlight};},
    enter(){
      if(tripped)return {ok:false,code:'breaker-tripped'};
      if(inFlight>=maxInFlight)return {ok:false,code:'at-capacity'};
      inFlight+=1;let done=false;
      return {ok:true,leave(success){
        if(done)return false;
        done=true;inFlight-=1;
        if(success){failures=0;return false;}
        failures+=1;
        if(failures>=breakerThreshold&&!tripped){tripped=true;return true;}
        return false;
      }};
    },
    reset(){failures=0;tripped=false;}
  };
}

export async function forwardToConsole({route,body,consoleKey,fetchImpl=fetch,port=4173,timeoutMs=60000}){
  const init={method:route.method,headers:{[CONSOLE_KEY_HEADER]:consoleKey||'','content-type':'application/json'},signal:AbortSignal.timeout(timeoutMs)};
  if(route.method==='POST')init.body=route.action?JSON.stringify({action:route.action}):body;
  const response=await fetchImpl(`http://127.0.0.1:${port}${route.target}`,init);
  return {status:response.status,text:await response.text()};
}

const isFailure=status=>status>=500&&status!==503;

export async function handleGateway(request,response,options){
  const {intakeKey,gate,fetchImpl=fetch,onTrip=()=>{},port=4175,consolePort=4173,consoleKeyPath=consoleKeyFile()}=options;
  const route=ROUTES[`${request.method} ${request.url}`];
  if(!route)return false;
  const send=(status,payload)=>{response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});response.end(typeof payload==='string'?payload:JSON.stringify(payload));};
  if(!authorize(request.headers,intakeKey,port)){send(401,{ok:false,code:'unauthorized'});return true;}

  let body='',parsed={};
  if(route.method==='POST'){
    try{
      for await(const chunk of request){body+=chunk;if(Buffer.byteLength(body)>route.limit)throw Error('too-large');}
      parsed=JSON.parse(body||'{}');
      if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('invalid-json');
    }catch(error){
      const tooLarge=error.message==='too-large';
      send(tooLarge?413:400,{ok:false,code:tooLarge?'too-large':'invalid-json'});return true;
    }
  }
  const consoleKey=readKey(consoleKeyPath);
  if(route.method==='POST'&&!consoleKey){send(503,{ok:false,code:'console-key-unavailable'});return true;}

  if(route.action==='resume'&&gate.state.tripped&&parsed.acknowledgeBreaker!==true){
    send(409,{ok:false,code:'breaker-tripped',message:'Intake stopped after repeated console failures. Resend with {"acknowledgeBreaker":true} once the cause is fixed.'});return true;
  }

  // Pause and status are never limited by capacity: stopping must always work.
  let slot=null;
  if(route.work){
    slot=gate.enter();
    if(!slot.ok){send(slot.code==='at-capacity'?429:503,{ok:false,code:slot.code,...gate.state});return true;}
  }
  try{
    const result=await forwardToConsole({route,body,consoleKey,fetchImpl,port:consolePort});
    if(route.action==='resume'&&result.status===200)gate.reset();
    if(slot&&slot.leave(!isFailure(result.status)))void onTrip();
    send(result.status,result.text||'{}');
  }catch{
    if(slot&&slot.leave(false))void onTrip();
    send(502,{ok:false,code:'console-unreachable'});
  }
  return true;
}
