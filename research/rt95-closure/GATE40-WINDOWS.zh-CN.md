# GATE-40 八窗口当前权威候选协议

> 状态：`candidate-not-frozen / local-pilot-only / NotVerified`。机器权威源为 `gate40-authoritative-protocol.json`。它固定当前 8 窗口×5 seed 本地候选协议，并记录 40/40 local pilot；不表示预注册已冻结、正式实验已执行或 GATE-40 已完成。

## 固定实验格

- 窗口顺序固定为下表 8 个 ID；不能缺项、重复、换序或临时改名。
- 每个窗口固定使用 5 个 seed：`469816031`、`3443330994`、`4121183031`、`3314624278`、`3472974415`。
- GATE-40 功能覆盖格为 `8×5=40` 个 window/seed case。当前草案另有 4 个实验 arm，因此完整配对草案是每 arm 40、合计 160 case；不能把 160 与 GATE-40 的 40 混称。
- `available` 仅表示生产 App Server 入口、真进程 Harness 和 Oracle 已有可执行接线；不表示 case 通过，更不表示 Verified。
- `blocked` 窗口不得用协议模拟、单元测试或同一窗口重复运行补数。

## 窗口清单

| 顺序 | 稳定窗口 ID | 故障注入点 | 生产入口 / Harness | Oracle | 预计 Artifact | 状态 |
|---|---|---|---|---|---|---|
| W01 | `FW-MODEL-RESPONSE-COMMIT` | model response received → invocation commit 前 | 真实 App Server 子进程 / Model WAL test-only hook | `ORACLE-MODEL-WAL-V1`：继任进程补交持久响应、Assistant 唯一、Provider 不重复 | runtime state、boundary report、失败最小复现 | `available` |
| W02 | `FW-TOOL-EFFECT-RECEIPT` | 本地 helper 效果发生 → Receipt commit 前 | 真实 App Server 子进程 / 独立本地 effect helper；不代表真实外部系统 | `ORACLE-TOOL-OUTCOME-V1`：known/unknown 正确、无盲重放和重复效果 | runtime state、成功 report、失败最小复现 | `available` |
| W03 | `FW-RETURN-RESPONSE-LEASE` | Return response received 且 Job Lease held → ready commit 前 | `node --import tsx src/app-server/main.ts` / `research/runtime-e2e-benchmarks/src/process-chaos-harness.ts` | `ORACLE-RETURN-LEASE-V1`：Return 恢复、Lease 到期前阻断、到期后单次消费、最终请求不重复 | runtime state、lease state、成功 report、失败最小复现 | `available` |
| W04 | `FW-RETURN-PERSISTED-CONSUME` | Return ready 持久化 → parent consume 前 | 真实 App Server 子进程 / Return boundary hook | `ORACLE-RETURN-CONSUME-V1`：Return 仅消费一次、父阶段仅推进一次 | runtime state、boundary report、失败最小复现 | `available` |
| W05 | `FW-LEASE-FENCED-COMMIT` | successor 获得新 token → stale owner commit 前 | 真实 App Server 子进程 / fenced boundary hook | `ORACLE-FENCING-V1`：旧 token 拒绝、仅 successor 改变权威状态 | runtime state、lease state、boundary report、失败最小复现 | `available` |
| W06 | `FW-WORKFLOW-STAGE-COMMIT` | product Stage Result 生成 → Evidence/Return/Checkpoint commit 前 | 真实 App Server 子进程 / workflow stage test-only hook | `ORACLE-WORKFLOW-COMMIT-V1`：持久 Model Result 不重取、Checkpoint/Evidence/Return 各唯一提交 | runtime state、boundary report、失败最小复现 | `available` |
| W07 | `FW-RECEIPT-COMMIT` | Tool Receipt 形成 → Invocation/Workflow 绑定 commit 前 | 真实 App Server 子进程 / 独立本地 effect helper；不代表真实外部系统 | `ORACLE-RECEIPT-V1`：稳定 Invocation ID 唯一绑定 Receipt、无第二次效果 | runtime state、成功 report、失败最小复现 | `available` |
| W08 | `FW-PROOF-COMMIT` | Proof Fragment verified → Completion Proof commit 前 | 真实 App Server 子进程 / 独立本地 effect helper；不代表真实外部系统 | `ORACLE-PROOF-V1`：新鲜度/摘要有效，缺片或矛盾不 completed，Final Receipt 唯一 | runtime state、成功 report、失败最小复现 | `available` |

每个 JSON 窗口都保存精确的 `injectionPoint`、`productionEntry`、`oracle`、`expectedArtifacts` 和 `readiness`。W03 成功 Raw 为 `process-chaos-<seed>/process-chaos-report.json`，W01/W04/W05/W06 为 `process-chaos-<seed>/process-chaos-boundary-report.json`，失败 Raw 为 `process-chaos-gate40-failures/<caseId>.json`；失败路径不能因没有成功 report 而被删除。

## 当前统一状态

截至 2026-08-24，W01～W08 均已有本地可执行接线。本机候选状态统一为：`candidate=40`、`runnable=40`、`passed-local-pilot=40`、`failed-local-pilot=0`、`blocked=0`、`formallyVerified=0`、`completeGate40=false`。本地 Pilot manifest 位于 `.tmp/gate40-pilot-40/process-chaos-gate40-pilot-manifest.json`。

这 40/40 只是同一台 Windows 主机上的 local pilot，不是冻结后的正式实验。W02/W07/W08 使用独立本地 helper，仍不是真实外部 Tool/系统；全部报告使用确定性 Fake Provider，`realApiCalls=0`、`credentialsRead=false`。任何窗口保持 available 必须持续满足：

1. 从 `src/app-server/main.ts` 启动真实 App Server 子进程；
2. 在该窗口的持久事实已经可观测后实施真进程强杀，而非调用协议模拟器；
3. 重启后由该窗口专属 Oracle 自动检查恢复、重复、错投、fencing 或 Proof 约束；
4. 无论成功或失败都落盘最小 Raw 与精确复现命令；
5. 同步更新权威协议、正反例测试；若接线退化，必须 fail-closed 降回 blocked，而不是保留陈旧数字。

## 冻结与 Claim 边界

当前 `preregistration.draft.example.json` 是为了旧最小 Validator 和负例保留的 **smoke 基础 Draft**，其中 1 available/7 blocked 不能再引用为当前实验口径。正式候选应由该 smoke 基础与 `gate40-authoritative-protocol.json` 确定生成，并保持：

```text
lifecycle.status=draft
lifecycle.frozenAt=null
faultPlan.windowSetLifecycle=candidate-not-frozen
verification.status=NotVerified
integrity.payloadSha256=null
```

权威协议 Validator 通过只表示“当前 8 窗口×5 seed 候选结构完整、40 条 local pilot 状态一致”。只有作者核定样本量、规则与摘要，写入 canonical 冻结时间并生成 payload digest 后，才能称输入被冻结；冻结仍不等于执行、独立复核或 Verified。

## 复试可用表述

可以说：“我把故障矩阵定义成 8 个候选窗口、每窗 5 个 seed，当前 40 个本机 Pilot case 全部通过。涉及 Tool 效果、Receipt 和 Proof 的窗口使用独立本地 helper，不是真实外部系统；Provider 也是离线 Fake。由于预注册尚未冻结、live call 为 0、没有第二环境独立复现，所以 formal Verified 仍是 0，我不会把 Pilot 说成完整 GATE-40。”
