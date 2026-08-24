# God-Agent RT95 Work Package 派发、交接与验收 SOP

> 版本：v1.5-W0-fifth-ReviewerReturned-remediation
> `frozenSopDigest`：`ae7fb1bb893139fa6963b948bd35970fade84548951ac22f4cf71f9fc55bf6fe`
> 目标：让一个新 Chat 仅凭冻结 Contract、仓库和 Evidence 入口，独立执行、失败留痕并交给 Reviewer/总控裁决。
> 边界：SOP 与模板存在只算 E1 文档事实；未经外部 Pilot、Session Log 和 TC-REP-003/004/007 验证，G03 不得标为 Verified。

## 1. 角色与权威

| 角色 | 职责 | 无权执行 |
|---|---|---|
| 总控 | 冻结 Requirement/Plan/baseline，分配文件与 Capability，解决冲突，作唯一 Verified/Return 裁决 | 不得把员工“完成”直接当 Verified |
| Employee Chat | 在 Contract 边界内实现/分析、自测、记录负结果并交接 | 不得扩权、改 Claim、Merge 或隐瞒失败 |
| Independent Reviewer | 只读审查、独立复验、攻击非法组合，输出 Accepted/Returned | 不得修改产物后自审通过 |
| Research/SOP Custodian | 维护指标、SOP、Artifact/Claim 保管链和复现记录 | 不得为通过实验改变生产 Runtime 语义 |
| 用户/授权人 | 批准超出 Contract 的权限、危险副作用和 Git/外部动作 | 授权必须绑定明确范围 |

Requirement、Lifecycle、Job/Task/Run、Proof 和 Artifact 各自只能有一个权威来源。文档投影、UI、员工摘要均不能写回或替代权威事实。

## 2. Digest、规范化与版本规则

三个身份字段必须出现在 Contract、成功 Handoff 和 Failure Handoff：

- `contractDigest`：绑定当前冻结 Contract 内容；
- `supersedesContractId`：首版为 `none`，后续 revision 必须指向被替代 Contract ID；
- `frozenSopDigest`：绑定执行者实际收到的 SOP，而不是仓库中事后更新版本。

唯一规范版本为 `god-agent-c14n-v1`，严格按以下顺序执行，任何换序均为不同算法并必须拒绝：

1. 读取原始 bytes；若前三字节为 UTF-8 BOM `EF BB BF`，立即拒绝，不允许静默剥离；
2. 使用 fatal UTF-8 解码，非法字节立即拒绝；
3. 对整个字符串执行 Unicode NFC；
4. 先把 CRLF 转 LF，再把剩余 CR 转 LF；
5. 执行目标选择：Contract 做 marker extraction；SOP 做 self-reference replacement；
6. 从目标文本末尾移除所有 LF，再恰好追加一个 LF；不裁剪空格、不重排字段；
7. 对最终 UTF-8 bytes 计算 SHA-256，输出 64 位小写十六进制。

Contract marker 规则：规范换行后，`<!-- CONTRACT-FROZEN-BEGIN -->` 与 `<!-- CONTRACT-FROZEN-END -->` 必须各自独占一行且恰好出现一次。Begin marker 行及其后 LF 属于 marker、排除；target 从该 LF 后第一个字符开始。End marker 从 `<` 开始即排除，End marker 行及其后 LF 也排除；End marker 前用于结束正文行的 LF 属于 target，随后由第 6 步统一为恰好一个尾 LF。缺失、重复、逆序或 marker 行含其他字符一律拒绝。

SOP self-reference 规则：完成 NFC 与换行规范后、执行尾 LF 处理前，必须恰好找到一行 ``> `frozenSopDigest`：`<value>`  ``，只把 `<value>` 替换为字面量 `<FROZEN_SOP_DIGEST_EXCLUDED>`，保留该行其他字符和两个尾随空格；找不到或多于一处即拒绝。摘要整个替换后的 SOP。

