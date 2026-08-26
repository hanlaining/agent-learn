# God-Agent 当前科研闭环独立结论

> 日期：2026-08-24  
> 范围：科研问题、实验方法、可复现性、消融与统计、外部效度、论文级证据  
> 边界：不把 Fake Provider、本地 helper、测试 fixture、临时 Frozen 输入或作者自述计作科研外证。

## 1. 当前评分

| 环节 | 当前分 | 距 95 | 裁决 |
|---|---:|---:|---|
| 正式科研证据完成度 | **69** | 26 | No-Go；沿用统一证据总账 |
| 本地研究合同与工具成熟度 | **90** | 5 | 协议 P0、持久账本与公开派生链已闭合；尚无正式/外部证据 |
| 预注册与研究问题对齐 | **90** | 5 | RQ1/RQ2 已闭合；仍需作者核定并 Freeze |
| 本地实验 Harness/Oracle | **92** | 3 | 8×5、40/40 local；Fake/helper 边界明确 |
| 统计与分析流水线 | **88** | 7 | 描述性与 Draft 确认性入口均可执行；样本量与聚类仍待正式核定 |
| Claim 与防越界治理 | **94** | 1 | 五个 Pipeline Claim 可闭合，formal/external Claim 保持 NotVerified |
| 正式 Raw 与独立审查 | **25** | 70 | formal Raw 为 0，真人独立 Reviewer 为 0 |
| 外部有效性与公平基线 | **20** | 75 | live Provider、真实外部系统、外部框架基线、第二机器均为 0 |
| 论文级结果与发布 | **47** | 48 | 正式结果、相关工作审读、版本化发布尚未完成 |

分数不能取最高项替代最低项。对外回答完整度仍使用科研 69、论文 47；90/88/92 只描述本地工具和合同。

## 2. 四个本地 P0 的关闭证据

### P0-1：1/5/8 窗口口径漂移——已关闭

直接证据：

- `research/rt95-closure/gate40-authoritative-protocol.json` 成为当前机器权威源；
- 固定 8 个稳定窗口、5 个 seed、40 个候选 case；
- 固定 `localPassed=40`、`localFailed=0`、`formalVerified=0`；
- 每个窗口都绑定稳定 Oracle、生产命令和 Harness；
- W02/W07/W08 明确是独立本地 helper，不是真实外部系统；
- `preregistration.draft.example.json` 标题和文档明确降级为旧 Validator 的 smoke 基础，1 available/7 blocked 不再代表当前实验口径；
- 权威 Validator 拒绝窗口降级、乱序、伪 formal 和 claim boundary 外部化；
- formal packet 测试从权威候选生成 4 arm × 40 格计划，preflight 为 `ready-to-run`，但 verification 三项仍为 false。

关闭范围：数字与候选协议已经统一。没有关闭作者 Freeze、正式 GATE-40 或真实外部系统。

### P0-2：RQ1–RQ3 与预注册不齐——已关闭

直接证据：

- 活跃预注册范围收敛为 RQ1 恢复可靠性、RQ2 单变量机制消融；
- RQ1/RQ2 都有机器可校验的 H0/H1；
- Claim Table 保留 RQ1/RQ2 为 NotVerified；
- 删除 RQ3 成本确认性 Claim；
- 论文明确把 latency/cost 列为范围外未来工作：Raw v1 的 latency 只能描述，成本字段不存在。

关闭范围：研究问题、假设、Claim 和当前 Raw 能力不再互相越界。没有产生任何 RQ1/RQ2 正式结果。

### P0-3：perArm=40 与 half-width=0.08 不成立——已关闭

直接证据：

- `perArm=40` 明确只表示 8 窗口×5 seed 覆盖格；
- assumed rate 0.8、n=40 时，32/40 Wilson 95% 区间约为 `[0.6524,0.8950]`；
- 最大单侧距离约 0.1476，Draft 的名义 `targetHalfWidth` 改为诚实的 0.15；
- 测试同时证明 0.15 可覆盖该边际、0.08 不成立；
- basis 明确为 `not-powered`；
- `targetPower=0.8` 只保留为正式设计目标，文档明确 40 格没有证明达到该 power。

关闭范围：消除了错误精度主张。正式 Freeze 前仍必须根据配对 discordance、窗口分层/聚类、缺失率、MEI 和 Holm family 重算样本量，正式 perArm 可以高于 40。

### P0-4：配对 CI/Holm 没有 Raw E2E——已关闭

直接证据：

- 新增 `confirmatory-analysis-plan.draft.json`；
- 新增 `src/confirmatory-analysis.ts`；
- 从逐条配对 Raw 自动计算双侧 exact McNemar p-value；
- 自动计算 discordant baseline-win Wilson 95% 区间和 matched odds ratio 区间；
- 自动对三个消融比较应用 Holm；
- 绑定 Raw/plan canonical SHA-256；
- 拒绝缺少 comparator、重复 family、人工注入 p-value、非配对 Raw、报告篡改及 formal/significance 越界；
- 输出固定 `formalVerified=false`、`significanceClaimed=false`；
- `rejectedUnderDraftPlan` 只表示 Draft 流水线阈值结果，不是正式显著性。

