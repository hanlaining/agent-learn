# God-Agent 科研、论文与复试闭环最终裁决

> 裁决日期：2026-08-24  
> 依据：统一证据快照、当前工作树实测、科研方法智囊、论文/复试智囊  
> 结论：**科研或论文正式证据没有任何一项达到 95；Research-95 与 Paper-95 均 No-Go。**

## 1. 最终评分

| 评价对象 | 当前分 | 95+ 状态 | 口径 |
|---|---:|---|---|
| 正式科研证据完成度 | **69/100** | No-Go | 当前科研完整度主分 |
| 科研方法与工具成熟度 | **90/100** | No-Go | 协议 P0、持久账本和公开派生链已闭合，只描述工具就绪度 |
| 正式论文证据强度 | **47/100** | No-Go | 当前论文完整度主分 |
| 论文可辩护性 | **58/100** | No-Go | 作为未完成实证论文 |
| 研究协议/审计基础设施可辩护性 | **90/100** | No-Go | 仅限研究工程原型定位 |
| 论文专项复试表达成熟度 | **84/100** | No-Go | 仍缺统一数字卡和真人复验 |

正式证据分沿用 `docs/evidence/current-evidence.json`，不因新增代码或测试上调。能力分说明“仓库能防住哪些错误”，不说明实验已经发生。

## 2. 当前已确认事实

统一证据快照：

- 主测试 699 项：698 pass、1 个 Windows symlink 权限条件 skip、0 fail；
- 测试发现 113/113，0 omitted、0 stale；
- GATE-40 为 40 candidate、40 runnable、40 local passed、0 blocked，但 `formalVerified=0`、`complete=false`；
- Provider 是 `offline-deterministic-fake`，live calls 0、credentials read false；
- 科研 69、论文 47。

本轮更晚的当前工作树实测：

- 完整主测试 716 项：715 pass、1 个相同条件 skip、0 fail；
- formal packet + preregistration 21/21；
- statistics 11/11、paper evidence 6/6、process chaos 17/17；
- 类型检查通过。

699/698/1/0 是统一快照；716/715/1/0 是本轮工作树实测。二者时间与口径不同，不能静默替换总账。

## 3. 本轮真实增量

`formal-research-packet-v1` 已经能够：

1. 只接受 digest 可复验的 Frozen 预注册，拒绝 Draft 与冻结后篡改；
2. 绑定非零 commit、source tree、lockfile、config 和 preregistration SHA-256；
3. 从 arm × window × seed 确定生成 160-case 计划和摘要；
4. 强制 executor/reviewer 身份不同，但保持 `independentReviewCompleted=false`；
5. 固定 Provider 预检 `realApiCalls=0`、`credentialsRead=false`；
6. 以事件哈希链保留 success、failure、excluded、aborted 和获准重跑；
7. 拒绝历史篡改、截断、重复 active attempt、未授权重跑与提前 seal；
8. 精确闭合 Claim Table 的每个 Claim 和 requirement，并禁止本地 preflight 升级 formal/external/publication Claim；
9. 用 `CLAIM-PIPELINE-PREFLIGHT-001` 将该能力纳入声明治理，同时明确不证明 formal run、Raw 真实性、真实 Provider、独立复现或可投稿状态。
10. 逐事件 exclusive-create 持久账本跨重启恢复人工介入、aborted、excluded、failure、rerun 与 success，并拒绝覆盖、篡改、删除、重排和重放；
11. publishable sanitizer 用显式白名单把私有源 tree SHA-256 绑定到公开派生 receipt，拒绝 secret、额外文件、摘要漂移和旧 receipt 重放；
12. 新能力登记为 CodeVerified Pipeline Claim，仍禁止写成 formal Raw、已发布 Artifact 或独立隐私审查。

加上 8×5 权威协议、RQ1/RQ2 收敛、诚实 Wilson 精度、Raw→exact McNemar→Holm、跨重启逐事件账本和 publishable derivation receipt 后，方法/工具成熟度提高到约 90，但正式科研/论文分仍是 69/47。

## 4. 四个本地协议 P0：已关闭

### P0-1：GATE-40 三套口径——已关闭

- `gate40-authoritative-protocol.json` 固定当前唯一口径：8 窗口×5 seed、40/40 local、formal 0；
- `GATE40-WINDOWS.zh-CN.md` 已同步为 8 runnable、40/40 local；
- 旧 `preregistration.draft.example.json` 明确标为 smoke 基础，1 available/7 blocked 不再代表当前实验；
- Validator 拒绝乱序、降级、伪 formal 和本地 helper 外部化。

测试从 smoke 基础与权威协议确定生成 8×5 候选，formal preflight 得到 `ready-to-run`；这不等于作者已 Freeze 或正式执行。

### P0-2：RQ、Raw 与 Claim 未对齐——已关闭

活跃候选范围已收敛为 RQ1 恢复可靠性和 RQ2 单变量消融，二者都有机器可校验 H0/H1。RQ3 成本确认性 Claim 已移除，latency/cost 在论文中明确列为范围外未来工作；没有虚构结果。

### P0-3：错误精度目标——已关闭

`perArm=40` 已明确只表示 8×5 覆盖格。assumed rate 0.8、32/40 的 Wilson 95% 区间约为 `[0.6524,0.8950]`，最大单侧距离约 0.1476，因此 Draft 将名义 `targetHalfWidth` 从错误的 0.08 改为可复验的 0.15，并标记 `not-powered`。正式 Freeze 前仍须基于配对 discordance、窗口分层/聚类、缺失率、MEI 和 Holm family 重算样本量。

### P0-4：确认性分析缺 E2E——已关闭