`research/metrics/canonical-digest-kat-v1.json` 是 W0 canonicalization manifest：包含合法 fixture、BOM 负例、规范输出、权威 digest、参考 Node 命令和当前 SOP 的真实 self-excluded digest。实现只有同时匹配 KAT 和 SOP digest 才可声称 `god-agent-c14n-v1`。

冻结区或 Frozen SOP 的任何语义/文字修改都必须创建新 revision/新 ID，设置 `supersedesContractId`、重算 digest 并重新 Accepted。禁止原地覆盖后继续使用旧 digest。执行日志、状态事件和三层 verdict 位于 Contract 冻结区外，只能追加，不能改写冻结条款。

## 3. 状态与退出条件

```text
Draft
→ Accepted
→ InProgress
→ EmployeeComplete | EmployeeFailed | Blocked | SafetyStopped
→ ReviewerAccepted | ReviewerReturned
→ TotalAccepted | TotalReturned
```

- `Draft`：字段未冻结，不得执行；
- `Accepted`：总控已绑定 baseline、scope、Capability、Verifier、deadline 和命令；
- `EmployeeComplete`：员工提交了完整 Evidence 包，不代表验收通过；
- `ReviewerAccepted`：独立审查通过，仍等待总控核对全局冲突和门禁；
- `TotalAccepted`：总控唯一可发布的 Verified 状态；
- P0、越权、Evidence 污染、baseline 偏移或 required+blocking `outcome_unknown` 进入 Failure/`SafetyStopped` 流程。非 required 或非 blocking unknown 必须披露，但不自动 `SafetyStopped`。`outcome_unknown` 是 Runtime case/occurrence outcome，不是 Work Package 状态。

`finalState` 只表示 Runtime case：`completed | failed | outcome_unknown | deadline`。Failure Report 的审查状态另用 `FailureReportAccepted | FailureReportReturned | NotReviewed`，不得冒充 Work Package 的 `ReviewerAccepted/ReviewerReturned`。

状态变更必须记录时间、操作者、reason、generation 和 Evidence。消息摘要不得单独推进状态。

## 4. 派发前：总控冻结 Contract

总控复制 `RT95-WORK-PACKAGE-TASK-CONTRACT.template.md`，完成以下十类强制信息：

1. 身份、Requirement revision、Plan version、baseline、`contractDigest`、`supersedesContractId`、`frozenSopDigest` 与负责人；
2. objective、scope、nonGoals 和不得夸大的表述；
3. 输入、前置依赖、权威事实与起点检查；
4. allowed/forbidden files、Artifact/Workspace namespace 和并发 File Claim；
5. Capability、Credential handle、token/time/tool/process/output/disk quota；
6. requiredOutputs、criterion、Verifier/Oracle 与 Evidence 路径；
7. 生产不变量、故障模型、EffectPolicyV2、Capability 风险全序、Runtime-visible Effect/Occurrence Ledger、在线 completionDecisionValidity、Harness-only/独立 criterion Oracle opaque binding 与安全停止条件；
8. 执行、wait predicate、retry/idempotency、heartbeat、recovery 和 guidance 边界；
9. 正向、反向、并发、恢复测试与精确命令；
10. Artifact/Evidence/Claim、负结果、人工介入、回滚、Git 边界和三层 verdict。

任何 `{{...}}` 未替换，或 baseline/Verifier/命令使用“自行决定”等泛化默认值，Contract 均保持 Draft。Task 合同不能用“测试通过”“功能完成”等无 Oracle 文本代替用户验收条件。

## 5. 接单检查：Employee 必须 fail closed

Employee 开始前逐项确认：

- baseline 与实际工作树/交付包可核对；
- 所有依赖已由权威 verdict 满足；
- 目标文件没有与其他员工重叠写 Claim；
- Capability 是最小交集，凭据只有 Handle；
- 副作用、等待、重试、deadline 和恢复语义明确；
- 每个 criterion 有独立 Verifier/Oracle；
- W0 命令只使用 `none | deterministic_fake` Provider，预期真实 Provider 调用数为 0；未来真实 Provider 条件必须由新 Contract/预注册/Capability/预算/用户授权定义；
- 回滚点不会删除失败 Evidence。

