# 论文 Claim 事实核验与非作者审阅执行包

> 任务编号：P-PAPER-01  
> 版本：v1.0  
> 初始状态：`NotReviewed / NotVerified`  
> 适用范围：`research/paper/` 论文正文、表格、图、Evidence Manifest、引用和审阅记录。

本执行包把“论文是否就绪”拆成可复核的逐 Claim 任务。它只定义核验和记录方式，不把本地测试、Fake Provider、作者自评或模板内容升级为正式科研证据。任何必填字段缺失时，Claim 必须保持 `NotVerified`，论文门禁保持 `No-Go`。

## 1. 目标和完成定义

目标是让每个正文主张都能沿着同一条链被第三方重建：

```text
正文句子/表格单元
  -> Claim ID
  -> Frozen RQ/endpoint/analysis contract
  -> 原始 Evidence（Raw/Oracle/一手文献）
  -> Artifact + SHA-256
  -> 相对 Locator（文件、章节、行/表格/记录）
  -> 非作者 Reviewer 意见和签名
  -> Status
```

只有同时满足以下条件，Claim 才可写成 `Verified`：

1. 必需 Evidence 全部存在，来自冻结计划后的真实执行或已打开的一手来源；
2. Artifact 路径、版本、SHA-256、生成命令和采样时间齐全；
3. 正文、图表、附录和 manifest 指向同一 candidate/source digest；
4. 非作者真人完成方法/统计/引用/伦理相关范围审阅，P0/P1 均已关闭；
5. 审阅者确认主张没有超出证据支持范围，并留下可追责意见。

`CodeVerified` 只代表代码合同和测试通过；`Reviewed` 代表证据被人核验；`Verified` 仅适用于证据链和审阅链均闭合的 Claim。

## 2. Claim 字段合同

每条 Claim 必须在 `research/paper/CLAIM-TABLE.json` 中有唯一 ID，并在审阅记录中重复以下字段。建议使用 [claim-audit-record.template.json](../../research/paper/CLAIM-AUDIT-RECORD.template.json) 作为机器可读记录起点。记录必须符合 [CLAIM-AUDIT-RECORD.schema.json](../../research/paper/CLAIM-AUDIT-RECORD.schema.json)；候选级汇总使用 [PAPER-AUDIT-INDEX.template.json](../../research/paper/PAPER-AUDIT-INDEX.template.json)。总账只保存记录路径、状态和门禁，不复制实验数字，避免汇总表与原始 Artifact 漂移。

| 字段 | 要求 | 缺失时处理 |
|---|---|---|
| `claimId` | 与 Claim Table 完全一致，禁止重名 | `NotVerified` |
| `claimText` | 论文中实际出现的最小事实句，保留限定词 | 拒绝审阅 |
| `claimType` | `method / result / reproduction / citation / limitation` 之一 | `P1 Open` |
| `manuscriptLocator` | 文件相对路径 + 章节/表格/图号 + 行或单元格 | `P1 Open` |
| `allowedClaim` / `forbiddenClaim` | 从 Claim Table 原样引用边界 | 禁止越界改写 |
| `preregistrationDigest` | 冻结预注册 payload/source SHA-256 | 结果 Claim 不可关闭 |
| `evidenceItems[]` | 每项含类型、相对路径、SHA-256、采样时间、生成命令 | 对应 Claim `NotVerified` |
| `artifactManifestDigest` | 与发布包 manifest 一致 | `P1 Open` |
| `analysisMethod` | 统计方法、方向、alpha、multiplicity、分母规则 | 统计审阅 `P1` |
| `negativeNullFailurePolicy` | 负、零、失败、排除和重跑是否完整保留 | 不完整即 `P0/P1` |
| `reviewer` | 非作者真人、组织、利益冲突声明 | `NotReviewed` |
| `reviewRound` / `reviewedAt` | 轮次和时间（含时区） | `NotReviewed` |
| `reviewDecision` | `Accepted / Revise / Rejected` | 非 `Accepted` 不得关闭 |
| `openIssues[]` | Issue ID、严重度、定位、处置和复验 | P0/P1 未清零则 No-Go |
| `status` | `CodeVerified / Collected / Reviewed / Verified / NotVerified` | 仅按证据门禁升级 |

## 3. 核验顺序（不可跳步）

