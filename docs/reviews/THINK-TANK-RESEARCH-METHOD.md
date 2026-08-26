# God-Agent 科研方法与实验闭环独立审阅

> 审阅日期：2026-08-24  
> 审阅角色：科研方法智囊团（独立口径）  
> 审阅范围：`research/**`、相关科研测试、`docs/evidence/current-evidence.json`、formal research packet v1  
> 总裁决：**正式科研证据完成度 69/100；科研方法与工具成熟度 78/100。两项都未达到 95，当前仍是 No-Go for Research-95。**

## 1. 评分口径

本报告严格区分两种不能互相替代的分数：

- **正式科研证据完成度 69/100**：衡量当前已经真实产生、可追溯、可独立复核的证据。该值与 `docs/evidence/current-evidence.json` 的统一总账一致，是对外回答“当前完成度”的主口径。
- **科研方法与工具成熟度 78/100**：衡量仓库是否已经具备预注册、故障注入、Raw 治理、统计和 Claim 治理能力。它可以因本地代码与测试完善而提升，但不能冒充正式实验结果。

新增 formal packet 提高的是第二项，而不是第一项。仓库代码已经能拒绝很多错误做法，不代表冻结后的实验已经执行。

## 2. 已核实的权威事实

| 项目 | 当前证据 | 允许结论 |
|---|---|---|
| 统一证据快照 | research 69；paper 47 | 当前科研正式证据仍为 69，不得按工具能力改写总账 |
| GATE-40 本地 pilot | 40 candidate、40 runnable、40 local passed、0 local failed | 8 窗口 × 5 seed 的本地候选矩阵已跑通 |
| GATE-40 正式状态 | `formalVerified=0`、`complete=false`、`candidate-not-frozen` | 不能说 GATE-40 已正式完成 |
| 预注册权威输入 | Draft；1 available、7 blocked；payload digest 为 null | 输入尚未冻结，且按当前输入 formal preflight 必须 blocked |
| 正式配对计划 | baseline + 3 ablation，共 4 arm × 8 窗口 × 5 seed = 160 case | 仅有确定性计划；没有 160 条正式 Raw |
| Provider | offline deterministic fake；live calls 0；credentials read false | 不证明真实 Provider、真实模型或真实外部系统 |
| 外部 baseline | `externalBaselines=[]` | 没有 LangGraph、Temporal 等同预算实跑对照 |
| 独立复现 | 无非作者、第二机器正式复现 | 同机复跑不得宣传为外部复现 |
| Claim 状态 | pipeline/method CodeVerified；RQ、reproduction、paper、maturity 均 NotVerified | 只能声称仓库存在方法工具，不能声称研究结论成立 |

实际 `.tmp/gate40-pilot-40/process-chaos-gate40-pilot-manifest.json` 也明确写明：`claimBoundary=local-pilot-only-not-gate40`、`formallyVerifiedCaseCount=0`、`independentReview=NotReviewed`。这与统一证据总账一致。

## 3. Formal research packet v1 审阅

### 3.1 已建立的真实能力

`research/rt95-closure/src/formal-research-packet.ts` 的方法设计是本轮最有价值的增量：

1. 只接受 digest 可复验的 Frozen 预注册；Draft 与冻结后篡改均拒绝。
2. 绑定非零 commit、source tree、lockfile、config 与 preregistration SHA-256。
3. 从冻结 arm × window × seed 确定生成 160-case 计划和计划摘要。
4. 当前权威窗口表仍含 7 个 blocked 窗口，因此即使把 Draft 临时 Freeze，也返回 `preflight.status=blocked`；运行时 pilot 不能绕过输入更新流程。
5. Provider preflight 固定 `realApiCalls=0`、`credentialsRead=false`，live-authorized 也只能表达“已授权但未调用”。
6. Raw ledger 使用 `previousEventSha256` / `eventSha256` 形成事件链，保留 success、failure、excluded、aborted 和获准重跑；能拒绝历史篡改、截断、重复 active attempt、未授权重跑与提前 seal。
7. Claim Matrix 精确覆盖 Claim Table 的每个 Claim 和 required evidence；本地 preflight 不能把 formal、external、publication Claim 升级为已验证。
8. CodeVerified 证据项要求 producer/reviewer 身份不同，并绑定相对路径和 SHA-256。

这些能力证明“仓库具备 fail-closed 的正式实验预检与内存态审计模型”，是方法成熟度从上一口径约 74 提高到 78 的主要依据。

### 3.2 仍未形成的证据

formal packet 的边界也很清楚，以下事项尚未完成：