有任一冲突时不得自行补默认值。使用 Failure 模板标记 Blocked，向总控提出一个具体问题，并保留只读取证。

## 6. EffectPolicyV2、双 Ledger、Capability 与 Oracle

EffectPolicyV2 使用六个正交轴：effectDomain、operation、reversibility、replay、observability、compensation；枚举以 Metric Dictionary 和模板表头为准。Capability 风险是全序：

- `none`：domain/operation 均 none；
- `read_only`：只允许 read，不得产生写 effect；
- `workspace_write`：只允许 workspace 的 create/update/delete/execute；
- `external_reversible`：external_system 且 reversible；
- `external_irreversible`：external_system 且 irreversible，默认 automaticReplayAllowed=false。

必须满足 `requiredRisk(effect) <= Capability ceiling`，其中 `none < read_only < workspace_write < external_reversible < external_irreversible`。风险名相等也不能扩大 Namespace、operation、Credential、Quota、expiry 或 confirmation 的实际 Grant。domain/operation none 不一致、read 搭配非 N/A mutation 属性、external mutation 缺 reversibility、automatic replay 搭配 non_idempotent 或 non_queryable、requiredRisk 超过 ceiling 等组合一律 fail closed。

每个逻辑 effect 必须有跨重试稳定的 effectId、criterionIds、requiredForCompletion、blocking、expectedCardinality、全部策略轴、automaticReplayAllowed、runtimeOutcomeState、unresolvedOccurrenceIds 和结构化 runtimeOccurrences。Runtime Occurrence Ledger 只记录 occurrenceId、invocationId、attempt、runtimeVisibleOutcome、完成/失败 receipt、Runtime query Oracle、decisive resolution 和 Runtime Evidence；禁止以自由文本 `ALL_EFFECTS` 代替 Ledger，禁止携带 Harness 字段或值。

`runtimeOutcomeReducerV1` 是确定性规则：没有 Effect Record 才能得到 `not_applicable`；存在 Effect 时，所有 outcome_unknown 且未被 decisive Runtime query 覆盖的 occurrenceId 组成 unresolvedOccurrenceIds，非空即 runtimeOutcomeState=outcome_unknown；清空后若成功/失败的决定性 receipt 或 resolution 冲突则拒绝；只有失败事实归 known_failure，只有完成/成功事实归 known_success；仍无决定性事实则 outcome_unknown。一个 known occurrence 不能遮蔽另一个 unresolved occurrence。

Harness Ground Truth 与独立 criterion Oracle 必须位于隔离 namespace。Contract 与执行期只携带 opaque handle、`revealAfterTerminal=true`、Custodian 和 join 规则，Employee/Runtime access 均为 denied。Research/SOP Custodian 只能在 Runtime case 终态后揭示：Effect 指标按 occurrenceId 与 Runtime Ledger join；Completion Oracle 必须覆盖所有 required criterion，包括没有 Effect 的 criterion，并严格按 `caseId+criterionId+requirementRevision` join。每条 Completion Oracle 记录 source、criterionSatisfied、available、decisive、evaluatedAfterTerminal、independentOfRuntime、oracleRevision 和 Evidence。任一 join 分量错配都 fail closed。

`observedCardinality > expectedCardinality` 才是 duplicate。只有 post-run Harness join 中全部相关行 `available=true && decisive=true`，才能按 effectOccurred 计算 observed、duplicate 和 unknown classifier；否则记 missing 并披露排除数。Runtime query Oracle 只服务在线查询、等待和重试，不能充当事后真值。

必须分离两个完成构念：

