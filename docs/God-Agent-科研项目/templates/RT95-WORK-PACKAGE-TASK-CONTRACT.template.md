# RT95 Work Package Task Contract

> 模板版本：v1.4-W0-fifth-ReviewerReturned-remediation
> Work Package 状态：`Draft | Accepted | InProgress | EmployeeComplete | EmployeeFailed | Blocked | SafetyStopped | ReviewerAccepted | ReviewerReturned | TotalAccepted | TotalReturned`
> 规则：所有 `{{...}}` 必须由总控填写；缺少 baseline、边界、Verifier 或验收命令时不得开始。`EmployeeComplete` 不等于 Verified。
>
> `contractDigest`：`{{CONTRACT_DIGEST_SHA256_LOWER_HEX}}`，规范版本 `god-agent-c14n-v1`。严格顺序为：拒绝 BOM → fatal UTF-8 解码 → NFC → CRLF/CR 转 LF → 提取冻结区 → 移除全部尾 LF 后补一个 LF → SHA-256 小写十六进制。精确定义与 KAT 见绑定 Frozen SOP。冻结区任何修改都必须创建新 Contract ID/revision，填写 `supersedesContractId` 并重算摘要，禁止原地覆盖。

<!-- CONTRACT-FROZEN-BEGIN -->

## 1. 身份与版本

| 字段 | 值 |
|---|---|
| Contract ID | `{{CONTRACT_ID}}` |
| Contract revision / `supersedesContractId` | `{{CONTRACT_REVISION}} / {{SUPERSEDES_CONTRACT_ID_OR_NONE}}` |
| `frozenSopDigest` | `{{FROZEN_SOP_SHA256_LOWER_HEX}}` |
| Work Package ID / 父项 | `{{WP_ID}} / {{PARENT_RT95_ID}}` |
| Requirement revision / hash | `{{REQUIREMENT_REVISION}}` |
| Plan version / generation | `{{PLAN_VERSION}} / {{GENERATION}}` |
| Baseline Commit / Tree / Artifact | `{{BASELINE_COMMIT}} / {{TREE_ID}} / {{ARTIFACT_BASELINE}}` |
| 派发者 / Employee / Reviewer / 总控 | `{{DISPATCHER}} / {{EMPLOYEE}} / {{REVIEWER}} / {{CONTROLLER}}` |
| 创建、截止与时区 | `{{CREATED_AT}} / {{DEADLINE}} / {{TIMEZONE}}` |

## 2. 目标、范围与非目标

### 2.1 Objective

`{{ONE_VERIFIABLE_OBJECTIVE}}`

### 2.2 Scope

- `{{IN_SCOPE_1}}`
- `{{IN_SCOPE_2}}`

### 2.3 Non-goals

- `{{NON_GOAL_1}}`
- `{{NON_GOAL_2}}`

### 2.4 不得夸大的表述

- 允许表述：`{{MAXIMUM_ALLOWED_CLAIM}}`
- 禁止表述：`{{FORBIDDEN_CLAIM}}`

## 3. Baseline、输入与依赖

- 权威事实来源：`{{AUTHORITY_SOURCE}}`
- 输入文件/Artifact 及 digest：`{{INPUTS_WITH_DIGEST}}`
- 前置 WP 与状态：`{{DEPENDENCY_IDS_AND_VERDICTS}}`
- 假设与待确认项：`{{ASSUMPTIONS_OR_NONE}}`
- 起点检查：目标文件、工作树、环境、旧输出、Provider/凭据边界均须记录。

### 3.1 独立复现输入（不适用也必须写理由）

- 复现者独立性声明要求：`{{INDEPENDENCE_DECLARATION_REQUIREMENT}}`
- 此前参与该代码/WP/实验：`{{PRIOR_INVOLVEMENT_OR_NONE}}`
- 只允许收到的 Frozen SOP/Artifact digest：`{{ALLOWED_SOP_AND_ARTIFACT_DIGESTS}}`
- 唯一通信渠道：`{{AUTHORIZED_COMMUNICATION_CHANNELS}}`
- Session Log / Guidance Audit 预期路径：`{{SESSION_LOG_REF}} / {{GUIDANCE_AUDIT_REF}}`
- 分类由 Reviewer 根据日志裁决，Employee 不得自行勾选 blind。

