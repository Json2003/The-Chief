import {createServer} from 'node:http';
import {appendFileSync} from 'node:fs';
appendFileSync(process.env.CHIEF_TEST_LOG,JSON.stringify({pid:process.pid,paused:process.env.CHEVERTON_START_PAUSED,managed:process.env.CHEVERTON_CHIEF_MANAGED})+'\n');
if(process.env.CHIEF_TEST_MODE==='crash')process.exit(1);
if(process.env.CHIEF_TEST_MODE==='booting')setInterval(()=>{},1000);
else createServer((req,res)=>{
  res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify({ok:true,paused:process.env.CHEVERTON_START_PAUSED==='true'}));
}).listen(Number(process.env.CHIEF_TEST_PORT),'127.0.0.1');
