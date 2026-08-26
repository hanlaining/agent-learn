# R-EVID-02 外部责任人证据提交清单与字段映射

版本：v1.1（2026-08-26）  
用途：把三类外部科研证据交付成一个可审计包，供主控只读门禁验收。本文是提交合同，不是实验结果；没有真实原件时不得把任何状态改为 `Verified`，科研证据仍按当前分数报告。

## 交付规则（先读）

1. 从冻结候选取得同一组 `commit`、`sourceTreeSha256`、`preregistrationSha256`、`casePlanSha256`。三类证据和总 Manifest 必须完全一致。
2. 在包外私有目录组装下列目录；Manifest 只引用 POSIX 相对路径，不能出现 Windows 绝对路径、反斜杠、`..`、Secret、Token 或环境变量。
3. 每个交付文件在写入 Manifest 前计算小写 SHA-256。失败、排除、超时和 `outcome_unknown` 原件必须保留，禁止只交均值、截图或精选成功样本。
4. Producer、Executor、Reviewer 使用稳定 handle；Executor/Reviewer 不得与 Producer 相同。不要把姓名、邮箱、凭据句柄或私钥写入公开证据文件。
5. 外部责任人只提交真实运行产生的原件和脱敏元数据；本地 Fake Provider、Mock、local pilot、同机复跑和文档演练不满足本清单。

## 统一目录与总 Manifest 槽位

将 `research/rt95-closure/evidence-90-manifest.template.json` 复制为包根的 `evidence-manifest.json`，目录至少如下：

```text
evidence-package/
  evidence-manifest.json
  provider/
    provider-authorization-redacted.json
    raw/ledger.json
    receipt.json
  baseline/
    protocol.json
    raw-results.json
    provenance.json
  reproduction/
    environment.json
    report.json
  artifact/
    raw.json
    derived.json
    statistics.json
    tables.csv
    figures-manifest.json
    artifact-manifest.json
  claims/claim-evidence-matrix.json
  review/non-author-review.json
```

总 Manifest 的 `candidate` 必须填入：`commit`（40 位非零小写 hex）、`sourceTreeSha256`、`preregistrationSha256`、`casePlanSha256`（均为 64 位小写 hex）和带 `Z` 的 RFC3339 `createdAt`。所有 `FileRef` 的 `path`、`sha256` 必须指向包内普通文件；门禁会拒绝缺失、摘要不匹配、符号链接和同一路径复用。

## A. Formal Provider 授权与正式 Raw（30 分）

提交文件：`provider/provider-authorization-redacted.json`、`provider/raw/ledger.json`、`provider/receipt.json`，并在总 Manifest 的 `formalProvider` 槽位填写三者 SHA。

| 模板字段 | 外部责任人填写内容 | 主控验收/拒绝条件 |
|---|---|---|
| `authorizationId`、`authorizerId`、`executorId` | 可追溯的授权编号与稳定 handle | 缺失、写邮箱/Token、授权人无法追溯：拒绝 |
| `status` | 授权前 `authorized-not-called`；运行完成后仍由主控决定是否 `Verified` | 不得自行把模板状态写成 `Verified` |
| `authorizedAt`、`expiresAt` | RFC3339 UTC，授权覆盖完整运行窗口 | 过期、无时区或时间倒退：拒绝 |
| `candidate.*` | 与总 Manifest 完全相同的四项摘要；另填冻结 `configSha256` | 任一摘要漂移：整包 `BLOCKED` |
| `provider.*` | Provider/API family/model/version/region；`credentialHandle` 只写 Secret Manager 引用 | 不交密钥；模型或区域不明确：拒绝 |
| `limits.*` | `maxRequests`、总预算、单请求/总墙钟超时、最大重试 | 0、负数、与冻结 case plan 不一致：拒绝 |
| `stopConditions` | 预算、政策错误、未知结果、digest 漂移等停止条件 | 缺少停止条件或运行中突破预算：拒绝 |
| `approval.*` | 批准范围、脱敏批准 receipt 路径与 SHA | 批准 receipt 缺失/摘要错：拒绝 |
| Raw ledger | 每 case 的 started/recorded/失败/排除/重跑事件及 append-only head | 删除失败、覆盖事件、链断裂、case 数不符：拒绝 |
| `receipt.json` | 请求数、费用摘要、UTC 起止时间、ledger head SHA、候选摘要 | 无真实 Provider receipt 或 head 不匹配：`formalProvider` 保持 `NotVerified` |

总 Manifest 门禁对应错误：`Formal Provider + Raw: formal Provider is not Verified`、`authorization is missing`、`formal Raw ledger SHA-256 mismatch`、`Provider receipt must not be a symbolic link` 等。任何一项出现即不得进入论文正式结果。

## B. 外部 baseline（20 分）

提交文件：`baseline/protocol.json`、`baseline/raw-results.json`、`baseline/provenance.json`；同时保留 `failureAndExclusionLedgerPath` 指向的失败/排除账本，并在总 Manifest 的 `externalBaseline` 槽位填写 protocol/raw/provenance SHA。

