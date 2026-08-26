# G95 持续目标：科研论文生产与工程可靠性

更新时间：2026-08-25  
目标状态：Active / No-Go until evidence-complete

## 目标

持续推进以下五条线，并分别达到可审计的 95+：

1. 工程研究原型：真实行为覆盖、Runtime 恢复、CLI/MCP/Electron 稳定性。
2. 复试项目：真人计时彩排、非作者试讲、可重复 Demo 和边界表达。
3. 科研证据闭环：formal Verified、正式 Raw、真实 Provider、外部基线、独立复现。
4. 论文生产：Claim、数据、统计、表格、引用、限制和非作者审阅闭环。
5. 生产发行：安全审计、SBOM、签名安装包、干净机安装、升级回滚和长稳。

95+ 是五条线分别达标，不使用加权平均掩盖单项缺口。任何关键证据缺失，最终裁决保持 No-Go。

## 当前基线（2026-08-25 17:49:41 +08:00）

- 工程覆盖：两次独占样本 26,867/28,804 = 93.2752%、26,872/28,804 = 93.2926%；加载源码 117/123 = 95.122%。全仓行覆盖距 95% 仍差约 492–497 行。
- 测试：最新全量 869 total；867 pass；2 conditional skip；0 fail。不得写成 869/869 全通过。
- 测试发现：115/115。
- Electron：91/91 专项通过；窗口当前未确认运行。
- 科研：69；formal Verified=0、正式 Raw=0、真实 Provider=0、外部基线=0、独立复现=0。
- 论文：47；正式结果仍 NotVerified/TODO，引用核验和非作者审阅未闭环。
- 生产：68；官方依赖审计仍有 3 high，签名安装/干净机/升级回滚/长稳证据缺失。

以上数字只作为本轮起点，不得与旧快照混用。统一候选材料必须重新串行生成。

## 并行工作流

### E1 工程覆盖与 Runtime 容错

范围：`src/app-server/main.ts`、`src/app-server/handlers.ts`、`src/agent/agent-loop.ts`、Runtime Store/Lease/Lifecycle、MCP、命令工具和 Electron IPC。

要求：只补真实行为测试和必要实现；不删测试、不排除源码、不改覆盖分母/阈值、不使用空 import。重点处理 `outcome_unknown`、取消、超时、迟到响应、恢复重放和显示竞态。

完成门禁：分母仍为 123 文件/28,804 行；连续两次独占 coverage ≥95%；`npm test` 0 fail；115/115 discovery。

### R1 科研证据链

范围：正式协议、Run Manifest、真实 Provider 适配边界、Raw/派生数据、统计、Artifact creator/verifier、外部基线和独立复现记录。

硬门禁：Mock/Fake/local pilot 只能标本地工具；真实 Provider 必须有授权和脱敏调用记录；正式 Raw 不得为 0；外部基线有公开来源和版本；独立复现由非作者或第二环境完成；verifier 能拒绝缺失、extra、漂移、路径和 secret。

### R2 论文生产与引用核验

范围：论文正文、方法、结果、局限、威胁有效性、Claim Table、引用审计、图表、附录和非作者审阅记录。

硬门禁：核心 Claim 100% 绑定证据；正文、表格和 Artifact 数字一致；引用逐条核验；NotVerified/TODO 不得被文档手工改成 Verified；local pilot、Mock、formal、external、independent replication 必须分层标记。

### O1 生产发行与复试验收

范围：官方 audit high 处置、签名安装包、干净 Windows、升级回滚、长稳、Electron 运行态、真人彩排和非作者试讲。

硬门禁：`release:check` 未 READY 时保持 BLOCKED；Electron ready 不等于 Provider ready；真人彩排和非作者试讲必须有原始记录。

## 子任务交付协议

每个子任务只修改自己的文件范围，提交前必须报告：

- 修改文件和未修改敏感范围；
- 专项测试、`npm run check`、`npm test`、相关 coverage/evidence 结果；
- 候选版本、采样时间、SHA 和已知失败/跳过；
- 是否涉及真实 Provider、外部基线或独立复现；
- 外部阻塞项和返工建议。

