# God-Agent 长程任务可靠性研究：论文草案

> 状态：结构草案，不是可投稿定稿。凡依赖尚未冻结的预注册、Raw、Oracle、独立复核或外部复现的内容均标为 `TODO/NotVerified`。本文不得作为实验已经完成或结论已经成立的证据。

## 摘要

背景：长程 Agent 任务会跨越进程、工具调用和故障窗口，单次演示成功不能代表可恢复性。

方法：本文拟采用按 seed 与 fault window 配对的多 arm 实验，比较完整机制与预注册消融组。描述性轨道报告成功率、Wilson 95% 区间、零失败单侧 95% 上界、延迟中位数/P95、配对率差、率比和固定 seed bootstrap 区间；Draft 确认性轨道从同一逐条 Raw 自动计算双侧 exact McNemar、discordant-pair 区间和 Holm family，但在 Frozen 输入、正式 Raw 与独立复核前固定不形成显著性主张。

结果：`TODO/NotVerified`。当前没有可在论文中报告为正式结果的冻结 Raw、完整 Artifact Manifest、独立复核记录或外部复现证据。

结论：`TODO/NotVerified`。在上述证据闭环前，不得宣称 God-Agent 显著优于基线、具有因果机制优势、达到 Research-95 或具备生产级可靠性。

## 1. 引言

长程任务系统的失败可能发生在模型调用前后、工具副作用提交前后、协调租约切换期间，或进程崩溃恢复之后。只统计“最终是否成功”会掩盖重复副作用、状态丢失、恢复超时和不可判定结果。本项目把这些风险转化为可执行实验窗口，并要求结果能回溯到冻结输入、命令、Raw、Oracle 与复核记录。

本文当前只把两个研究问题纳入预注册候选范围：

- **RQ1（恢复可靠性）**：在预注册故障窗口下，完整机制相对于预注册消融组的任务成功率与恢复质量如何？当前冻结候选未纳入外部 baseline；状态：`TODO/NotVerified`。
- **RQ2（机制贡献）**：Lease、WAL、证据校验等单项机制被移除时，配对结果的绝对率差和失败类型如何变化？状态：`TODO/NotVerified`。
- **范围外问题（延迟与成本）**：当前不作为预注册 RQ 或确认性 Claim。Raw v1 可生成描述性 latency median/P95，但计时边界尚未冻结，也没有 token、货币成本或 Provider 账单字段；只能列为未来工作。

预期贡献仅限以下可审计目标，不能提前写成已证实结论：

1. 一套故障窗口、配对运行与 Raw QA 协议；
2. 一条从机器统计报告到论文表格的确定性流水线；
3. 一份明确区分描述性结果、正式推断和禁止主张的 Claim Table。

## 2. 方法

### 2.1 系统与实验对象

实验对象为 God-Agent 本地多 Agent Runtime。待正式冻结时，应记录源码版本、运行环境、Provider 能力、模型标识、依赖摘要、配置、随机种子和实验命令。任何无法固定或审计的外部依赖都必须作为偏差来源登记。

当前状态：`TODO/NotVerified`。本节尚未绑定可投稿实验的冻结源码摘要与 Artifact Manifest。

### 2.2 实验设计

计划以完整机制为一个 arm，并为每项预注册机制建立消融 arm。所有 arm 必须共享完全相同的 `(seed, faultWindowId)` 集合；每个 arm、seed、故障窗口组合只能有一条 Raw 记录。基线必须在预注册冻结前指定，不能在看到结果后更换。

正式执行前必须冻结：

- RQ、假设、主要与次要终点；
- arm、样本量、seed、fault window 和停止规则；
- 纳入、排除、重跑与失败分类规则；
- Oracle、执行命令、环境与 Artifact Manifest；
- 多重比较 family、分析方法和独立 Reviewer。

当前状态：`TODO/NotVerified`。预注册草案不等于已冻结预注册。

### 2.3 指标与操作化定义

