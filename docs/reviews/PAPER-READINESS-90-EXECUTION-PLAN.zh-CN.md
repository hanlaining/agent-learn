# 论文就绪度 90+ 执行计划与审计账本

> 版本：v1.0
>
> 记录日期：2026-08-26（Asia/Shanghai）
>
> 当前裁决：**47/100，No-Go**。90+ 是目标门槛，不是当前状态；本文件不能把 `NotVerified`、`TODO`、Fake Provider、local pilot、作者自测或合成 Raw 升级为正式证据。

## 1. 直接结论

论文当前可以证明的是“仓库已有可审计的研究协议、统计和表格生成基础设施”，不能证明正式实验结论、外部有效性或投稿完成。要达到论文就绪度 90+，必须同时关闭 P1–P4 的硬门：

| 阶段 | 目标 | 当前状态 | 90+ 必须具备的证据 |
|---|---|---|---|
| P1 研究合同 | RQ、Claim、引用和分析计划一一对齐 | `Partial / NotVerified` | Frozen preregistration digest、endpoint/arm/样本量/排除规则一致性报告、逐条 Claim 映射 |
| P2 正式结果 | 从正式 Raw 重建完整论文结果 | `NotStarted` | 正式 Provider 或获授权执行记录、完整 Raw、Oracle、Artifact Manifest、统计报告、负/零/失败结果索引 |
| P3 独立与外部 | 证明不是同作者同机器的自证 | `NotVerified` | 公平外部 baseline、第二环境/非作者复现、digest 对比、差异处置记录 |
| P4 论文与审阅 | 形成可投稿且可追责的文稿 | `NotReviewed` | 一手引用核验、方法/统计/伦理/全文非作者审阅、修改闭环、最终作者批准 |

任何一个阶段未达硬门，论文总裁决不得写成 `90+` 或 `submission-ready`。

## 2. 当前完整度和评分口径

当前论文就绪度为 **47/100**。该分数反映证据闭环，不是文稿字数或代码测试数量：

| 评分项 | 权重 | 当前估计 | 90+ 需要达到 | 证据边界 |
|---|---:|---:|---:|---|
| 研究问题、预注册与 Claim 对齐 | 20 | 12 | 19 | 不能用 Draft 当 Frozen |
| 正式 Raw、Oracle 与统计结果 | 30 | 5 | 27 | 合成/fixture Raw 不计入正式结果 |
| 外部 baseline 与独立复现 | 20 | 0 | 17 | local pilot、同作者复跑不计独立 |
| 引用、伦理、可复现发布材料 | 15 | 8 | 14 | 搜索摘要和模型生成引用不计核验 |
| 非作者方法/统计/全文审阅 | 15 | 2 | 13 | ID 不同不等于真人独立审阅 |
| **合计** | **100** | **47** | **≥90** | 另受以下硬门约束 |

### 2.1 90+ 硬门

- `formalVerified` 仍为 0 时，论文分数最高只能保持在 No-Go 区间；
- 正式 Raw 必须完整覆盖冻结计划，所有失败、排除、重跑和零结果均可回溯；
- 至少一个公平外部 baseline 和一次非作者/第二环境复现必须有可验证 Artifact；
- Claim Table 中 RQ、REPRO、PAPER 相关 requirement 必须全部绑定证据、Artifact、相对 Locator 和 Reviewer；
- Citation checklist 中每条最终引用必须有一手来源、完整元数据和实际支持范围；
- 方法、统计、伦理/数据治理和全文审阅必须由非作者完成并留存意见与处置；
- `significanceClaimed=false`、`NotVerified/TODO` 的保护规则不得被文字改写绕过；
- 只有上述硬门全部满足且总分达到 90，才允许把状态写为 `ReadyForSubmissionReview`；最终投稿仍需作者批准。

## 3. Claim → Evidence → Artifact → Locator → Reviewer → Status 总账

以下是当前可审计的最小链。`CodeVerified` 只证明仓库工具能力，不是研究结论；缺项必须保持 `NotVerified`。

