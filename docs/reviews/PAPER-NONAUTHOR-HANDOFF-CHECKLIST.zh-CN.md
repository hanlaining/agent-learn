# 非作者审阅交接与签字字段核对清单

> 任务编号：P-PAPER-02  
> 用途：在 R0/R1/R2 审阅轮次之间交接 Claim 记录、证据摘要和非作者签字，确保交接内容符合 `research/paper/CLAIM-AUDIT-RECORD.schema.json` 及论文 90+ 门禁。  
> 初始状态：`NotReviewed`。本清单不能替代正式 Raw、外部 baseline、独立复现或真人审阅。

## 1. 交接前硬门（主控填写）

交接人必须逐项勾选并附相对路径；任一项为“否”时，不得把 Claim 或审阅轮次升级。

| 检查项 | 对应 schema/门禁字段 | 结果 | 证据路径或说明 |
|---|---|---|---|
| 候选标签唯一且未覆盖旧目录 | `candidate.candidateLabel`、候选锁定 | `TODO` | `TODO` |
| source/candidate、Frozen preregistration、Evidence bundle digest 已记录 | `candidate.*Sha256` | `TODO` | `TODO` |
| 正文路径、章节和行/表格单元格可定位 | `manuscriptLocator` | `TODO` | `TODO` |
| Claim ID 与 `CLAIM-TABLE.json` 完全一致 | `claimId` | `TODO` | `TODO` |
| allowed/forbidden claim 从 Claim Table 原样复制 | `claimBoundary` | `TODO` | `TODO` |
| 每项 Evidence 有 kind、相对 path、SHA、生成命令、locator | `evidenceItems[]` | `TODO` | `TODO` |
| 统计方向、alpha、multiplicity、分母和负/零/失败规则已填 | `analysis.*` | `TODO` | `TODO` |
| `PAPER-AUDIT-INDEX.json` 已列出本记录路径且 digest 一致 | 候选级总账 | `TODO` | `TODO` |
| 测试原始输出已归档（命令、退出码、时间） | 90+ 门禁 | `TODO` | `TODO` |

## 2. 非作者身份与范围核对

审阅者必须是结果作者之外的真人。组织邮箱、账号或 Reviewer ID 不是签字本身；需要在受控交接渠道留下可追责的姓名/组织和时间。

| 必填项 | schema 字段 | 填写要求 | 审阅者填写 |
|---|---|---|---|
| 姓名/组织 | `review.reviewerNameOrOrg` | 使用真实姓名或可追责组织名称，不用 `TODO/匿名 ID` | `TODO` |
| 非作者确认 | `review.nonAuthor` | R1/R2 要求为 `true`；R0 可先为 `false` 但不得 Accepted | `TODO` |
| 利益冲突声明 | `review.conflictOfInterest` | 写明“无”或列出具体关系、处理方式 | `TODO` |
| 审阅范围 | `review.scope[]` | 逐项列出 `method/statistics/citations/ethics/full-manuscript`，未覆盖项要说明 | `TODO` |
| 轮次 | `review.round` | 只能是 `R0/R1/R2`，不得跳过前置轮次 | `TODO` |
| 审阅时间 | `review.reviewedAt` | ISO 8601，包含时区；必须晚于候选采样时间 | `TODO` |
| 结论 | `review.decision` | 只能是 `Accepted/Revise/Rejected/NotReviewed` | `TODO` |

## 3. 签字与真实性声明

审阅者在签字前必须实际打开并核对候选摘要、正文 locator、每个必需 Artifact 和 Issue 复验结果。以下声明必须逐条填写；只写姓名或复制作者意见不构成签字。

| 声明 | 填写 |
|---|---|
| 我确认自己不是该结果的执行者、分析者或正文主要作者。 | `TODO` |
| 我按列出的 locator 实际打开了来源和 Artifact，并核对 SHA-256。 | `TODO` |
| 我没有用搜索摘要、模型生成内容、截图或同机复跑替代一手来源/独立证据。 | `TODO` |
| 我核对了失败、负结果、零差异、排除和重跑记录，没有选择性报告。 | `TODO` |
| 我已披露利益冲突，并确认审阅范围覆盖本轮声称的全部结论。 | `TODO` |
| 我同意本记录、签字时间和后续处置可随候选包长期归档。 | `TODO` |

**签字栏（由审阅者本人填写）：**

```text
Reviewer name / organization: TODO
Role and scope: TODO
Signature or approved organizational attestation: TODO
Signed at (ISO 8601 with timezone): NotRun
Contact / audit reference (non-secret): TODO
```

## 4. Claim 与 Issue 交接

每条 Claim 都必须有记录文件，并将开放问题逐条交给责任人；Issue 不得只写在聊天消息中。

| Claim ID | 记录路径 | 当前 status | P0 open | P1 open | Issue ID | 责任人 | 复验命令/Locator | 交接状态 |
|---|---|---|---:|---:|---|---|---|---|
| `CLAIM-TODO-001` | `TODO` | `NotVerified` | `TODO` | `TODO` | `ISSUE-TODO-001` | `TODO` | `TODO` | `Open` |

Issue 字段必须满足 schema：`issueId`、`severity(P0/P1/P2)`、`locator`、`description`、`disposition`、`reverification`、`status(Open/Closed)`。P0/P1 关闭时必须补充新 SHA、复验退出码和非作者复核；不得通过删除 Issue 或重命名 Claim 来“关闭”。

## 5. 轮次退出条件

| 轮次 | 允许结论 | 必须满足 | 不满足时 |
|---|---|---|---|
| R0 | 仅 `NotReviewed` / `Revise` | Claim 盘点、digest 预检、证据缺口和引用清单完整 | 退回补齐交接包 |
| R1 | `Revise` 或 `Accepted`（范围内） | 方法/统计/Raw/图表重建完成；`nonAuthor=true`；P0/P1=0 | 保持 `Revise`，开 Issue 并复验 |
| R2 | 仅在全部范围覆盖后 `Accepted` | 一手引用、伦理/数据治理、全文越界、发布边界均通过；作者批准；四项外部门通过 | 论文 90+ 复评保持 `No-Go` |

`review.decision=Accepted` 不等于论文投稿或研究结论成立；只有 R2 Accepted、全部结果 Claim `Verified`（或从结论性文字移除）、P0/P1=0、Artifact/图表一致性通过、作者批准后，才允许请求 90+ 复评。

## 6. 主控接收回执

```text
Received candidate label: TODO
Received PAPER-AUDIT-INDEX path: TODO
Claim record count / expected count: TODO / TODO
Reviewer record path: TODO
Digest consistency: NotRun
Schema validation: NotRun
paper / consistency / evidence tests: NotRun
Open P0/P1 after handoff: TODO / TODO
Next owner and due action: TODO
Controller decision: No-Go
Controller name / time: TODO
```

若连续两轮交接没有新增真实 Artifact、关闭 Issue、外部签字或 digest 绑定，主控应停止重复本地文档操作，明确列出外部责任人和阻塞证据；不得把“工具可用”写成“论文已就绪”。
