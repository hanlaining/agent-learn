# God-Agent 独立智囊审阅：论文证据与考研复试表达

> 审阅日期：2026-08-24（Asia/Shanghai）  
> 审阅范围：`research/paper/**`、`research/rt95-closure/**`、相关 RT95 测试、统一证据快照与既有评审文档  
> 审阅边界：本报告只评价当前工作树可见证据；不把测试 fixture、临时 Frozen 输入、Fake Provider、本地 Pilot 或 preflight 代码写成正式研究结果。

## 1. 独立结论

| 评价对象 | 当前分 | 95+ 差距 | 裁决 |
|---|---:|---:|---|
| 论文证据强度 | **47/100** | 48 | **No-Go**；沿用统一证据主口径 |
| 论文可辩护性 | **58/100** | 37 | **No-Go**；能诚实守住边界，但没有可答辩的实证结论 |
| 论文专项复试表达成熟度 | **84/100** | 11 | **No-Go**；技术主线较强，数字口径与真人追问验证未闭合 |

补充解释：若明确把当前材料定位为“研究协议和可审计实验基础设施”，可辩护性约 **78/100**；若把它定位成“已经完成的实证论文”，则不超过 **46/100**。这两个场景不能混称。当前最优策略不是包装成已完成论文，而是把“我如何阻止自己过度下结论”讲成科研能力的一部分。

本轮新增的 formal preflight、160-case 确定计划、append-only Raw 事件哈希链和 Claim→Evidence Matrix，真实提高了方法工具就绪度，但不改变正式证据分 47：`formalVerified=0`、正式 Raw=0、外部基线=0、独立复现=0、完整相关工作=0。

## 2. 本次独立复验

| 检查 | 结果 | 能证明什么 | 不能证明什么 |
|---|---:|---|---|
| 预注册、formal packet、统计、论文表格、paper evidence 专项 | **44/44 pass** | 本地 Validator、统计公式、确定性渲染、证据包和负例能按当前合同运行 | 正式实验已执行、Raw 真实或 Oracle 正确 |
| 仓库类型检查 | **通过** | 当前 TypeScript 类型闭合 | 研究设计合理或论文结论成立 |
| formal preflight fixture | 4 arm × 8 window × 5 seed = **160 case**；**7 个 blocker** | 计划生成和 fail-closed 行为存在 | 当前计划可以正式开跑 |
| 统一证据快照 | GATE-40 local 40/40；formal 0；Provider live 0 | 当前本机候选功能矩阵已跑通 | 正式 GATE-40、真实 Provider 或外部有效性 |

代码层优点是明确的：Frozen digest 防事后修改、输入摘要绑定、执行人与复核人身份分离、失败/排除/中止/重跑事件只追加、Claim requirement 精确覆盖、显著性主张默认关闭。这些都是复试中值得讲的科研工程能力。

## 3. 当前关键否决点

### P0-1：没有正式结果主体

论文草案的结果、讨论、结论仍全部为 `TODO/NotVerified`。预注册仍是 Draft，当前 formal packet 因权威预注册中 1 available / 7 blocked 而拒绝进入 `ready-to-run`。测试中临时 Freeze 并合成 160 条 Raw 只验证流水线，不产生一条正式论文观察值。

**否决规则：** 没有作者确认的 Frozen 预注册、冻结后正式 Raw、Artifact Manifest 和非作者复核，就不能把论文分数提升到 95，也不能说“论文实验已完成”。

### P0-2：同一项目存在三套 GATE-40 数字

- `preregistration.draft.example.json` 与 `research/rt95-closure/README.zh-CN.md`：1 个窗口 available、7 个 blocked；
- `GATE40-WINDOWS.zh-CN.md`：5 个窗口 available、25/25 local pilot、15 blocked；
- `docs/evidence/current-evidence.json` 与现有总评：40 runnable、40 local passed、0 blocked、formal 0。

这不是措辞小问题，而是复试现场的高风险证据冲突。老师只需追问“到底是 1、5 还是 8 个窗口可运行”，当前材料就无法给出单一权威答案。运行时最新 40/40 不能自动改写预注册；正确做法是逐窗核验入口、Harness、Oracle 和 Artifact 后更新候选预注册，再由作者审定 Freeze。

### P0-3：论文 RQ 与预注册没有对齐

论文草案提出 RQ1、RQ2、RQ3，Claim Table 也为三项建了边界；实际预注册只注册 RQ1。RQ3要求成本与尾延迟，但 Raw v1没有 token、货币成本或 Provider 账单字段。论文还计划故障 taxonomy 和不可判定案例，统计 Raw v1却只接受 `success|failure`；formal ledger 虽接受 `excluded|aborted`，但尚未形成从 ledger 到分析分母的受验证派生协议。

**否决规则：** 不能用只注册 RQ1 的 Frozen 文件支撑 RQ2/RQ3，也不能从没有成本字段的数据生成可靠性—成本结论。

### P0-4：样本量数字与精度目标不一致

