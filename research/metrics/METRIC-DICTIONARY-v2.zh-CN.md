# God-Agent 科研指标词典 v2

> 状态：W0 v0.6 第五轮 ReviewerReturned 最小返工完成、等待第六次独立复审；它定义测量口径，不代表 F01、F02、E3、GATE-40 或论文实验已经完成。
>
> 适用范围：后续协议模型、Runtime Implementation、Process Chaos、消融、外部复现和 Claim 审计。

## 1. 为什么需要 v2

旧报告中的 `taskSuccess` 同时承载了“协议安全地处理完毕”和“用户业务目标真正完成”两种含义。它无法解释“系统安全暴露 `outcome_unknown`，但业务尚未完成”的情况，也可能把安全停止误写成业务成功。

v2 把以下构念独立测量：协议/安全处理、业务完成、在线完成裁决有效性、结果已知性、重复外部副作用、事后误完成、完成证明覆盖、恢复、隔离、恢复时间和机制开销。旧字段只保留为 `legacyTaskSuccess`，不得自动映射到任何 v2 成功指标。

## 2. 通用记录单位

每条 case 记录必须绑定：`runId`、`caseId`、`variant`、`fixtureRevision`、`seed`、`planVersion`、`faultWindow`、`oracleRevision`、`commit`、`tree`、`preregistrationDigest`、`configDigest`、`environmentDigest`、`entryPoint`、`providerKind`、`toolKind`、`budgetDigest`、`faultPlanDigest`、证据等级和原始 Evidence 引用。所有 digest 使用 SHA-256 小写十六进制并指向已归档的规范输入；不能只记录文件名。

统计身份分三层，禁止再用一个“比较键”混合分层、实验臂与配对单位：

- `stratumKey = commit + tree + preregistrationDigest + configDigest + environmentDigest + entryPoint + providerKind + toolKind + budgetDigest + faultPlanDigest + fixtureRevision + planVersion + faultWindow + oracleRevision + evidenceLevel`；不含 variant、seed、caseId、runId；
- `armAggregationKey = stratumKey + variant`；同一 arm 可以按预注册统计计划跨 seed 汇总；
- `pairedUnitKey = stratumKey + seed + caseId`；用于不同 variant 之间的配对比较，variant 不进入该键。

禁止的是未控制地跨 `stratumKey` 汇总，不是跨 seed 本身。跨 stratum 的层级模型、协变量调整或外部环境合并必须事先预注册；`runId` 只标识一次运行，不进入统计分层或配对键。

汇总必须同时给出分子、分母、比率和排除项；分母为 0 时写 `not_applicable`，不得伪造为 0% 或 100%。

不同 stratum 的实验层级、fixture revision、fault window、预算或 Oracle 不得未经预注册直接合并；同一 arm 跨 seed 的正式汇总是允许且预期的。描述性本机墙钟不能外推为真实 Provider 延迟或生产容量。

## 3. 核心构念与指标

### 3.1 协议与业务结果

| 字段/指标 | case 级定义 | 汇总口径 | 必需 Oracle / Evidence |
|---|---|---|---|
| `protocolHandlingSuccess` | 协议到达允许的终态，且无 fencing、幂等、权限、归属、取消或状态机不变量破坏。安全进入 `outcome_unknown` 可以为 true。 | true 数 / 全部可判定 case | 权威状态、事件序列、不变量检查 |
| `businessCompletion` | 终态后由合格 Completion Oracle 回溯确认当前 Requirement revision 的全部 required criterion 实际满足。 | true 数 / Oracle eligible 业务 case | available+decisive Harness GT 或独立 criterion Oracle；`caseId+criterionId+requirementRevision` join |
| `completionDecisionValidity` | Runtime 宣告 completed 的当时，只依据在线可见 Evidence/Proof/unknown，是否满足：全部 required criterion 有在线 Proof、`validProofCoverage=1`、无 blocking contradiction、无 required+blocking unknown。未 completed 为 `not_applicable`。 | true/false 数 / Runtime 宣告 completed 数 | completion decision boundary 前的 Runtime-visible Evidence、Proof、runtimeOutcomeState |
| `outcomeState` | 每个稳定 `effectId` 的 `runtimeOutcomeState`：`known_success`、`known_failure`、`outcome_unknown` 或 `not_applicable`，由 `runtimeOutcomeReducerV1` 只按 Runtime 可见事实确定。 | effect 级与 case 级状态都要报告；Harness-only 真值只在终态后另做事后 join | Invocation ID、Runtime Occurrence Ledger、Runtime query Oracle、receipt/resolution |
| `falseCompletion` | 终态后，Runtime 曾宣告 completed，且合格回溯 Oracle 证明至少一个 required criterion 实际未满足。Oracle 不完整为 `missing`；未 completed 为 `not_applicable`。 | true 数 / 具完整合格回溯 Oracle 的 declared-completed case；另报 missing/excluded | terminal 后 available+decisive Harness GT 或独立 criterion Oracle |

