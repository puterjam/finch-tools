import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,realpath,mkdir,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixtureRm,fixtureLink} from './test-platform.mjs';
import {LibraryAvailability,probeLibrary} from '../dist/index.js';
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const record=(id)=>({id,root:`/fixture/${id}`,name:id});
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}

test('availability has distinct readable, offline, replaced-identity and symlink states without creating indexes',async t=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'knowledge-availability-')));t.after(()=>fixtureRm(root,{recursive:true,force:true}));
  const source=join(root,'source');await mkdir(source);const r={id:'a',root:source,name:'A'};
  assert.equal(await probeLibrary(r),'available');assert.equal(await stat(join(source,'.knowledge')).catch(()=>null),null);
  assert.equal(await probeLibrary({...r,root:join(root,'missing')}),'offline');
  assert.equal(await probeLibrary({...r,index:{kind:'source',dev:'999999',ino:'999999'}}),'unavailable');
  const alias=join(root,'alias');await fixtureLink(source,alias);assert.equal(await probeLibrary({...r,root:alias}),'unavailable');
  assert.equal(await probeLibrary({...r,index:{kind:'local',key:'a'.repeat(32)}}),'offline','a disconnected known share is not reported available merely because its mountpoint is a local directory');
});

test('probe deadlines do not become offline or release physical concurrency slots',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date']});const pending=[];let active=0,max=0;
  const monitor=new LibraryAvailability(()=>{}, {timeoutMs:2000,probe:async r=>{active++;max=Math.max(max,active);const gate=deferred();pending.push({id:r.id,...gate});try{return await gate.promise;}finally{active--;}}});t.after(()=>monitor.dispose());
  const records=['a','b','c'].map(record);monitor.refresh(records);await turn();assert.equal(pending.length,2);assert.equal(monitor.state(records[2]),'unknown');
  t.mock.timers.tick(2001);assert.equal(monitor.state(records[0]),'unavailable');assert.equal(monitor.state(records[1]),'unavailable');
  for(let i=0;i<10;i++)monitor.refresh(records,true);await turn();assert.equal(pending.length,2,'timed-out SMB I/O must not accumulate retries');assert.equal(max,2);
  pending[0].resolve('available');await turn();assert.equal(pending.length,3);assert.equal(monitor.state(records[2]),'checking');
  pending[1].resolve('offline');pending[2].resolve('available');await turn();assert.equal(max,2);assert.equal(monitor.state(records[1]),'offline');
});

test('removed/re-added identities reject old results and disposal rejects every late callback',async t=>{
  const probes=[],events=[];const monitor=new LibraryAvailability(rows=>events.push(rows),{probe:async()=>{const gate=deferred();probes.push(gate);return gate.promise;}});
  const a=record('a');monitor.refresh([a]);await turn();monitor.refresh([]);monitor.refresh([{...a,name:'Renamed'}]);await turn();assert.equal(probes.length,2);
  probes[0].resolve('available');await turn();assert.equal(monitor.state(a),'checking','old registration completion cannot overwrite a new registration');
  probes[1].resolve('offline');await turn();assert.equal(monitor.state(a),'offline');
  const before=events.length;monitor.dispose();monitor.refresh([record('b')]);await turn();assert.equal(events.length,before);
});

test('renaming uses the cached access state while changed roots require a new probe',async t=>{
  const gates=[];const monitor=new LibraryAvailability(()=>{}, {probe:async()=>{const gate=deferred();gates.push(gate);return gate.promise;}});t.after(()=>monitor.dispose());
  const a=record('a');monitor.refresh([a]);await turn();gates[0].resolve('available');await turn();monitor.refresh([{...a,name:'New name'}]);await turn();assert.equal(gates.length,1);assert.equal(monitor.state(a),'available');
  const moved={...a,root:'/fixture/replacement'};monitor.refresh([moved]);await turn();assert.equal(gates.length,2);gates[1].resolve('unavailable');await turn();assert.equal(monitor.state(moved),'unavailable');
});