### Step 0：候选锁定

记录候选 commit（或明确的未提交工作树标签）、Frozen preregistration digest、Evidence bundle digest 和采样时间。任何正文、表格或图来自不同 digest 时，先开 `P0-CANDIDATE-DRIFT`，停止后续核验。

### Step 1：正文逐句盘点

从摘要、引言贡献、结果、讨论和结论按出现顺序摘录最小事实句；每句分配 Claim ID。无法映射到 Claim Table 的句子必须降级为背景描述、增加引用，或标为 `TODO/NotVerified`。

### Step 2：一手来源核验

引用 Claim 必须打开论文、标准、官方规范或原始数据页面等一手来源，而不是搜索摘要、二手博客或模型生成内容。记录作者、标题、出处/版本、年份、DOI/稳定 URL、页码/章节/表号、实际支持范围以及来源不能支持的范围。无法访问全文时状态为 `NotVerified`。

### Step 3：正式 Evidence 和 Raw 核验

结果 Claim 需要冻结计划、完整 Raw、Oracle、统计报告和 failure/exclusion ledger。核对每个 `(arm, seed, faultWindowId)` 是否覆盖、是否唯一、所有 outcome 是否入账，负/零/失败/unknown 是否保留。Fake、fixture、local pilot 只能作为 `CodeVerified` 或背景材料。

### Step 4：Artifact 与图表重建

使用仓库规定的分析和渲染命令，从记录的 Raw digest 重新生成 `results.md`、`arms.csv`、`comparisons.csv` 及图表。比较正文数字、表格、图注、附录和 manifest；任何手工数字、四舍五入不一致或输入 digest 漂移均开 `P0/P1`。

### Step 5：外部性和独立性核验

涉及“优于基线”“跨环境”“可复现”的 Claim，必须有公平外部 baseline、第二环境或非作者独立执行日志、环境指纹、Raw、digest 对比和差异处置。作者在同一机器上的重跑不计独立复现。

### Step 6：非作者审阅和关闭

先方法，再统计，再引用/伦理，最后全文越界审阅。每轮审阅都填写记录、Issue 和复验命令；只有 P0/P1=0、结论为 `Accepted` 且作者批准后，才可把适用 Claim 标为 `Verified` 并请求论文 90+ 复评。

## 4. 逐 Claim 审阅记录表

| Claim ID | 正文 Locator | Claim 最小表述 | 必需 Evidence（路径 + SHA） | 生成命令/输入 digest | 结果与图表 Locator | Reviewer/时间 | P0/P1 | Status |
|---|---|---|---|---|---|---|---:|---|
| `CLAIM-RQ1-001` | `TODO` | `TODO` | `preregistration / raw / oracle / manifest` | `TODO` | `TODO` | `NotAssigned` | `TODO` | `NotVerified` |
| `CLAIM-RQ2-001` | `TODO` | `TODO` | `frozen ablations / paired raw / exclusions` | `TODO` | `TODO` | `NotAssigned` | `TODO` | `NotVerified` |
| `CLAIM-REPRO-001` | `TODO` | `TODO` | `independent env / logs / digest diff` | `TODO` | `TODO` | `NotAssigned` | `TODO` | `NotVerified` |
| `CLAIM-PAPER-001` | `TODO` | `TODO` | `formal results / citations / ethics / approval` | `TODO` | `TODO` | `NotAssigned` | `TODO` | `NotVerified` |

填写规则：`TODO`、`NotIncluded`、`NotRun` 不能被摘要数字替换；每次变更追加新审阅轮次，不覆盖历史意见。

## 5. 非作者审阅包

### 5.1 角色分离

- 方法审阅者：核对 RQ、endpoint、arm、Oracle、排除/重跑和预注册一致性；不得是结果执行者。
- 统计审阅者：核对分母、区间、配对方向、缺失、multiplicity 和显著性措辞；不得只看正文截图。
- 引用/伦理审阅者：逐条打开一手来源，核对授权、费用、隐私、AI 辅助披露和公开边界。
- 全文审阅者：从读者角度检查所有主张是否越界，并确认图表/附录/manifest 同源。

同一人可承担多个范围，但必须分别记录范围、冲突声明和结论；AI 不能担任 Reviewer。

### 5.2 审阅轮次

