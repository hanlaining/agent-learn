# Runtime-E2E GATE-30 本机审计摘要（2026-08-19）

## 运行声明

本摘要来自 `god-runtime-e2e-gate_hln` worktree 中实际执行的 `npm run benchmark:runtime-e2e:gate30`。fixture seed 为 `20260819`；运行器完成两次确定性结果复核后又生成正式报告。环境是本机 Windows/Node，Provider 与 Tool 均为确定性 Fake；生产 Runtime 类和真实 `JsonFileRuntimePersistence` JSON 文件参与每条 baseline。没有调用真实 API、没有读取 Key、没有产生费用。

以下耗时是本次本机真实墙钟测量，只证明门禁实际执行过，不能作为真实 Provider 延迟或生产容量引用。

| 变体 | taskSuccess | recoverySuccess | duplicateModelCalls | duplicateToolEffects | unknownOutcome | evidenceCompleteness | 墙钟总计 / p50 / p95 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 30/30 (100%) | 30/30 (100%) | 0 | 0 | 5/30 (16.6667%) | 1.000000 | 811.005 / 27.874 / 45.013 |
| no-wal | 20/30 (66.6667%) | 30/30 (100%) | 10 | 5 | 10/30 (33.3333%) | 1.000000 | 564.673 / 9.635 / 40.208 |
| no-recovery | 5/30 (16.6667%) | 5/30 (16.6667%) | 0 | 0 | 0/30 (0%) | 0.500000 | 393.320 / 9.727 / 31.729 |
| no-lease | 23/30 (76.6667%) | 25/25 (100%) | 0 | 7 | 5/30 (16.6667%) | 0.944445 | 551.506 / 12.046 / 38.120 |

baseline 的 5 个 `unknownOutcome` 来自 Snapshot 族故意保存的 `submitted`/`executing` 状态。这里的成功不代表请求完成，而是生产启动恢复把不确定状态安全标记为需要显式处理，且没有重复 Provider/Tool 副作用；这是预注册的安全不变量。

## 结论与局限

- baseline 30 条 fixture 全部满足重载后的生产状态不变量，重复模型调用与重复 Tool 副作用均为 0。
- `no-wal` 真实绕过 AgentLoop WAL 接线后出现 10 次重复模型调用与 5 次重复 Tool 效果。
- `no-recovery` 停用生产恢复入口后，恢复成功率和证据完整度明显下降；较短耗时来自提前停止，不能解释为性能改善。
- `no-lease` 绕过真实 Lease/Fencing 后产生 7 次重复效果。
- 这不是进程/主机级混沌、真实 Provider、真实外部 Tool 或生产吞吐测试；结论仅限当前 fixture 对生产实现机制的本机 Implementation Check。

原始 `report.json` SHA-256：`152BB16FDF3CB27EDE9B4E542933C9A770198BDE29016DE3C95379BDAC5F14F4`。原始 JSON/CSV/repro 按设计位于 gitignore 的 `results/`，不提交仓库。
