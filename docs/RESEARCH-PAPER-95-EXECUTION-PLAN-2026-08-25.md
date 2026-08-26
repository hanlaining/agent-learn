# 科研论文生产 95+ 执行方案

更新时间：2026-08-25 17:49:41 +08:00  
状态：Active / No-Go until evidence-complete

> 本计划是持续目标的执行合同，不是论文完成声明。每次切片都必须以真实测试和可追溯产物验收；任何一项未达标都继续返工。

## 0. 当前独占验收快照（2026-08-25，+08:00）

本轮在停止并发写入后串行复核，候选仍为当前工作区候选；以下数字只描述本机工具链，不升级正式科研结论：

| 门禁 | 结果 | 解释 |
| --- | ---: | --- |
| TypeScript | 通过 | 只证明类型检查通过 |
| Test discovery | 115/115 | 正式测试文件均被 package scripts 覆盖 |
| `npm test` | 869 total；867 pass；2 conditional skip；0 fail | 两条 skip 为 Windows 平台能力条件，不得写成 869/869 |
| 主测试行覆盖（两次独占） | 26,867/28,804 = 93.2752%；26,872/28,804 = 93.2926% | 距 95% 门槛仍差约 492–497 行；分母固定为 123 文件/28,804 行 |
| Loaded source | 117/123 = 95.122% | 仅 loaded 子门，不等于全仓行覆盖 |
| Statistics / Paper tables / Consistency / Evidence / Reproducibility / Process Chaos | 11/11；7/7；29/29；6/6；9/9；17/17 | 证明本地校验与 local pilot 边界，不等于正式研究结果 |

正式科研状态继续固定为：`formalVerified=0`、正式 Raw `NotIncluded`、真实 Provider=0、外部 baseline=0、独立复现=0、publication review=`NotReviewed`。生产发行仍因官方审计 3 个 high 和缺少签名/干净机/升级回滚/长稳证据而 No-Go。

## 一、目标定义

“95+”按门禁逐项判定，不使用加权平均掩盖缺口。论文生产线只有在以下五个层面全部达到 95% 以上且证据可追溯时，才能标记为 Ready：

1. Claim 覆盖：核心研究问题、方法、结果、限制和结论 100% 绑定可验证证据。
2. 数据一致性：Raw、派生数据、统计、表格、图和正文数字来自同一版本化 Artifact。
3. 引用质量：引用逐条存在、版本/页码可核验，引用结论与原文范围一致。
4. 可复验性：Manifest、脚本、环境、候选提交和 receipt 可在干净目录复跑；第二环境/非作者复现缺失时仍保持 No-Go。
5. 审阅与边界：限制、威胁有效性、审阅记录完整；Mock、Fake、Draft、local pilot 不得升级为正式实验或 Verified。

## 二、并行小需求

### P1：论文结构与 Claim 表

- 文件范围：`research/paper/`、对应 schema 和测试。
- 交付：正文章节、RQ/Claim/证据 ID 三向绑定；每个未验证 Claim 显式 `NotVerified/TODO`。
- 验收：缺 Claim、孤立证据、状态越界、绝对路径和 secret 均能被测试拒绝。

### P2：引用核验

- 文件范围：引用清单、引用审阅脚本和专项测试。
- 交付：每条引用有稳定 ID、来源、版本、定位信息、核验状态和审阅者字段。
- 验收：缺失来源、定位漂移、无法访问、把二手摘要当原文等场景 fail-closed。

### P3：数据、统计与表图

- 文件范围：Artifact creator/verifier、统计和表图生成器。
- 交付：Raw→derived→statistics→tables/figures→manuscript 的哈希链和生成 receipt。
- 验收：摘要漂移、extra/missing 文件、候选 SHA 漂移、版本回退和分母变化均拒绝。

### P4：可复验性与外部证据

- 文件范围：复现 runbook、evidence manifest 和测试。
- 交付：本机复验记录、第二环境/非作者复验入口、真实 Provider 和外部 baseline 的待办协议。
- 验收：在真实证据尚未提供前，状态必须保持 `formalVerified=0`、`formalRaw=NotIncluded`、`externalBaseline=0`、`independentReproduction=0`。

### P5：论文级审阅与统一收口

