import test from 'node:test';
import assert from 'node:assert/strict';
import {Stop,configFrom,identity,Client,run,submitOnce} from '../scripts/linping.mjs';
import {MAX_ACCOUNTS,accountsFrom,executionEnv,randomWindow,planFrom,waitForStart,executeAccount} from '../scripts/daily.mjs';

const entries = [
  {user_id:19426008,token:'offline-token-one',device_id:'authorized-test-device-one'},
  {user_id:19426009,token:'offline-token-two',device_id:'authorized-test-device-two'}
];
const envFor = (accounts = entries) => ({LINPING_ACCOUNTS:JSON.stringify(accounts),MODE:'inspect'});
const now = Date.parse('2026-10-29T01:20:00Z');

test('legacy single-account configuration and default ID remain compatible',()=>{
  const [config] = accountsFrom({LINPING_TOKEN:' offline-token ',MODE:'signin',MAX_WAIT_MINUTES:'200'});
  assert.equal(config.userId,19426008); assert.equal(config.token,'offline-token');
  assert.equal(config.mode,'signin'); assert.equal(config.maxWait,200);
  assert.equal(accountsFrom({LINPING_TOKEN:'test',LINPING_USER_ID:'123'})[0].userId,123);
});

test('explicit expected ID is strict and never inferred from a token',()=>{
  for (const id of [null,true,0,-1,'1.5','NaN','1\n','9007199254740992']) {
    assert.throws(()=>configFrom({LINPING_TOKEN:'offline',LINPING_USER_ID:id}),Stop);
  }
  const other = {id:19426009,user_id:19426009,t_id:59,gold:5};
  assert.deepEqual(identity(other,19426009),{user_id:19426009,gold:5});
  assert.throws(()=>identity(other),Stop);
  assert.throws(()=>identity({...other,user_id:19426008},19426009),Stop);
  assert.throws(()=>identity({...other,t_id:60},19426009),Stop);
});

test('multi-account configs override legacy values without mixing credentials',()=>{
  const accounts = accountsFrom({...envFor(),LINPING_TOKEN:'legacy',LINPING_USER_ID:'1',LINPING_DEVICE_ID:'legacy-device'});
  assert.equal(accounts.length,2);
  accounts.forEach((config,i)=>{
    assert.equal(config.userId,entries[i].user_id);
    assert.equal(config.token,entries[i].token);
    assert.equal(config.device,entries[i].device_id);
  });
});

test('malformed, empty, oversized or misspelled multi-account configs fail closed',()=>{
  for (const raw of ['private-invalid-json','{}','[]','[null]',JSON.stringify(Array(MAX_ACCOUNTS+1).fill(entries[0]))]) {
    assert.throws(()=>accountsFrom({LINPING_ACCOUNTS:raw,LINPING_TOKEN:'legacy'}),
      error=>error instanceof Stop && !error.message.includes('private-invalid-json'));
  }
  const invalid = [{...entries[0],token:1},{...entries[0],token:'a\nb'},
    {...entries[0],device_id:''},{...entries[0],device_id:undefined},
    {...entries[0],user_id:null},{...entries[0],token_typo:'secret'}];
  for (const entry of invalid) assert.throws(()=>accountsFrom(envFor([entry])),Stop);
});

test('duplicate identities, tokens or device IDs are rejected before requests',()=>{
  for (const field of ['user_id','token','device_id']) {
    assert.throws(()=>accountsFrom(envFor([entries[0],{...entries[1],[field]:entries[0][field]}])),/重复/);
  }
});

test('daily event selects real signin and a 200 minute wait, manual selection is preserved',()=>{
  const scheduled = executionEnv({...envFor(),GITHUB_EVENT_NAME:'schedule',MODE:'inspect',MAX_WAIT_MINUTES:'0'});
  assert.ok(accountsFrom(scheduled).every(config=>config.mode==='signin' && config.maxWait===200));
  const manual = executionEnv({...envFor(),GITHUB_EVENT_NAME:'workflow_dispatch',MAX_WAIT_MINUTES:'0'});
  assert.ok(accountsFrom(manual).every(config=>config.mode==='inspect' && config.maxWait===0));
});