## 4. 文件所有权与 Namespace

### 4.1 允许读取/修改/新增

| 路径或 Namespace | 权限 | 用途 |
|---|---|---|
| `{{ALLOWED_PATH}}` | `read | modify | add` | `{{PURPOSE}}` |

### 4.2 禁止修改

- `{{FORBIDDEN_PATH_OR_CLASS}}`
- 未列入允许清单的文件默认禁止写入。

### 4.3 并发 File Claim

- 独占写 Claim：`{{EXCLUSIVE_WRITE_CLAIMS_OR_NONE}}`
- 可共享只读 Claim：`{{SHARED_READ_CLAIMS}}`
- 冲突处置：发现重叠写、未知 diff 或生成物时立即停止并通知总控，不自行覆盖或回滚。

## 5. Capability、Namespace 与 Quota

有效权限采用交集：`AgentProfile ∩ Job ∩ Task ∩ Workspace ∩ UserConfirm`，Child 不得自行扩大。

| 能力 | Namespace / Handle | 风险级别 | 额度 | 到期/确认 | 是否允许 |
|---|---|---:|---:|---|---|
| Model | `{{MODEL_SCOPE}}` | `{{RISK}}` | `{{TOKEN_QUOTA}}` | `{{EXPIRY}}` | `yes/no` |
| Tool / Skill | `{{TOOL_SKILL_SCOPE}}` | `{{RISK}}` | `{{INVOCATION_QUOTA}}` | `{{CONFIRM_POLICY}}` | `yes/no` |
| MCP / Credential | `{{MCP_CREDENTIAL_HANDLES}}` | `{{RISK}}` | `{{CALL_QUOTA}}` | `{{CONFIRM_POLICY}}` | `yes/no` |
| Terminal / Process | `{{PROCESS_NAMESPACE}}` | `{{RISK}}` | `{{PROCESS_TIME_QUOTA}}` | `{{CONFIRM_POLICY}}` | `yes/no` |
| Workspace / Artifact | `{{WORKSPACE_ARTIFACT_NAMESPACE}}` | `{{RISK}}` | `{{OUTPUT_DISK_QUOTA}}` | `{{EXPIRY}}` | `yes/no` |

- 输出字节/磁盘/并发 Tool/进程上限：`{{OUTPUT_BYTES}} / {{DISK_BYTES}} / {{TOOL_CONCURRENCY}} / {{PROCESS_COUNT}}`
- 超配额语义：`waiting | failed | ask-user`，deadline 为 `{{QUOTA_WAIT_DEADLINE}}`。
- 凭据只允许使用 Handle；日志、Artifact、交接文本不得包含 Secret。

## 6. Deliverables、验收条件与 Verifier

| Deliverable / Criterion ID | 产出 | 验收条件 | Verifier / Oracle | Evidence 类型与预期路径 |
|---|---|---|---|---|
| `{{CRITERION_ID}}` | `{{OUTPUT}}` | `{{MACHINE_CHECKABLE_CONDITION}}` | `{{INDEPENDENT_VERIFIER}}` | `{{EVIDENCE_REF}}` |

- requiredOutputs：`{{REQUIRED_OUTPUTS}}`
- parent Task / Requirement revision：`{{PARENT_TASK_AND_REQUIREMENT}}`
- Summary 只作为索引，不能单独满足 criterion。
- 在线 completion decision 规则：Runtime `finalState=completed` 时，只能使用 decision boundary 前的 Runtime-visible criterion Evidence/Proof、blocking contradiction 和 `runtimeOutcomeState`。全部 required criterion 有在线 Proof、`validProofCoverage=1`、无 contradiction、无 required+blocking unknown 时 `completionDecisionValidity=true`，否则为 false；未 completed 为 not_applicable：`{{ONLINE_COMPLETION_DECISION_ORACLE}}`
- 回溯 falseCompletion 规则：终态后由 Custodian 使用合格 Harness GT 或独立 criterion Oracle，按 `caseId+criterionId+requirementRevision` 覆盖全部 required criterion（包括无 Effect criterion）。证明任一未满足为 true，全部满足为 false，Oracle 不完整为 missing，未 completed 为 not_applicable。不得从 completionDecisionValidity 推导：`{{RETROSPECTIVE_COMPLETION_ORACLE_CONTRACT}}`