- `completionDecisionValidity` 是 Runtime 在线安全判定。Runtime 宣告 completed 时，只使用 decision boundary 前可见的 criterion Evidence、Completion Proof、blocking contradiction 和 runtimeOutcomeState；全部 required criterion 有在线 Proof、validProofCoverage=1、无 blocking contradiction、无 required+blocking unknown 才为 true，否则为 false；未 completed 为 not_applicable。Harness GT 与 terminal 后 criterion Oracle 严禁作为输入。
- `falseCompletion` 是终态后的回溯标签。只有 completed 且 available+decisive Harness GT 或独立 criterion Oracle 在 terminal 后证明至少一个 required criterion 实际未满足才为 true；合格 Oracle 证明全部满足为 false；completed 但任一 required criterion Oracle 不合格为 missing 并披露排除数；未 completed 为 not_applicable。

两个指标不可互推：在线有效仍可能事后假完成；在线无效仍可能事后业务成功。falseCompletion=true 的 case 必须保留，在 eligible declared-completed 分母和分子各计一次，不能作为“非法 case”删除。回溯 Oracle 值在 terminal 前进入 Employee/Runtime Context、Prompt、Tool、Artifact、完成或恢复决策，使 case invalid。

强制验收七例：在线有效/事后假完成；在线存在 required+blocking `runtimeOutcomeState=outcome_unknown` 但事后 Oracle 证明全部 criterion 实际满足；未 completed 时两者均 not_applicable；Oracle unavailable/indecisive 时 falseCompletion=missing 且披露排除；terminal 前泄漏使 case invalid；`caseId+criterionId+requirementRevision` 错配 fail closed；假完成在 eligible declared-completed 分母和分子各计一次。

七例必须执行 Metric JSON 的 `completionSeparationConsistencyCheckV1.referenceNodeCommand`。该命令确定性复算 structured input/expected，并扫描 `invalidCombinations`；通过输出必须包含 `cases=7`、`passed=7`、`unexpectedInverseRejections=0`、`inv017=online-only`。任何把 terminal `businessCompletion` 与 runtimeOutcomeState/online unknown/Proof 缺口/contradiction 绑定的规则均使审查失败。

只有 effect 绑定 criterion、`requiredForCompletion=true` 且 `blocking=true` 时，`runtimeOutcomeState=outcome_unknown` 才必然阻止 Runtime case `finalState=completed`；非阻塞 unknown 仍披露但不自动 SafetyStop。

恢复时间每条记录必须有 `startKind=fault_observed|wake_eligible` 和 `terminalKind=protocol_recovered|business_completed|business_failed|business_outcome_unknown|business_deadline`，按组合分别汇总。只有 business_completed 且 Proof 有效才是 businessRecoverySuccess；到达 failed/outcome_unknown/deadline 只形成 time-to-safe-terminal，不能冒充恢复成功。

## 7. 执行与 Session Log

每个关键动作记录：时间与时区、命令/事件、输入 revision/seed、exit、stdout/stderr 相对路径、Artifact digest、Capability/Quota 消耗、人工介入和异常。Runtime 事件不得包含 Harness-only 真值。推荐日志事件：

```text
accepted → started → progress → blocked → guidance-received
→ evidence-produced → test-finished → employee-terminal
```

非关键 progress 可合并，但 started、blocked、guidance、Evidence 和 terminal 不得丢失。工具输出只能投递给归属 Invocation/Task；迟到或失权 generation 的结果只记录，不得推进业务状态。

出现失败时先保存现场，再决定是否重试。没有稳定 effectId/occurrenceId，或 observability=non_queryable 且策略未授权时，禁止自动重放，将 Runtime occurrence 记为 `outcome_unknown` 并由 reducer 进入人工裁决。不得为了让测试变绿临时更换 seed、fixture、预算、Oracle、排除规则或 baseline。

## 8. 指导与人工介入协议

所有指导都记录：发送者、接收者、时间、原消息、目标 Task/generation、原因、生效消息边界、是否改变 Contract/Plan、Employee 的确认事件。