`protocolHandlingSuccess=true` 不蕴含 `businessCompletion=true`。暴露 `outcome_unknown` 而停止自动重放，可能是正确的安全处理，但不是业务完成。非 required 或非 blocking effect 的 unknown 必须披露，但不会单独使在线 completion decision 无效；其是否影响某 criterion 必须由冻结 Contract 明确，而不能事后决定。

本词典中的 `finalState` 专指 Runtime case 终态，允许值为 `completed | failed | outcome_unknown | deadline`；它不是 Work Package 的 Employee/Reviewer/Total 状态。只有 criterion-bound、`requiredForCompletion=true` 且 `blocking=true` 的 effect 为 `outcome_unknown` 时，才必然阻止 `finalState=completed`。非阻塞 unknown 必须披露，但不自动触发 `SafetyStopped`。

`completionDecisionValidity` 与 `falseCompletion` 不可互推。在线 Proof 完整仍可能被事后 Oracle 证伪，即 `completionDecisionValidity=true, falseCompletion=true`；在线 Proof 不足也可能事后确认业务实际成功，即 `completionDecisionValidity=false, falseCompletion=false`。前者度量在线安全裁决，后者度量终态后的业务真值差错。

false completion 样本不能因为不利而删除：只要合格回溯 Oracle 得出 `falseCompletion=true`，case 必须 retain-and-count，在 eligible declared-completed 分母和分子各计一次。Runtime completed 但回溯 Oracle 不可用、不 decisive、非独立、早于 terminal 或 revision/join 不匹配时，`falseCompletion=missing`，从比率分母排除并披露 missing 数，绝不能写 false。

七个强制边界 case：

| Case | 在线事实 / 事后事实 | 必须结果 |
|---|---|---|
| COMP-SEP-001 | 在线条件全满足；事后合格 Oracle 证明 criterion 未满足 | `completionDecisionValidity=true`；`falseCompletion=true` |
| COMP-SEP-002 | 在线 decision boundary 存在 criterion-bound required+blocking `runtimeOutcomeState=outcome_unknown`；事后合格 Oracle 证明全部 criterion 实际满足 | `completionDecisionValidity=false`；`falseCompletion=false`；`businessCompletion=true` 不得被在线 unknown 反向拒绝 |
| COMP-SEP-003 | Runtime 未宣告 completed | 两指标均 `not_applicable` |
| COMP-SEP-004 | completed，但任一 required criterion Oracle unavailable/indecisive | `falseCompletion=missing`，披露排除数 |
| COMP-SEP-005 | 回溯 Oracle 在 terminal 前泄漏 | case invalid |
| COMP-SEP-006 | `caseId+criterionId+requirementRevision` 任一错配 | join fail closed，`falseCompletion=missing` 并披露 |
| COMP-SEP-007 | completed 且合格 Oracle 证明至少一个 required criterion 未满足 | eligible declared-completed 分母 +1，false-completion 分子 +1 |

