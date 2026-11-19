# 1022「热奶茶爆金币」签到回归

此工作流不调用业务接口，也不读取账号 Secrets。独立排程只通过 GitHub API 读取 621 工作流是否停用。根据 1022 接口文档，签到活动 ID 为 `10609054`，停留门槛是 3 小时，签到前由服务端会话确认资格。金币钱包由多个活动共用；检查余额时，请取同一账号签到紧邻的前后两次余额，并确保期间没有其他金币收支。

## 每日开关

- 两个每日任务默认开启，不需要设置变量。621 仍按北京时间 07:20 排程；1022 等 621 的当次定时运行结束后再开始，不要求 621 成功。手动运行或重跑 621 不会触发 1022 的回归。
- 暂停 1022 的自动测试：在仓库 `Settings → Secrets and variables → Actions → Variables` 将 `LINPING_1022_DAILY` 设为 `false`。改回 `true` 或删除变量即恢复，621 不受影响。
- 暂停 621：在 Actions 中选中原来的 **H5 接口测试**，用菜单中的 `Disable workflow`；恢复用 `Enable workflow`。621 被手动停用时，1022 改由北京时间 13:20 的独立排程触发。621 未停用时，该排程只检查状态，不重复跑回归。
- 手动测试：改动到默认分支后，在 **Actions → 1022 签到离线回归 → Run workflow** 启动，不用等 621，也不受 `LINPING_1022_DAILY` 影响。

## 核对一次 App 实测

在 App 中按正常流程测试。按顺序整理同一个会话的计时响应 `data` 到 `snapshots`，把每个 `session_id` 改成同一个本地别名，仅保留下列字段。最后一个快照应取自签到前；如未签到，省略 `signin`。`expected_gold_delta` 填本次签到档位预期发放的金币；签到被拒绝时省略该字段，余额按零增量检查。

```json
{
  "activity_id": 10609054,
  "snapshots": [
    {
      "session_id": "fixture-a",
      "status": "eligible",
      "required_ms": 10800000,
      "credited_ms": 10800000,
      "remaining_ms": 0,
      "started_at_ms": 1000,
      "settled_until_ms": 10801000,
      "expires_at_ms": 22000000,
      "server_now_ms": 10801000
    }
  ],
  "signin": {
    "outcome": "success",
    "gold_before": 100,
    "gold_after": 110,
    "expected_gold_delta": 10
  }
}
```

```console
node scripts/activity-1022-contract.mjs path/to/redacted-trace.json
node --test tests/activity-1022/contract.test.mjs
```

不要把真实请求头、Token、Cookie、签名、设备标识、会话 ID 或原始抓包文件提交到仓库。每日离线测试只使用模拟数据，通过不代表服务端已实际发奖。
