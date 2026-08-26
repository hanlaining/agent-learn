# 科研证据闭环 90+ 执行包

版本：v1.0（2026-08-26）  
用途：把当前科研证据闭环 69/100 推进到可审计的 90+；本文件是执行合同，不是实验结果。

## 先说结论：当前真实完整度

当前仓库仍为 **69/100，No-Go**。本轮新增的是可执行的证据包模板和 fail-closed 审计器，不能把缺失的真实 Provider、正式 Raw、外部 baseline 或独立复现“补成”已完成。因此以下状态必须保持：

```text
formalVerified=0
externalBaseline=0
independentReproduction=0
claimBoundary=preflight-only-not-formal-or-external-verification
```

审计器最多输出 `READY_FOR_90_REVIEW`，不写入 `current-evidence.json`，也不把 Claim 的 `NotVerified` 改成 `Verified`。90+ 只有在外部原始证据实际进入证据包、非作者复核完成且总控串行验收后才成立。

## 90 分的可计算组成

| 区域 | 分值 | 90+ 必须满足 |
| --- | ---: | --- |
| Formal Provider + 正式 Raw | 30 | 脱敏授权、真实调用 receipt、append-only Raw ledger、每 case 原件及 SHA |
| 外部 baseline | 20 | 公开来源、固定版本、公平协议、同 seed/window 原始结果及失败记录 |
| 独立复现 | 20 | 第二环境或非作者执行，环境指纹、命令、原始结果、差异说明 |
| Raw→derived→statistics→tables/figures | 15 | 每一环文件存在、SHA 正确、候选/预注册 digest 绑定 |
| Claim 矩阵闭环 | 10 | 每个主要 Claim 都能反向定位到 Raw、统计和 Artifact |
| 非作者复核 | 5 | reviewer 与 producer 身份不同，逐 Claim 意见和签字记录 |
| **合计** | **100** | 任一关键区域 BLOCKED，整体不得宣称 90+ |

审计器将“文件存在且摘要一致”与“状态确实为 Verified”分开检查。只有全部区域通过、没有 blocker 时才会给出 90 分；文档完整度或本机 Fake/Mock 运行不会贡献这些分值。

## 证据包目录和 Manifest

复制 [`evidence-90-manifest.template.json`](../../research/rt95-closure/evidence-90-manifest.template.json) 到一个**包外私有目录**，填入真实值。推荐目录：

```text
evidence-package/
├─ evidence-manifest.json
├─ provider/
│  ├─ provider-authorization-redacted.json
│  ├─ raw/ledger.json
│  └─ receipt.json
├─ baseline/
│  ├─ protocol.json
│  ├─ raw-results.json
│  └─ provenance.json
├─ reproduction/
│  ├─ environment.json
│  └─ report.json
├─ artifact/
│  ├─ raw.json
│  ├─ derived.json
│  ├─ statistics.json
│  ├─ tables.csv
│  ├─ figures-manifest.json
│  └─ artifact-manifest.json
├─ claims/claim-evidence-matrix.json
└─ review/non-author-review.json
```

每个 `path` 必须是包根内的 POSIX 相对路径；每个 `sha256` 必须由实际文件计算。禁止绝对路径、反斜杠、`..`、Token、Secret、完整 Authorization header 或未脱敏 Prompt。

## 分阶段执行方案

### A. 冻结候选与预注册（主控，半天）

1. 记录候选 commit、source tree SHA、lockfile/config SHA 和冻结 preregistration payload SHA。
2. 由作者和非作者分别确认 executor/reviewer handle；两者不得相同。
3. 生成 case plan SHA（所有 arm×window×seed），把 plan 放入包的 artifact manifest。
4. 运行现有预注册和 formal packet Validator；只能得到 `ready-to-run`，不得写 formal Verified。

通过条件：四个 digest 与同一候选一致，窗口/seed 无漂移，凭据策略为 fail-closed。失败处理：停止后续调用，状态记 `Blocked`，保留失败日志。

### B. 真实 Provider 正式采样（外部授权人 + 科研执行者）

1. 授权人交付脱敏 `provider-authorization-redacted.json`，包含 authorizationId、Provider/model/version/region、预算、超时、停止条件和授权时间。
2. 凭据只以运行环境句柄注入；终端和日志只能记录脱敏 request id、token/费用**摘要**，不记录密钥。
3. 严格按 Frozen case plan 执行；每个 case 追加 `case-started` 和 terminal `case-recorded`，失败、排除、中止、outcome_unknown 和获准重跑全部保留。
4. ledger sealed 后计算整体 SHA，并生成 receipt；任何不确定远端终态不得覆盖原件。

