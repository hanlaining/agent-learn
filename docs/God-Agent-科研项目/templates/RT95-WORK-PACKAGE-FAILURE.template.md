# RT95 Work Package 失败 / 阻塞交接模板

> 模板版本：v1.3-W0-fourth-ReviewerReturned-remediation
> 失败、未知、偏差和阻塞都属于科研事实。保存现场优先于“做成绿色”；后续复跑成功不得覆盖本记录。

## 1. 身份与影响

- Failure ID / Contract ID / WP ID：`{{FAILURE_ID}} / {{CONTRACT_ID}} / {{WP_ID}}`
- Contract revision / `contractDigest` / `supersedesContractId`：`{{CONTRACT_REVISION}} / {{CONTRACT_DIGEST_SHA256_LOWER_HEX}} / {{SUPERSEDES_CONTRACT_ID_OR_NONE}}`
- `frozenSopDigest`：`{{FROZEN_SOP_SHA256_LOWER_HEX}}`
- Baseline / Plan version / generation：`{{BASELINE}} / {{PLAN_VERSION}} / {{GENERATION}}`
- 报告者 / 接收 Reviewer / 总控：`{{REPORTER}} / {{REVIEWER}} / {{CONTROLLER}}`
- 发生时间与时区：`{{TIME}} / {{TIMEZONE}}`
- 当前 Work Package 状态：`EmployeeFailed | Blocked | SafetyStopped`
- 受影响 criterion / Claim / Gate：`{{IMPACTED_IDS}}`

`contractDigest` 与 `frozenSopDigest` 必须按绑定 SOP 中 SHA-256/UTF-8/NFC/LF canonicalization 复算，`supersedesContractId` 必须核对前一冻结 Contract。即使失败由 mismatch 触发，也必须保留实际值和原始 Evidence；不得就地修补旧 Contract，必须由总控创建新 Contract ID/revision、建立 supersedes 链并重算摘要。

## 2. 预期与实际

- Objective：`{{OBJECTIVE}}`
- 故障模型/Case：`{{FAULT_OR_CASE_ID}}`
- 精确命令或事件：`{{COMMAND_OR_EVENT}}`
- 预期退出/状态/Oracle：`{{EXPECTED}}`
- 实际退出码与状态：`{{ACTUAL}}`
- 首次异常原文（脱敏）：`{{ERROR_EXCERPT}}`

## 3. 现场 Evidence

| Evidence | 相对路径/ID | digest | 生成者/时间 | 保管状态 |
|---|---|---|---|---|
| stdout/stderr | `{{REF}}` | `{{DIGEST}}` | `{{PRODUCER_TIME}}` | `raw | manifested | local-only` |
| State/Event/Trace | `{{REF}}` | `{{DIGEST}}` | `{{PRODUCER_TIME}}` | `{{STATUS}}` |
| Artifact/Repro | `{{REF}}` | `{{DIGEST}}` | `{{PRODUCER_TIME}}` | `{{STATUS}}` |

- 未生成的预期文件：`{{MISSING_OUTPUTS}}`
- Evidence 缺口及原因：`{{GAPS}}`
- 本机绝对路径/凭据已脱敏：`yes | {{STOP_AND_ESCALATE}}`

## 4. 副作用与安全处置

Runtime-visible Effect Ledger 禁止自由文本逃逸，必须逐行填写：

| effectId | criterionIds | required | blocking | expectedCardinality | effectDomain | operation | reversibility | replay | observability | compensation | autoReplay | requiredRisk | runtimeOutcomeState | unresolvedOccurrenceIds |
|---|---|---|---|---:|---|---|---|---|---|---|---|---|---|---|
| `{{EFFECT_ID}}` | `{{CRITERION_IDS}}` | `true/false` | `true/false` | `{{EXPECTED}}` | `none/workspace/external_system` | `none/read/create/update/delete/execute/communicate` | `not_applicable/reversible/irreversible` | `not_applicable/idempotent/deduplicated/non_idempotent` | `not_applicable/queryable/non_queryable` | `not_applicable/compensatable/non_compensatable` | `true/false` | `none/read_only/workspace_write/external_reversible/external_irreversible` | `known_success/known_failure/outcome_unknown` | `{{IDS_OR_EMPTY}}` |

| effectId | occurrenceId | invocationId | attempt | runtimeVisibleOutcome | completion receipt | failure receipt | Runtime query Oracle | decisive query resolution | Runtime Evidence |
|---|---|---|---:|---|---|---|---|---|---|
| `{{EFFECT_ID}}` | `{{OCCURRENCE_ID}}` | `{{INVOCATION_ID}}` | `{{ATTEMPT}}` | `known_success/known_failure/outcome_unknown` | `{{COMPLETION_RECEIPT_OR_NONE}}` | `{{FAILURE_RECEIPT_OR_NONE}}` | `{{RUNTIME_ORACLE_REF}}` | `{{SUCCESS_FAILURE_UNKNOWN_OR_NONE}}` | `{{RUNTIME_EVIDENCE_REFS}}` |