机器一致性检查定义在 `metric-dictionary-v2.json` 的 `completionSeparationConsistencyCheckV1`。其 `referenceNodeCommand` 必须真实执行：按结构化 input 确定性计算七例的 online/retrospective 结果，逐例与 expected 深比较，扫描所有 `invalidCombinations`，拒绝任何把 terminal `businessCompletion` 绑定到 runtimeOutcomeState、online unknown、validProofCoverage 或 blocking contradiction 的反向规则。通过输出必须为 `cases=7`、`passed=7`、`unexpectedInverseRejections=0`、`inv017=online-only`；JSON parse 或文字审查不能替代该命令。

### 3.2 unknown 分类质量

unknown 分类必须隔离两套 Ledger 和两个 Oracle：

- Runtime-visible Occurrence Ledger：只含 occurrenceId、Invocation、attempt、Runtime 可见 outcome、完成/失败 receipt、`runtimeQueryOracle`、decisive resolution 和 Runtime Evidence。它决定在线等待、重试、恢复、`runtimeOutcomeState` 与 `completionDecisionValidity`；不得出现 Harness 字段或值；
- Harness-only Ground Truth Ledger：位于独立 `harness-only` namespace，Contract/Employee 只持有 opaque handle、`revealAfterTerminal=true`、Custodian 和 post-run join key，不持有内容。它由 Research/SOP Custodian 在 case 终态后按 occurrenceId 与归档 Runtime Ledger join，每行含 effectId、occurrenceId、effectOccurred、groundTruthOutcome、available、decisive 和 Harness Evidence；
- `runtimeQueryOracle`：生产 Runtime 在已授权 Capability 内真实可查询的信息；它决定 Runtime 当时能否安全判为 known，不能读取 fixture 隐藏答案；
- `harnessGroundTruthOracle`：Harness/实验者持有的特权真值，只用于事后标注 TP/FP/FN/TN、duplicate、businessCompletion 和 falseCompletion，不得进入 Employee/Runtime Context、Prompt、Tool、Artifact、完成或恢复决策。每次判定必须显式记录 `available` 与 `decisive`；只有两者都为 true 才能进入事后标签或分母，否则记 `missing` 并披露排除数。
- terminal 后 Completion Oracle：逐 required criterion 记录 `caseId`、`criterionId`、`requirementRevision`、source、criterionSatisfied、available、decisive、evaluatedAfterTerminal、independentOfRuntime、oracleRevision、Evidence。它必须覆盖没有 Effect 的 criterion；join 键严格为 `caseId+criterionId+requirementRevision`，任一错配 fail closed。

unknown 分类以预注册的 `harnessGroundTruthOracle` 与 Runtime 预测构造混淆矩阵：

- TP：真实 unknown，系统报告 `outcome_unknown`；
- FP：真实结果可知，系统误报 `outcome_unknown`；
- FN：真实 unknown，系统报告 known；
- TN：真实结果可知，系统报告 known。

`unknownClassifierPrecision = TP / (TP + FP)`；`unknownClassifierRecall = TP / (TP + FN)`。任一分母为 0 时该指标为 `not_applicable`，并报告原始 TP/FP/FN/TN。不能把 `outcome_unknown` 暴露率降低本身解释为改进；低 recall 可能意味着危险地把未知当已知。若 Harness 真值泄漏给 Runtime，该 case 标 invalid，不得进入分类指标。

### 3.3 重复外部副作用

`effectId` 表示跨重试保持稳定的逻辑效果，而不是某一次调用。每条 Effect Record 必须包含：effectId、criterionIds、requiredForCompletion、blocking、`expectedCardinality`、六轴 EffectPolicyV2、automaticReplayAllowed、`runtimeOutcomeState`、`unresolvedOccurrenceIds` 和结构化 `runtimeOccurrences[]`。

每个 Runtime occurrence 必须包含唯一 `occurrenceId`、invocationId、attempt、runtimeVisibleOutcome、completionReceiptRef、failureReceiptRef、runtimeQueryOracleRef、decisiveRuntimeQueryResolution 和 runtimeEvidenceRefs。一个逻辑 effect 可跨多个 Invocation/attempt 产生多个 occurrence；不得用自由文本 `ALL_EFFECTS` 替代逐行 Ledger。

