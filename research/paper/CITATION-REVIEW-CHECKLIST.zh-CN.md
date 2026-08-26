# 论文 Claim / Citation 独立审阅清单

> 当前状态：`NotReviewed / NotVerified`。此清单是论文生产门禁，不是引用清单，也不构成任何文献已经核验的证明。
>
> 规则：没有作者之外的审阅者、可定位的一手来源和逐条支持关系时，Claim 必须保持 `NotVerified`；不得用搜索摘要、模型生成内容或本机测试替代引用核验。

## A. 引用元数据核验

每一条最终引用都必须由人工根据一手来源填写并复核以下字段。本轮仅收集了公开来源的候选元数据；除非“状态”变为 `Verified` 且有非作者复核，否则它们不能作为已核验引用或论文结论依据。

| Citation ID | 作者 | 标题 | 出处/版本 | 年份 | DOI/稳定 URL | 一手来源已打开 | 与 Claim 的支持范围 | 状态 |
|---|---|---|---|---:|---|---|---|---|
| CIT-TODO-001 | `TODO` | `TODO` | `TODO` | `TODO` | `TODO` | `NotRun` | `TODO` | `NotVerified` |
| CIT-TAIL-2013 | Jeffrey Dean；Luiz André Barroso | The tail at scale | Communications of the ACM 56(2), pp. 74–80 | 2013 | https://doi.org/10.1145/2408776.2408794 | Yes | 支持尾部延迟、可靠性评测中报告分位数和尾部风险的背景说明；元数据由 Crossref 核对，正文定位待人工复核 | `NotVerified` |
| CIT-CHUBBY-2006 | Mike Burrows | The Chubby lock service for loosely-coupled distributed systems | OSDI ’06 Proceedings, pp. 335–350 | 2006 | https://www.usenix.org/legacy/events/osdi06/tech/full_papers/burrows/burrows_html/index.html | Yes | 支持粗粒度锁、可靠低吞吐存储、租约/锁服务语义的背景说明；USENIX 页面已打开，章节映射待人工复核 | `NotVerified` |
| CIT-AWS-IDEMPOTENCY | Malcolm Featonby | Making retries safe with idempotent APIs | Amazon Web Services Builders’ Library | `NotRun` | https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/ | Yes | 支持重试副作用、幂等请求标识、迟到请求和语义等价的背景说明；AWS 页面已打开，发布日期待人工核对 | `NotVerified` |
| CIT-ACM-ARTIFACT-2018 | Nicola Ferro；Diane Kelly | SIGIR Initiative to Implement ACM Artifact Review and Badging | ACM SIGIR Forum 52(1), pp. 4–10 | 2018 | https://doi.org/10.1145/3274784.3274786 | `NotRun` | 支持软件工件审阅、可复核材料和 badging 流程的背景说明 | `NotVerified` |

## B. Claim 对齐核验

| Claim 范围 | 机器来源 | 所需引用/证据 | 禁止越界表述 | 当前状态 |
|---|---|---|---|---|
| 机制与协议定义 | `research/paper/CLAIM-TABLE.json`、源码测试 | 一手相关工作 + CodeVerified 入口 | 把本地实现写成领域首创 | `NotVerified` |
| 正式实验结果 | `research/paper/MANUSCRIPT-DRAFT.zh-CN.md` | Frozen preregistration、正式 Raw、Artifact Manifest、独立复核 | 把 Fake/local pilot 写成正式结果 | `NotVerified` |
| 外部有效性 | Claim Table `CLAIM-REPRO-001` | 外部基线、第二环境或独立团队复现 | 把同作者同机器复跑写成独立复现 | `NotVerified` |

## C. 论文级审阅门槛

- [ ] 每个正文主张都能映射到 Claim ID 或明确的背景引用。
- [ ] 每条引用均核对作者、标题、出处、年份、DOI/URL 和实际支持范围。
- [ ] 正文、表格、附录和 Evidence Manifest 使用同一候选与同一采样时间。
- [ ] 所有负结果、零差异、失败运行和排除记录均保留并能回到 Raw。
- [ ] 非作者审阅者完成方法、统计、引用和伦理边界审阅；审阅记录可验证。
- [ ] 未完成项保持 `TODO`、`NotRun`、`NotVerified` 或 `NotIncluded`，不得通过改文字升级状态。

## D. 审阅记录

| 审阅轮次 | 审阅者身份 | 候选/提交摘要 | 时间 | P0/P1 未关闭数 | 结论 |
|---|---|---|---|---:|---|
| R0 | `NotAssigned` | `TODO` | `NotRun` | `TODO` | `NotReviewed` |

本清单完成后仍需运行论文表格、证据包、类型检查和统一证据一致性门禁；本清单本身不能把论文状态改为 `Verified` 或 `95+`。
