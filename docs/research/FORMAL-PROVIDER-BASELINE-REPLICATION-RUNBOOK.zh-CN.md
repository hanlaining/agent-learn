# Formal Provider、外部基线与第二环境复现 Runbook

版本：v1.0（2026-08-25）  
状态：执行手册，不是实验结果；当前 `formalVerified=0`、`externalBaseline=0`、`independentReproduction=0`。

## 1. 目的与证据边界

本手册规定如何在获得真实授权后，运行 Formal Provider 样本、公开外部基线，并由第二环境或非作者执行复现。它只定义输入、步骤、原始证据和拒绝条件，不把本地 Fake/Mock、local pilot、同作者同机器复跑或文档演练升级为正式科研证据。

在真实外部输入尚未满足前，所有结果必须保持以下状态：

| 项目 | 允许状态 | 禁止写法 |
| --- | --- | --- |
| Provider | `NotRun` / `authorized-not-called` | “已验证真实 Provider” |
| Formal Raw | `NotIncluded` / `NotRun` | “本地 fixture 就是正式 Raw” |
| 外部基线 | `NotRun` / `Blocked` | “已有公平外部对照” |
| 第二环境复现 | `NotVerified` | “同机复跑即独立复现” |
| 论文 Claim | `NotVerified` 或受限的 `CodeVerified` | “论文结论已完成” |

任何一项关键输入缺失、摘要不一致、身份独立性无法证明或 Provider 结果不可判定，必须 `BLOCKED` 或 `outcome_unknown`，不得删除失败记录或改写为成功。

## 2. 必须由外部提供的输入

### 2.1 Formal Provider 授权包

执行前必须由授权人提供一份不含密钥的 `provider-authorization.json`，至少包含：

- `authorizationId`：可审计的授权编号；
- `providerName`、`providerApiFamily`、`modelId`、`modelVersion`、`region`；
- `maxRequests`、`maxTotalCostUsd`、`perRequestTimeoutMs`、`maxWallClockMs`；
- 允许的实验版本、baseline commit、preregistration digest 和 config digest；
- 数据处理、日志保留、脱敏和停止条件；
- 授权人身份与时间戳（使用 handle，不写邮箱、Token 或 Secret）。

真实凭据只通过运行环境的安全凭据句柄注入。密钥、Token、完整 Authorization header、环境变量值和原始敏感 Prompt 不得进入终端、日志、Raw、Artifact 或 Claim 文档。

### 2.2 Formal Raw 输入

Formal Raw 必须来自一次真实授权运行，且每条 case 都绑定：

- 冻结 preregistration payload SHA-256；
- baseline commit、source tree、lockfile、config 摘要；
- `caseId`、arm、fault window、seed、attempt；
- Provider 名称/版本/区域、请求计数、超时、重试、费用摘要；
- 事件哈希链、开始/结束时间、成功/失败/排除/中止原因；
- 原始结果文件相对路径和 SHA-256；
- 人工介入、停止、不可判定和重跑授权记录。

Raw ledger 必须 append-only。失败、`aborted`、`excluded`、`outcome_unknown` 和重跑原件都保留；不得只保留最后一次成功。ledger sealed 后禁止追加或覆盖。

### 2.3 外部基线输入

外部 baseline 必须由可公开识别的来源、固定版本和公平协议提供，至少记录：

- 来源 URL/文献 DOI 或公开仓库版本；
- adapter/commit、模型和 Provider 版本；
- 相同任务、相同 fault window、相同 seed、相同预算和超时；
- 重试、并发、人工介入、排除规则和 Oracle 定义；
- 原始结果、失败和成本，不只提交摘要或最终均值；
- 与本项目方案的已知实现差异和不可比项。

无法取得原始结果、版本或公平协议时，baseline 只能标记 `Blocked`，不能进入正式比较或论文显著性 Claim。

### 2.4 第二环境/非作者复现输入

独立复现必须满足以下至少一项，并留存原始记录：

1. 非作者执行者按 Frozen SOP 在其权限范围内运行；或
2. 第二台机器/干净 VM 使用冻结 Artifact 和同一候选 SHA 运行。

复现记录必须包含环境指纹、OS/Node/依赖版本、命令、开始/结束时间、输出 Manifest、失败/人工介入和执行者 handle。原作者可以答疑，但不得代替执行、修改结果或隐藏失败。作者指导下的复现应标注 `guided`，不得冒充 blind/independent。

## 3. 执行顺序

### Preflight（未通过不得调用 Provider）

1. 验证 preregistration 为 frozen，payload digest 与 Manifest 一致。
2. 验证 baseline commit、source/lock/config 摘要未漂移。
3. 验证 provider authorization 的预算、模型白名单、停止条件和授权期限。
4. 验证 case plan 完整（所有 arm × window × seed），生成唯一 `casePlanSha256`。
5. 创建私有 Raw ledger 和不可覆盖的事件目录；记录 `ledger-opened`。
6. 运行 secret/path 扫描；失败则停止并标记 `BLOCKED`。