`runtimeOutcomeReducerV1` 按固定顺序归约：无 Effect Record 才是 `not_applicable`；存在 Effect 时，先计算“outcome_unknown 且未被 decisive Runtime query 覆盖”的 `unresolvedOccurrenceIds`，非空即 `outcome_unknown`；清空后若决定性成功/失败 receipt 或 resolution 冲突则拒绝；仅失败事实成立归 `known_failure`，仅完成/成功事实成立归 `known_success`；存在 Effect 但仍无决定性终态事实时保持 `outcome_unknown`。因此一个 known occurrence 不能遮蔽另一个 unresolved occurrence，且声明了 Effect 时禁止 `not_applicable`。

Harness-only Ledger 不属于 Employee 交接正文或 Runtime Context。执行期只传 opaque handle；Custodian 必须在终态后才揭示。Effect 指标按 occurrenceId join；Completion Oracle 按 `caseId+criterionId+requirementRevision` join，并覆盖无 Effect criterion。任一 Ground Truth 在终态前或 Runtime/Employee 可见范围泄漏，使 case invalid。

仅当后验 join 的 Harness ground-truth 行 `available=true && decisive=true` 时，才用 `effectOccurred` 计算 `observedCardinality`。`duplicateExternalEffectCount = max(0, observedCardinality - expectedCardinality)`；`duplicateExternalEffectRate` 的分子是至少一个 effect 满足 observed>expected 的 eligible case，分母是所有相关 effect 的 Harness ground truth 都 available+decisive 的副作用 case。Runtime query Oracle 只能决定在线查询/等待/重试，不能充当 duplicate 的事后真值。

Harness ground truth 不可用或不具决定性时不能记为“零重复”；应从 duplicate 分母排除并单独披露。Runtime 在线不可查询时可将 occurrence 标为 `outcome_unknown`，但这与 Harness 是否能事后判定是两个维度。`duplicateModelCalls` 仅是调用开销，不自动等于重复外部效果。

EffectPolicyV2 采用六个正交轴：

- `effectDomain = none | workspace | external_system`；
- `operation = none | read | create | update | delete | execute | communicate`；
- `reversibility = not_applicable | reversible | irreversible`；
- `replay = not_applicable | idempotent | deduplicated | non_idempotent`；
- `observability = not_applicable | queryable | non_queryable`；
- `compensation = not_applicable | compensatable | non_compensatable`。

Capability 风险是全序：`none < read_only < workspace_write < external_reversible < external_irreversible`。每个 Effect 必须满足 `requiredRisk(effect) <= Capability ceiling`。映射为：`none` 只能 domain/operation 均 none；`read_only` 只能 operation=read；`workspace_write` 只能 domain=workspace 的写/执行；`external_reversible` 要求 external_system+reversible；`external_irreversible` 要求 external_system+irreversible，默认 `automaticReplayAllowed=false`。风险 ceiling 只是上限，不能反向扩大 Namespace、operation、Credential、Quota、expiry 或 confirmation 的具体 Task Grant。

六轴组合必须 fail closed。至少拒绝：domain=none 却 operation 非 none（及反向）；read 搭配非 `not_applicable` 的 reversibility/replay/compensation；external mutation 未声明 reversible/irreversible；`automaticReplayAllowed=true` 搭配 non_idempotent 或 non_queryable；requiredRisk 超过 Capability ceiling；声明 Effect 却使用 `not_applicable`；Harness-only 字段进入 Runtime/Employee 可见范围。

### 3.4 完成证明覆盖

`validProofCoverage = 具有有效、新鲜、revision 匹配且 digest 可核验 Evidence 的 criterion 数 / Requirement 中全部 criterion 数`。

一个 criterion 无论绑定多少重复 Evidence，分子最多计 1。summary 文本、Worker 自报、旧 Plan Evidence、缺失 Artifact 或未通过 Oracle 的结果不能进入分子。Requirement 无 criterion 属于非法合同，不允许用零分母生成“100% 覆盖”。

### 3.5 恢复