- 文件范围：审阅清单、最终裁决、统一 evidence 快照和总账。
- 交付：一致候选、同一采样时间、同一数字的最终包；清理旧快照残留但保留历史记录。
- 验收：paper consistency、paper evidence、evidence verify、release readiness 全部重新通过；任何 high 风险或外部缺口继续 No-Go。

### P6：论文生产 95+ 的可执行拆片队列（按顺序逐个验收）

每个切片都要独立记录“目标、文件范围、至少 10 个反向用例、专项命令、失败回滚点、候选和采样时间”。切片未通过前不得开始下一个；代理只能提交结果和证据，统一材料由主控串行收口。

1. **P6-A Claim 闭合**：逐条检查 RQ→Claim→Evidence→Artifact 字段，补缺失/孤立/重复/状态越界反向用例；`Verified` 必须有一手来源、版本、定位、审阅者和 receipt。
2. **P6-B 引用可核验**：覆盖表头/列数/ID/locator/来源类型/版本漂移/二手冒充/一手来源缺失；任何异常均拒绝升级状态。
3. **P6-C 数据到表图哈希链**：测试 Raw→derived→statistics→tables/figures→manuscript 的摘要链，拒绝 extra、missing、candidate drift、版本回退、人工数字参数和摘要重算。
4. **P6-D 复现与 provenance**：测试 Manifest、receipt、环境摘要、第二环境入口和非作者复核记录；本机复跑只能标记 local pilot，不得写成独立复现。
5. **P6-E 论文审阅与威胁有效性**：补限制、负结果、审阅日志和 reviewer independence 约束；缺非作者审阅时保持 `NotReviewed`。
6. **P6-F 统一候选收口**：仅在工程 coverage 连续两次 ≥95%、所有专项门禁通过且候选/采样时间一致后，才一次性更新 evidence snapshot、Coverage、Claim、正文、表图和最终裁决。

P6-A～P6-E 当前本机专项已通过，但 P6-F 尚未满足，因为全仓主测试行覆盖仍为 93.26%，且正式 Provider、Raw、外部 baseline、独立复现和非作者审阅均缺失。

## 三、执行顺序与返工规则

```text
并行小需求专项测试
→ 主控检查 diff/边界
→ npm run check
→ test discovery
→ npm test（独占连续两次）
→ coverage（独占连续两次）
→ statistics / paper / paper-evidence / reproducibility / process-chaos
→ electron / security / SBOM / doctor / evidence / release
→ 锁定候选 SHA 与采样时间
→ 一次性更新 current-evidence、Coverage、总账、正文、Claim、表图和裁决
→ 再跑 consistency 与全套门禁
```

任一切片出现失败、越界、覆盖分母变化、证据漂移或状态冒充，立即退回该切片返工；不得删测试、排除源码、降低阈值或手工改数字。连续两次独占 coverage 未达到 95% 时，论文线仍不得宣称工程 95+。

## 三点一、工程覆盖与论文生产的耦合验收

论文 95+ 不允许用文档分数掩盖工程缺口。工程覆盖补强采用真实行为路径：优先 App Server `write_file` 授权、Runtime Store/lease/lifecycle、MCP/命令工具、Electron IPC 的取消/超时/迟到响应/恢复路径。每个行为切片至少 10 个正反向断言，顺序固定为：专项测试连续两次 → `npm run check` → `npm run test:discovery` → `npm test` → 独占 coverage 两次。覆盖分母、阈值、测试入口均不得修改。

## 四、不可由本机替代的条件

真实 Provider 调用、正式 Raw 数据、公开外部 baseline、第二机器或非作者独立复现、非作者论文审阅、真人彩排、签名安装包和干净 Windows 安装，必须由相应外部主体产生原始记录。本机只能生成协议、校验器、待办和 local pilot 证据，不能用文档或 Mock 替代。

## 五、主控最终回报字段

每轮完成后记录：实际修改文件、敏感范围未修改声明、每条门禁结果、候选和采样时间、覆盖分子/分母/百分比、五项评分、低于 95 的差距、外部阻塞项、Electron 运行状态以及唯一下一最小切片。只有全部证据满足条件才允许进入 PR；PR 不等于合并或生产放行。

## 六、协作与提交边界