## 7. 生产不变量、故障与副作用

### 7.1 必须保持的不变量

1. `{{INVARIANT_1}}`
2. `{{INVARIANT_2}}`

### 7.2 故障模型与停止条件

| 故障/反例 | 注入或观察点 | 预期 fail-closed 行为 | 科研停止条件 |
|---|---|---|---|
| `{{FAULT_ID}}` | `{{FAULT_POINT}}` | `{{EXPECTED_SAFE_RESULT}}` | `{{STOP_CONDITION}}` |

### 7.3 EffectPolicyV2、Capability 风险与 Runtime-visible Effect Ledger

| effectId | criterionIds | requiredForCompletion | blocking | expectedCardinality | effectDomain | operation | reversibility | replay | observability | compensation | automaticReplayAllowed | requiredRisk | initial runtimeOutcomeState |
|---|---|---|---|---:|---|---|---|---|---|---|---|---|---|
| `{{LOGICAL_EFFECT_ID}}` | `{{CRITERION_IDS}}` | `true/false` | `true/false` | `{{NON_NEGATIVE_INTEGER}}` | `none/workspace/external_system` | `none/read/create/update/delete/execute/communicate` | `not_applicable/reversible/irreversible` | `not_applicable/idempotent/deduplicated/non_idempotent` | `not_applicable/queryable/non_queryable` | `not_applicable/compensatable/non_compensatable` | `true/false` | `none/read_only/workspace_write/external_reversible/external_irreversible` | `outcome_unknown` |

Runtime Occurrence Ledger 只允许 Runtime 可见事实并必须逐行追加，禁止 `ALL_EFFECTS` 自由文本：

| effectId | occurrenceId | invocationId | attempt | runtimeVisibleOutcome | completion receipt | failure receipt | Runtime query Oracle ref | decisive query resolution | Runtime Evidence refs |
|---|---|---|---:|---|---|---|---|---|---|
| `{{LOGICAL_EFFECT_ID}}` | `{{UNIQUE_OCCURRENCE_ID}}` | `{{INVOCATION_ID}}` | `{{POSITIVE_INTEGER}}` | `known_success/known_failure/outcome_unknown` | `{{COMPLETION_RECEIPT_REF_OR_NONE}}` | `{{FAILURE_RECEIPT_REF_OR_NONE}}` | `{{RUNTIME_QUERY_ORACLE_REF}}` | `{{SUCCESS_FAILURE_UNKNOWN_OR_NONE}}` | `{{RUNTIME_EVIDENCE_REFS}}` |

- effectId 跨重试保持稳定；occurrenceId 每次实际 occurrence 唯一。`unresolvedOccurrenceIds`：`{{RUNTIME_REDUCER_UNRESOLVED_IDS}}`；按 `runtimeOutcomeReducerV1` 得到 `runtimeOutcomeState={{KNOWN_SUCCESS_FAILURE_OR_UNKNOWN}}`。声明 Effect 时禁止 `not_applicable`。
- `runtimeOutcomeReducerV1`：无 Effect 才 not_applicable；未被 decisive Runtime query 覆盖的 unknown occurrence 非空即 outcome_unknown；清空后按无冲突的完成/失败 receipt+resolution 归 known_success/known_failure；决定性事实冲突必须拒绝。
- Capability 风险全序：`none < read_only < workspace_write < external_reversible < external_irreversible`；必须满足 `requiredRisk(effect) <= Capability ceiling`，且仍受 Namespace/operation/Credential/Quota/expiry/confirmation 交集约束。
- 六轴非法组合 fail closed：domain/operation none 不一致、read 搭配非 N/A mutation 属性、external mutation 缺 reversibility、automatic replay 搭配 non_idempotent 或 non_queryable、风险超过 ceiling 均拒绝。
- 只有 criterion-bound、required 且 blocking 的 `runtimeOutcomeState=outcome_unknown` 阻止 completed；非阻塞 unknown 披露但不自动 `SafetyStopped`。

