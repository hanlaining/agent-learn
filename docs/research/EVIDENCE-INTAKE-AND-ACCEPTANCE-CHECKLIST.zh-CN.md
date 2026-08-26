# 90+ 科研证据接收与验收清单

版本：v1.0（2026-08-26）  
用途：把真实 Provider、正式 Raw、外部 baseline、独立复现接收为可审计证据。本文是操作清单，不是结果声明；未完成前科研证据仍为 69/100。

## 责任与交付边界

| 小需求 | 责任人 | 必须交付 | 本机只做 | 90+ 阻塞条件 |
|---|---|---|---|---|
| R-EVID-01A Provider 授权与正式 Raw | Provider 授权人 + 科研执行者 | 脱敏授权、冻结绑定、append-only ledger、每 case 原件、receipt | SHA/预算/哈希链审计 | 无真实调用、缺 case、删失败、超预算、摘要漂移 |
| R-EVID-01B 外部 baseline | baseline 维护者 + 非作者 reviewer | 公开来源固定版本、公平协议、逐 case Raw、失败/排除 ledger | 来源、版本、配对和 SHA 审计 | 只有论文/均值、协议不公平、无法取得 Raw |
| R-EVID-01C 独立复现 | 非作者执行者 | 第二环境指纹、命令日志、逐 case Raw、统计、差异报告 | 身份差异、候选绑定、输出 SHA 审计 | 同作者同机、作者代执行、空结果目录未确认 |
| R-EVID-01D 闭环总控 | 科研负责人 + 非作者 reviewer | evidence-manifest、Claim 矩阵、审阅报告 | 运行 fail-closed gate | 任一关键状态不是 Verified |

## 统一输入冻结（总控先做）

1. 从冻结预注册取得 `preregistrationSha256`；确认 `lifecycle=frozen`。
2. 固定候选 `commit`、source tree、lockfile、config、case plan SHA；将 commit、source tree、预注册和 case plan 的 SHA 写入总 Manifest 的 `candidate`，并写入所有责任人模板的 `candidateBinding`。
3. 生成包外私有目录，复制 [`evidence-90-manifest.template.json`](../../research/rt95-closure/evidence-90-manifest.template.json) 为 `evidence-manifest.json`。
4. 为每个责任人发放对应模板：Provider、baseline、reproduction；不发送 Secret 或作者结果目录。
5. 记录 UTC 开始时间、操作者 handle 和目标包路径；包路径必须为本地绝对路径，但 Manifest 内只能出现 POSIX 相对路径。

## A. Provider/正式 Raw 接收步骤

### 输入

- [`provider-authorization.template.json`](../../research/rt95-closure/provider-authorization.template.json) 的脱敏副本；
- Frozen case plan 和其 SHA；
- 运行环境凭据句柄（只由执行环境读取）。

### 执行与命令

1. 授权人填写 Provider、模型版本、区域、预算、超时、停止条件；`status` 保持 `authorized-not-called`。
2. Preflight：验证预注册和候选 digest；只允许输出 `ready-to-run`。
3. 每个 case 追加 `case-started`，完成后追加 `case-recorded`；失败、排除、中止、`outcome_unknown` 和获准重跑均追加，不覆盖原件。
4. 对每个原始文件计算 SHA-256，并生成 `provider/receipt.json`；receipt 记录请求数、费用摘要、开始/结束 UTC 时间和 ledger head SHA。
5. 执行只读审计：

```powershell
npx tsx research/rt95-closure/src/formal-research-packet.ts --help
npx tsx research/rt95-closure/src/evidence-90-gate.ts --root D:/path/to/evidence-package --json
```

### 通过标准

授权范围、候选绑定、planned case 数、终态数、事件哈希链、原件 SHA、预算和 Secret 扫描全部 PASS。总控核验后才可把 `formalProvider.status` 改为 `Verified`；执行者不得自行升级。

## B. 外部 baseline 接收步骤

### 输入

- [`external-baseline-protocol.template.json`](../../research/rt95-closure/external-baseline-protocol.template.json)；
- 公开 URL/DOI、固定 commit/release、许可证和 adapter；
- 与候选相同的 task/window/seed/Oracle/预算/超时协议。

### 执行与命令

1. baseline 维护者先提交协议和来源 SHA，Reviewer 判断是否可比；未通过不得运行或进入论文表格。
2. 按相同 case plan 运行，保留逐 case 原始结果、失败、排除和成本；禁止只提交均值或截图。
3. 记录 adapter 差异、缺失窗口、版本漂移和人工介入；任何差异写入 `knownDifferences` 与 exclusion ledger。
4. 总控把三个文件 SHA 填入 Manifest，并运行：

```powershell
npx tsx research/rt95-closure/src/evidence-90-gate.ts --root D:/path/to/evidence-package --json
```

### 通过标准