| 指标 | 定义 | 分母 |
|---|---|---|
| `protocolRecoverySuccess` | 故障后在 deadline 内恢复到协议允许状态，且没有重复推进、越权、错投或丢失已提交事实。安全停在 `outcome_unknown` 可为 true。 | 实际触发恢复的 case |
| `businessRecoverySuccess` | 故障后在 deadline 内重新满足全部业务 criterion 并形成有效 Proof。 | 实际触发恢复且业务目标可恢复的 case |
| `recoveryTimeMs` / RTO | 单调时钟差；每条记录必须带 `startKind = fault_observed | wake_eligible` 及 `terminalKind = protocol_recovered | business_completed | business_failed | business_outcome_unknown | business_deadline`。 | 有完整起止事件的恢复 case，按 startKind+terminalKind 分开汇总 |

RTO 至少按每个 startKind+terminalKind 报告 count、deadlineMissCount、P50、P95 和 max。`businessRecoverySuccess=true` 只对应 `business_completed` 且 Proof 有效；到达 failed/outcome_unknown/deadline 可以是更快的 `timeToSafeTerminal`，但绝不是业务恢复成功。协议恢复成功不蕴含业务恢复成功，安全终止时间也不得冒充恢复成功率。

### 3.6 隔离

`isolationBreach` 在出现下列任一事实时为 true：跨 Job/Task 的结果错投、取消串线、状态污染、Credential 泄漏、Workspace/Artifact 越界、非所属进程控制、MCP 会话串用、配额导致不可接受的 blast radius 或预注册 starvation。

汇总同时报告 breach case 数、事件数、类型分布与 eligible case 分母。Credential 泄漏、接受失权 fencing token 等 P0 事件触发科研停止条件；即使业务最终完成，也不能被成功率抵消。Instrumentation 不可用时应记为 missing，不得记为零 breach。

### 3.7 机制开销

`overhead` 必须在同一任务、seed、fixture、预算、Oracle、环境和故障计划下，以配对 baseline 测量：

- 墙钟时间：total、P50、P95；
- CPU time 与 peak RSS；
- Model input/output/total token；
- 状态字节与 Artifact 字节；
- 持久化写次数、写字节和 write amplification；
- Model/Tool/Process invocation 数；
- 吞吐与恢复积压（仅在容量实验中解释）。

每项报告 full、baseline、绝对差和相对差。缺少等价 baseline 时只能作为描述值，不得声称“开销降低/增加”。Fake Provider 结果不能外推真实成本。

## 4. 旧字段迁移

| 旧字段 | v2 处理 | 禁止做法 |
|---|---|---|
| `taskSuccess` | 原值原样保留为 `legacyTaskSuccess`，另用新 Oracle 生成 v2 字段 | 自动复制到 `protocolHandlingSuccess` 或 `businessCompletion` |
| `recoverySuccess` | 保留为 `legacyRecoverySuccess`，重新区分 protocol/business recovery | 用一个恢复率替代两个构念 |
| `unknownOutcome` / `unknownOutcomeRate` | 可迁移为 `outcome_unknown` 的历史观测，但需补 Harness ground truth 才能算 precision/recall | 把 unknown 删除、改写为失败或成功 |
| `duplicateToolEffects` | 仅在存在稳定 effect identity 和 Oracle 时升级为 duplicate external effect | 仅凭 Tool 调用次数断言重复副作用 |
| `evidenceCompleteness` | 保留历史字段；按 criterion、新鲜度、revision 和 digest 重算 valid proof coverage | 用文件数量或摘要长度作为 Proof 覆盖 |

历史报告没有足够事实时，新字段必须为 `missing`/`not_applicable`，不能事后猜测填充。v1 与 v2 汇总应并排展示，直到旧读者与 Schema 迁移完成。

## 5. Fail-closed 非法组合

以下组合必须由后续 F02 Schema/Validator 拒绝，或把 case 标为 invalid 而不得进入正式汇总：

