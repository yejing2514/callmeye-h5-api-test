import test from 'node:test';
import assert from 'node:assert/strict';
import {Stop,configFrom,identity,tokenIdentity,testDeviceId,Client,run,submitOnce} from '../scripts/callmeye.mjs';
import {MAX_ACCOUNTS,accountsFrom,executionEnv,randomWindow,planFrom,waitForStart,executeAccount} from '../scripts/daily.mjs';

const entries = [
  {user_id:19426008,token:'offline-token-one',device_id:'authorized-test-device-one'},
  {user_id:19426009,token:'offline-token-two',device_id:'authorized-test-device-two'}
];
const envFor = (accounts = entries) => ({LINPING_ACCOUNTS:JSON.stringify(accounts),MODE:'inspect'});
const now = Date.parse('2026-10-29T01:20:00Z');
// Synthetic, deliberately unsigned tokens. Never use real account credentials.
const envelope = query => '0'.repeat(32) + Buffer.from(query).toString('base64');
const tokenFor = (id, changes = {}) => envelope(new URLSearchParams({exp:'1803172795',iat:'1793172795',
  'data[t_id]':'59','data[t_id_in]':'59','data[user_id]':String(id),
  'data[user_name]':'offline_test_only',...changes}).toString());

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
    {...entries[0],device_id:''},{...entries[0],device_id:null},{...entries[0],device_id:1},
    {...entries[0],user_id:null},{...entries[0],token_typo:'secret'}];
  for (const entry of invalid) assert.throws(()=>accountsFrom(envFor([entry])),Stop);
});

test('duplicate identities, tokens or device IDs are rejected before requests',()=>{
  for (const field of ['user_id','token','device_id']) {
    assert.throws(()=>accountsFrom(envFor([entries[0],{...entries[1],[field]:entries[0][field]}])),/重复/);
  }
});

test('observed token format yields only user and tenant claims, never credentials or profile fields',()=>{
  const claims=tokenIdentity(tokenFor(19426009));
  assert.deepEqual(claims,{userId:19426009,tenantId:59,tenantIdIn:59});
  assert.ok(!JSON.stringify(claims).includes('offline_test_only'));
  assert.deepEqual(tokenIdentity(' '+tokenFor(19426009)+' '),claims);
  assert.deepEqual(tokenIdentity(tokenFor(19426009).replace(/=+$/,'')),claims);
});

test('token-only multi-account JSON resolves IDs and stable isolated client identifiers',()=>{
  const accounts=accountsFrom(envFor([{token:tokenFor(19426008)},{token:tokenFor(19426009)}]));
  assert.deepEqual(accounts.map(config=>config.userId),[19426008,19426009]);
  assert.notEqual(accounts[0].device,accounts[1].device);
  accounts.forEach(config=>{
    assert.match(config.device,/^[a-f0-9]{32}$/);
    assert.equal(config.device,testDeviceId(config.userId));
  });
});

test('renewal and array reordering preserve each account automatic device identifier',()=>{
  const before=accountsFrom(envFor([{token:tokenFor(19426008)},{token:tokenFor(19426009)}]));
  const after=accountsFrom(envFor([{token:tokenFor(19426009,{exp:'1809999999'})},
    {token:tokenFor(19426008,{exp:'1809999999'})}]));
  assert.notEqual(before[0].token,after[1].token);
  assert.equal(before[0].device,after[1].device);
  assert.equal(before[1].device,after[0].device);
});

test('token-only credentials never inherit old single-account user or device settings',()=>{
  const [account]=accountsFrom({...envFor([{token:tokenFor(12345)}]),LINPING_USER_ID:'19426008',
    LINPING_DEVICE_ID:'legacy-device',LINPING_TOKEN:'legacy-token'});
  assert.equal(account.userId,12345);assert.equal(account.device,testDeviceId(12345));
  assert.equal(account.token,tokenFor(12345));
});

test('legacy entries and partial optional overrides remain compatible',()=>{
  const configs=accountsFrom(envFor([
    entries[0],
    {token:tokenFor(19426009)},
    {token:tokenFor(12345),device_id:'fixed-authorized-device'},
    {token:'opaque-offline-token',user_id:54321}
  ]));
  assert.equal(configs[0].device,entries[0].device_id);
  assert.equal(configs[1].device,testDeviceId(19426009));
  assert.equal(configs[2].device,'fixed-authorized-device');
  assert.equal(configs[3].device,testDeviceId(54321));
});

