# 1022「热奶茶爆金币」完整流程

1022 已接入真实接口执行，不再只是离线回归。共用 621 的 Token 认证、租户/用户校验、设备初始化、请求签名、多账号计划、真实停留和签到确认逻辑；621 的工作流文件及原有默认行为保持不变。

## 活动和执行范围

| 用途 | 1022 标识 |
| --- | --- |
| 页面来源 | `1022` |
| 签到活动 | `10609054` |
| 抽奖活动 | `a13d10304994b98ae3de08` |
| 提现规则活动 | `13109567` |

`signin` 模式执行：

1. 初始化原有租户/设备认证，校验所选账号和租户。
2. 加载签到规则并二次解析 `rule` / `other_set`，检查活动有效期和额外验证条件。
3. 查询当日签到记录；已签到则不创建会话、不重复提交，继续查询记录和金币。
4. 校验等待预算，创建 `stay_session`，真实运行并每 60 秒 checkpoint，以服务端 `credited_ms` / `eligible` 为准。
5. 达标后重新读取规则、校验账号和当日状态，带 `stay_session_id` 只提交一次；再确认当日记录和金币余额。
6. 查询金币钱包、抽奖次数、参与/中奖记录、核销码接口、金币流水、提现规则和提现记录；不打印核销码或原始响应，不提交抽奖或提现。

`inspect` 模式仅初始化认证并查询状态，不创建停留会话、不签到、不抽奖、不提现。签到出现网络超时或业务失败时，不自动重试提交；登录业务码 `1001` / `1002` 立即停止。

进程持续运行，不模拟 App 切后台，不伪造 `observed_elapsed_ms`。`checkpoint close` 和 `recover` 接口可由共用客户端调用，但定时任务不会跨运行恢复旧会话，也不会在会话关闭或过期后自动重建补报；请核对记录后再手动运行。

## 抽奖和提现边界

按需求，定时运行和手动运行都不会执行抽奖或提现，不受剩余次数或验证码配置影响。自动抽奖实现已移除，共用客户端也不允许调用 `/aoslottery/ac_sub` 或提现提交接口，仅保留相关 GET 查询。

签到接口正常发放的金币或抽奖次数仍由服务端记账，程序不会消耗抽奖次数。需要抽奖或提现时，请自行在原 App 操作。

提现比例只读取服务端配置，不硬编码「30 金币 = 1 元」。金币钱包由多个活动共用，两个工作流可以并行，不以钱包差额单独认定本活动发奖。

## 每日开关

- 621 保持北京时间 **09:20**（UTC `01:20`）；1022 独立排程为北京时间 **10:20**（UTC `02:20`），晚一小时。定时运行自动选择真实 `signin` 模式，等待上限 200 分钟。
- 两个任务沿用每账号随机延迟 0～60 分钟的逻辑，因此「晚一小时」指 cron 排程，不保证同一账号实际启动时间严格相差一小时。1022 可单独设置变量 `LINPING_1022_RANDOM_WINDOW_MINUTES` 为 0～90 的整数，未设置则复用 `RANDOM_WINDOW_MINUTES`，再默认 60。GitHub 排队也可能造成延迟。
- 两个工作流使用不同的并发组，互不等待、不取消对方、不通过 `workflow_run` 串联，也不读取对方的启停状态。相同账号配置下，1022 使用独立且稳定的测试设备标识、页面来源和服务端活动/会话。
- 暂停 1022 自动运行：在仓库 `Settings → Secrets and variables → Actions → Variables` 将 `LINPING_1022_DAILY` 设为 `false`。改回 `true` 或删除变量即恢复，621 不受影响。
- 暂停任一完整工作流：在 Actions 中选中对应工作流，使用 `Disable workflow`；恢复用 `Enable workflow`。另一个工作流不受影响。

## 手动运行

改动合并到默认分支后，在 **Actions → 1022 活动完整流程 → Run workflow**：

1. `mode=inspect`：仅查询，默认值。
2. `mode=signin`：真实停留并签到，之后查询金币和记录，不抽奖、不提现。
3. `max_wait_minutes=200`：完整三小时流程推荐值；小于活动要求时会在创建会话前停止。

手动运行不受 `LINPING_1022_DAILY=false` 影响，不增加随机延迟，但同一 1022 工作流已有运行时仍受自身并发锁约束。无需启动或等待 621。

## 账号配置

默认直接复用现有 `LINPING_ACCOUNTS` 多账号 Secret；没有多账号配置时，复用 `LINPING_TOKEN`、`LINPING_DEVICE_ID` 和变量 `LINPING_USER_ID`，无需重复配置。

如需让 1022 使用不同账号，支持独立覆盖：

| 类型 | 名称 | 作用 |
| --- | --- | --- |
| Secret | `LINPING_1022_ACCOUNTS` | 1022 专用多账号 JSON，格式与原 `LINPING_ACCOUNTS` 相同 |
| Secret | `LINPING_1022_TOKEN` | 1022 专用单账号 Token；设置后不会被共享多账号配置覆盖 |
| Secret | `LINPING_1022_DEVICE_ID` | 1022 单账号设备标识种子 |
| Variable | `LINPING_1022_USER_ID` | 单账号预期 ID；不同账号须同步设置 |
| Variable | `LINPING_1022_RANDOM_WINDOW_MINUTES` | 1022 独立随机启动窗口 |
| Variable | `LINPING_1022_DAILY` | 仅控制 1022 定时运行 |

优先级：专用多账号 > 专用单账号 > 原有账号配置。Token 不自动续期，失效时更新实际使用的 Secret。多账号仍最多 10 个，每个账号独立任务，最多并发 3 个，一个账号失败不取消其他账号。矩阵只传账号索引和计划时间，不传 Token、用户资料或设备标识。

## 本地验证

```console
node --test tests/*.test.mjs tests/activity-1022/*.test.mjs
```

以下 PowerShell 7 示例只使用已有环境变量，不把 Token 写入命令或文件：

```powershell
$env:LINPING_ACTIVITY = '1022'
$env:MODE = 'inspect'
node scripts/daily.mjs --account '0:0'
```

本地真实签到需明确将 `MODE` 改为 `signin`；进程必须持续运行足够时间。不要在测试时主动提交真实签到或抽奖，离线测试使用模拟服务端和模拟时钟。

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

不要把真实请求头、Token、Cookie、签名、设备标识、会话 ID 或原始抓包文件提交到仓库。离线测试通过只证明本地逻辑，不代表服务端已实际发奖；工作流中的真实执行结果应以当日记录确认为准。