关闭范围：确认性计算链已存在并有正反例。没有证明样本量充分、Draft 已 Frozen、Raw 真实或机制具有因果效果。

## 3. 第三波本地证据链增量

### 持久 run ledger

`persistent-run-ledger.ts` 复用 formal Raw 事件哈希链，并将每个序号写为 exclusive-create 的独立 canonical JSON 文件。进程重启后不依赖内存快照，直接由不可变 header 与事件目录重建 open/sealed 状态。

直接覆盖：人工介入、active attempt 中断恢复、aborted、excluded、failure、获准重跑、success 和 sealed。攻击测试拒绝覆盖、内容篡改、中间删除、重排、重放与额外文件。它仍是 preflight/local 能力；攻击者同时删除尾事件和全部同源锚点的模型需要仓库外可信 head anchor。

### Publishable sanitizer

`publishable-sanitizer.ts` 对私有源全树计算摘要，但公开 receipt 不披露被排除的私有路径。公开文件必须来自显式 allowlist、通过 secret 检查，并与私有源同路径 bytes/SHA-256/content type 完全一致。

攻击测试拒绝 helper-secret/credentials 文件名、高置信凭据内容、私有源漂移、公开篡改、删除、额外文件、receipt 摘要漂移、旧 receipt 重放和覆盖已有输出。它不代表已经发布，也不替代真人隐私审查。

## 4. 本轮复验

| 门禁 | 结果 |
|---|---:|
| 权威协议、formal packet、RQ、样本量、确认性 E2E、持久账本、sanitizer 与攻击负例 | **32/32** |
| 基础统计 KAT/Raw QA | **11/11** |
| Paper evidence bundle | **6/6** |
| Process chaos | **17/17** |
| TypeScript 类型检查 | **通过** |
| Repository security scan | **通过；无高置信凭据** |

这些测试证明代码和合同行为，不证明测试 fixture 是正式 Raw。

## 5. 仍未达到 95 的 P0/P1

### 外部/真人 P0

1. 作者核定正式样本量、分析、排除/重跑/停止规则并签署 Frozen 预注册；
2. 固定 commit/tree/lock/config/环境后执行正式实验；
3. 完整保留 baseline 与消融的正式 Raw、失败、排除、中止和重跑；
4. 真实 Provider 与可回滚外部系统 effect→receipt→proof；
5. 同预算 LangGraph/Temporal 等公平外部基线；
6. 非作者第二机器无指导复现；
7. 真人方法、统计和论文审读；
8. 版本化 Artifact Release。

### 本地 P1

1. 为持久 ledger 增加仓库外可信 head anchor，覆盖“同时删除尾事件与同源文件”的强攻击模型；
2. ledger path/SHA 与实际 Artifact Manifest 自动复验；
3. 根据 pilot discordance 完成分层/聚类样本量模拟和 KAT；
4. 把确认性报告与 publishable receipt 纳入 paper evidence bundle，但继续保持 Draft/formal 边界；
5. 由真人完成公开包隐私审查、许可证检查和发布签字。

## 6. 最终结论

四个协议层 P0 已经真实关闭；第三波又补齐了跨重启的逐事件 exclusive-create 账本，以及私有源摘要→公开白名单派生 receipt。人工介入、aborted、excluded、failure、rerun 和 success 都进入不可覆盖哈希链，公开包会拒绝 secret、额外文件和摘要漂移。因此本地研究合同与工具成熟度从约 84 提升到 **90**。

正式科研证据仍是 **69**，论文证据仍是 **47**。原因不是本地测试不足，而是正式 Raw、真实外部系统、公平基线、独立复现和真人审查仍为 0。任何把 90 写成正式科研完成度、把持久账本测试写成正式 Raw，或把 sanitizer 写成已经公开发布，都会构成越界。

## 第四波：版本化 Artifact Release（本地方法能力）

本轮新增一个组合式 Release creator/verifier，复用既有 Artifact Manifest 与 publishable sanitizer，没有建立第二套脱敏逻辑。严格清单绑定源码、Draft 预注册、数据字典、公开派生 receipt、统计、表格、Manifest、License 和 Claim Table；只允许纳入 `CodeVerified` Claim。

攻击面覆盖缺失、extra、摘要漂移、绝对路径、本机路径、secret、版本回退、Claim 越界、未审查状态和非递增版本。测试同时发现 `.ts/.js` 原先按二进制类型跳过正文 secret 检查，现已改为文本扫描。

实际示例 Release：`research/artifact-releases/local-tooling-v0.1.0/release/`，9 个受控文件并已独立 verify。它固定声明 `Draft / NotIncluded / NotRun / NotVerified / NotReviewed`，不能解释为正式实验或公开论文 Artifact。

评分口径：正式科研仍为 **69**，正式论文仍为 **47**；本地研究合同/工具成熟度由 **90 提升到 92**。尚未关闭作者 Freeze、formal Raw、真实 Provider/外部副作用、公平外部基线、第二机器复现、真人方法审查与版本化公开发布。