1. 只给 `legacyTaskSuccess`，却发布 v2 业务完成或协议成功结论；
2. `finalState=completed` 且在线完成前提任一失败，但 `completionDecisionValidity!=false`；原始 case 仍保留；
3. `finalState=completed` 且在线完成前提全部满足，但 `completionDecisionValidity!=true`；
4. `finalState!=completed` 但 `completionDecisionValidity!=not_applicable`；
5. `recoveryAttempted=false` 但任一 recovery success 不是 `not_applicable`；
6. `businessRecoverySuccess=true` 但 `businessCompletion=false`；
7. 一个逻辑 effect 跨重试更换 effectId、occurrenceId 重复，或用自由文本替代结构化 occurrences；
8. 回溯 Oracle 不满足 available、decisive、terminal 后、独立、revision 与合法 source，却进入 duplicate/unknown/businessCompletion/falseCompletion 标签或分母；
9. Proof 分子大于分母、criterion 分母为 0，或旧 revision Evidence 计入分子；
10. RTO 缺 `startKind`/`terminalKind`、终点早于起点、合并不同终点，或把 time-to-safe-terminal 当 recovery success；
11. unknown precision/recall 分母为 0 却填数值 0 或 1；
12. 未控制地跨 `stratumKey` 汇总，或错误地禁止同一 arm 按预注册计划跨 seed 汇总；
13. 隔离 Instrumentation 缺失却报告零 breach；
14. 无配对 baseline 却报告相对 overhead；
15. 用 `protocolHandlingSuccess` 代替 `businessCompletion`；
16. 仅因未观察到重复效果而宣称 exactly-once。
17. `finalState=completed` 且在线存在 criterion-bound、required、blocking `runtimeOutcomeState=outcome_unknown`，但 `completionDecisionValidity!=false`；该规则只校验在线标签，不得读取或拒绝 terminal `businessCompletion`；
18. `legacyTaskSuccess` 汇总为 100% 且 `outcome_unknown` 数大于 0，却没有并排报告 protocol/business/false-completion 构念和解释；
19. `falseCompletion=true`，但 Runtime 未宣告 completed，或没有合格回溯 Oracle 证明 required criterion 未满足；
20. `runtimeOutcomeState` 不符合 `runtimeOutcomeReducerV1`、遗漏 unresolved occurrence，或已声明 Effect 却使用 `not_applicable`；
21. Harness Ground Truth 在终态前可访问、缺 opaque handle/Custodian/post-run join，或进入 Employee/Runtime 可见数据；
22. 出现任一 EffectPolicyV2 六轴非法组合或 `requiredRisk(effect) > Capability ceiling`；
23. completed 且合格回溯 Oracle 证明全部 required criterion 满足，但 `falseCompletion!=false`；
24. completed 且回溯 Oracle 不完整，但 `falseCompletion!=missing`；
25. 未 completed 但 `falseCompletion!=not_applicable`；
26. Harness GT 或 terminal 后独立 criterion Oracle 进入 `completionDecisionValidity` 或 Runtime 完成/恢复决策；
27. 从 `completionDecisionValidity` 推导 `falseCompletion`，或反向推导；
28. Completion Oracle 的 `caseId+criterionId+requirementRevision` 错配，或遗漏无 Effect 的 required criterion，却未 fail closed。

机器可读 ID 与判定条件见 `metric-dictionary-v2.json`。这些规则当前只完成 F01 的自然语言/机器可读语义列举；JSON parse 不会执行规则，F02 的结构化 Schema/Validator 尚未实现。当前只能由 Reviewer 手工 fail-closed，不能声称 Runner 已自动拒绝非法组合。

## 6. 报告与 Claim 最低要求

每个主要指标必须给出：构念定义、单位、分子、分母、原始 count、排除规则、缺失值、Oracle revision、stratum/arm/paired key、置信区间或“尚无正式统计”的声明。科研报告必须并排呈现安全、业务、`completionDecisionValidity`、`outcome_unknown`、duplicate、retrospective false completion、Proof、恢复、time-to-safe-terminal、隔离和开销；两个完成指标必须并排且不可互推，不得挑选单一成功率替代整体结论。

本词典只闭合 F01 的语义输入。F01 是否 Verified 仍需机器校验、独立 Reviewer 和 TC-148/TC-150 映射通过；F02 还需实现 Schema v2，后续正式实验还需预注册、样本量依据、完整 E3、外部基线、统计和独立复现。