来源可公开定位、版本固定、协议公平、原始结果可复算、失败未删除、配对集合可解释。任何一项不满足，状态必须为 `Blocked`，论文只能写限制，不能写比较 Claim。

## C. 独立复现接收步骤

### 输入

- [`independent-reproduction-report.template.json`](../../research/rt95-closure/independent-reproduction-report.template.json)；
- Frozen SOP、候选/预注册/case plan SHA；
- 空结果目录和安全凭据说明。

### 执行与命令

1. 非作者执行者在第二台机器、干净 VM 或不同权限身份下从空目录开始；填写环境指纹和依赖 lock SHA。
2. 执行者自行保存 SOP SHA、命令日志、开始/结束 UTC 时间、逐 case Raw、统计和失败 ledger。
3. 作者只能答疑；不得运行命令、修改输出、删失败或替换执行者。指导运行必须标记 `guided`。
4. Reviewer 比对 case 集合、候选 digest、失败保留和统计差异；差异必须逐项解释。
5. 总控运行：

```powershell
npx tsx research/rt95-closure/src/evidence-90-gate.ts --root D:/path/to/evidence-package --json
```

### 通过标准

`executorId != producerId`、`reviewerId != producerId`、空目录证明、环境指纹、命令日志、原始结果和差异报告齐全；Reviewer 签字前状态保持 `NotVerified`。

## D. SHA、时间与身份验收规则

- 所有 SHA 使用 SHA-256 小写十六进制；计算示例：`Get-FileHash -Algorithm SHA256 <path>`。
- 时间统一 RFC3339 UTC（末尾 `Z`）；不得用本地无时区时间。
- 身份使用稳定 handle，不写邮箱、Token、姓名或秘密；Producer、Executor、Reviewer 至少两方不同。
- Manifest 只引用包内 POSIX 相对路径；禁止绝对路径、反斜杠和 `..`；引用文件必须是包内普通文件，不得使用符号链接，且每个文件只能被一个证据槽位引用。
- `candidate.createdAt` 必须是带 `Z` 的 canonical RFC3339 UTC 时间；producer、executor、reviewer 使用稳定 handle，且 producer 不得与 executor/reviewer 相同。
- Raw ledger 必须 append-only；事件链断裂、文件被覆盖、失败记录缺失均使整包作废。

## E. 负结果、失败和阻塞处理

| 情况 | 必须记录 | 状态 | 后续 |
|---|---|---|---|
| Provider 超时/远端不确定 | 原始响应摘要、request id 摘要、时间、attempt、reason | `outcome_unknown` / `Blocked` | 不覆盖；按预注册规则申请重跑 |
| case 失败或排除 | 原件 SHA、失败原因、排除规则和 reviewer | `Completed-Unreviewed` | 统计按预注册规则处理 |
| 预算/停止条件触发 | receipt、ledger head、剩余 case | `Blocked` | 授权人重新批准才可继续 |
| baseline 缺 Raw/不可比 | URL/版本、缺失项、差异理由 | `Blocked` | 不进入比较 Claim |
| 独立复现摘要漂移 | 双方 digest、环境差异、复核意见 | `NotVerified` | 重新定位差异；不得挑选成功运行 |
| Secret/path 扫描失败 | 扫描报告和隔离路径 | `Blocked` | 清理并重新生成，不能编辑原件掩盖 |

## F. 总控放行与分数规则

1. 将真实文件 SHA 写入 Manifest；填写 Claim→Raw→statistics→table/figure→正文 locator。
2. 由非作者 Reviewer 完成逐 Claim 审阅，提交 `review/non-author-review.json`。
3. 连续运行两次审计（间隔至少一次目录只读检查）：

```powershell
npx tsx research/rt95-closure/src/evidence-90-gate.ts --root D:/path/to/evidence-package --json
npm run test:statistics
npm run test:reproducibility
```

4. 只有审计输出 `READY_FOR_90_REVIEW`、专项测试通过、Reviewer 签字且总控复核后，才可把科研证据分数从 69/100 重新评估；本清单本身不改变 `current-evidence.json`。

## 当前外部证据清单（基线）

| 证据 | 当前状态 | 接收后状态 | 是否已提供 |
|---|---|---|---|
| 真实 Provider 授权 + receipt + formal Raw | `NotVerified` | `Verified` | 否 |
| 外部 baseline 原始结果与公平协议 | `Blocked` | `Verified` | 否 |
| 第二环境/非作者独立复现 | `NotVerified` | `Verified` | 否 |
| Claim/Artifact/统计 SHA 链 | `NotVerified` | `Verified` | 仅有模板 |
| 非作者逐 Claim 复核 | `NotVerified` | `Verified` | 否 |

在上述清单全部有原始文件、SHA 和独立复核之前，科研证据闭环仍按 **69/100、No-Go** 报告；本材料只减少执行歧义，不虚增完成度。