子任务不得自行更新统一总账、最终裁决或把局部通过写成整体 95+。

## 主控验收与 PR 准入

主控先检查 diff 和证据边界，再独占重跑专项门禁。只有以下条件全部满足，才允许子任务进入 PR：

1. 文件范围无越界；
2. 测试是真实行为断言；
3. `npm run check` 和专项测试通过；
4. 全量测试 0 fail；
5. coverage/evidence 数字可复验且候选一致；
6. 无 secret、绝对本机路径或 Fake/Mock 冒充正式证据；
7. 外部缺口仍被明确标记。

当前工具环境没有可调用的 PR 创建/提交接口，因此不能声称 PR 已提交或已合并。若后续提供可审查的 PR 状态，主控仍会先验收再批准进入 PR，绝不自动合并。

## 固定回归顺序

```text
专项测试
→ npm run check
→ npm run test:discovery
→ npm test
→ npm run test:coverage
→ npm run test:statistics
→ npm run test:paper-evidence
→ npm run test:reproducibility
→ npm run test:process-chaos
→ npm run test:electron
→ npm run security:scan
→ npm run sbom:generate
→ npm run doctor
→ npm run test:evidence
→ npm run evidence:verify
→ npm run test:release
→ npm run release:check
```

最终材料只能在全部子任务完成后，以同一候选、同一采样时间、同一 Manifest 串行收口。若任一项未达标，继续返工，不降低门槛。

## 2026-08-25 继续执行：多任务验收队列

主控已按用户要求建立三个独立任务，先并行产出本地变更，再由主控串行验收：

| 任务 | 负责切片 | 验收重点 | 当前状态 |
|---|---|---|---|
| `01a0390b-c4cd-79a0-8d60-027cf305b264` | E1 工程覆盖与 Runtime 容错 | 主测试集合中的真实行为路径、双次独占 coverage | 待验收 |
| `01a0390b-cd4e-7063-8d1e-01b675fe3cb9` | R1/R2 Claim-Evidence-Artifact 与引用核验 | fail-closed 漂移/越界校验；formal 状态不越界 | 待验收 |
| `01a0390b-d4d2-7ef3-ad7c-e7425e6f8a77` | O1 生产发行与安全门禁 | release/security/SBOM/doctor 真实边界和 BLOCKED 保持 | 待验收 |

### 主控验收协议（每个任务必须逐项满足）

1. 变更文件只落在任务声明范围；共享总账由主控最后串行写入。
2. 至少包含正向、反向、边界、恢复/幂等和篡改/漂移用例；测试断言真实行为，不得使用空 import 提升覆盖。
3. 专项测试通过后，依次执行 `npm run check`、`npm run test:discovery`、`npm test`，再执行相关专项和独占 coverage。
4. 任一失败、coverage 低于 95%、分母/阈值变化、证据状态越界或工作区冲突，立即 `RETURN_FOR_REWORK`；不得创建 PR。
5. 只有主控复核 diff、原始输出、候选/采样时间和证据边界均一致后，才允许进入 PR 准备；PR 本身不等于合并、正式实验或生产放行。

### 95% 目标分解与硬条件

- 工程线：源码行覆盖至少 `27,359/28,798`，且连续两次独占运行均达到 95.00% 以上；当前低样本缺口约 440 行。
- 科研证据线：`formal Verified=0`、`formal Raw=NotIncluded`、真实 Provider=0、外部 baseline=0、独立复现=0、publication review=NotReviewed` 只在真实原始记录齐全后才可升级。
- 论文线：Claim 100% 可追溯到一手证据；引用逐条核验；Raw→derived→statistics→tables/figures→manuscript 哈希链完整；非作者审阅未完成前保持 No-Go。
- 生产线：官方 3 个 high、签名安装包、干净 Windows、升级回滚、长稳等缺口不能由本机文档替代；`release:check` 为 BLOCKED 时不作 READY 声明。

本段只记录执行计划与任务路由，不更新最终统一 evidence 快照，不改变覆盖分母/阈值，也不把本地任务或 PR 写成外部科研证据。