- reducer 复算：无 Effect 才可 `not_applicable`；未被 decisive Runtime query 覆盖的 unknown occurrence 必须进入 unresolved，非空即 outcome_unknown；清空后按无冲突的完成/失败 receipt+resolution 归 known_success/known_failure：`{{RUNTIME_OUTCOME_REDUCER_PROOF}}`
- 风险校验：`requiredRisk(effect) <= Capability ceiling`，全序 `none < read_only < workspace_write < external_reversible < external_irreversible`；六轴非法组合或超 Namespace/operation/Credential/Quota/expiry/confirmation 必须 fail closed：`{{CAPABILITY_CEILING_PROOF}}`
- `outcome_unknown` 是 Runtime occurrence/case outcome，不是 Work Package 状态。非阻塞 unknown 披露但不自动 `SafetyStopped`；只有 criterion-bound required+blocking unknown 阻止 completed。

Harness Ground Truth/独立 criterion Oracle 在 Employee terminal 前只允许 opaque 绑定，内容不得进入 Employee/Runtime Context：

| Oracle 用途 | opaque handle | Namespace | revealAfterTerminal | Custodian | post-run join key | Runtime/Employee access |
|---|---|---|---|---|---|---|
| Effect retrospective metrics | `{{OPAQUE_HARNESS_LEDGER_HANDLE}}` | `harness-only` | `true` | `Research/SOP Custodian: {{CUSTODIAN_ID}}` | `occurrenceId` | `denied/denied` |
| Completion retrospective truth | `{{OPAQUE_COMPLETION_ORACLE_HANDLE}}` | `harness-only/independent-oracle` | `true` | `Research/SOP Custodian: {{CUSTODIAN_ID}}` | `caseId+criterionId+requirementRevision` | `denied/denied` |

Custodian-only post-run join（仅 Runtime case terminal 后填写并向 Reviewer 揭示）：

| effectId | occurrenceId | effectOccurred | groundTruthOutcome | available | decisive | Harness Evidence |
|---|---|---|---|---|---|---|
| `{{EFFECT_ID}}` | `{{OCCURRENCE_ID}}` | `true/false` | `known_success/known_failure/outcome_unknown` | `true/false` | `true/false` | `{{HARNESS_EVIDENCE_REFS}}` |

Custodian-only Completion Oracle reconciliation（仅 terminal 后填写，覆盖无 Effect 的 required criterion）：

| caseId | criterionId | requirementRevision | source | criterionSatisfied | available | decisive | evaluatedAfterTerminal | independentOfRuntime | oracleRevision | Evidence |
|---|---|---|---|---|---|---|---|---|---|---|
| `{{CASE_ID}}` | `{{CRITERION_ID}}` | `{{REQUIREMENT_REVISION}}` | `harness_ground_truth/independent_criterion_oracle` | `true/false` | `true/false` | `true/false` | `true` | `true` | `{{ORACLE_REVISION}}` | `{{CRITERION_ORACLE_EVIDENCE}}` |

逐 effect duplicate reconciliation（禁止单自由文本替代）：

| effectId | expectedCardinality | observedCardinality | GT eligible（全部相关行 available+decisive） | duplicate=max(0, observed-expected) | Evidence |
|---|---:|---:|---|---:|---|
| `{{EFFECT_ID}}` | `{{EXPECTED}}` | `{{OBSERVED_OR_MISSING}}` | `true/false` | `{{DUPLICATE_COUNT_OR_MISSING}}` | `{{POST_RUN_JOIN_EVIDENCE}}` |

- 是否允许自动重试及依据：`{{RETRY_DECISION}}`
- 已执行查询/补偿：`{{QUERY_OR_COMPENSATION}}`
- 残留 process/port/lock/lease/temp：`{{RESIDUALS}}`
- 隔离、凭据、fencing 或错投 P0：`none | {{DETAIL_AND_STOP}}`
- 科研停止条件是否触发：`no | yes: {{CONDITION}}`
- W0 Provider policy：仅允许 `none | deterministic_fake`，实际真实 Provider 调用数：`{{EXPECTED_ZERO_OR_SAFETY_STOP}}`。未来受控真实 Provider 实验必须使用新 Contract/预注册/Capability/预算/用户授权。

## 5. 复跑、介入与偏差

| 尝试 | 时间 | 与首次条件差异 | Exit/结果 | Evidence | 人工/作者介入 |
|---:|---|---|---|---|---|
| 1 | `{{TIME}}` | `{{DIFF_OR_NONE}}` | `{{RESULT}}` | `{{EVIDENCE}}` | `{{INTERVENTION}}` |

