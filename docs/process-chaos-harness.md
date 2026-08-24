# Process Chaos Smoke：可重复恢复验证入口

Process Chaos Smoke 会启动真实的本地 App Server 子进程，但 Provider 使用进程内的确定性 Fake Responses Server。它不读取真实凭据、不调用外部 API，也不会产生供应商费用。

## 快速检查

先做不启动子进程的 dry-run：

```text
npm run process-chaos:smoke -- --dry-run
```

正式运行一次强制退出恢复验证：

```text
npm run process-chaos:smoke -- --seed gate40-seed-1 --out research/runtime-e2e-benchmarks/results/process-chaos-gate40-seed-1 --timeout-ms 120000
```

`--seed` 必须是文件名安全的标识符；`--timeout-ms` 是整个 smoke 的有界墙钟上限，至少为 1000 毫秒。默认输出目录为 `research/runtime-e2e-benchmarks/results/process-chaos-process-chaos-smoke`，该目录已被忽略，不会进入提交。

## 输出与审计

每次运行输出两个 JSON：

- `process-chaos-report.json`：harness 的原始证据，包含两个故障窗口、Owner PID、Lease 截止时间、原始状态文件路径和 Fake Provider 请求计数。
- `smoke-result.json`：入口层的审计结果，包含 `status`、运行时间、原始报告 SHA-256 和七个明确不变量。

只有以下条件全部满足，入口才返回成功：

1. 三个不同的 App Server PID 被观察到（初始进程、第一次重载、Lease 接管进程）。
2. 第二个故障窗口在强杀前确实持有 Job Lease，重启后观察到 Lease 等待。
3. 两个故障窗口都完成 public RPC 与原始 JSON 重载，并恢复到明确终态。
4. 最终 Job 为 `completed`，最终 Return 为 `consumed`。
5. `return_god` Fake Provider 请求数严格为 1，作为无重复最终副作用的证据。

`status=failed` 时仍会写出 `smoke-result.json`，其中保留错误信息，便于 CI 或复试材料审计。`status=dry-run` 只验证参数和输出契约，不启动 App Server。

## 与测试套件的关系

```text
npm run test:process-chaos   # 入口参数、dry-run 和安全校验
npm run test:runtime-e2e     # 包含真实 App Server 强制退出恢复回归测试
npm run check                # TypeScript 类型检查
```

这项验证证明的是当前本机、确定性 Fake Provider 下的进程恢复不变量；它不等价于真实 Provider 的 exactly-once，也不覆盖网络、主机故障或外部工具的幂等能力。