可以并行分派小切片，但共享工作区的主控必须先验收 diff、测试和证据边界，再决定是否允许进入评审流程。当前工作区保留既有修改，禁止 fetch/pull/checkout/reset/rebase/commit/push；不创建或提交 PR，不读取或输出密钥，不修改依赖、lockfile、覆盖分母和阈值。若未来明确解除该边界，仍须先通过本计划全部门禁，且不得把 PR/合并本身写成科研证据。

## 七、最新验收检查点（非最终收口）

2026-08-25 20:32 +08:00，当前未提交工作区候选：V3 下游 revalidation 五类 fail-closed 快照边界已补齐，专项 13/13，`npm run check` 通过，`npm test` 为 927 total / 925 pass / 2 conditional skip / 0 fail。两次独占覆盖为 26,923/28,798 = 93.4891% 与 26,898/28,798 = 93.4023%，loaded source 117/123 = 95.122%；95% 行门槛为 27,359 行，低样本仍差 461 行。

该检查点只记录返工事实，不是论文或生产 Ready 声明。正式 Provider、正式 Raw、外部 baseline、独立复现、非作者审阅、签名安装包、干净 Windows、升级回滚和长稳证据仍缺失，所有对应状态继续保持 No-Go/NotVerified；`current-evidence.json` 在覆盖连续两次达到 95% 且候选统一前不更新。

2026-08-25 21:05 +08:00 追加：Manifest 专项 10/10；主 `npm test` 仍为 928 total / 926 pass / 2 conditional skip / 0 fail；两次独占覆盖 26,925/28,798 = 93.4961% 与 26,926/28,798 = 93.4995%。Manifest 专项未进入主测试集合，因此不计入主覆盖提升；低样本距 95% 仍差 433 行，计划继续返工。

2026-08-25 接管后追加：V3 rework 专项 14/14、RuntimeMetricsLedger 专项 21/21；当前 `npm test` 931 total / 929 pass / 2 conditional skip / 0 fail；两次独占 coverage 为 26,941/28,798 = 93.5516% 与 26,919/28,798 = 93.4752%，loaded 117/123 = 95.122%，低样本距 95% 门槛 440 行，覆盖采样相差 22 行。discovery 115/115、paper-consistency 29/29、statistics 11/11、paper-evidence 6/6、reproducibility 10/10、Electron 94/94、Process Chaos 17/17、security 589/590、doctor 7/7、release tests 10/10。`evidence:verify` 仍因 README 旧 113/113 漂移阻断，`release:check` 仍因 3 个 high 与 evidence drift BLOCKED；正式 Provider/Raw/external baseline/independent reproduction/publication review 继续 No-Go，不更新 `current-evidence.json`。

2026-08-25 Claim→Evidence→Artifact 切片追加：论文一致性入口新增 Artifact Release 文件集合、字节数、SHA-256、符号链接/额外文件、规范化 `releaseSha256` 校验，并将发布包内 included Claim 与论文 `CLAIM-TABLE.json` 的 `topic/allowedClaim/forbiddenClaim/requiredEvidence` 逐字段绑定；引用表新增一手来源状态、年份上界和 HTTPS/DOI 定位协议门禁。专项 `test:paper-consistency` 为 41 tests / 40 pass / 1 Windows symlink conditional skip / 0 fail，`npm run check` 通过。纸面-only fixture 未物化完整发布包时保持原契约；一旦 Claim/Receipt 物化，缺失、漂移、越界和未声明文件统一 fail-closed。

本切片外部条件与 No-Go 不变且不得由本机替代：`formalVerified=0`、formal Raw=`NotIncluded`、real Provider=0、external baseline=0、independent reproduction=0、publication review=`NotReviewed`。仍缺真实 Provider 授权及原始调用、冻结正式 Raw、公开且公平的 baseline 原件、第二环境或非作者复现、非作者论文/引用审阅；因此不得把 local tooling、Draft、Mock、同作者同机器复跑或引用占位升级为正式证据。`evidence:verify` 的共享总账 README 仍有 `113/113` 漂移，本切片未修改共享总账；`current-evidence.json`、依赖/lockfile、覆盖率阈值与口径均未改动。上述外部条件未满足前，论文生产和发布保持 No-Go。