| 轮次 | 入口条件 | 必查项 | 退出条件 |
|---|---|---|---|
| R0 | 候选和 Frozen digest 已记录 | Claim 盘点、引用可达性、证据缺口 | 形成完整 Issue 清单 |
| R1 | R0 的 P0/P1 已修复 | 方法、统计、Raw/图表重建 | P0/P1=0 或明确退回 |
| R2 | R1 通过且外部/独立证据到位 | 引用、伦理、全文越界、发布边界 | `Accepted` + 作者批准 |

## 6. P0/P1 关闭标准

### P0（阻断）

以下任一项必须立即阻断论文 90+ 复评：

- 候选、Frozen digest、Raw 或 Artifact Manifest 不一致；
- 正文宣称显著、因果、跨环境或生产结论，但 Claim 证据缺失；
- 成功子集替代完整样本流，或删除负/零/失败/排除记录；
- 引用无法打开一手来源，或引用支持范围与正文不符；
- 发现凭据、隐私或未授权 Provider 数据进入待发布材料。

关闭：修正文稿或证据链，追加复验命令和新 SHA-256，由非作者复核后标 `Closed`。

### P1（必须修复）

- Claim 缺 Locator、生成命令、版本或 Reviewer 字段；
- 正文、表格、图注、附录存在舍入/分母/术语漂移；
- 统计方向、缺失处理、multiplicity 或 `significanceClaimed=false` 规则未在正文说明；
- 外部 baseline/独立复现协议不公平、环境差异未解释；
- 审阅意见没有作者处置或复验记录。

关闭：补齐字段并通过相关专项测试；不可解释的结果回退为 `NotVerified`。

## 7. 最终论文门禁

运行顺序：

```powershell
npm run test:paper
npm run test:paper-consistency
npm run test:paper-evidence
npm run check
```

门禁输出需与审阅包一起归档（命令、退出码、采样时间、候选和工作树状态）。90+ 复评必须同时满足：

1. 所有正文结果 Claim 均 `Verified` 或明确降级为 `NotVerified` 并从结论性文字移除；
2. P0/P1 未关闭数为 0；
3. 所有最终引用已完成一手来源核验；
4. 正式 Raw、外部 baseline、独立复现和 Artifact Manifest 均有可定位 SHA 链；
5. 非作者方法/统计/引用伦理/全文审阅均 `Accepted`；
6. 作者完成最终批准，且 `current-evidence.json` 等权威状态文件未被未经证据支持地修改。

若任一条件不满足，最终状态只能是 `RETURN_FOR_REWORK / NO-GO`。

## 8. 当前基线和预期

本包建立时论文就绪度仍为 **47/100**；文档和测试通过不会改变该分数。只有真实 Provider/Raw、外部 baseline、独立复现、一手引用和非作者审阅全部到位后，才可按现有评分表请求 90+ 复评。

## 9. 交接包与持续整改规则

每次整改或审阅结束必须交接一个不可覆盖的候选目录（建议 `research/paper/audit/<candidate-label>/`），至少包含：

- `PAPER-AUDIT-INDEX.json`：候选总账，列出全部 Claim 记录和 R0/R1/R2 审阅记录路径；
- `claims/<claim-id>.json`：逐 Claim 记录，符合 schema；
- `reviews/<review-id>.md`：非作者审阅意见、Issue 处置和签名/日期；
- `commands.txt`：生成、重建和门禁命令、退出码、采样时间；
- `checksums.txt`：所有输入/输出 Artifact 的 SHA-256；
- `open-issues.md`：尚未关闭的 P0/P1/P2 及下一责任人。

主控每轮只做三件事：

1. 读取总账并核对 digest、状态转换和 P0/P1 计数；
2. 运行 `npm run test:paper`、`npm run test:paper-consistency`、`npm run test:paper-evidence`，把原始输出归档；
3. 若任一硬门未通过，继续派发“补证据、重建、复核或处置 Issue”的最小任务；若连续两轮没有新 Artifact、Issue 关闭或外部签字，则停止本地重复操作，明确等待外部责任人。

不得通过修改评分文字、删除失败记录、替换 candidate 标签或把模板字段改成 `Verified` 来制造进度。只有新证据、可复验 Artifact、非作者意见或作者批准能推动状态前进。