| Claim ID | Claim（允许的最小表述） | 必需 Evidence | Artifact / 当前 Locator | Reviewer | Status |
|---|---|---|---|---|---|
| `CLAIM-PIPELINE-001` | 存在确定性论文表格渲染器 | `test:paper`、类型检查 | `research/paper/README.zh-CN.md`；命令输出待留档 | `NotAssigned` | `CodeVerified` |
| `CLAIM-METHOD-001` | 统计区间和配对输出被标为描述性 | `test:statistics`、`test:paper` | `research/paper/CLAIM-TABLE.json`；报告 JSON 待绑定 | `NotAssigned` | `CodeVerified` |
| `CLAIM-RQ1-001` | RQ1 已定义，等待正式证据 | Frozen digest、完整 paired Raw、Oracle、Manifest、独立签字 | `research/paper/MANUSCRIPT-DRAFT.zh-CN.md` §1/§3；正式路径 `NotIncluded` | `NotAssigned` | `NotVerified` |
| `CLAIM-RQ2-001` | RQ2 仅是预注册候选，尚无机制效果结论 | 冻结消融 arm、全量 paired Raw、排除清单、独立签字 | 同上 §1/§3；正式路径 `NotIncluded` | `NotAssigned` | `NotVerified` |
| `CLAIM-REPRO-001` | 本地确定性生成已测试，外部复现未验证 | 独立环境、执行日志/Raw、digest 对比、差异处置 | `CITATION-REVIEW-CHECKLIST.zh-CN.md` §B；Artifact `NotIncluded` | `NotAssigned` | `NotVerified` |
| `CLAIM-PAPER-001` | 存在 IMRaD 草案和 Claim 边界表 | 正式结果、相关工作、伦理审查、作者批准 | `MANUSCRIPT-DRAFT.zh-CN.md`、`CLAIM-TABLE.json` | `NotAssigned` | `NotVerified` |
| `CLAIM-MATURITY-001` | 项目正在建设可审计研究基础设施 | 全部适用研究门、正式实验、复现、发布证据 | 本计划 §2–§6 | `NotAssigned` | `NotVerified` |

### 3.1 关闭一条 Claim 的必要条件

1. Evidence 必须来自冻结计划之后的真实执行或可验证的一手来源；
2. Artifact 必须有相对路径、SHA-256/版本和生成命令，不能只给摘要数字；
3. Locator 必须能定位到文件、表格、记录或命令输出的具体位置；
4. Reviewer 必须是非该结果作者的真人，记录身份、范围、时间、意见和处置；
5. Status 只能按证据合同升级，任何缺项都回落到 `NotVerified`。

## 4. P1–P4 执行切片

### P1：研究合同与引用闭合（本地材料可先完成）

**目标：** 使论文问题、预注册、Claim Table、统计计划和引用边界使用同一套术语与数字。

**执行项：**

1. 由作者确认当前论文范围：RQ1 为主要问题，RQ2 为次要问题；成本/Provider 账单字段未冻结前，延迟与成本仅列未来工作。
2. 冻结前逐字段核对 arm、seed、fault window、样本量、停止规则、排除/重跑规则、Oracle、分析方向和多重比较 family。
3. 生成一份 `contract-alignment` 记录，绑定预注册 source/payload digest，并列出每个 Claim 的 requiredEvidence 与 Locator。
4. 逐条检索并打开一手文献；补齐作者、标题、出处、年份、DOI/稳定 URL、支持范围和不能支持的范围。未核验项保留 `TODO/NotVerified`。
5. 由非作者方法审阅者先审 P1；审阅意见关闭前，不进入正式执行。

**通过标准：** 论文正文、Claim Table、Citation checklist 和 Frozen preregistration 无 RQ/数字/术语漂移；`test:paper-consistency` 通过；引用仍未核验则 P1 只能 `Partial`。

**失败处理：** 任何漂移回到 Draft；禁止手工修改结果数字或把引用状态改为 `Verified`。

### P2：正式实验与结果包

**目标：** 让所有论文表格、图和样本流都能从正式 Raw 确定性重建。

**执行项：**

1. 作者授权后冻结预注册，记录真实源码、环境、Provider/模型、依赖摘要和命令。
2. 逐 case 写入 append-only ledger；成功、失败、中止、排除和重跑都保留终态及原因。
3. 真实 Provider 或经授权的正式执行完成全部冻结 arm；Fake/离线 pilot 另列，不进入正式结果分母。
4. 绑定 Oracle 证据、Raw QA、Artifact Manifest、统计 JSON、`results.md`、`arms.csv`、`comparisons.csv`、`raw-index.csv` 和 `failure-records.csv`。
5. 自动生成样本流、窗口分层、主结果、负/零结果、失败分类和敏感性分析；禁止手工录入成功率、P95 或 p-value。

**通过标准：** 计划覆盖 100%；Raw QA 通过；失败记录完整；统计报告可重复生成且 `significanceClaimed=false`；非作者 reviewer 对 Oracle、排除与重跑签字。

**失败处理：** 任一缺失或 hash 漂移都标为 `NotVerified`，不得只报告成功子集；重新执行必须追加事件并说明授权理由。

### P3：公平外部 baseline 与独立复现

**目标：** 关闭“同作者、同机器、同 Fake Provider 自证”的外部有效性缺口。

