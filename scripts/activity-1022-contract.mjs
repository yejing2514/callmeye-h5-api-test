import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ACTIVITY_ID = 10609054;
const REQUIRED_STAY_MS = 10_800_000;
const statuses = new Set(['waiting', 'eligible', 'closed', 'expired']);
const timeFields = ['required_ms', 'credited_ms', 'remaining_ms', 'started_at_ms',
  'settled_until_ms', 'expires_at_ms', 'server_now_ms'];
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCount = value => Number.isSafeInteger(value) && value >= 0;

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function checkSnapshot(snapshot, previous) {
  check(isObject(snapshot), '计时快照必须是对象');
  check(typeof snapshot.session_id === 'string' && snapshot.session_id.trim().length > 0
    && snapshot.session_id.length <= 64, '会话别名无效');
  check(statuses.has(snapshot.status), '未知的服务端计时状态');
  for (const field of timeFields) {
    check(isCount(snapshot[field]), `计时字段缺失或无效：${field}`);
  }
  check(snapshot.required_ms === REQUIRED_STAY_MS, '1022 的停留门槛不是 3 小时');
  check(snapshot.remaining_ms === Math.max(0, snapshot.required_ms - snapshot.credited_ms),
    '已计和剩余时长不一致');
  if (snapshot.status === 'eligible') {
    check(snapshot.remaining_ms === 0, '服务端标记可签到，但尚未达到停留门槛');
    check(snapshot.server_now_ms < snapshot.expires_at_ms, '可签到的会话已过期');
  }
  if (previous) {
    check(snapshot.session_id === previous.session_id, '同一份记录不能混入另一会话');
    check(snapshot.server_now_ms >= previous.server_now_ms
      && snapshot.credited_ms >= previous.credited_ms, '计时快照顺序或累计时长有误');
  }
}

// Audit normalized observations only: no credentials or network requests.
export function checkActivityTrace(trace) {
  check(isObject(trace) && trace.activity_id === ACTIVITY_ID, '记录不是 1022 的签到活动');
  check(Array.isArray(trace.snapshots) && trace.snapshots.length > 0, '缺少计时快照');
  let previous;
  for (const snapshot of trace.snapshots) {
    checkSnapshot(snapshot, previous);
    previous = snapshot;
  }

  const result = { snapshotCount: trace.snapshots.length, signin: 'not-observed' };
  if (trace.signin === undefined) return result;
  const { signin } = trace;
  check(isObject(signin) && ['success', 'rejected'].includes(signin.outcome), '签到结果无效');
  if (signin.outcome === 'success') {
    check(previous.status === 'eligible', '签到成功前未观察到服务端放行');
    check(isCount(signin.expected_gold_delta), '预期金币增量无效');
  }
  check(isCount(signin.gold_before) && isCount(signin.gold_after), '金币余额无效');
  const expected = signin.outcome === 'success' ? signin.expected_gold_delta : 0;
  check(signin.gold_after - signin.gold_before === expected, '金币余额变化与预期不符');
  return { ...result, signin: signin.outcome, goldDelta: expected };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, ...rest] = process.argv.slice(2);
  if (!file || rest.length) {
    console.error('用法：node scripts/activity-1022-contract.mjs <脱敏记录.json>');
    process.exitCode = 1;
  } else {
    let trace;
    try {
      trace = JSON.parse(readFileSync(file === '-' ? 0 : file, 'utf8').replace(/^\uFEFF/, ''));
    } catch {
      console.error('无法读取记录，或记录不是有效的 JSON。');
      process.exitCode = 1;
    }
    if (!process.exitCode) {
      try {
        console.log(JSON.stringify(checkActivityTrace(trace)));
      } catch (error) {
        console.error(`1022 校验失败：${error.message}`);
        process.exitCode = 1;
      }
    }
  }
}