| 模板字段 | 外部责任人填写内容 | 主控验收/拒绝条件 |
|---|---|---|
| `baselineId`、`maintainerId`、`reviewerId` | 稳定 ID 与非作者 Reviewer | Reviewer 与 Producer 相同：拒绝 |
| `source.*` | 公开标题、URL/DOI、固定 commit/release、许可证、检索 UTC、来源 SHA | 只有论文引用、未固定版本或无法公开定位：拒绝 |
| `candidateBinding.*` | 至少 commit、preregistration、case plan 摘要 | 与候选不一致：拒绝 |
| `fairnessContract.*` | 相同 task/window/seed/Oracle/预算/超时、重试、并发、人为介入和排除规则 | 协议不公平、缺窗口/seed、只交均值：拒绝 |
| `rawDelivery.*` | 逐 case Raw、失败/排除 ledger、provenance 路径与 SHA | Raw/ledger/provenance 缺失或摘要错：拒绝 |
| `comparabilityDecision` | Reviewer 的可比性决定、理由、时间和签字引用 | `pending-review` 不得升级为 Verified |

总 Manifest 门禁对应错误：`External baseline: external baseline is not Verified`、`baseline Raw is missing`、`baseline provenance SHA-256 mismatch` 等。无法获得逐 case Raw 时，必须保留 `Blocked` 并记录原因，不能填造文件。

## C. 第二环境/非作者独立复现（20 分）

提交文件：`reproduction/environment.json`、`reproduction/report.json`，以及报告中声明的 command log、逐 case Raw、statistics、failure ledger 和 reviewer report；总 Manifest 的 `independentReproduction` 槽位引用环境与报告 SHA。

| 模板字段 | 外部责任人填写内容 | 主控验收/拒绝条件 |
|---|---|---|
| `executorId`、`producerId`、`reviewerId` | 三方稳定 handle | Executor 或 Reviewer 与 Producer 相同：拒绝 |
| `independence.*` | blind-independent/guided、作者协助、结果目录确实为空 | 作者代运行、删失败、替换输出或空目录未证明：拒绝 |
| `candidateBinding.*` | commit、source tree、preregistration、case plan 摘要 | 任一漂移：拒绝 |
| `environment.*` | 非秘密机器/VM ID、OS、Node/npm/工具版本、lock SHA、环境清单及 SHA | 无第二环境指纹或 lock 摘要：拒绝 |
| `execution.*` | 冻结 SOP 路径与 SHA、命令日志与 SHA、UTC 起止、planned/terminal case 数 | 日志缺失、case 数不符、时间非法：拒绝 |
| `outputs.*` | Raw/statistics/failure ledger 路径与 SHA | 只交汇总或失败被删除：拒绝 |
| `comparison.*` | case 集合、digest、失败保留核对、差异和解决意见 | 未逐项解释差异：保持 `NotVerified` |
| `signoff.*` | Executor/Reviewer 签字 UTC、review evidence 路径与 SHA | Reviewer 未签字：不得升级 `Verified` |

总 Manifest 门禁对应错误：`Independent reproduction: independent executor must differ from producer`、`reproduction environment is missing`、`reproduction report SHA-256 mismatch`、`publication review is not Verified` 等。

## 总控接收与复核命令

1. 收到包后先做只读目录检查，确认没有 Secret、符号链接、绝对路径或包外引用。
2. 填好总 Manifest 的所有真实 SHA，连续运行两次门禁；两次之间不得改变包内容：

```powershell
npx tsx research/rt95-closure/src/evidence-90-gate.ts --root D:/path/to/evidence-package --json
npm run test:statistics
npm run test:reproducibility
```

3. 只有输出 `status=READY_FOR_90_REVIEW`、`percent >= 90`，且非作者 Reviewer 已逐 Claim 签字，才可以提交复评；输出 `BLOCKED` 时保留原状态并把 `blockers` 原文发回责任人。
4. 门禁只验证文件闭合、摘要和身份/路径边界，不证明 Provider 真实性、baseline 公平性或结果显著性；主控不得据此修改 `current-evidence.json` 或任何 Verified Claim。

## 当前缺口与责任人回执

在回执中逐项回答“已交/未交/阻塞原因”，并附文件 SHA：

- [ ] 真实 Provider 授权、正式 Raw ledger、receipt；
- [ ] 可公开定位且协议公平的外部 baseline Raw、失败账本、provenance；
- [ ] 第二环境或非作者独立复现的环境指纹、命令日志、逐 case Raw、统计与差异报告；
- [ ] 总 Manifest 的 candidate 四项摘要、Claim 矩阵、artifact chain、非作者论文审阅报告；
- [ ] 所有失败/排除/未知结果原件完整保留，未使用本地 Fake/Mock 替代。

只要任一勾选项未完成，科研证据闭环继续保持 `69/100 / No-Go`；本清单不会把计划、模板或本地专项测试计入真实分数。