**执行项：**

1. 冻结至少一个外部框架/基线的同任务、同模型、同预算、同超时/重试、同故障窗口和同 Oracle 协议。
2. 记录真实 Provider 授权、模型版本、区域、限流、费用、unknown outcome 和外部副作用 receipt；不得用本地 Fake 替代。
3. 由非作者在第二环境执行冻结 release，保留环境指纹、命令、日志、Raw、Artifact digest 和差异解释。
4. 由独立 reviewer 复核公平性、环境差异和结果方向；差异不可解释时不得升级 Claim。

**通过标准：** 外部 baseline 和独立复现均有完整 Raw/Manifest/Locator/Reviewer；`CLAIM-REPRO-001` 才能从 `NotVerified` 进入可审阅状态。

**失败处理：** Provider 未授权、baseline 不公平或复现由作者完成时，P3 保持 `NotVerified`，论文不得写跨框架或跨环境结论。

### P4：论文定稿、伦理与非作者审阅

**目标：** 让文稿结论、引用、局限、伦理和开放材料可被第三方追责。

**执行项：**

1. 由统计审阅者核对分析方向、区间、缺失/排除、multiplicity 和任何显著性文字。
2. 由方法审阅者核对 RQ→endpoint→Oracle→Raw→Claim 链；由伦理/数据治理审阅者核对 Provider 授权、隐私、费用、AI 辅助和公开限制。
3. 由非作者全文审阅者逐段检查主张是否越过证据；所有意见记录为 P0/P1/P2，附修改文件和定位。
4. 自动重建图表、表格和附录；核对正文、表格、附录、Evidence Manifest 使用同一候选与采样时间。
5. 作者最终批准版本，生成 release manifest、许可证、数据字典、复现说明和长期 Locator；未公开材料说明原因。

**通过标准：** P0/P1 为 0；所有最终引用已一手核验；所有 Claim requirement 有 Artifact/Locator/Reviewer；非作者全文审阅结论为 `Accepted` 或明确记录未采纳理由；作者批准后才可请求 90+ 复评。

**失败处理：** 任何未关闭的 P0/P1、无一手来源或越界主张都会使论文状态回到 `No-Go / NotReviewed`。

## 5. 交付物与责任矩阵

| 交付物 | 责任角色 | 允许状态 | 最小定位信息 |
|---|---|---|---|
| Frozen preregistration | 作者 + 方法 reviewer | `Draft`→`Frozen` | source/payload SHA-256、冻结时间 |
| 正式 Raw 与 Oracle | 执行者 + 独立 reviewer | `NotIncluded`→`Collected`→`Reviewed` | 相对路径、case ID、事件链、digest |
| 统计与论文表格 | 分析者 + 统计 reviewer | `Generated`→`Reviewed` | 命令、输入 SHA、输出 SHA |
| 外部 baseline | 执行者 + 公平性 reviewer | `NotVerified`→`Reviewed` | 协议、版本、预算、Raw/receipt |
| 独立复现 | 非作者执行者 | `NotVerified`→`Reproduced` | 环境摘要、命令、差异记录 |
| 引用清单 | 作者 + 引用 reviewer | `NotVerified`→`Verified` | 一手 URL/DOI、页码/章节、支持范围 |
| 论文全文 | 非作者全文 reviewer | `NotReviewed`→`Accepted` | 轮次、意见、修改/不采纳理由 |

## 6. 当前阻塞与外部输入

以下不是本地文档可以自行补齐的内容：

- 真实 Provider 授权、调用 receipt、正式 Raw 和 Oracle 结果；
- 公平外部 baseline 的执行与完整 Raw；
- 第二环境或非作者独立复现；
- 一手文献的人工检索、打开和支持范围核验；
- 非作者方法、统计、伦理和全文审阅；
- 作者对 Frozen 预注册、正式候选和最终版本的批准。

在这些输入到位前，本计划的可交付结果是“路线、门禁和记录模板”，不是 90+ 论文证明。

## 7. 当前下一步唯一最小切片

先完成 P1 的 contract-alignment 和引用候选人工核验，再由作者批准 Frozen preregistration；随后才启动 P2 正式执行。不要用继续运行 local pilot、合成 Raw 或增加本地测试来替代 P2/P3/P4 的外部证据。

## 8. 复评规则

复评时必须提交：本文件更新版、三份论文材料、Frozen digest、正式 evidence bundle、外部 baseline、独立复现包、引用审阅清单、非作者审阅记录和作者批准记录。复评器按第 2 节评分并逐项核对硬门；若任一硬门缺失，裁决仍为 `RETURN_FOR_REWORK / NO-GO`。
