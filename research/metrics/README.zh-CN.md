# God-Agent 科研指标入口

## 当前文件

- `METRIC-DICTIONARY-v2.zh-CN.md`：面向研究者和 Reviewer 的构念、分母、Oracle、迁移与非法组合说明；
- `metric-dictionary-v2.json`：供后续 F02 Schema/Validator、报告生成器和一致性检查读取的机器可读语义词典。
- `canonical-digest-kat-v1.json`：`god-agent-c14n-v1` 的 W0 manifest/Known Answer Test，绑定合法 fixture、BOM 负例、规范输出、权威 SHA-256 和当前 Frozen SOP self-excluded digest。

## 使用顺序

1. 在预注册中固定 RQ、假设、主要/次要指标、Oracle、故障窗口、样本量和排除规则；
2. 逐 case 记录 v2 原始字段、stratum/arm/paired identity、Runtime-visible Effect/Occurrence Ledger、Harness-only post-run join 及完整身份；
3. 先执行非法组合检查，再汇总；
4. 并排报告协议处理、业务完成、在线 `completionDecisionValidity`、`outcome_unknown`、duplicate、retrospective false completion、Proof、恢复、time-to-safe-terminal、隔离和 overhead；
5. 将原始记录、报告、Claim、负结果和环境信息纳入 Artifact 保管链。

## 当前边界

该目录当前只完成 W0 的指标语义输入。`invalidCombinations` 是 F01 规则清单，不是可执行 Schema；JSON 可解析不等于 F02 Validator 已实现，也不等于 Runner 已接线、F01/F02 已 Verified、完整 E3/GATE-40 已完成、外部复现已完成或形成 E4/生产结论。

旧报告继续可读，但 `taskSuccess` 只能作为 `legacyTaskSuccess`。任何 v2 数值都必须由新 Oracle 生成；缺失事实写 `missing` 或 `not_applicable`，不得从旧成功率猜测。

## ReviewerReturned 负结果保留

- v0.1 首次独立审查结论为 `ReviewerReturned`：case 身份分量不足；Contract/SOP 无规范 digest 链；blind 只靠标签；false completion 未绑定 required blocking effect；Runtime query Oracle 与 Harness privileged ground truth 混用；状态词、SideEffect taxonomy、RTO 终点和 missing 类型不统一。
- v0.2 第二次独立审查仍为 `ReviewerReturned`：聚合键把 variant 放入 stratum 且对跨 seed 表述自相矛盾；digest 顺序、marker 换行归属和 KAT 不足；Effect occurrence 仍可被自由文本绕过；Failure Report 与 WP 状态混用；Harness ground truth 未要求 available+decisive；taxonomy 仍跨层混杂。
- v0.3 第三次独立审查仍为 `ReviewerReturned`：INV-002/004 会错误删除应计数的 false completion；缺确定性 Runtime outcome reducer，Harness GT 仍与 Runtime occurrence 同表；示例 KAT 读取错误字段且 4/3 文件口径冲突；成功/失败模板缺逐 effect duplicate reconciliation 和逐 case RTO raw ledger；Capability 风险无全序公式且六轴非法组合未 fail closed。
- v0.4 第四次独立审查仍为 `ReviewerReturned`：把 Runtime 在线安全裁决与终态后 false-completion 真值标签混成一个 Runtime-only 构念，导致 Proof 缺口可直接冒充业务误完成，也无法表达“在线有效但事后假完成”与“在线无效但事后成功”。
- v0.5 第五次独立审查仍为 `ReviewerReturned`：`METRIC-INV-017` 继续用 required+blocking Runtime unknown 拒绝 terminal `businessCompletion=true`，导致 COMP-SEP-002 被跨层规则反向否决；七例虽列出但缺可执行的一致性检查。
- v0.6 已针对第五轮退回完成最小返工，当前状态为 pending sixth review。后续通过不得删除、合并或改写五轮退回记录。

## W0 执行偏差负结果

- 2026-08-20 v0.3 自验期间，执行者在仅获准处理 Research/SOP 原 8 文件与唯一 KAT JSON 的边界外运行了一次只读远端引用更新，并短暂发起范围外审计协调。该操作没有修改工作文件，也没有执行 pull、merge、checkout、commit 或 push；发现后立即停止范围外任务并撤回协调。此记录作为 Scope/Capability fail-closed 的反例保留，不构成第三轮审查通过，也不得据此把状态提升为 Verified。
- 2026-08-20 v0.4 自验的首轮综合 PowerShell 检查返回 `exit=1`，stdout/stderr 均为空；原因是检查脚本把 PASS 缓存到末尾、异常前未刷新，导致失败不可定位。后续拆成即时输出的 JSON/模板两段并通过；该首轮失败不得删除，也不证明规范当时正确。
- 2026-08-20 v0.5 独立七例首轮检查返回 `exit=1`；总控回传原文：`COMP-SEP-002 首次独立七例脚本仅该例失败。` 根因是 `METRIC-INV-017` 把 terminal business truth 反向绑定到 Runtime unknown。
- 2026-08-20 R0-L2/L3 账本首次执行 `npm run test:w0-ledgers` 返回 `exit=1`，原始错误：`EXP-RT95-001.evidenceRefs must be an array`。根因是两份 Contract 的字段集合冲突；为 66 项补 `evidenceRefs: []` 后复跑 `exit=0`，未把空数组冒充 Evidence。