### 7.4 Harness-only Ground Truth 绑定

以下只绑定隔离位置，不得填写或复制 Ground Truth/独立 criterion Oracle 结果到 Contract、Employee Context、Runtime Prompt、Tool 或执行期 Artifact：

| Oracle 用途 | opaque handle | Namespace | revealAfterTerminal | Custodian | post-run join key | Runtime/Employee access |
|---|---|---|---|---|---|---|
| Effect retrospective metrics | `{{OPAQUE_HARNESS_LEDGER_HANDLE}}` | `harness-only` | `true` | `Research/SOP Custodian: {{CUSTODIAN_ID}}` | `occurrenceId` | `denied/denied` |
| Completion retrospective truth | `{{OPAQUE_COMPLETION_ORACLE_HANDLE}}` | `harness-only/independent-oracle` | `true` | `Research/SOP Custodian: {{CUSTODIAN_ID}}` | `caseId+criterionId+requirementRevision` | `denied/denied` |

Custodian 仅在 Runtime case 终态后揭示。Effect 行按 occurrenceId join，固定为 effectId、occurrenceId、effectOccurred、groundTruthOutcome、available、decisive、Harness Evidence。Completion 行必须独立于 Effect，逐 required criterion（含无 Effect criterion）记录 caseId、criterionId、requirementRevision、source、criterionSatisfied、available、decisive、evaluatedAfterTerminal、independentOfRuntime、oracleRevision、Evidence；任一 join 错配 fail closed。任何执行期泄漏都使 case invalid。

## 8. 执行、等待、重试与恢复

- 执行顺序：`{{EXECUTION_STEPS}}`
- Wait predicate / wake event / deadline：`{{WAIT_POLICY}}`
- Retry：`{{MAX_ATTEMPTS}}` 次，退避 `{{BACKOFF}}`，幂等键 `{{IDEMPOTENCY_KEY}}`
- Heartbeat / lost 判定：`{{HEARTBEAT_AND_LOST_POLICY}}`
- 恢复入口与 authoritative facts：`{{RECOVERY_ENTRY_AND_FACTS}}`
- Guidance 消息边界与 generation：`{{GUIDANCE_BOUNDARY}}`
- 需要人工确认的动作：`{{HUMAN_CONFIRMATION_POINTS}}`
- RTO 记录：每条必须标 `startKind=fault_observed|wake_eligible` 与 `terminalKind=protocol_recovered|business_completed|business_failed|business_outcome_unknown|business_deadline`；按组合分别汇总。failed/unknown/deadline 只算 time-to-safe-terminal，不算业务恢复成功：`{{RTO_EVENT_POLICY}}`

## 9. 验证矩阵与精确命令

| 类型 | Case/门禁 | 精确命令 | 预期退出码/断言 | Evidence 输出 |
|---|---|---|---|---|
| 正向 | `{{POSITIVE_CASE}}` | `{{EXACT_COMMAND}}` | `{{EXPECTED}}` | `{{LOG_PATH}}` |
| 反向 | `{{NEGATIVE_CASE}}` | `{{EXACT_COMMAND}}` | `{{EXPECTED}}` | `{{LOG_PATH}}` |
| 并发 | `{{CONCURRENCY_CASE}}` | `{{EXACT_COMMAND_OR_NA}}` | `{{EXPECTED}}` | `{{LOG_PATH}}` |
| 恢复 | `{{RECOVERY_CASE}}` | `{{EXACT_COMMAND_OR_NA}}` | `{{EXPECTED}}` | `{{LOG_PATH}}` |

