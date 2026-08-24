# RT95 Work Package 成功交接模板

> 模板版本：v1.4-W0-fifth-ReviewerReturned-remediation
> 仅用于 Employee 认为目标已完成时的交接。填写本模板不会自动产生 ReviewerAccepted、Verified、Commit、PR 或 Merge。

## 1. 交接身份

- Contract ID / WP ID：`{{CONTRACT_ID}} / {{WP_ID}}`
- Contract revision / `contractDigest` / `supersedesContractId`：`{{CONTRACT_REVISION}} / {{CONTRACT_DIGEST_SHA256_LOWER_HEX}} / {{SUPERSEDES_CONTRACT_ID_OR_NONE}}`
- `frozenSopDigest`：`{{FROZEN_SOP_SHA256_LOWER_HEX}}`
- Baseline Commit / Tree / Plan version：`{{BASELINE}} / {{TREE}} / {{PLAN_VERSION}}`
- Employee / 接收 Reviewer / 总控：`{{EMPLOYEE}} / {{REVIEWER}} / {{CONTROLLER}}`
- 开始、结束与时区：`{{START}} / {{END}} / {{TIMEZONE}}`

`contractDigest` 与 `frozenSopDigest` 必须按绑定 SOP 中 SHA-256/UTF-8/NFC/LF canonicalization 复算，`supersedesContractId` 必须核对前一冻结 Contract。任一不匹配时不得就地修补旧 Contract；必须进入 `ReviewerReturned`，由总控创建新 Contract ID/revision、建立 supersedes 链并重算摘要。

## 2. 完成摘要

- Objective：`{{OBJECTIVE}}`
- 实际完成：`{{COMPLETED_SCOPE}}`
- 未完成/非目标：`{{NOT_COMPLETED_OR_NON_GOALS}}`
- Employee verdict：`EmployeeComplete`；这不是 Verified。

## 3. 文件与 Namespace 清单

| 文件/Artifact 相对路径 | 动作 | 对应 criterion | digest / Evidence ID |
|---|---|---|---|
| `{{PATH}}` | `add | modify | delete | generated` | `{{CRITERION_ID}}` | `{{DIGEST_OR_EVIDENCE}}` |

- 未声明 diff/生成物：`none | {{LIST_AND_REASON}}`
- 禁止文件检查：`{{RESULT}}`
- Frozen Artifact、依赖、配置、凭据是否触碰：`no | {{AUTHORIZED_EXCEPTION}}`

## 4. 验收结果

| Case/门禁 | 精确命令 | 开始/结束 | Exit | 关键断言 | stdout/stderr Evidence |
|---|---|---|---:|---|---|
| `{{CASE_ID}}` | `{{COMMAND}}` | `{{TIME}}` | `{{EXIT}}` | `{{ASSERTIONS}}` | `{{EVIDENCE}}` |

- 正向：`{{RESULT}}`
- 反向：`{{RESULT}}`
- 并发：`{{RESULT_OR_NOT_APPLICABLE_WITH_REASON}}`
- 恢复/真实进程：`{{RESULT_OR_NOT_APPLICABLE_WITH_REASON}}`
- Provider：本 W0 Contract 仅允许 `none | deterministic_fake`；观测到的真实 Provider 调用数必须为 `0`，否则 `SafetyStopped`。未来受控真实 Provider 实验必须绑定新的版本化 Contract、预注册、Capability/预算和用户授权，不得把本字段复用为通用断言。
- `COMP-SEP-001..007` 逐例结果与 Evidence：`{{COMPLETION_SEPARATION_RESULTS}}`；`completionSeparationConsistencyCheckV1` 输出：`{{CASES_7_PASSED_7_UNEXPECTED_0_INV017_ONLINE_ONLY}}`；禁止用一个总布尔值代替七例。

## 5. Criterion → Evidence 映射

| Criterion ID | 状态 | Evidence / Artifact | Verifier/Oracle | 新鲜度与 revision |
|---|---|---|---|---|
| `{{CRITERION_ID}}` | `CriterionSatisfied | CriterionUnsatisfied | CriterionIndeterminate` | `{{EVIDENCE}}` | `{{VERIFIER}}` | `{{FRESHNESS}}` |

Summary 不单独构成 Evidence。缺少有效 Evidence 的 criterion 必须保持 `CriterionUnsatisfied` 或 `CriterionIndeterminate`。

Online completion-decision reconciliation（仅 decision boundary 前 Runtime-visible 输入）：`finalState={{RUNTIME_FINAL_STATE}}`；全部 required criterion 在线 Proof=`{{YES_NO_EVIDENCE}}`；`validProofCoverage={{RATIO}}`；blocking contradiction=`{{YES_NO_EVIDENCE}}`；required+blocking unknown=`{{EFFECT_IDS_OR_NONE}}`；`completionDecisionValidity={{TRUE_FALSE_OR_NOT_APPLICABLE}}`。禁止使用或推测 terminal 后 Oracle。

## 6. 负结果、人工介入与偏差