test('unknown token envelope or wrong tenant never guesses an account or falls back',()=>{
  for(const token of ['private-opaque-token',tokenFor(1,{'data[t_id]':'60'}),
    tokenFor(1,{'data[t_id_in]':'60'}),tokenFor(1,{'data[user_id]':'NaN'}),
    tokenFor(1,{'data[user_id]':'9007199254740992'}),tokenFor(1,{'data[user_id]':'0'})]) {
    assert.throws(()=>accountsFrom({...envFor([{token}]),LINPING_TOKEN:'legacy'}),
      error=>error instanceof Stop && !error.message.includes(token));
  }
});

test('malformed Base64, invalid UTF-8, missing or duplicate claims fail safely',()=>{
  const bad=[
    '0'.repeat(32)+'A',
    '0'.repeat(32)+'AB==',
    '0'.repeat(32)+Buffer.from([255,254]).toString('base64'),
    tokenFor(1).slice(0,34)+'!'+tokenFor(1).slice(35),
    envelope('data%5Bt_id%5D=59&data%5Bt_id_in%5D=59'),
    envelope('data%5Buser_id%5D=1&data%5Bt_id%5D=59'),
    envelope('data[user_id]=1&data%5Buser_id%5D=2&data[t_id]=59&data[t_id_in]=59'),
    envelope('data[user_id]=1&data[t_id]=59&data%5Bt_id%5D=60&data[t_id_in]=59'),
    envelope('data[user_id]=1%0A&data[t_id]=59&data[t_id_in]=59'),
    '0'.repeat(16385)
  ];
  for(const token of bad) assert.throws(()=>tokenIdentity(token),Stop);
});

test('explicit user ID cannot override conflicting claims in an observed token',()=>{
  assert.throws(()=>accountsFrom(envFor([{token:tokenFor(19426009),user_id:19426008}])),/不一致/);
  assert.equal(accountsFrom(envFor([{token:tokenFor(19426009),user_id:'19426009'}]))[0].userId,19426009);
});

test('same account with different tokens is rejected before running, including auto devices',()=>{
  assert.throws(()=>accountsFrom(envFor([{token:tokenFor(19426009)},
    {token:tokenFor(19426009,{exp:'1809999999'})}])),/重复/);
});

test('token-only plan and execution expose no claims or generated device IDs in matrix',async()=>{
  const env={...envFor([{token:tokenFor(19426009)}]),GITHUB_EVENT_NAME:'schedule'};
  const plan=planFrom(env,{now:()=>now,randomInt:()=>0});
  assert.deepEqual(plan,{include:[{account_index:0,start_at_ms:now}]});
  await executeAccount({...env,START_AT_MS:String(now)},0,{now:()=>now,log:()=>{},run:async config=>{
    assert.equal(config.userId,19426009); assert.equal(config.device,testDeviceId(19426009));
    assert.equal(config.mode,'signin');
  }});
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
  const account=accountsFrom({...envFor([{token:tokenFor(19426008)},{token:tokenFor(19426009)}]),MODE:'signin',MAX_WAIT_MINUTES:'1'})[1];
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

test('decoded claims do not authenticate: server identity mismatch creates no stay session or reward',async()=>{
  const [account]=accountsFrom({...envFor([{token:tokenFor(19426009)}]),MODE:'signin'});
  const paths=[];
  const client={initDevice:async()=>{},call:async path=>{
    paths.push(path);return {id:19426008,user_id:19426008,t_id:59,gold:5};
  }};
  const fetch=async()=>({ok:true,status:200,json:async()=>({code:'0',data:{appid:'linping',appkey:'offline',t_id:59,t_id_in:59}})});
  await assert.rejects(run(account,{fetch,client,log:()=>{}}),/账号/);
  assert.deepEqual(paths,['/aosbase/user_info']);
});

test('unverified or expired token rejected by server never causes a reward attempt',async()=>{
  const [account]=accountsFrom({...envFor([{token:tokenFor(19426009,{exp:'1'})}]),MODE:'signin'});
  const paths=[];
  const fetch=async(url,opt)=>{
    paths.push(url);
    return {ok:true,status:200,json:async()=>({code:url.endsWith('user_info')?'1001':'0',data:
      url.includes('_auth_h5init')?{appid:'linping',appkey:'offline',t_id:59,t_id_in:59}:
        url.endsWith('_auth_dt')?'a'.repeat(32)+'b'.repeat(32):{}})};
  };
  await assert.rejects(run(account,{fetch,log:()=>{}}),/登录失效/);
  assert.equal(paths.length,3);
  assert.ok(paths.every(path=>!path.includes('stay_session') && !path.includes('ac_sub')));
});

test('one account failure does not mutate or disable another account',async()=>{
  const logs=[];
  await assert.rejects(executeAccount(envFor(),0,{log:()=>{},run:async()=>{throw new Stop('登录失效');}}),Stop);
  await executeAccount(envFor(),1,{log:()=>{},run:async config=>logs.push(config.userId)});
  assert.deepEqual(logs,[19426009]);
});
