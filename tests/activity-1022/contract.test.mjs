import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkActivityTrace } from '../../scripts/activity-1022-contract.mjs';

const waiting = {
  session_id: 'fixture-a', status: 'waiting', required_ms: 10_800_000,
  credited_ms: 0, remaining_ms: 10_800_000, started_at_ms: 1_000,
  settled_until_ms: 1_000, expires_at_ms: 22_000_000, server_now_ms: 1_000,
};
const eligible = {
  ...waiting, status: 'eligible', credited_ms: 10_800_000, remaining_ms: 0,
  settled_until_ms: 10_801_000, server_now_ms: 10_801_000,
};
const reward = { outcome: 'success', gold_before: 100, gold_after: 110, expected_gold_delta: 10 };
const trace = (snapshots, signin) => ({ activity_id: 10609054, snapshots, signin });

test('等待达到 3 小时后放行，且钱包变化与预期奖励相同', () => {
  assert.deepEqual(checkActivityTrace(trace([waiting, eligible], reward)), {
    snapshotCount: 2, signin: 'success', goldDelta: 10,
  });
});

test('只观察到计时，不等同于已签到', () => {
  assert.deepEqual(checkActivityTrace(trace([waiting])), { snapshotCount: 1, signin: 'not-observed' });
});

test('等待、已关闭和已过期状态不能证明签到成功', () => {
  for (const status of ['waiting', 'closed', 'expired']) {
    assert.throws(() => checkActivityTrace(trace([{ ...waiting, status }], reward)), /未观察到服务端放行/);
  }
});

test('对会话过期或提前签到的拒绝，钱包不应改变', () => {
  const rejected = { outcome: 'rejected', gold_before: 100, gold_after: 100 };
  assert.equal(checkActivityTrace(trace([{ ...waiting, status: 'expired' }], rejected)).goldDelta, 0);
  assert.throws(() => checkActivityTrace(trace([waiting], { ...rejected, gold_after: 110 })), /余额变化/);
});

test('识别未知状态、计时缺失、规则变化及不一致的剩余时长', () => {
  assert.throws(() => checkActivityTrace(trace([{ ...waiting, status: 'unknown' }])), /未知/);
  assert.throws(() => checkActivityTrace(trace([{ ...waiting, settled_until_ms: undefined }])), /settled_until_ms/);
  assert.throws(() => checkActivityTrace(trace([{ ...waiting, required_ms: 60_000 }])), /门槛不是 3 小时/);
  assert.throws(() => checkActivityTrace(trace([{ ...waiting, remaining_ms: 0 }])), /时长不一致/);
});

test('服务端提前放行或放行时会话已经过期均记为异常', () => {
  assert.throws(() => checkActivityTrace(trace([{ ...waiting, status: 'eligible' }])), /尚未达到/);
  assert.throws(() => checkActivityTrace(trace([{ ...eligible, expires_at_ms: eligible.server_now_ms }])), /已过期/);
});

test('不接受其他活动、串会话和乱序快照', () => {
  assert.throws(() => checkActivityTrace({ ...trace([waiting]), activity_id: 10609040 }), /不是 1022/);
  assert.throws(() => checkActivityTrace(trace([waiting, { ...eligible, session_id: 'fixture-b' }])), /另一会话/);
  assert.throws(() => checkActivityTrace(trace([eligible, waiting])), /顺序/);
});

test('签到成功但余额增量不足或超出预期时失败', () => {
  for (const gold_after of [100, 120]) {
    assert.throws(() => checkActivityTrace(trace([eligible], { ...reward, gold_after })), /余额变化/);
  }
});

test('命令行接受脱敏 JSON，非法输入失败且不回显内容', () => {
  const script = fileURLToPath(new URL('../../scripts/activity-1022-contract.mjs', import.meta.url));
  const run = input => spawnSync(process.execPath, [script, '-'], { input, encoding: 'utf8' });
  const pass = run(JSON.stringify(trace([waiting, eligible], reward)));
  assert.equal(pass.status, 0, pass.stderr);
  assert.equal(JSON.parse(pass.stdout).goldDelta, 10);
  const fail = run('raw-value-not-to-be-printed');
  assert.equal(fail.status, 1);
  assert.doesNotMatch(fail.stderr + fail.stdout, /raw-value-not-to-be-printed/);
});