通过条件：planned case 全部有终态、事件哈希链连续、原始文件可独立 SHA 校验、请求和费用未超预算。只有满足后，Manifest 的 `formalProvider.status` 才可由总控改为 `Verified`。

### C. 外部 baseline（独立来源）

1. 选择公开论文/仓库/数据集，记录 URL 或 DOI、版本/commit、许可证和 adapter。
2. 用同一任务、fault window、seed、超时、预算、Oracle 和排除规则运行；不可比差异写进 protocol 和 exclusion ledger。
3. 提交原始结果（含失败和成本），不得只交均值、截图或二手引用。
4. 由 Reviewer 检查配对集合与本项目 Raw 一致，确认没有选择性删行。

通过条件：来源可公开定位、协议可复核、raw-results 与 provenance SHA 稳定。无法取得原始结果时保持 `Blocked`，不得进入论文比较 Claim。

### D. 第二环境/非作者独立复现

1. 只分发 Frozen SOP、候选/预注册 digest、Artifact Manifest 和安全凭据说明，不分发作者结果目录或 Secret。
2. 执行者从空目录开始，在第二台机器、干净 VM 或不同身份环境运行；记录 OS/Node/依赖、命令、时间和输出 SHA。
3. 执行者自行生成 Raw、统计和 reproduction report；作者只能答疑，不能代执行、删失败或改结果。
4. Reviewer 比对 case 集合、摘要、失败保留和环境差异；差异必须可解释并留痕。

通过条件：`executorId != producerId`，环境指纹和报告齐全，原始结果可追溯。作者指导下运行应标记 `guided`，不计 blind independent。

### E. 派生、统计、表图和 Claim 闭环

固定链：

```text
provider/raw + baseline/raw
        ↓ deterministic derive
      derived
        ↓ rt95 statistics / confirmatory analysis
      statistics
        ↓ paper table/figure renderer
   tables + figures
        ↓ locator map
   claim-evidence-matrix
```

每个派生文件都要记录输入 SHA、脚本版本、命令、输出 SHA 和生成时间。统计必须从逐条 Raw 自动生成；禁止人工输入 successes/rate/p-value。表格/图只允许引用 statistics 输出，正文数字必须能反查到表图和 Raw locator。

### F. 非作者论文级复核与总控放行

Reviewer 逐 Claim 检查方法、统计、威胁有效性、限制、负结果、引用和候选绑定，记录 `findingId`、严重性、修订前后摘要、时间和签字。总控运行审计器及现有专项门禁两次；任一 blocker、digest drift 或 reviewer 缺失都保持 No-Go。

## 一键审计命令

在仓库根目录执行（不会读取环境变量或凭据）：

```powershell
npx tsx research/rt95-closure/src/evidence-90-gate.ts --root D:/path/to/evidence-package
npx tsx research/rt95-closure/src/evidence-90-gate.ts --root D:/path/to/evidence-package --json
```

命令返回：

- `READY_FOR_90_REVIEW`：文件、SHA、状态和身份检查全部通过，等待总控把证据与 Claim/论文/发行包串行复核；
- `BLOCKED`（退出码 2）：至少一个区域缺文件、SHA 漂移、状态未 Verified、身份冲突或路径不安全。

该命令**不会**把结果写回任何统一快照；它只是证据包的机械验收器。

## Fail-closed 规则

- 只有授权没有真实调用：`formalProvider=Blocked`。
- 只有摘要没有 Raw：`formalProvider=Blocked`。
- Fake/Mock/local pilot：最多 CodeVerified，不计正式分值。
- 同机同作者复跑：不计 independent reproduction。
- 外部 baseline 无原始结果或协议不公平：`externalBaseline=Blocked`。
- 任意文件 SHA 不匹配、事件链断裂、删除失败记录：整包作废，重新预注册。
- Reviewer 与 producer 相同：论文复核 0 分。

## 交付责任和外部依赖

| 交付物 | 责任人 | 本机可做 | 必须外部提供 |
| --- | --- | --- | --- |
| Provider 授权、receipt、formal Raw | 授权人/科研执行者 | 校验格式、SHA、预算 | 真实授权与调用原件 |
| 外部 baseline | baseline 维护者 | 校验来源、协议、配对 | 公开版本和原始结果 |
| 独立复现 | 非作者执行者 | 校验环境指纹、差异 | 第二环境/不同身份运行 |
| Claim/统计/表图链 | 科研负责人 | 运行确定性脚本、审计 | 真实 Raw 输入 |
| 非作者论文审阅 | 外部 Reviewer | 提供模板和门禁 | 逐 Claim 意见与签字 |

在这些外部输入到位前，真实可报告分数仍是 **69/100**；本轮工具和文档只提升“可执行性”，不提升“证据已完成度”。