- **成功**：仅当预注册 Oracle 对该次运行给出 `success`；不得由论文作者事后凭印象判定。
- **失败**：Oracle 未满足或运行触发预注册失败条件。超时、崩溃、重复副作用和不可判定结果必须按冻结规则处理，不能静默删除。
- **延迟**：Raw 中记录的非负有限 `latencyMs`。起止点和计时工具仍需在预注册中冻结，状态为 `TODO/NotVerified`。
- **成本**：`TODO/NotVerified`。当前 `rt95-raw-results-v1` 不含 token 或货币成本字段，因此本流水线不能生成成本结论。

### 2.4 Raw QA

正式 Raw 必须满足：schema 版本正确；ID 合法；`runId` 唯一；每个 arm 内 `(seed, faultWindowId)` 唯一；所有 arm 的配对计划完全一致；outcome 只能是 `success` 或 `failure`；延迟为有限非负数。Raw QA 未通过时不得生成正式统计报告。

### 2.5 统计分析

基础统计报告固定 `significanceClaimed=false`，以下输出均为描述性分析：

- arm 成功率同时报告成功数、总样本数与双侧 Wilson 95% 区间；
- 当且仅当观察到零失败时，报告精确单侧零失败 95% 上界；
- 延迟报告中位数与 nearest-rank P95；
- 比较方向固定为“基线减比较组”，报告绝对率差；
- 率比固定为“基线成功率除以比较组成功率”，零分母显式标为非有限状态；
- 相同 seed 与 fault window 上报告配对二元描述性效应；
- 固定 seed 的配对 percentile bootstrap 95% 区间只用于描述，不自动构成显著性检验；
- Raw v1 不接收人工 p-value；描述性报告不应用 Holm–Bonferroni。

另有 `confirmatory-analysis-plan.draft.json` 与受测入口从 Raw 的配对 outcome 自动计算双侧 exact McNemar p-value、discordant baseline-win Wilson 95% 区间、matched odds ratio 区间，并对三个消融比较应用 Holm。该输出固定 `formalVerified=false`、`significanceClaimed=false`；`rejectedUnderDraftPlan` 只是流水线决策字段，不是正式实验结论。只有冻结检验、方向、alpha、family、样本量、聚类/分层和排除规则，并绑定正式 Raw 与独立复核后，才允许进入正式解释。

## 3. 结果

### 3.1 样本流与质量检查

`TODO/NotVerified`：填写计划数、执行数、排除数、排除原因、失败数和 Raw QA 结果。没有完整样本流图或清单时，不得只呈现成功子集。

### 3.2 Arm 描述性结果

`TODO/NotVerified`：正式冻结 Raw 生成统计报告后，用下述命令生成表格；不得手工录入或改写数字。

```powershell
npx --no-install tsx scripts/render-rt95-paper-tables.ts --input <report.json> --output-dir <paper-table-directory>
```

### 3.3 配对比较与消融

`TODO/NotVerified`：报告全部预注册比较，包括负向、零差异和区间宽到无法支持方向判断的结果。任何缺失 arm 或运行必须解释，不能从表中静默移除。

### 3.4 次要结果与故障分类

`TODO/NotVerified`：按冻结 taxonomy 报告故障类型、恢复时间和未决案例。当前 Raw v1 不包含完整故障 taxonomy，因此不得从现有统计报告推导这类结论。

## 4. 讨论

### 4.1 对研究问题的回答

- RQ1：`TODO/NotVerified`。
- RQ2：`TODO/NotVerified`。
- 延迟与成本：范围外未来工作；不得从 Raw v1 生成确认性或成本结论。

讨论必须与效应大小、区间、样本量和证据范围一致。描述性改善不能写成显著改善；本地结果不能外推为跨机器、跨 Provider 或跨模型结论；机制共同出现时不能直接归因于某一单项机制。

### 4.2 正结果、负结果与无显著结果保留政策

所有预注册 arm、窗口和终点均进入结果清单。方向相反、差异为零、区间跨越零、样本不足或运行失败的结果同样保留。排除只能依据冻结规则并同时报告排除前后计数；不得因结果“不好看”而删除、改名、合并终点或停止分析。探索性发现必须标为探索性，并与确认性结果分区呈现。

## 5. 有效性威胁

### 5.1 内部有效性

主要风险包括非确定性 Provider、机器负载差异、故障注入时序漂移、恢复操作对后续运行的污染、Oracle 错误和选择性重跑。缓解措施拟包括配对计划、环境记录、幂等清理、固定停止规则、Raw 不可变保存和独立复核。落实状态：`TODO/NotVerified`。