Draft 同时写 `perArm=40`、`targetHalfWidth=0.08`、`assumedBaselineRate=0.8`。按当前 Wilson 实现，32/40 的 95% 区间约为 `[0.6524, 0.8950]`，下侧距离点估计约 0.148，明显超过 0.08。40 次零失败的单侧 95% 失败率上界仍约 7.22%。此外，8 个异质故障窗口共享 5 个 seed，观测并非天然独立同分布；逐 pair bootstrap 也未处理 seed/window 聚类与窗口权重。

**否决规则：** 160 只是当前功能覆盖格，不是已经论证充分的正式样本量。Freeze 前必须根据配对 discordance、最小关注效应、窗口分层/聚类和缺失率重做 power/precision 计算。

### P0-5：确认性分析计划尚不可执行

预注册写“paired binary contrast with two-sided confidence interval”和 Holm correction；当前统计流水线只输出描述性 Wilson、率差、率比和固定 seed bootstrap，明确 `significanceClaimed=false`，也没有从 Raw 自动获得预注册 p-value family。方法边界是诚实的，但确认性假设尚没有冻结、可执行、端到端测试的分析入口。

**否决规则：** 在确定配对检验/区间、alpha、方向、多重比较 family、聚类单位、缺失与排除规则之前，不得使用“显著优于”“证明机制贡献”等表述。

### P0-6：外部有效性与独立性为零

`externalBaselines=[]`，真实 Provider 调用为 0，真实外部 Tool/副作用证据为 0，第二机器独立复现为 0，非作者方法/统计审查为 0。执行人与 Reviewer ID 不同只是结构约束，不是独立审查已经发生。

### P0-7：论文基本学术组成仍为空

相关工作没有一条经作者核验的一手引用；伦理、数据治理、AI 辅助披露、公开/私有 Raw 派生规则仍是 TODO；没有正式结果表、样本流、负/零结果段、图表、附录或版本化 Artifact Release。因此它目前是规范的 IMRaD scaffold，不是完整论文。

## 4. 95+ 具体实施与验收清单

以下顺序不能颠倒。前一阶段未验收，不进入下一阶段的正式 Claim。

### 阶段 A：统一研究合同（本地可完成）

1. 建立一个机器可读的“当前窗口状态”单一来源；逐窗记录生产入口、Harness、注入时点、Oracle、成功/失败 Artifact 和最近实跑摘要。
2. 由该来源生成或校验预注册候选表、GATE40 文档和总账，拒绝 1/5/8、25/40 等数字漂移。
3. 作者明确选择论文范围：推荐将 RQ1 设为主要问题、RQ2 设为预注册次要问题；RQ3 若暂不实现成本合同，就降为未来工作，不能留在当前确认性结论范围。
4. 为每个 ablation 增加 manipulation check，证明只关闭目标机制且没有意外关闭恢复链其他能力；“NO-WAL/NO-RECOVERY/NO-LEASE”不能只凭配置名推导因果。
5. 冻结统计单位和权重：按窗口分层报告，明确 seed 是随机化/重复单位还是仅确定性输入，避免把 8×5 格机械当成 40 个独立同分布样本。
6. 重做配对样本量计算或模拟，输入至少包括预期 discordant pair 比例、最小关注效应、alpha/power、多重比较、窗口分层和预期无效/中止率；输出可复验计算报告和摘要。
7. 固定确认性分析：配对二元检验/区间、效应方向、Holm family、缺失/排除/重跑、停止规则和敏感性分析；实现与预注册逐字段一致的端到端 KAT。
8. 定义 ledger→analysis Raw 派生合同，保留 `failure/excluded/aborted` 和全部尝试，明确 eligible 分母，任何删记录都必须带冻结规则 ID 与摘要链。

**阶段验收：** 所有研究文档数字一致；RQ、endpoint、arm、样本量、统计方法、Raw 字段和 Claim Table 一一闭合；formal preflight 只在全部真实条件满足时返回 `ready-to-run`。

### 阶段 B：冻结与正式执行（需要作者授权和真实执行）

1. 作者审定 RQ、样本量、arm、窗口、Oracle、排除/重跑/停止规则并生成 Frozen digest。
2. 绑定真实 commit、source tree、lockfile、config、模型/Provider、操作系统和执行环境摘要。
3. 将 Raw ledger 原子持久化；每条 case 在执行前写 started，成功、失败、中止和排除均写 terminal，重跑必须先写授权事件。
4. 按重新计算后的样本量完整执行 baseline 与各 ablation；**160 是当前最低计划格，不是默认足够样本量**。
5. 每条 terminal 事件绑定实际 Artifact path/SHA；sealed 前验证计划覆盖、事件前缀、文件 Manifest、敏感信息与恢复现场。
6. 独立 Reviewer 复核 Oracle、排除、重跑和 Raw；作者不能自行充当独立复核人，AI 也不能替代签字。

**阶段验收：** Frozen 输入不可变；计划 case 100% 有可追踪终态；失败和负结果没有被选择性删除；统计报告可从正式 Raw 确定重建；Reviewer 有原始签字记录。

### 阶段 C：外部基线与复现（本机代码不能替代）