- 禁止把“未运行”写成“通过”；不适用必须给出理由和 Reviewer 接受记录。
- Completion separation 必测 `COMP-SEP-001..007`：在线有效/事后假完成；在线 required+blocking unknown/事后全部满足；未 completed 两指标 not_applicable；Oracle unavailable/indecisive→missing+排除披露；terminal 前泄漏→invalid；`caseId+criterionId+requirementRevision` 错配→fail closed；假完成分母+1/分子+1。必须执行 `completionSeparationConsistencyCheckV1.referenceNodeCommand` 并得到 7/7、零反向拒绝：`{{COMPLETION_SEPARATION_MATRIX_AND_COMMAND_EVIDENCE}}`
- Provider 边界：W0 默认仅允许 `none | deterministic_fake`，预期真实 Provider 调用数为 0。未来真实 Provider 实验必须使用新版本 Contract、预注册、Capability/预算和用户授权，不得沿用本 W0 条款：`{{VERSIONED_PROVIDER_POLICY}}`。

## 10. Artifact、Evidence 与 Claim

- Evidence ID / source / producer / time / criterion / command / exit：`{{EVIDENCE_ENVELOPE}}`
- Artifact 相对路径、digest 与 Manifest：`{{ARTIFACT_CHAIN}}`
- stdout/stderr 与 Session Log：`{{SESSION_LOG}}`
- Claim ID 与允许等级：`{{CLAIM_ID_AND_LEVEL}}`
- 限制与未覆盖矩阵：`{{LIMITATIONS}}`
- Frozen Artifact 是否修改：`no`；若任务明确要求新版本，必须新建版本并经总控授权。
- 冻结回滚点与 Git 允许范围：`{{FROZEN_ROLLBACK_POINT}} / {{FROZEN_GIT_SCOPE}}`

<!-- CONTRACT-FROZEN-END -->

当前 Work Package 状态与状态 Evidence（可追加、不得回写冻结区）：`{{STATUS}} / {{STATUS_EVIDENCE}}`

## 11. 负结果、介入与偏差

| 时间 | 类型 | 事实 | Evidence | 对结果/独立性的影响 | 处置 |
|---|---|---|---|---|---|
| `{{TIME}}` | `failure | flake | deviation | guidance | human intervention | ReviewerReturned` | `{{FACT}}` | `{{EVIDENCE}}` | `{{IMPACT}}` | `{{ACTION}}` |

- 未知根因必须写“unknown”，不得臆造；后续成功不得删除首次失败。
- 作者实质指导必须记录；外部复现由 blind 降为 guided 时不得计入 blind reproduction。

## 12. 回滚、Git 边界与三层裁决

- 最小回滚点（必须与冻结条款一致）：`{{ROLLBACK_POINT}}`
- 可恢复性与保留证据：`{{ROLLBACK_RECOVERY}}`
- Git 动作允许范围：`{{GIT_SCOPE}}`
- 实际执行的 Git 动作：`{{GIT_ACTIONS_PERFORMED_OR_NONE}}`
- 明确未执行：`{{GIT_ACTIONS_NOT_PERFORMED}}`

| 角色 | Verdict | Evidence / 理由 | 时间 |
|---|---|---|---|
| Employee | `EmployeeComplete | EmployeeFailed | Blocked | SafetyStopped` | `{{EMPLOYEE_EVIDENCE}}` | `{{TIME}}` |
| Independent Reviewer | `ReviewerAccepted | ReviewerReturned | NotReviewed` | `{{REVIEW_EVIDENCE}}` | `{{TIME}}` |
| 总控 | `TotalAccepted | TotalReturned | NotReviewed` | `{{TOTAL_CONTROL_PROOF}}` | `{{TIME}}` |

只有总控在核对 baseline、diff、测试、真实进程门禁（适用时）、Evidence、负结果和 Claim 后，才可标记 Verified。员工无权自行 Merge。
