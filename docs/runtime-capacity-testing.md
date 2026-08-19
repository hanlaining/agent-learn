# Runtime 压爆与容量测试

该套件测试 God-Agent 本机 Runtime 的编排与存储容量，不调用真实模型，也不测 OpenAI/其他 Provider 的限流能力。所有结果必须带有 `deterministic-local-fake-provider (NO NETWORK / NO PAID PROVIDER)` 标记。

套件分为两类负载：有界瞬时 Spike，以及固定并发、按时长运行的 Steady/short-soak。所有模式都限制 in-flight，不会一次创建无限 Promise。30–60 秒运行只能称为 short-soak，仍不得外推为长期容量。阶梯使用 `S0/S1/...` 与 `D0/D1/...` 命名，避免与正式架构的 L0 Store、L1 Runtime 分层混淆。

## 运行入口

```powershell
npm run test:capacity
npm run capacity:runtime:smoke
npm run capacity:runtime -- --levels 20,100,500,1000 --label local-staircase
npm run capacity:runtime:steady
npm run capacity:runtime:short-soak
npm run capacity:runtime:short-soak:shaped
```

Spike 的 `--levels` 是每级总 Task 数；每个 Job 最多 10 Task，套件通过增加 Job 数加压。Spike 也受单档墙钟门禁约束，超时后不再派发新 Task，只 drain 已在途工作。Duration 模式使用固定 worker 数维持有界并发，并受运行时长和 `--safe-task-limit` 双重保护；停止产生新任务后等待 in-flight 完成，再 drain 全部 Return。

## 覆盖与指标

- 并发 Job、Task、Run、Return 全链路。
- Return storm 重放全部幂等键后集中 claim/consume，校验重复与丢失。
- Runtime 快照 JSON 序列化与重建。
- 过期 Task lease 恢复探针。
- 环境指纹（含 Git commit）、基准/Schema 版本、Task/s、p50/p95/p99、错误率、重复/丢失 Return、峰值 RSS、快照大小与恢复耗时。
- Duration 模式每 5 秒输出吞吐、p95、错误数和 RSS，并报告首尾增长、线性斜率、尾/头吞吐比和 Event Loop p95。

默认正确性门禁是零错误、零重复 Return、零丢失 Return、消费数严格等于完成 Task 数。稳定性门禁包括 p95、单级耗时和 RSS；CLI 可调整，但报告会保留实际门禁参数。

持续模式额外要求：结束后 Return 全部 drain、尾部窗口吞吐不低于头部窗口的 70%、RSS 增长/斜率受限、Event Loop p95 和任务 p95 不越界。

报告写入 `reports/capacity/`，包含 JSON 和 Markdown。该目录被 Git 忽略，避免提交机器相关的大量生成文件。

## 结果解释

- **稳定档**：所有正确性与稳定性门禁通过。
- **退化档**：正确性仍通过，但吞吐比此前最佳档下降超过 30%，或 p95 已超过门禁的一半。
- **终止档**：首个失败档；或者已到安全上限，不能据此宣称 Runtime 已达到真实极限。
- Fake Provider 结果只能说明本机 Runtime 控制面/存储的承载能力，不能外推真实模型响应速度、网络限流或费用。
