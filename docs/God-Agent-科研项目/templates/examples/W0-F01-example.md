# W0-F01 Work Package 示例：科研构念与指标拆分

> 这是已填写的交接示例，不是当前事实 Ledger，也不等于 F01 已 Verified。实际派发时，总控必须把 baseline 占位符替换为当次冻结值。

## 1. 身份与目标

- Contract ID / revision：`RT95-W0-F01-example-v2 / 2`
- contractDigest / supersedesContractId / frozenSopDigest：`{{TOTAL_CONTROL_COMPUTES_DIGEST}} / RT95-W0-F01-example-v1 / {{FROZEN_SOP_DIGEST}}`
- WP：`F01 / RT95-601`
- Requirement revision：D11 v0.2.0 中 F01 与附录 C.1/C.2
- Baseline：`{{TOTAL_CONTROL_MUST_BIND_COMMIT_AND_TREE}}`
- Employee：Research/SOP Chat
- Reviewer：独立 Verification Reviewer
- Objective：新增 v2 指标语义词典，严格拆分安全处理、业务完成、在线 `completionDecisionValidity`、known/`outcome_unknown`、duplicate、终态后 false completion、Proof、恢复、隔离、RTO 和 overhead。
- Non-goals：不修改 Runner/Schema v1；不生成实验数值；不修改 Frozen Artifact；不声称 F02、完整 E3、GATE-40、E4 或生产可用。

## 2. 文件与权限

允许写入 4 个相对路径：

- `research/metrics/METRIC-DICTIONARY-v2.zh-CN.md`
- `research/metrics/metric-dictionary-v2.json`
- `research/metrics/README.zh-CN.md`
- `research/metrics/canonical-digest-kat-v1.json`

禁止修改：现有报告与 Runner、`research/artifacts/v0.1/`、D00–D11、根 README、`package.json`、lockfile、配置与凭据。

Capability/Quota：只读仓库文档和 Schema；只写上述 4 个相对路径；W0 `providerKind=none`，观测真实 Provider 调用必须为 0；不允许 MCP、外部副作用、进程控制或 Git 写操作。未来真实 Provider 实验必须使用新 Contract/预注册/Capability/预算/用户授权。时间上限 2 小时，输出上限 256 KiB。

## 3. Deliverables 与 Criterion

| Criterion | 验收条件 | Verifier / Evidence |
|---|---|---|
| F01-C01 | `taskSuccess` 只迁移为 `legacyTaskSuccess`，禁止自动映射 | JSON `legacyPolicy` + Reviewer 静态审查 |
| F01-C02 | 15 类核心构念均有定义、单位/分母、Oracle 或聚合边界：`protocolHandlingSuccess`、`businessCompletion`、`completionDecisionValidity`、`outcomeState`、`unknownClassifierPrecision`、`unknownClassifierRecall`、`duplicateExternalEffectCount`、`duplicateExternalEffectRate`、`falseCompletion`、`validProofCoverage`、`protocolRecoverySuccess`、`businessRecoverySuccess`、`isolationBreach`、`recoveryTimeMs`、`overhead`；统计身份明确拆成 stratumKey、armAggregationKey、pairedUnitKey | JSON 自动核对 ID、数量、唯一性与三层统计身份；Markdown 交叉审查 |
| F01-C03 | unknown precision/recall、duplicate、在线 completion decision、retrospective false completion、Proof coverage、RTO 有可计算定义 | Reviewer 按 EXP-RT95-009～016 逐项映射 |
| F01-C04 | 至少覆盖协议/业务混用、completed+unknown、零分母、无 Oracle 重复率等非法组合 | `invalidCombinations` 列表 |
| F01-C05 | 明确结果不代表实验/Runner/论文门禁完成 | 四份文件 Claim boundary |
| F01-C06 | completionDecisionValidity 与 falseCompletion 不可互推；Completion Oracle 覆盖无 Effect criterion，以 `caseId+criterionId+requirementRevision` join，并覆盖 COMP-SEP-001～007 | JSON separation invariants/cases + Reviewer 逐例复算 |

映射门禁：EXP-RT95-001～003、009～016；TC-148、TC-150。F01-C01～C06 通过只证明 W0 语义输入可审查，不替代正式预注册、实验 Schema、统计或 Claim 审计。

## 4. 不变量与失败策略

1. `protocolHandlingSuccess` 不蕴含 `businessCompletion`；
2. `completionDecisionValidity` 只用 Runtime 在线可见事实，retrospective `falseCompletion` 只用 terminal 后合格 Completion Oracle，两者不可互推；
3. `outcome_unknown` 不得静默改写为成功/失败；每个逻辑 effect 必须有跨重试稳定 effectId、criterionIds、required/blocking、expectedCardinality、EffectPolicyV2、runtimeOutcomeState、unresolvedOccurrenceIds 和结构化 Runtime occurrences；
4. 不可查询副作用不得记为零 duplicate；
5. summary 不能构成 valid Proof；
6. 历史结果与 v2 结果必须保持可区分。

