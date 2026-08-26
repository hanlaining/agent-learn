# 论文非作者审阅记录模板

> 用途：记录论文方法、统计、引用、伦理和全文审阅。填写人必须是结果作者之外的真人；AI 输出、作者自评、不同字符串的 Reviewer ID 或同机器复跑不能替代本记录。
>
> 初始状态：`NotReviewed`。未填写的字段必须保持 `TODO/NotRun`，不得把模板本身当成审阅证据。

## 1. 审阅元数据

| 字段 | 填写 |
|---|---|
| Review ID | `REVIEW-TODO-001` |
| 轮次 | `R0` |
| 审阅者姓名/组织 | `TODO` |
| 与作者关系/利益冲突 | `TODO` |
| 审阅范围 | `method / statistics / citations / ethics / full-manuscript`（未覆盖项写明） |
| 候选 commit / source digest | `TODO` |
| Frozen preregistration digest | `TODO` |
| Evidence bundle digest | `NotIncluded` |
| 开始/结束时间 | `NotRun` |
| 审阅结论 | `NotReviewed` |

审阅者必须先验证候选、Frozen preregistration、Evidence bundle 和每个 Artifact 的 SHA-256，再开始阅读正文。若任一摘要不匹配，立即记录 `P0-CANDIDATE-DRIFT`，审阅结论保持 `NotReviewed`。

### 审阅者真实性声明（必填）

| 声明 | 填写 |
|---|---|
| 我是结果作者之外的真人，并实际打开了列出的来源和 Artifact | `TODO` |
| 我没有仅凭摘要、截图、模型输出或同机复跑作出结论 | `TODO` |
| 我已披露与作者、Provider、数据源和投稿机构的利益冲突 | `TODO` |
| 我同意审阅意见可随候选包长期归档并接受追责 | `TODO` |

## 2. Claim→证据逐条核验

| Claim ID | 正文位置 | 必需 Evidence | Artifact + SHA/版本 | Locator | 是否支持 | 越界/缺口 | 处置 Issue ID |
|---|---|---|---|---|---|---|---|
| `CLAIM-RQ1-001` | `TODO` | Frozen、正式 Raw、Oracle、Manifest、独立签字 | `NotIncluded` | `TODO` | `NotReviewed` | `TODO` | `ISSUE-TODO-001` |
| `CLAIM-RQ2-001` | `TODO` | 冻结消融、全量 Raw、排除、独立签字 | `NotIncluded` | `TODO` | `NotReviewed` | `TODO` | `ISSUE-TODO-002` |
| `CLAIM-REPRO-001` | `TODO` | 独立环境、日志/Raw、digest 对比 | `NotIncluded` | `TODO` | `NotReviewed` | `TODO` | `ISSUE-TODO-003` |
| `CLAIM-PAPER-001` | `TODO` | 正式结果、一手相关工作、伦理审查、作者批准 | `NotIncluded` | `TODO` | `NotReviewed` | `TODO` | `ISSUE-TODO-004` |

## 3. 审阅检查表

### 方法与预注册

- [ ] RQ、主要/次要终点、arm、seed、fault window 和停止规则与 Frozen 文件完全一致。
- [ ] 样本量/精度目标有可复验计算，且说明配对、分层、聚类和缺失规则。
- [ ] Oracle、纳入/排除/重跑规则在看到结果前已冻结。
- [ ] 论文没有把 local pilot、Fake Provider、fixture 或合成 Raw 当正式结果。

### 统计

- [ ] 成功率、区间、延迟、配对效应和多重比较与分析计划一致。
- [ ] 所有失败、负向、零差异、排除和未决记录均保留并可回到 Raw。
- [ ] 描述性 bootstrap 没有被写成显著性或因果证明。
- [ ] 缺失、停止、重跑和 unknown outcome 的分母处理有明确证据。

### 引用、伦理与发布

- [ ] 每条引用都打开并核对一手来源、完整元数据和实际支持范围。
- [ ] Provider 授权、费用、隐私、凭据脱敏和 AI 辅助披露已审阅。
- [ ] 公开材料、私有 Raw、Manifest、许可证和长期 Locator 的边界清楚。
- [ ] 正文、图表、附录和 Evidence Manifest 使用同一候选、时间和数字。

### 全文越界检查

- [ ] 没有“证明可靠”“显著优于”“跨环境复现”“投稿已完成”等无证据表述。
- [ ] `NotVerified/TODO/NotIncluded` 状态没有被文字或表格隐式升级。
- [ ] 所有修改均记录文件、定位、Issue ID 和复验命令。

## 4. 问题与处置记录

| Issue ID | 严重度 | 文件/定位 | 问题描述 | 作者处置 | 复验结果 | 状态 |
|---|---|---|---|---|---|---|
| `ISSUE-TODO-001` | `P1` | `TODO` | `TODO` | `TODO` | `NotRun` | `Open` |

严重度只能使用 `P0/P1/P2`。P0/P1 未关闭时，审阅结论不能为 `Accepted`，论文也不能请求 90+ 复评。

## 5. 最终结论

| 结论项 | 状态 |
|---|---|
| 方法审阅 | `NotReviewed` |
| 统计审阅 | `NotReviewed` |
| 引用审阅 | `NotReviewed` |
| 伦理/数据治理审阅 | `NotReviewed` |
| 全文审阅 | `NotReviewed` |
| 是否存在开放 P0/P1 | `TODO` |
| 是否建议进入 90+ 复评 | `No` |
| 审阅者签名/日期 | `TODO` |

## 6. 关闭与升级条件

- `R0` 只能输出完整 Claim/引用/证据缺口清单，不能输出 `Accepted`。
- `R1` 必须逐条复核方法、统计、Raw、失败/排除和图表重建；任一 P0/P1 未关闭时只能 `Revise` 或 `Rejected`。
- `R2` 必须完成一手引用、伦理/数据治理、全文越界和发布边界审阅；只有 `Accepted`、P0/P1=0、作者批准且候选摘要一致，才可请求论文 90+ 复评。
- 任何新候选、Raw、Artifact 或正文数字漂移都必须新建审阅轮次，旧轮次只读保留；不得覆盖旧意见。

审阅记录中的 `Accepted` 只表示本轮范围内通过，不等于论文已投稿或研究结论已被外部同行评审。