- 复跑上限与停止理由：`{{BOUND}}`
- 是否违反预注册 seed/fixture/budget/oracle：`no | {{DEVIATION}}`
- 复现者独立性声明与此前参与：`{{DECLARATION}} / {{PRIOR_INVOLVEMENT_OR_NONE}}`
- 收到的 Frozen SOP/Artifact digest：`{{SOP_DIGEST}} / {{ARTIFACT_DIGESTS}}`
- 通信渠道、Session Log ref、Guidance Audit ref：`{{CHANNELS}} / {{SESSION_LOG_REF}} / {{GUIDANCE_AUDIT_REF}}`
- 外部复现分类由 Reviewer 派生：`blind | guided | invalidated | not_applicable`；缺字段或存在未登记指导时不得判 blind。

## 6. 原因与可证伪假设

- 已知事实：`{{FACTS_ONLY}}`
- 初步原因：`unknown | {{HYPOTHESIS}}`
- 可证伪预测：`{{PREDICTION}}`
- 最小下一步诊断：`{{ONE_BOUNDED_DIAGNOSTIC}}`
- 逐 case RTO raw ledger 必须填写；不得只给自由文本或聚合值：

| caseId | startKind | startEvent | startMonotonicTime | terminalKind | terminalEvent | terminalMonotonicTime | monotonic delta ms | Completion Proof | Evidence |
|---|---|---|---:|---|---|---:|---:|---|---|
| `{{CASE_ID}}` | `fault_observed/wake_eligible` | `{{START_EVENT_ID}}` | `{{START_MONOTONIC}}` | `protocol_recovered/business_completed/business_failed/business_outcome_unknown/business_deadline` | `{{TERMINAL_EVENT_ID}}` | `{{TERMINAL_MONOTONIC}}` | `{{NON_NEGATIVE_DELTA}}` | `{{PROOF_REF_OR_NOT_APPLICABLE}}` | `{{RTO_EVIDENCE}}` |

- RTO 汇总必须由 raw ledger 按 startKind+terminalKind 生成 count、deadlineMissCount、P50/P95/max。非 completed 终点是 time-to-safe-terminal，不是业务恢复成功：`{{TYPED_RTO_SUMMARY_OR_MISSING}}`
- 禁止臆断：没有 Evidence 时不得写“已定位”或“已修复”。

## 7. Claim 与完成状态降级

- 原 Claim：`{{ORIGINAL_CLAIM}}`
- 处置：`retain | downgrade | withdraw | pending-review`
- 当前最大允许表述：`{{DOWNGRADED_CLAIM}}`
- 不得表述：`{{FORBIDDEN_CLAIM}}`
- Gate/评分影响：`{{GATE_IMPACT}}`
- Online completion-decision reconciliation（只用 decision boundary 前 Runtime-visible 输入）：`finalState={{RUNTIME_FINAL_STATE}}`；required criterion 在线 Proof=`{{YES_NO_EVIDENCE}}`；`validProofCoverage={{RATIO}}`；blocking contradiction=`{{YES_NO_EVIDENCE}}`；required+blocking unknown=`{{EFFECT_IDS_OR_NONE}}`；`completionDecisionValidity={{TRUE_FALSE_OR_NOT_APPLICABLE}}`。
- Retrospective false-completion reconciliation（仅 Custodian terminal 后）：Completion Oracle eligible=`{{TRUE_FALSE}}`；实际未满足 criterion=`{{IDS_OR_NONE_OR_MISSING}}`；`falseCompletion={{TRUE_FALSE_MISSING_OR_NOT_APPLICABLE}}`。completed+事后未满足必须 retain-and-count；Oracle 不完整/join 错配为 missing 并披露；未 completed 为 not_applicable。两个指标不可互推。

## 8. 恢复、回滚与 Git 边界

- 安全恢复点：`{{RECOVERY_POINT}}`
- 回滚点与影响：`{{ROLLBACK_POINT_AND_IMPACT}}`
- 必须保留的失败 Evidence：`{{PRESERVE_LIST}}`
- Git 动作已执行：`none | {{ACTIONS}}`
- Commit/Push/PR/Merge 是否执行：`no | {{AUTHORIZED_ACTION}}`

## 9. 三层裁决

| 角色 | Verdict | 理由/Evidence | 下一责任人 |
|---|---|---|---|
| Employee | `EmployeeFailed | Blocked | SafetyStopped` | `{{EVIDENCE}}` | `{{OWNER}}` |
| Failure Report Reviewer | `FailureReportAccepted | FailureReportReturned | NotReviewed` | `{{EVIDENCE}}` | `{{OWNER}}` |
| 总控 | `TotalReturned | NotReviewed` | `{{EVIDENCE}}` | `{{OWNER}}` |