- 澄清既有冻结文字：不改 Plan，但仍记 clarification；
- 补充上下文或实现建议：记 substantive guidance；
- 改 scope、criterion、预算、权限或依赖：必须创建新 Contract/Plan revision，旧执行结果不能自动证明新 revision；
- Reviewer 修改产物：破坏独立审查，必须换 Reviewer 或重新开始 review。

外部无指导复现不能靠勾选 `blind`。Handoff 必须包含：签名式独立性声明、此前参与代码/WP/fixture/实验/审查的记录、实际收到的 Frozen SOP/Artifact/源码/lock/config digest、全部通信渠道与参与者、Session Log ref/digest、Guidance Audit ref/digest。Reviewer 根据这些事实派生 `blind | guided | invalidated | not_applicable`；任一字段缺失、存在未登记渠道或作者提供实质指导，均不得判 blind。guided 不得计入 TC-REP-003/007 的 blind reproduction。

## 9. 成功交接

Employee 认为完成时填写 `RT95-WORK-PACKAGE-HANDOFF.template.md`，至少提交：

- Contract/baseline/Plan 身份；
- 完整文件清单和未声明 diff 检查；
- 每条验收命令、时间、exit、stdout/stderr；
- criterion→Evidence→Verifier 映射与 Artifact digest；
- 正向、反向、并发、恢复结果；
- 所有失败、flake、偏差、guidance 和人工介入；
- 每个 effect 的稳定身份、criterion/required/blocking、expectedCardinality、EffectPolicyV2、requiredRisk/Capability ceiling、runtimeOutcomeState、unresolvedOccurrenceIds、Runtime-visible occurrences，以及残留进程/锁/临时文件和 quota；
- Runtime 在线 `completionDecisionValidity` 的 decision-boundary raw input 与裁决；
- Harness-only/独立 criterion Oracle 的 opaque handle、Custodian、revealAfterTerminal 和两类 join 证明；Employee terminal 后由 Custodian 补充按 occurrenceId 的 Effect join、按 `caseId+criterionId+requirementRevision` 的 Completion join，不能回灌 Employee/Runtime；
- retrospective `falseCompletion` 的逐 criterion Oracle reconciliation、eligible/missing 统计及分子分母；
- 逐 effect duplicate reconciliation raw 表（expected、observed、GT eligibility、duplicate、Evidence）和逐 case RTO raw 表（typed 起止事件、单调时间、delta、Proof、Evidence），禁止只用摘要文本或聚合值替代；
- 最大允许 Claim、限制、回滚点和 Git 动作清单。

Employee verdict 只能是 `EmployeeComplete`。文件存在、编译通过、单元测试通过、真实进程检查和生产可用是不同证据等级，必须分别表述。

## 10. 失败、阻塞与安全停止交接

使用 `RT95-WORK-PACKAGE-FAILURE.template.md`，保留首次失败及每次复跑。至少说明：预期/实际、原始错误、Environment/seed/revision、Evidence 缺口、副作用结果、残留资源、是否触发 P0、可证伪假设、最小下一步诊断和 Claim 降级。

下列情况立即停止扩大运行并通知总控：接受旧 fencing token、双 Owner 提交、策略判定不可自动重放却发生重放、required+blocking unknown 却 completed 且 completionDecisionValidity 未标 false、跨 Job 泄漏、Credential 暴露、Artifact 无法解释变化、Instrumentation 丢关键事件、Runtime query Oracle 与 Harness ground truth 串线、任何回溯 Oracle 在 terminal 前揭示、Completion Oracle join 错配、风险超过 Capability ceiling、环境/Commit/fixture 偏离预注册、W0 意外真实 Provider 调用、残留进程不收敛，或正式实验中临时改变 seed/排除规则/主要指标。

未知根因必须保持 unknown。后续连续成功只说明“未再次复现”，不能自动写成“已修复”。

## 11. Reviewer 独立验收

Reviewer 按以下顺序执行：