| 时间 | 类型 | 原始事实与 Evidence | 介入/修复 | 是否复现 | 对 Claim/独立性的影响 |
|---|---|---|---|---|---|
| `{{TIME}}` | `failure | flake | deviation | guidance | intervention` | `{{FACT}}` | `{{ACTION}}` | `{{REPRO}}` | `{{IMPACT}}` |

- 没有时明确写 `none observed`，不能删除历史失败。
- 作者实质指导：`none | {{DETAIL}}`；分类由 Reviewer 根据下一节声明与日志裁决，Employee 不得自行勾选 blind。

## 7. 独立复现声明与 Guidance Audit

- 复现者签名式独立性声明：`{{DECLARATION_TEXT_AND_SIGNED_AT}}`
- 此前参与本代码、WP、fixture、实验或审查：`none | {{PRIOR_INVOLVEMENT}}`
- 实际收到的 Frozen SOP digest：`{{SOP_DIGEST}}`
- 实际收到的 Artifact/源码/lock/config digest：`{{RECEIVED_DIGESTS}}`
- 全部通信渠道及参与者：`{{CHANNELS_AND_PARTICIPANTS}}`
- Session Log ref / digest：`{{SESSION_LOG_REF_AND_DIGEST}}`
- Guidance Audit ref / digest：`{{GUIDANCE_AUDIT_REF_AND_DIGEST}}`
- Reviewer 派生分类：`blind | guided | invalidated | not_applicable`；理由：`{{REVIEWER_REASON}}`

缺失任一字段时不得判 blind；任何未登记渠道或实质指导均至少降为 guided。

## 8. 副作用、等待与恢复结余

- 未决 Invocation / process / lock / lease：`none | {{LIST}}`

Runtime-visible Effect Ledger 必须逐 effect、逐 occurrence 填表，禁止 `ALL_EFFECTS` 或摘要文本代替：

| effectId | criterionIds | required | blocking | expectedCardinality | effectDomain | operation | reversibility | replay | observability | compensation | autoReplay | requiredRisk | runtimeOutcomeState | unresolvedOccurrenceIds |
|---|---|---|---|---:|---|---|---|---|---|---|---|---|---|---|
| `{{EFFECT_ID}}` | `{{CRITERION_IDS}}` | `true/false` | `true/false` | `{{EXPECTED}}` | `none/workspace/external_system` | `none/read/create/update/delete/execute/communicate` | `not_applicable/reversible/irreversible` | `not_applicable/idempotent/deduplicated/non_idempotent` | `not_applicable/queryable/non_queryable` | `not_applicable/compensatable/non_compensatable` | `true/false` | `none/read_only/workspace_write/external_reversible/external_irreversible` | `known_success/known_failure/outcome_unknown` | `{{IDS_OR_EMPTY}}` |

| effectId | occurrenceId | invocationId | attempt | runtimeVisibleOutcome | completion receipt | failure receipt | Runtime query Oracle | decisive query resolution | Runtime Evidence |
|---|---|---|---:|---|---|---|---|---|---|
| `{{EFFECT_ID}}` | `{{OCCURRENCE_ID}}` | `{{INVOCATION_ID}}` | `{{ATTEMPT}}` | `known_success/known_failure/outcome_unknown` | `{{COMPLETION_RECEIPT_OR_NONE}}` | `{{FAILURE_RECEIPT_OR_NONE}}` | `{{RUNTIME_ORACLE_REF}}` | `{{SUCCESS_FAILURE_UNKNOWN_OR_NONE}}` | `{{RUNTIME_EVIDENCE_REFS}}` |

- reducer 复算：无 Effect 才可 `not_applicable`；未被 decisive Runtime query 覆盖的 unknown occurrence 必须进入 unresolved；非空即 outcome_unknown，清空后按无冲突的完成/失败 receipt+resolution 归 known_success/known_failure：`{{RUNTIME_OUTCOME_REDUCER_PROOF}}`
- 风险校验：`requiredRisk(effect) <= Capability ceiling`，全序 `none < read_only < workspace_write < external_reversible < external_irreversible`；Namespace/operation/Credential/Quota/expiry/confirmation 仍须逐项满足：`{{CAPABILITY_CEILING_PROOF}}`
- 非阻塞 `runtimeOutcomeState=outcome_unknown` 必须披露但不自动 `SafetyStopped`；只有 criterion-bound required+blocking unknown 阻止 completed：`{{BLOCKING_UNKNOWN_DECISION}}`
- 配额消耗与超限：`{{QUOTA_LEDGER}}`
- 残留进程/临时文件：`none | {{LIST}}`
- Retry/Recovery 实际发生：`{{EVENTS_AND_IDEMPOTENCY_KEYS}}`

Harness Ground Truth/独立 criterion Oracle 在 Employee terminal 前只允许以下 opaque 绑定，Employee 不得访问内容：

| Oracle 用途 | opaque handle | Namespace | revealAfterTerminal | Custodian | post-run join key | Runtime/Employee access |
|---|---|---|---|---|---|---|
| Effect retrospective metrics | `{{OPAQUE_HARNESS_LEDGER_HANDLE}}` | `harness-only` | `true` | `Research/SOP Custodian: {{CUSTODIAN_ID}}` | `occurrenceId` | `denied/denied` |
| Completion retrospective truth | `{{OPAQUE_COMPLETION_ORACLE_HANDLE}}` | `harness-only/independent-oracle` | `true` | `Research/SOP Custodian: {{CUSTODIAN_ID}}` | `caseId+criterionId+requirementRevision` | `denied/denied` |