test('random window defaults to 60, supports disabling and rejects over-timeout inputs',()=>{
  assert.equal(randomWindow({}),60); assert.equal(randomWindow({RANDOM_WINDOW_MINUTES:'0'}),0);
  assert.equal(randomWindow({RANDOM_WINDOW_MINUTES:'90'}),90);
  for (const value of ['91','-1','NaN','1.5','Infinity']) assert.throws(()=>randomWindow({RANDOM_WINDOW_MINUTES:value}),Stop);
});

test('daily plan independently samples accounts, exports only indices and numeric times',()=>{
  let calls = 0;
  const plan = planFrom({...envFor(),GITHUB_EVENT_NAME:'schedule'},
    {now:()=>now,randomInt:(min,max)=>{assert.equal(min,0); assert.equal(max,3600001); return calls++ ? max-1 : 0;}});
  assert.deepEqual(plan,{include:[{account_index:0,start_at_ms:now},{account_index:1,start_at_ms:now+3600000}]});
  const output = JSON.stringify(plan);
  for (const entry of entries) for (const value of Object.values(entry)) assert.ok(!output.includes(String(value)));
  assert.throws(()=>planFrom({...envFor(),GITHUB_EVENT_NAME:'schedule'},{now:()=>now,randomInt:()=>3600001}),Stop);
});

test('manual planning never delays or samples randomness',()=>{
  const plan = planFrom({...envFor(),GITHUB_EVENT_NAME:'workflow_dispatch',RANDOM_WINDOW_MINUTES:'unused'},
    {now:()=>now,randomInt:()=>{throw new Error('must not sample');}});
  assert.ok(plan.include.every(item=>item.start_at_ms===0));
});

test('zero random window produces immediate scheduled starts',()=>{
  const plan = planFrom({...envFor(),GITHUB_EVENT_NAME:'schedule',RANDOM_WINDOW_MINUTES:'0'},
    {now:()=>now,randomInt:(min,max)=>{assert.equal(max,1);return 0;}});
  assert.ok(plan.include.every(item=>item.start_at_ms===now));
});

test('scheduled waiting happens before business requests, and does not count as dwell',async()=>{
  let elapsed = 0, started = false;
  const env = {...envFor(),GITHUB_EVENT_NAME:'schedule',START_AT_MS:String(now+125000)};
  await executeAccount(env,'1',{now:()=>now,clock:()=>elapsed,
    sleep:async ms=>{assert.equal(started,false);assert.ok(ms<=60000);elapsed+=ms;},log:()=>{},
    run:async config=>{started=true;assert.equal(elapsed,125000);assert.equal(config.userId,19426009);assert.equal(config.mode,'signin');}});
  assert.equal(started,true);
});

test('late same-day start is immediate; cross-day or unbounded plans stop',async()=>{
  const env = {GITHUB_EVENT_NAME:'schedule'};
  await waitForStart(now-1000,env,()=>{},{now:()=>now,sleep:()=>{throw new Error('must not sleep');}});
  for (const target of [undefined,'invalid','0',String(now+3600001),String(now-86400000)]) {
    await assert.rejects(waitForStart(target,env,()=>{},{now:()=>now}),Stop);
  }
});

test('manual invocation is immediate and selected accounts never share mutable config',async()=>{
  const seen=[];
  for (const index of [0,1]) await executeAccount(envFor(),String(index),
    {log:()=>{},sleep:()=>{throw new Error('must not sleep');},run:async config=>seen.push(config)});
  assert.notEqual(seen[0],seen[1]);
  seen[0].token='changed'; assert.equal(seen[1].token,entries[1].token);
  for (const index of [-1,2,'NaN','1.5']) await assert.rejects(executeAccount(envFor(),index),Stop);
});