1. 核对 Contract、baseline、Requirement/Plan revision 和文件所有权；
2. 阅读全部改动和 Evidence，不依赖 Employee summary；
3. 对每个 criterion 检查 Evidence 来源、新鲜度、digest、命令、exit 和 Oracle；
4. 独立运行针对性正向/反向/并发/恢复检查；
5. 攻击权限、Namespace、Quota、`requiredRisk<=Capability ceiling`、六轴非法组合、取消/迟到、required/blocking unknown、runtimeOutcomeReducer、多 effect/occurrence、Harness/criterion Oracle opaque/reveal/join 隔离、Oracle availability/decisiveness/泄漏、无 Effect criterion 覆盖、逐 effect duplicate reconciliation、逐 case RTO raw ledger、completionDecisionValidity/falseCompletion 不可互推；执行七例一致性命令并确认零反向拒绝；
6. 核对负结果未删除、人工介入完整、Claim 未越级；
7. 输出 `ReviewerAccepted` 或逐条带 Evidence 的 `ReviewerReturned`。

Reviewer 不得在同一轮修改 Employee 产物并自审通过。条件冲突、P0 或返工耗尽时交总控触发独立 Arbiter，而非多数投票。

## 12. 总控最终验收

总控执行：员工自测 → 独立 Reviewer → 针对性攻击矩阵 → 全量回归 → 真实进程门禁（适用时）→ 文档/证据一致性 → Artifact/Claim 审查。只有全部 P0、criterion、Proof 和未决副作用合取通过，才能标 `TotalAccepted`；Verified 是对该状态的解释，不是另一个拼写。

总控还必须核对工作树、目标分支、文件清单和用户对 Git/外部动作的明确授权。Employee 与 Reviewer 均无权自行 Commit/Push/PR/Merge；SOP 不扩大任何 Git 权限。

## 13. 可复现性分类

| 等级 | 最低条件 | 当前不能替代它的证据 |
|---|---|---|
| guided pilot | 新环境按 SOP 执行，但作者有实质指导 | 同作者旧工作区复跑 |
| blind pilot | 一名未参与者仅获 digest 匹配的冻结 SOP/Artifact；独立性、既往参与、全部渠道、Session Log 和 Guidance Audit 完整，且 Reviewer 派生为 blind | 自报勾选 blind 或同机干净副本 |
| 独立复现 | 至少两名复现者/两个环境，绑定源码/lockfile/命令/Artifact/签名 | GATE-40 或测试数量 |
| E4 | 独立复现、外部基线、正式重复统计、Claim 审核和完整保管链共同成立 | 单个 E3 Process Check |

对应门禁：TC-REP-003（独立性）、TC-REP-004（Session Log）、TC-REP-007（Guidance 审计）。发现作者实质指导必须诚实降级，不得换措辞保留 blind 标签。

## 14. 文件入口与最小 Pilot

模板入口：

- `docs/God-Agent-科研项目/templates/RT95-WORK-PACKAGE-TASK-CONTRACT.template.md`
- `docs/God-Agent-科研项目/templates/RT95-WORK-PACKAGE-HANDOFF.template.md`
- `docs/God-Agent-科研项目/templates/RT95-WORK-PACKAGE-FAILURE.template.md`
- `docs/God-Agent-科研项目/templates/examples/W0-F01-example.md`

最小 G03 Pilot 应选择一个只新增文件、无外部副作用、15–30 分钟可完成的 WP。总控冻结 Contract 后交给从未参与该 WP 的新 Chat；观察其是否无需口头补充即可完成起点检查、执行、失败留痕和交接。所有提问与回复进入 Session Log。Reviewer 独立复验后，按歧义数、未声明介入数、Contract 缺字段数和 Evidence 缺口数决定修订模板。

Pilot 成功也只证明该 WP/环境下 SOP 可执行；G03 Verified 还需预注册判定、TC-REP-003/004/007、独立 Reviewer 和总控裁决。