Custodian-only post-run join（仅 terminal 后填写并向 Reviewer 揭示，不回灌 Employee/Runtime Context）：

| effectId | occurrenceId | effectOccurred | groundTruthOutcome | available | decisive | Harness Evidence |
|---|---|---|---|---|---|---|
| `{{EFFECT_ID}}` | `{{OCCURRENCE_ID}}` | `true/false` | `known_success/known_failure/outcome_unknown` | `true/false` | `true/false` | `{{HARNESS_EVIDENCE_REFS}}` |

Custodian-only Completion Oracle reconciliation（terminal 后填写；必须覆盖无 Effect 的 required criterion）：

| caseId | criterionId | requirementRevision | source | criterionSatisfied | available | decisive | evaluatedAfterTerminal | independentOfRuntime | oracleRevision | Evidence |
|---|---|---|---|---|---|---|---|---|---|---|
| `{{CASE_ID}}` | `{{CRITERION_ID}}` | `{{REQUIREMENT_REVISION}}` | `harness_ground_truth/independent_criterion_oracle` | `true/false` | `true/false` | `true/false` | `true` | `true` | `{{ORACLE_REVISION}}` | `{{CRITERION_ORACLE_EVIDENCE}}` |

Retrospective false-completion reconciliation：`finalState={{RUNTIME_FINAL_STATE}}`；全部 required criterion Oracle eligible=`{{TRUE_FALSE}}`；实际未满足 criterion=`{{IDS_OR_NONE_OR_MISSING}}`；`falseCompletion={{TRUE_FALSE_MISSING_OR_NOT_APPLICABLE}}`。completed+任一实际未满足为 true 并在 eligible declared-completed 分母和分子各计一次；全部实际满足为 false；Oracle 不完整或 join 错配为 missing 并披露；未 completed 为 not_applicable。不得从 `completionDecisionValidity` 推导。

逐 effect duplicate reconciliation（禁止用一个自由文本结果替代）：

| effectId | expectedCardinality | observedCardinality | GT eligible（全部相关行 available+decisive） | duplicate=max(0, observed-expected) | Evidence |
|---|---:|---:|---|---:|---|
| `{{EFFECT_ID}}` | `{{EXPECTED}}` | `{{OBSERVED_OR_MISSING}}` | `true/false` | `{{DUPLICATE_COUNT_OR_MISSING}}` | `{{POST_RUN_JOIN_EVIDENCE}}` |

逐 case RTO raw ledger（禁止只填 P50/P95 或自由文本）：

| caseId | startKind | startEvent | startMonotonicTime | terminalKind | terminalEvent | terminalMonotonicTime | monotonic delta ms | Completion Proof | Evidence |
|---|---|---|---:|---|---|---:|---:|---|---|
| `{{CASE_ID}}` | `fault_observed/wake_eligible` | `{{START_EVENT_ID}}` | `{{START_MONOTONIC}}` | `protocol_recovered/business_completed/business_failed/business_outcome_unknown/business_deadline` | `{{TERMINAL_EVENT_ID}}` | `{{TERMINAL_MONOTONIC}}` | `{{NON_NEGATIVE_DELTA}}` | `{{PROOF_REF_OR_NOT_APPLICABLE}}` | `{{RTO_EVIDENCE}}` |

RTO 汇总须由 raw ledger 按 startKind+terminalKind 生成 count、deadlineMissCount、P50/P95/max。非 completed 终点只算 time-to-safe-terminal，不算业务恢复成功：`{{TYPED_RTO_SUMMARY}}`

## 9. Claim 与限制

- 建议允许 Claim：`{{MAXIMUM_CLAIM}}`
- 明确禁止 Claim：`{{FORBIDDEN_CLAIMS}}`
- 未覆盖范围：`{{LIMITATIONS}}`
- GATE/证据等级：`{{EXACT_GATE_AND_EVIDENCE_LEVEL}}`

## 10. Git 与回滚

- Git 动作已执行：`none | {{EXACT_ACTIONS}}`
- 未执行 Commit/Push/PR/Merge：`{{YES_OR_EXPLAIN_AUTHORITY}}`
- 回滚点：`{{ROLLBACK_POINT}}`
- 回滚是否会损失 Evidence：`{{IMPACT_AND_PRESERVATION}}`

## 11. Reviewer 接手清单

- [ ] 核对 baseline、Contract revision 和文件所有权
- [ ] 静态审查全部 diff/新增文件
- [ ] 独立重跑目标测试与攻击矩阵
- [ ] 核对 Evidence、Artifact digest、负结果和未决副作用
- [ ] 核对 Capability/Quota/Namespace 无越界
- [ ] 核对 Claim 未超过证据等级
- [ ] 输出 `ReviewerAccepted` 或带证据的 `ReviewerReturned`

Reviewer verdict：`NotReviewed`
总控 verdict：`NotReviewed`
