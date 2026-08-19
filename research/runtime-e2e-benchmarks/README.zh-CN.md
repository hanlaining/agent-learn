# Runtime-E2E GATE：生产实现检查

## 它与旧 GATE 的区别

`research/benchmarks` 的 GATE-30/100 是 deterministic-mock 协议状态机，用来做 Model Check；本目录是独立的 Implementation Check。它直接实例化生产 `AgentLoop`、`AgentRuntimeStore`、`WorkflowTeamCoordinator`、Model/Tool WAL、Return、`JsonFileRuntimePersistence` 与 `PersistentRuntimeLeaseStore`，并在每条 baseline 用例中至少一次从真实 JSON 文件重载状态。旧基准、旧 fixture 和旧结果均未改动。

Provider 和 Tool 是确定性 Fake：Provider 只返回固定响应，Tool 只写临时目录下的 effect journal。运行器不会调用真实 API、不会读取凭据，也不会产生供应商费用。报告中的时间是本机真实墙钟耗时，但只能用于确认本次门禁执行过，不能宣称真实 Provider 延迟或生产容量。

## 覆盖与判定

固定 seed `20260819` 的 GATE-30 有六类、每类 5 条：Model 响应窗口、Tool 副作用窗口、Return claim/consume 与父子反馈、Workflow stage、Snapshot 重载、多实例 Lease/Fencing 竞争。baseline 成功由重载后的生产状态不变量判定，而不是 runner 预设概率；核心指标包括 `duplicateModelCalls`、`duplicateToolEffects`、`unknownOutcome`、`evidenceCompleteness`、恢复结果和 `wallClockDurationMs`。

消融通过真实接线生效：`no-wal` 构造未接入生产 Model/Tool WAL 的 `AgentLoop`，`no-recovery` 在故障后停用生产恢复入口，`no-lease` 让两个真实 Runtime 实例绕过 `PersistentRuntimeLeaseStore` 竞争同一临时副作用。它们没有修改数学模拟变量。

## 命令

```text
npm run test:runtime-e2e
npm run benchmark:runtime-e2e:gate30
npm run benchmark:runtime-e2e:gate100 -- --shard 1/4
npm run benchmark:runtime-e2e:gate30 -- --variant baseline --case tool-effect-window-001
```

`--verify-determinism` 会完整复跑并比较排除真实墙钟/运行时间后的确定性结果投影。输出目录包含 `report.json`、`summary.csv`、`cases.csv`，失败用例在 `repro/` 下包含单条重跑命令。`results/` 整体被 gitignore；仓库只提交 fixture、schema、runner、测试和小型审计摘要。

## 防伪与局限

运行时 schema 会拒绝 `protocolSimulatorUsed=true`、缺少生产类清单、缺少 JSON 读写证据、缺少墙钟字段或 baseline 不变量失败的报告。JSON Schema 供外部工具审计，TypeScript 校验器负责本地强制门禁。

这仍不是进程/主机级混沌实验，也不测真实 Provider、网络、凭据、供应商账单或生产吞吐。Fake Tool 的副作用限定在 runner 创建的本机临时目录；真实跨主机文件系统与外部服务幂等性需要单独验证。