1. 选择至少一个可比外部框架基线，并冻结同任务、同模型、同 token/请求预算、同资源、同超时/重试、同故障时点和同 Oracle 的公平协议；adapter 特有差异单列。
2. 经费用和数据授权，在真实 Provider 上记录鉴权、模型版本、区域、限流、重试、费用、断网和 unknown outcome。
3. 在可回滚沙箱外部系统验证 effect→receipt→proof；本地 helper 或 Fake Provider 只能作为离线轨道。
4. 由非作者在第二机器或第二操作系统上执行冻结 release，记录环境指纹、人工介入、失败与摘要比较。

**阶段验收：** 公平基线全量 Raw、真实 Provider/外部副作用证据和独立环境复现三者均有 Artifact Manifest 与非作者结论。

### 阶段 D：完成论文和发布包

1. 人工检索并逐条核验 Agent 恢复、分布式语义、可靠性评测、可复现性与统计方法的一手文献；建立 claim→citation 支撑表。
2. 自动生成样本流、arm 主结果、配对效应、窗口分层、负/零结果、失败 taxonomy 和敏感性分析；禁止手工改数字。
3. 讨论只回答证据实际覆盖的 RQ；区分描述性、确认性和探索性结果。
4. 完成内部/构念/结论/外部有效性、伦理、费用、隐私、AI 辅助和公开限制审查。
5. 发布版本化源码、预注册、Raw/公开派生 Raw、数据字典、分析代码、表格、排除日志、Manifest、许可证和长期地址。
6. 获得非作者方法审查、统计审读和全文审读；所有意见、修改和未采纳理由可追踪。

**阶段验收：** Claim Table 中 RQ/PAPER/REPRO 的每项 requirement 都有真实、复核过的 Artifact；结果可由独立环境从 Raw 重建；论文不包含超出证据边界的句子。

### 阶段 E：复试表达达到 95+

1. 建立唯一“答辩数字卡”，现场只使用同一候选的测试数、覆盖率、local/formal、Provider、Raw、基线和复现数字。
2. 准备 30 秒、90 秒和 3 分钟三个版本，均保持同一主张边界。
3. 完成至少 3 次 `2:45–3:10` 真人计时彩排和 1 次非作者随机追问；保留时间、卡顿、问题、反馈和复验记录。
4. 强制练习五个否决追问：40/40 为什么不是可靠性概率；为什么不能称 exactly-once；为什么不是 LangGraph/Temporal 已胜出；AI 做了什么、本人做了什么；论文为何仍未完成。
5. 准备断网、无 Key、应用启动失败的 20 秒降级路线，用冻结 Artifact 展示而不临时编数字。

**阶段验收：** 非作者能够根据统一证据复述所有关键数字；随机追问不发生 local/formal、Fake/live、代码验证/结论验证混淆；真人记录完成 3/3 与 1/1。

## 5. 推荐复试表述

> 我的项目研究的是长程 Agent 在进程崩溃、租约切换和外部副作用边界上的可恢复性。我先把问题拆成 8 个稳定故障窗口和固定 seed，并做了本机候选 Pilot；当前统一快照是 local 40/40，但 formal Verified 仍为 0。仓库已经具备冻结预注册校验、160-case 配对计划、只追加 Raw 哈希链、描述性统计、确定性论文表格和 Claim→Evidence 门禁，它们能阻止事后改计划、删失败结果或把测试写成科研结论。当前 Provider 仍是离线 Fake，预注册权威文件尚未更新并冻结，也没有公平外部框架基线、第二机器复现和正式论文结果，所以我会把它定位为可审计的研究工程原型，而不是已经证明更可靠的系统。

如果老师追问“你的创新是什么”，推荐回答：

> 我当前能守住的创新点不是宣称某个成功率，而是把 WAL、Lease/Fencing、Receipt、Proof 和 unknown outcome 这些恢复语义转成可注入窗口、专属 Oracle、不可变 Raw 和可审查 Claim。机制效果是否成立，要等冻结后的配对消融和独立复现来回答。

## 6. 禁止表述

- “GATE-40 已正式通过”或“40/40 证明可靠率 100%”；
- “160 条实验已经完成”——当前 160 只是由测试 fixture 生成的计划/合成 Raw 覆盖；
- “已经证明 exactly-once”——当前最多能说特定本地 Oracle 下未观察到重复；
- “真实 Provider、真实外部 Tool 或外部框架已验证”；
- “配对 bootstrap 95% CI 证明统计显著”；
- “执行人与 Reviewer ID 不同，所以独立复核已完成”；
- “科研/论文已经 95+”或用方法工具分替代正式证据分。

## 7. 最终裁决

- 作为复试中的**科研工程原型与研究协议**：可以讲，且有较强特色；
- 作为“已经完成的实证论文”：**No-Go**；
- 论文证据 95+：必须等待正式执行、真实外部证据、独立复现和论文审读，不能靠继续增加本地测试直接达到；
- 当前最优先动作：先关闭数字漂移、RQ/样本量/分析合同三项 P0，再由作者审定 Freeze。若这三项不闭合，直接跑更多 case 只会产生设计上不可用的数据。