Runtime query Oracle 与 Harness privileged ground truth 必须隔离：Runtime Ledger 只含 Runtime-visible outcome/query/receipt Evidence；Harness-only Ledger 仅以 opaque handle 绑定，由 Custodian 在 terminal 后对 Effect 按 occurrenceId join、对 Completion 按 `caseId+criterionId+requirementRevision` join，且覆盖无 Effect criterion。后者不得进入 Employee/Runtime Context 或决策。若发现旧字段无法无损迁移，写 `missing`/`not_applicable` 并记录负结果，不猜测。若发现真实凭据、本机绝对路径或 Frozen Artifact 变化，立即停止并交接总控。

## 5. 精确静态验收

从仓库根目录执行：

```powershell
node -e "JSON.parse(require('fs').readFileSync('research/metrics/metric-dictionary-v2.json','utf8')); console.log('metric-json-ok')"
node -e "const d=JSON.parse(require('fs').readFileSync('research/metrics/metric-dictionary-v2.json','utf8'));const expected=['protocolHandlingSuccess','businessCompletion','completionDecisionValidity','outcomeState','unknownClassifierPrecision','unknownClassifierRecall','duplicateExternalEffectCount','duplicateExternalEffectRate','falseCompletion','validProofCoverage','protocolRecoverySuccess','businessRecoverySuccess','isolationBreach','recoveryTimeMs','overhead'];const actual=d.constructs.map(x=>x.id);if(actual.length!==15||new Set(actual).size!==15||expected.some(x=>!actual.includes(x)))throw Error('construct-contract-failed');console.log('constructs-15-unique-complete')"
node -e "const d=JSON.parse(require('fs').readFileSync('research/metrics/metric-dictionary-v2.json','utf8'));if(!d.aggregationIdentity.stratumKey||d.aggregationIdentity.stratumKey.includes('variant')||!d.aggregationIdentity.armAggregationKey||!d.aggregationIdentity.pairedUnitKey||!d.effectPolicyV2.runtimeOccurrenceRequired||!d.effectPolicyV2.runtimeOutcomeReducerV1||!d.effectPolicyV2.harnessOnlyLedgerPolicy||d.completionSeparationAcceptanceCases.length!==7||!d.completionSeparationConsistencyCheckV1)throw Error('v0.6-structure-failed');console.log('aggregation-effect-completion-structure-ok')"
node -e "const d=JSON.parse(require('fs').readFileSync('research/metrics/canonical-digest-kat-v1.json','utf8'));if(d.canonicalizationVersion!=='god-agent-c14n-v1'||!d.validFixture||!d.validFixture.expectedDigest||!d.sopSelfExcludedDigest)throw Error('kat-contract-failed');console.log('digest-kat-structure-ok',d.validFixture.expectedDigest)"
$d=Get-Content -LiteralPath 'research/metrics/metric-dictionary-v2.json' -Raw -Encoding UTF8 | ConvertFrom-Json; Invoke-Expression $d.completionSeparationConsistencyCheckV1.referenceNodeCommand
rg -n "protocolHandlingSuccess|businessCompletion|completionDecisionValidity|outcomeState|unknownClassifierPrecision|unknownClassifierRecall|duplicateExternalEffect|falseCompletion|validProofCoverage|protocolRecoverySuccess|businessRecoverySuccess|isolationBreach|recoveryTimeMs|overhead" research/metrics
rg -n "legacyTaskSuccess|automaticMappingAllowed|METRIC-INV-" research/metrics
rg -n "GATE-40|exactly-once|production|E4|Verified" research/metrics
```

预期：JSON parse 退出 0；第二条命令自动证明 15 个指定 ID 完整且唯一；最后一条确定性检查输出 `cases=7, passed=7, unexpectedInverseRejections=0, inv017=online-only`。所有迁移、非法组合与 COMP-SEP-001～007 可定位。`invalidCombinations` 当前只是 F01 语义清单，F02 通用 Schema/Validator 尚未实现；本窄范围 consistency checker 不等于 Runner 已接线。限制词扫描的命中不等于违规。敏感路径和凭据扫描由总控统一执行。

## 6. Evidence、负结果与裁决

- Evidence：写入上述四文件、JSON parse 输出、Reviewer 检查表、命令及 exit code。
- 预期 Artifact：W0 交接包；不得写入 Frozen Artifact v0.1。
- 负结果：任何解析失败、构念缺失、非法组合遗漏或 Claim 越界均使用 Failure 模板保留。
- Employee verdict：完成文件后只能填 `EmployeeComplete`。
- Reviewer verdict：独立检查前为 `NotReviewed`。
- 总控 verdict：TC-148/150 与事实一致性审查前保持 `NotReviewed`。
- Git：本 Employee 不执行 Commit、Push、PR 或 Merge。