- 当前预注册仍是 Draft，且只有 1/8 窗口在权威输入中标为 available。
- 没有一个绑定固定源码与配置、真实持久化到文件系统的 formal packet 实例。
- ledger 当前是库内数据结构和测试 fixture；没有正式执行生成的 append-only 文件、原子落盘、恢复日志或 sealed ledger。
- Claim Evidence 中的 artifact path/SHA 目前只做格式与闭合检查，没有自动读取实际 Artifact Manifest 并复验文件内容。
- “executorId 与 reviewerId 不同”只证明字符串不同，不等于真人身份、签名或组织独立性已经核验。
- 没有 160 条正式 Raw，没有真实 Provider/外部副作用 Raw，也没有外部 baseline 或第二环境数据。

因此，formal packet 不能计作 formal run、Raw 真实性、独立审查或外部复现证据。

## 4. 客观评分

### 4.1 正式科研证据完成度：69/100

| 维度 | 得分 | 满分 | 依据 |
|---|---:|---:|---|
| 研究问题、可证伪终点与预注册设计 | 12 | 15 | RQ/H、主要终点、Oracle、MEI、排除/重跑/停止规则存在；预注册仍未冻结，样本量仍需用 pilot 方差/精度重核 |
| 实验 Harness、故障窗口与 Oracle | 17 | 20 | 8 个本地窗口已接线，40/40 local pilot 通过；仍是单机、test-only fault injector、本地 helper 与 fake Provider |
| 正式执行与完整 Raw | 5 | 20 | 有 pilot Raw 和新的 ledger 模型；formal Verified 为 0，无冻结后 4-arm 160-case Raw、无正式 sealed ledger |
| 统计与分析治理 | 14 | 15 | Raw QA、Wilson、零失败上界、率差、配对描述、bootstrap、Holm 函数和确定生成较强；当前没有可分析的正式 Raw，confirmatory 推断未成立 |
| 外部有效性与公平基线 | 5 | 15 | 有内部三消融计划；真实外部 baseline、live Provider、真实外部系统和跨环境样本均为 0 |
| 复现与独立审查 | 7 | 10 | 同机 Frozen Artifact/Clean 记录和 fail-closed 边界较好；无非作者第二机器复现和真人签字 |
| Artifact 与 Claim 治理 | 9 | 15 | Manifest、Claim Table、formal hash chain 与 exact closure 已具备；正式 ledger/Artifact 自动绑定、敏感 Raw 派生链和顶层 release 尚未完成 |
| **总计** | **69** | **100** | **强本地研究原型，但正式证据主体尚未产生** |

### 4.2 科研方法与工具成熟度：78/100

| 维度 | 得分 | 满分 | 依据 |
|---|---:|---:|---|
| 预注册与可证伪设计 | 13 | 15 | Schema、冻结摘要、固定计划、停止/排除/重跑规则较完整 |
| Harness 与专用 Oracle | 18 | 20 | 8 窗口均有本地接线和专项 Oracle；边界仍局限于单机实验条件 |
| Formal preflight 与 Raw 治理模型 | 14 | 15 | 输入绑定、160-case 计划、事件哈希链和 rerun/seal 状态机完善；尚无文件系统持久化 |
| 统计与确定性分析 | 14 | 15 | 统计 KAT、Raw QA 和禁止显著性过度主张较完整；成本 schema、确认性检验落地仍缺 |
| Claim/Artifact 治理 | 11 | 15 | Claim exact closure 和产物摘要能力较强；实际文件真实性与身份签名未自动闭合 |
| 外部基线与跨环境准备 | 4 | 10 | 知道所需公平约束，但尚无可执行的外部 baseline adapter/正式协议证据 |
| 独立复核与发布准备 | 4 | 10 | 有规则与文档框架；真人、第二环境和版本化 release 流程未实际完成 |
| **总计** | **78** | **100** | **已具备继续做正式研究的较强工具链，但不是 95+ 研究结论** |

## 5. 本轮独立复验

| 复验 | 结果 | 证明范围 |
|---|---:|---|
| RT95 preregistration + formal packet | 21/21 | Frozen 摘要、blocked preflight、160-case 计划、hash-chain、重跑规则、Claim 闭合与 overclaim 负例 |
| RT95 statistics | 11/11 | Raw QA、描述统计 KAT、确定性输出和边界负例 |
| Paper evidence bundle | 6/6 | Frozen/完整配对输入、失败保留、摘要、不可覆盖、篡改/缺失/多余文件拒绝 |
| Process Chaos | 17/17 | 8 个本地窗口、真 App Server 子进程/本地 helper 接线及安全边界 |

测试证明的是代码行为。测试中临时生成的 Frozen 文件、160 条合成 Raw 或本地 helper，不是当前实验的 formal Raw、真实 Provider 或外部系统证据。

## 6. 距离 95+ 的差距

### 6.1 可在本机继续补足

以下项目能继续提高方法成熟度，但单独不能关闭 Research-95：