Draft 入口现从逐条配对 Raw 自动计算双侧 exact McNemar、discordant-pair Wilson/matched-odds 区间，并对三个消融比较应用 Holm。它拒绝人工 p-value、缺比较、非配对 Raw、报告篡改及 formal/significance 越界，固定 `formalVerified=false`、`significanceClaimed=false`。它只证明流水线，不证明正式显著性。

## 5. 95+ 实施顺序

### 阶段 A：本地研究合同闭合

1. 根据 pilot discordance 完成正式分层/聚类样本量模拟并冻结；
2. 为每个 ablation 增加 manipulation check；
3. 建立 ledger→analysis Raw 派生合同，保留全部失败、排除、中止、尝试和分母规则；
4. 为持久 ledger 增加仓库外可信 head anchor，并自动复验 ledger artifact path/SHA 与实际 Manifest；
5. 把确认性输出和 publishable receipt 纳入 paper evidence bundle；
6. 建立同模型、预算、资源、超时、重试、Oracle 和排除规则的外部基线协议。

阶段 A 全部完成只能把本地方法/流水线就绪度推向 95，不能把正式科研或论文证据写成 95。

### 阶段 B：作者冻结与正式执行

1. 作者确认并冻结 RQ、样本量、arm、窗口、终点、分析、排除、重跑和停止规则；
2. 固定 commit/tree/lock/config/prereg/环境摘要；
3. 按重新论证的样本量执行 baseline 与消融，完整保留所有结果和人工介入；
4. 每条终态绑定真实 Artifact，sealed 前完成计划覆盖、摘要和敏感信息检查；
5. 非作者 Reviewer 复核 Oracle、排除、重跑和 Raw，并保留原始签字。

### 阶段 C：外部有效性与独立复现

1. 经预算和数据治理授权执行真实 Provider；
2. 在可回滚沙箱验证真实 effect→receipt→proof；
3. LangGraph、Temporal 或其他基线按冻结公平协议实跑；
4. 非作者在第二机器/环境按冻结 release 无指导复现；
5. 完成非作者方法、统计和论文审读。

### 阶段 D：论文与发布

1. 人工核验一手相关工作并建立 Claim→Citation 表；
2. 从正式 Raw 自动生成样本流、主结果、配对效应、分层结果、负/零结果和敏感性分析；
3. 完成威胁、伦理、费用、隐私与 AI 辅助披露；
4. 发布版本化源码、Frozen 预注册、Raw/脱敏 Raw、数据字典、分析代码、表图、Manifest 和许可证；
5. RQ/PAPER/REPRO requirement 全部由真实 Artifact 与独立 Reviewer 闭合。

### 阶段 E：复试达到 95+

1. 生成唯一答辩数字卡，所有材料只引用同一候选和快照；
2. 完成 30 秒、90 秒和 3 分钟三个版本；
3. 完成 3 次 2:45–3:10 真人计时彩排和 1 次非作者随机追问并留档；
4. 熟练回答 local/formal、Fake/live、代码验证/结论验证、at-least-once/exactly-once、AI辅助/本人贡献边界；
5. 准备断网、无 Key、应用启动失败的冻结 Artifact 降级路线。

## 6. 本地代码无法关闭的硬门

- Frozen 作者签署；
- 冻结后正式 Raw；
- 真实 Provider 与真实外部副作用；
- 公平外部框架基线；
- 非作者第二环境复现；
- 真人方法、统计、论文审读；
- 版本化 Artifact Release。

任一关键门未关闭，正式科研和论文证据都不得上调到 95。

## 7. 复试推荐表述

> 我的项目研究长程 Agent 在进程崩溃、租约切换和外部副作用边界上的可恢复性。我把问题拆成 8 个稳定故障窗口和固定 seed，当前统一快照是本地候选 Pilot 40/40，但 formal Verified 仍为 0。仓库已具备冻结预注册校验、160-case 四臂计划、Raw 事件哈希链、确定性统计和 Claim→Evidence 门禁，能阻止事后改计划、删除失败结果或把测试写成科研结论。当前预注册权威文件尚未统一并冻结，Provider 仍是离线 Fake，也没有公平外部基线和第二机器独立复现，所以我把它定位为可审计的研究工程原型，而不是已经完成的实证论文。

禁止表述：

- “40/40 证明可靠率 100%”；
- “160 条正式实验已经完成”；
- “已经证明 exactly-once”；
- “真实 Provider、外部 Tool、LangGraph/Temporal 已验证”；
- “配对 bootstrap 区间证明统计显著”；
- “不同 Reviewer ID 就等于独立复核已完成”；
- “科研或论文已经 95+”。

## 8. 最终判断

当前最值得在复试中讲的不是夸大的成功率，而是：项目已经把恢复语义转成可注入窗口、专属 Oracle、不可变 Raw 设计和可审查 Claim，并主动拒绝越界结论。

四个本地协议 P0 已关闭，但不能直接把 160 格当成充分样本量并开跑。下一步先完成正式分层/聚类样本量核定和 manipulation check，再由作者审定 Freeze；正式 Raw、外部有效性和独立复现仍不能由本地测试替代。

## 第四波独立意见：Release 可验证，不等于实验已发布

新增版本化 Artifact Release verifier 后，本地工具链已经能失败关闭清单缺项、额外文件、摘要漂移、敏感内容、路径泄漏、版本回退、Claim 越界和审查状态冒充，并能把私有 Raw 树摘要与公开派生 receipt 纳入同一发布摘要。示例 Release 已实际生成和复验。

独立评分保持正式科研 **69/100**、正式论文 **47/100**；本地方法工具成熟度可从 **90/100** 上调到 **92/100**。理由是发布契约已变成可执行证据，但当前包仍绑定 Draft、local tooling 和旧的确定性 Artifact，没有 formal Raw、外部基线、独立复现或真人审查。不得用“Release verified”替换“research result verified”。
