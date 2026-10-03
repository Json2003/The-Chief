import {mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';

export async function readChiefRuntimePreference(file){
  try{
    const saved=JSON.parse(await readFile(file,'utf8'));
    return saved.action==='resume'?'resume':'drain';
  }catch{return 'drain';}
}

export async function saveChiefRuntimePreference(file,action){
  if(!['drain','resume'].includes(action))throw new Error('Choose drain or resume.');
  await mkdir(dirname(file),{recursive:true});
  const temporary=`${file}.${process.pid}.tmp`;
  await writeFile(temporary,JSON.stringify({action,at:new Date().toISOString()})+'\n','utf8');
  await rename(temporary,file);
}
