import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chiefRecoveryDecision} from '../the-chief-policy.mjs';
import {readChiefRuntimePreference,saveChiefRuntimePreference} from '../chief-runtime-preference.mjs';

test('healthy, occupied, and booting backends are preserved',()=>{
  assert.equal(chiefRecoveryDecision({healthy:true,failures:9}),'healthy');
  assert.equal(chiefRecoveryDecision({listenerPresent:true,failures:9}),'occupied-preserve');
  assert.equal(chiefRecoveryDecision({booting:true,failures:9}),'starting');
  assert.equal(chiefRecoveryDecision({failures:2}),'wait');
  assert.equal(chiefRecoveryDecision({failures:3}),'start');
});

test('operator pause state survives process restart',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'chief-test-'));
  const file=join(directory,'preference.json');
  try{
    assert.equal(await readChiefRuntimePreference(file),'drain');
    await saveChiefRuntimePreference(file,'resume');
    assert.equal(await readChiefRuntimePreference(file),'resume');
    await saveChiefRuntimePreference(file,'drain');
    assert.equal(JSON.parse(await readFile(file,'utf8')).action,'drain');
    await assert.rejects(saveChiefRuntimePreference(file,'invalid'));
  }finally{await rm(directory,{recursive:true,force:true});}
});