test('each Client uses its own user header, token and device session',async()=>{
  const requests=[];
  const settings={appid:'linping',appkey:'offline-key'};
  for (const config of accountsFrom(envFor())) {
    const client=new Client(config,settings,async(url,opt)=>{
      requests.push({url,opt}); return {ok:true,status:200,json:async()=>({code:'0',data:url.endsWith('_auth_dt')?'a'.repeat(68):{}})};
    });
    await client.initDevice(); await client.call('/aosbase/user_info');
  }
  for(let i=0;i<2;i++) {
    assert.equal(requests[i*2].opt.headers['Access-Api-Dt'],entries[i].device_id);
    assert.equal(requests[i*2+1].opt.headers['Access-User-Id'],String(entries[i].user_id));
    assert.equal(requests[i*2+1].opt.headers['Access-Token'],entries[i].token);
  }
});

test('non-default account is verified again during submit and confirmation',async()=>{
  const user={id:19426009,user_id:19426009,t_id:59,gold:5};
  const session={session_id:'offline-session',status:'eligible',required_ms:60000,credited_ms:60000,
    remaining_ms:0,server_now_ms:61000,started_at_ms:1000,settled_until_ms:61000,expires_at_ms:900000};
  let times=0,submits=0;
  const client={call:async path=>{
    if(path.endsWith('user_times')) return {day_remain:times++};
    if(path.endsWith('user_info')) return user;
    if(path.endsWith('checkpoint')) return session;
    if(path.endsWith('ac_sub')) { submits++;return {}; }
    throw new Error('unexpected');
  }};
  assert.equal((await submitOnce(client,1,session,()=>{},19426009)).confirmed,true);
  assert.equal(submits,1);
});

test('full signin flow accepts the selected account and submits only once after real waiting',async()=>{
  const account=accountsFrom({...envFor(),MODE:'signin',MAX_WAIT_MINUTES:'1'})[1];
  const user={id:account.userId,user_id:account.userId,t_id:59,gold:5};
  const detail={id:123,t_id:59,start_time:1,end_time:9999999999,
    rule:JSON.stringify({submit_limit:{open_stay_time:1,stay_time:1},prevent_cheat:{area_limit:{}}}),other_set:'{}'};
  let elapsed=0,submits=0;
  const fetch=async url=>({ok:true,status:200,json:async()=>({code:'0',data:
    url.includes('_auth_h5init')?{appid:'linping',appkey:'offline',t_id:59,t_id_in:59}:
      url.includes('page_getattr')?{content:[{type:'signin',attr:{id:123}}]}:detail})});
  const client={initDevice:async()=>{},call:async path=>{
    if(path.endsWith('user_info')) return user;
    if(path.endsWith('user_times')) return {day_remain:submits};
    if(path.endsWith('ac_sub')) { submits++;return {}; }
    return {session_id:'offline',status:elapsed>=1000?'eligible':'waiting',required_ms:1000,
      credited_ms:Math.min(elapsed,1000),remaining_ms:Math.max(0,1000-elapsed),server_now_ms:1000+elapsed,
      started_at_ms:1000,settled_until_ms:1000+elapsed,expires_at_ms:900000};
  }};
  await run(account,{client,fetch,clock:()=>elapsed,sleep:async ms=>{elapsed+=ms;},log:()=>{}});
  assert.equal(elapsed,1000);assert.equal(submits,1);
});

test('one account failure does not mutate or disable another account',async()=>{
  const logs=[];
  await assert.rejects(executeAccount(envFor(),0,{log:()=>{},run:async()=>{throw new Stop('登录失效');}}),Stop);
  await executeAccount(envFor(),1,{log:()=>{},run:async config=>logs.push(config.userId)});
  assert.deepEqual(logs,[19426009]);
});