Preflight 只能输出 `ready-to-run`，不能输出 `formalVerified=true`。

### Formal Provider 运行

1. 每个 case 先追加 `case-started`，再执行一次受预算约束的调用。
2. 记录原始响应摘要、Provider request id（脱敏）、费用/Token 摘要和终态。
3. 远端结果不确定时记录 `outcome_unknown` 或 `aborted`，不得自动重试覆盖原件。
4. 只有预注册规则允许时，追加 `rerun-authorized` 后再开启新 attempt。
5. 每次终态写入独立 Raw 文件并绑定 SHA-256。
6. 全部 planned case 均有终态后追加 `ledger-sealed`；否则保持 open 并标记未完成。

### 外部 baseline 运行

按同一 case plan 和公平协议运行。任何 adapter 差异、缺失窗口、版本漂移、预算超限或人工干预都必须进入 Raw 和 exclusion ledger；不得通过删行让配对数据完整。

### 第二环境/非作者复现

1. 分发 Frozen SOP、Artifact Manifest、preregistration digest 和安全凭据说明，不分发 Secret。
2. 执行者从空结果目录开始运行，不复用作者的结果目录。
3. 执行者独立生成 Raw、Manifest 和复现报告。
4. Reviewer 对字节摘要、case 集合、失败保留、环境差异和 Claim 上限进行核验。
5. 任一摘要漂移、缺失原件、作者代执行或无法解释差异，复现状态为 `NotVerified`。

## 4. Fail-closed 验收清单

以下清单必须逐项有原始证据。任一 `FAIL`、`MISSING` 或 `UNKNOWN` 都禁止升级正式 Claim。

| 检查项 | PASS 条件 | 失败结果 |
| --- | --- | --- |
| Frozen preregistration | lifecycle=frozen，payload digest 一致 | BLOCKED |
| Candidate binding | commit/tree/lock/config 与 prereg 一致 | BLOCKED |
| Authorization | 授权编号、预算、模型和期限齐全 | BLOCKED |
| Secret hygiene | 日志/Artifact 无 Secret、Token、绝对本机路径 | BLOCKED |
| Case plan | arm×window×seed 完整且 digest 一致 | BLOCKED |
| Provider provenance | 真实 Provider、版本、区域和请求摘要可核验 | `NotVerified` |
| Raw completeness | 每 case 有原始文件、SHA 和终态 | `NotVerified` |
| Raw append-only | 事件哈希链连续，失败/中止/排除未删除 | `NotVerified` |
| Budget/stop | 请求、费用、超时未超预算 | BLOCKED |
| External baseline | 来源、版本、协议和原始结果齐全 | `Blocked` |
| Pairing fairness | 相同 seed/window、排除规则可解释 | `NotVerified` |
| Second environment | 第二环境或非作者原始执行记录齐全 | `NotVerified` |
| Independent review | Reviewer 身份不同且审阅输入独立 | `NotVerified` |
| Statistics | 由 Raw 自动生成且脚本版本绑定 | `NotVerified` |
| Claim closure | Claim→Raw→stats→table→Artifact 全链闭合 | `NotVerified` |

### 禁止升级规则

- 只有本机 Fake/Mock 结果：最多 `CodeVerified` 或 local pilot。
- 只有作者在同一机器复跑：最多 local reproducibility，不是 independent reproduction。
- 只有 Provider 授权、没有真实调用原件：`authorized-not-called`。
- 只有摘要、没有 Raw 原件：`NotVerified`。
- 只有外部论文名称、没有可比 Raw 和协议：baseline `Blocked`。
- 任何校验器被绕过、手工编辑报告或删除失败记录：整批证据作废并重新预注册。

## 5. 交付与状态模板

每次运行必须提交以下脱敏文件：

```text
run-manifest.json
preregistration-digest.txt
provider-authorization-redacted.json
raw/ledger-header.json
raw/events/*.json
raw/cases/*.json
statistics/report.json
tables/*.csv
artifact-manifest.json
reproduction-report.json
```

状态只能从以下集合选择：

```text
NotRun | Blocked | Running | outcome_unknown | Completed-Unreviewed | Verified
```

`Verified` 仅由总控在核对 Raw、Manifest、统计、Claim、Provider、外部基线和独立复现后授予。执行者不得自行把 `Completed-Unreviewed` 写成 `Verified`。

## 6. 当前阻塞与下一步

截至本手册版本，仓库没有可公开的真实 Provider 授权、正式 Raw、外部 baseline 原始结果或第二环境/非作者复现记录。因此当前结论保持：

```text
formalVerified=0
externalBaseline=0
independentReproduction=0
claimBoundary=preflight-only-not-formal-or-external-verification
```

下一步只能由授权人提供脱敏授权包、冻结候选和执行环境后启动 Preflight；在此之前不得调用真实 Provider，不得更新总账数字，不得生成“论文已完成”或“95+”结论。