1. 同步权威预注册窗口表与当前运行时接线事实；逐窗口复验后把真实 available 状态写回候选输入，再由作者审阅，而不是直接伪造 Frozen。
2. 给 formal ledger 增加文件系统原子持久化、进程中断恢复、锁与 sealed 后只读保护；生成真实可复验的 ledger manifest。
3. 将 ledger 中 artifact path/SHA 与实际 Artifact Manifest、文件字节数和内容摘要自动复验，拒绝“只填一个合法格式 SHA”的假闭合。
4. 给 Claim Evidence 增加可验证身份签名或签字 receipt；区分“字符串不同”与“人员独立性已证明”。
5. 增加 publishable sanitizer：保留私有 Raw 摘要，排除 helper secret，生成“私有源摘要 → 脱敏公开包”的机器可读派生 receipt。
6. 建立 external baseline 公平协议和空模板：固定任务、模型、Token/请求预算、费用、超时、重试、硬件资源、Oracle、排除规则与 adapter 差异。
7. 扩展 Raw v2：冻结成本、token、Provider 响应元数据、环境指纹、人工介入和不可判定结果；补充迁移与兼容验证。
8. 建立 formal dry-run/preflight CLI 与不可覆盖输出目录，但输出必须继续标为 preflight/dry-run，不能生成 formal Verified。

### 6.2 必须由真实外部流程关闭

以下是 95+ 的硬门，本机代码或测试 fixture 不能替代：

1. 作者确认并冻结最终预注册：样本量、arm、窗口、终点、统计、排除、重跑和停止规则全部固定并签署。
2. 经授权固定 commit/tree/lock/config/prereg digest，在该固定输入上启动正式运行。
3. 完成 baseline + 3 ablation 至少 160 条正式配对 Raw；所有失败、排除、中止、人工介入和重跑均保留。
4. 在预算、密钥和数据治理授权下进行真实 Provider 调用，记录模型版本、区域、请求、费用、限流、重试与失败。
5. 在可回滚沙箱系统中执行真实外部副作用，保留 effect → receipt → proof 证据；本地文件 helper 不能代替。
6. LangGraph、Temporal 或其他对照必须在同任务、模型、预算、资源、超时、重试、Oracle 与排除规则下实跑，并由 Reviewer 审核公平性。
7. 至少一名非作者在独立机器/环境按冻结 release 无指导复现，保留 session log、环境指纹、人工介入与偏差处理记录。
8. 非作者方法审查、统计审读、论文审读完成并签字；负向、零差异和失败结果不得选择性删除。
9. 发布版本化 Artifact：源码、预注册、数据字典、Raw/脱敏派生包、统计脚本、表图、manifest、许可证和长期地址全部可复验。

这些硬门中的任一项未完成，正式科研证据不得上调到 95。

## 7. 推荐闭环顺序

| 优先级 | 阶段 | 完成定义 |
|---|---|---|
| P0 | 权威输入对齐 | 8 个窗口的真实 readiness 经复验写回 Draft；样本量依据补齐；作者审批后生成 Frozen digest |
| P0 | Formal 基础设施落盘 | packet、ledger、Raw、Artifact Manifest 原子持久化并可从中断恢复；篡改、截断、伪摘要和身份冒用负例通过 |
| P0 | 正式内部实验 | 固定输入上完成 160 条四-arm Raw；独立 Reviewer 完成 Oracle、排除与重跑审查 |
| P0 | 真实外部条件 | live Provider、可回滚外部副作用和公平外部 baseline 全部产生直接证据 |
| P0 | 独立复现 | 非作者、第二机器、冻结 release、无指导 session log 与偏差闭环完成 |
| P1 | 论文与发布 | Raw→统计→表图→Claim→文稿自动闭合；同行审读、伦理/披露与版本化 Artifact release 完成 |

## 8. 最终判断与复试表述

客观结论：当前 God-Agent 的科研方法已经从“有实验脚本”进化到“有较强 fail-closed 研究工具链”，但正式科研主体仍未发生。最明显的断点是：**运行时已经有 40/40 本地 pilot，而权威预注册仍是 Draft、1 available/7 blocked，formal Verified 为 0。** 应先关闭输入与执行证据断点，再谈 95+。

复试时建议表述：

> 我把 Runtime 恢复问题拆成 8 个稳定故障窗口和 5 个固定 seed，当前 40 个本地候选 pilot 全部通过。仓库也具备冻结输入校验、160-case 四臂计划、Raw 事件哈希链、确定性统计和 Claim 到证据的 fail-closed 闭合。但当前权威预注册仍未冻结，formal Verified 是 0，真实 Provider、公平外部基线和第二机器独立复现也没有完成。所以我把它定位为方法与工具成熟度约 78，正式科研证据完成度 69，而不是宣称已经达到 95。

禁止表述：

- “40/40 已经是正式 GATE-40”；
- “代码测试通过率等于系统可靠性概率”；
- “append-only 验证器证明正式 Raw 已经真实产生”；
- “本地 helper 就是真实外部 Tool/系统”；
- “已验证真实 Provider、LangGraph/Temporal 基线或独立复现”；
- “科研已经达到 95+”。