### 5.2 构念有效性

二元 success 可能不足以表示恢复质量；延迟也不能覆盖重复副作用、数据一致性或人工介入成本。必须把 Oracle 与真实研究问题逐项映射，并报告不可判定状态。落实状态：`TODO/NotVerified`。

### 5.3 结论有效性

小样本会导致区间很宽；多重比较、事后选择终点和把描述性 bootstrap 当作确认性推断都会夸大证据。当前流水线主动禁止显著性主张，但这不替代样本量规划和冻结分析计划。落实状态：`TODO/NotVerified`。

### 5.4 外部有效性

单台 Windows 机器、本地故障注入或单一 Provider/模型的结果不能代表其他操作系统、网络条件、工作负载或真实生产流量。至少需要独立环境复现与边界条件说明。落实状态：`TODO/NotVerified`。

## 6. 伦理、数据治理与 AI 辅助边界

- 实验数据不得包含未经授权的个人信息、凭据、Token 或第三方私密内容；日志发布前必须执行敏感信息检查。
- 真实 Provider 调用涉及费用、服务条款与外部数据传输，必须获得明确授权并记录调用边界。
- AI 可以辅助代码、表述和检查清单，但不能被列为独立 Reviewer，不能替代 Oracle 验证，也不能自行确认事实、相关工作或实验结果。
- AI 生成文本必须由人类作者核验；提示词或模型输出不构成原始实验数据，除非预注册明确把它们定义为实验材料并保存版本。
- 不得让 AI 补写缺失数字、猜测引用、伪造外部复现或把 Mock/离线测试表述为真实 Provider 证据。

当前伦理审查、数据分级和披露文本状态：`TODO/NotVerified`。

## 7. 相关工作

当前状态：`TODO/NotVerified`。本轮已从公开一手页面和 DOI 元数据收集候选来源，但尚未完成作者逐条人工核验和非作者审阅，因此下列内容只能作为待核验背景，不支持任何正式实验结论：

| 背景主题 | 候选来源 | 可支持的范围 | 当前状态 |
|---|---|---|---|
| 尾部延迟与可靠性评测 | Dean & Barroso, *The tail at scale*, CACM 56(2), 2013, DOI:10.1145/2408776.2408794 | 解释为什么报告中位数之外还应报告 P95/尾部风险 | `Collected/NotVerified` |
| 锁服务与租约语义 | Burrows, *The Chubby lock service for loosely-coupled distributed systems*, OSDI ’06, USENIX, 2006 | 说明粗粒度锁、租约和可靠低吞吐存储的背景，不证明本项目实现等价 | `Collected/NotVerified` |
| 重试与幂等副作用 | Featonby, *Making retries safe with idempotent APIs*, AWS Builders’ Library | 说明重试可能产生副作用以及请求标识的必要性，不构成本项目效果证据 | `Collected/NotVerified` |
| 软件工件审阅与可复核材料 | Ferro & Kelly, *SIGIR Initiative to Implement ACM Artifact Review and Badging*, ACM SIGIR Forum 52(1), 2018, DOI:10.1145/3274784.3274786 | 说明工件审阅和可复核材料的背景，不等于本项目已通过审阅 | `Collected/NotVerified` |

正式版本仍需由作者打开每个一手来源，补齐章节/页码和支持边界，再由非作者审阅。没有完成这些步骤时，Claim 状态必须保持 `NotVerified`。

## 8. 可复现性与开放材料

拟发布材料包括预注册摘要、冻结源码与环境摘要、执行命令、Raw、统计 JSON、生成表格、排除日志、Artifact Manifest 和 Reviewer 记录。涉及凭据、隐私或服务条款的材料必须脱敏或说明不可公开原因。

当前可复现性状态：`TODO/NotVerified`。代码内确定性测试只能证明相同合规报告生成相同表格，不能证明 Raw 真实、实验独立复现或科研结论成立。

## 9. 结论

`TODO/NotVerified`。在正式 Raw、冻结预注册、完整证据清单、独立复核与外部复现完成前，结论只能陈述“已建立可审计的分析与表格生成基础设施”，不得陈述机制效果或科研成熟度已经达到 95+。
