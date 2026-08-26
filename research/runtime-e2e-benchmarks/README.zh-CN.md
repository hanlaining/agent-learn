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

## Process Chaos GATE-40 候选矩阵与本机 Pilot

`process-chaos-gate40.ts` 把 D11 的“8 窗口×5 seed”展开为 40 个稳定 case。每个 case 都有 `caseId`、`windowId`、`oracleId`、`seed`、状态和精确复现命令；运行时 Validator 与 JSON Schema 都拒绝缺项、重复、乱序、数量漂移、额外字段和越级 Claim。失败 case 会写入单独的最小复现报告，不能只留下汇总。

当前仓库没有已冻结的 8 窗口清单：`research/rt95-closure/preregistration.draft.example.json` 仍为 Draft，且只列 4 个窗口。因此这里的 8 个 ID 是依据 RT95-603/604、EXP-RT95-032/034 整理的候选分解，不是事后冒充的冻结预注册。Manifest 固定为：

- `lifecycle=candidate-not-frozen`；
- `claimBoundary=local-pilot-only-not-gate40`；
- `formallyVerifiedCaseCount=0`；
- `completeGate40=false`；
- `independentReview=NotReviewed`。

现有生产 App Server 真进程 Harness 已接通三个候选窗口：`FW-RETURN-RESPONSE-LEASE`、`FW-RETURN-PERSISTED-CONSUME`、`FW-LEASE-FENCED-COMMIT`。W04 会在 Lead Return 的 `ready/attempts=0` 已写入生产 JSON、父阶段尚未消费时，通过仅限测试环境的文件握手停住真实子进程，再强杀并由新 App Server 的生产恢复入口完成；Oracle 要求 Return `attempts=1`、`return_god` Checkpoint/Evidence 各唯一一条、重复推进不改变状态。W05 会让旧 App Server 停在同一持久边界，测试时钟越过 Lease TTL 后由第二个真实 App Server 取得更高 fencing token 并唯一提交；释放旧进程后必须收到持久 Lease/CAS 的真实 `fencing token mismatch`，随后强杀旧进程并由第三个审计进程重载权威终态。

故障握手只有同时满足 `NODE_ENV=test`、显式 `PROCESS_CHAOS_TEST_ONLY_FAULT_WINDOW` 和绝对 `PROCESS_CHAOS_TEST_ONLY_CONTROL_DIRECTORY` 才会启用；生产默认路径没有停顿或额外写入。三个窗口×5 个 Draft seed 共 15 个 case 可作为本机窄范围 E3 pilot 运行；其余 25 个 case 继续 fail-closed 标为 `blocked`，不运行协议模拟来补数。两个新增窗口使用 `process-chaos-boundary-report-v1` Raw 与专用 JSON Schema；所有报告仍强制 `completeGate40=false`、`exactlyOnceClaimed=false`、`productionReadyClaimed=false`。

```text
node --import tsx research/runtime-e2e-benchmarks/src/process-chaos-gate40.ts --output .tmp/process-chaos-gate40
node --import tsx --test research/runtime-e2e-benchmarks/tests/process-chaos-gate-test.ts
```

只有总控冻结 8 窗口、seed、oracle、排除/重跑/停止规则和摘要，剩余 5 个缺失窗口全部接入生产 App Server 故障点，40 条成功/失败 Raw 完整保存并经独立 Reviewer 与总控验收后，`EXP-RT95-032` 才可能从 `NotVerified` 转为 Verified。即使 GATE-40 完成，也只能称 E3 功能覆盖，不能替代正式重复、统计、真实 Provider/副作用或 E4。
