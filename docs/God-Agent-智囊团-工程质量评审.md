# God-Agent 智囊团：工程质量独立评审

> 审查日期：2026-08-24  
> 审查对象：`D:\练手\agent-learn-god-latest-audit` 当前工作树  
> 角色：独立工程质量智囊  
> 审查边界：只读代码、复跑本机门禁并新增本报告；未做 Git 操作，未改业务代码，未调用真实 Provider，未把历史文档或 Fake 结果冒充本轮实测。  
> 最终裁决：**92/100，未达到 95，No-Go for 95+**。

> 后续总控状态更新：本评审发现的 README 旧基线已在同轮修复；`release:check` 也已增加 discovery 数字一致性阻断并通过 `test:release` 5/5。下文相关段落保留为审查发现快照，不再代表当前未修复缺陷；其余 95+ 阻断不变。

## 1. 结论先行

God-Agent 的工程主体已经形成闭环：CLI/Electron 入口、Agent Loop、动态与固定多 Agent 编排、Model/Tool WAL、Return Outbox/Receipt、单机 Lease/Fencing、Snapshot CAS、崩溃恢复、`outcome_unknown` 人工裁决、权限/Sandbox、Skill/MCP 和可观测事件都进入了实际组装与测试，不是停留在设计文档中的概念。

本轮重新验证显示，当前代码在本机 Windows + Node 20 环境下健康度很高：正式测试文件发现 106/106，主测试 658 项中 657 通过、0 失败、1 条件跳过；源码覆盖本轮为 90.8354%，加载率 93.2773%；Process Chaos 专项 12/12；Electron 构建通过；本地 release readiness 为 11/11；Security Scan 未发现高置信凭据。

但“本机测试全绿”还不足以判为 95+。当前至少有五类硬缺口：源码覆盖未到 95、GATE-40 仍有 15 个 blocked 且 formal 为 0、Windows 文件符号链接安全分支仍是条件跳过、当前候选没有可核验的远端 CI/干净机同 SHA 产物、完整开发/构建依赖审计仍有 3 个 high。另有一个本轮新发现的门禁可信度问题：根 README 的测试数字已经过期，但 `release:check` 仍把 README 判为“current”，说明该门禁只验证关键词存在，不能验证事实一致性。

因此客观定位应是：**工程研究原型已接近 95，但工程证据闭环尚未达到 95；生产发行更不能据此判定为 READY。**

## 2. 独立评分

| 环节 | 权重 | 得分 | 证据与扣分理由 |
|---|---:|---:|---|
| Runtime 主链与工程闭环 | 25% | 95/100 | Agent、Tool、Skill、MCP、多 Agent、WAL、Lease、Return、恢复、Electron 已实际组装；持久化仍是单机 JSON 文件，未证明断电级 durability 或多机一致性 |
| 自动化测试与测试发现 | 20% | 96/100 | 106/106 正式测试文件被脚本显式覆盖；主测试 657 pass、0 fail；唯一 Windows 文件 symlink 用例条件跳过 |
| 覆盖率与防回退 | 20% | 91/100 | 本轮 24,442/26,908 = 90.8354%，历史连续两次保守基线最低 90.7723%；loaded 111/119 = 93.2773%；缺全局加权 branch/function 门禁 |
| 故障恢复与可靠性实证 | 15% | 89/100 | Process Chaos 测试 12/12，5 个窗口 × 5 seeds 的 local pilot 通过；另 3 个窗口 × 5 seeds 未接线，formal Verified 仍 0/40 |
| Windows 兼容 | 10% | 92/100 | 本轮在含中文路径的 Windows 工作树完成检查、测试、覆盖、Process Chaos 和 Electron 构建；Windows rename sharing retry 正反例通过；文件 symlink 权限分支未通过，长路径/标准用户安装未形成证据 |
| CI 与可复现交付 | 5% | 88/100 | `.github/workflows/ci.yml` 已声明 Windows 全门禁；本轮只验证了配置存在，未获得当前候选 SHA 的远端运行和产物摘要 |
| 发行与供应链卫生 | 5% | 84/100 | 本地 11/11 和 Security Scan 通过，运行时依赖 audit 为 0；完整依赖树仍有 3 个 high，且无签名安装、升级、回滚和长期稳定性证据 |
| **加权总分** | **100%** | **92.3/100，取整 92** | **距离 95 仍差约 2.7 分；当前不得写成 95+** |

### 2.1 已达到或接近 95 的环节

- Runtime 机制实现完整度：95。最强资产是对“不确定结果”不盲目重放，而是通过 WAL、稳定 ID、Fencing 与 `outcome_unknown` 显式暴露风险。
- 自动化正确性：96。测试数量不是核心价值，关键是当前测试已经覆盖取消竞态、损坏快照、并发保存、迟到结果、重复 Return、MCP 超时与 IPC/Sandbox 的 fail-closed 边界。

### 2.2 未达到 95 的环节

- 覆盖与防回退：91。
- 故障恢复的正式实证：89。
- Windows 条件兼容：92。
- 当前候选的远端可复现性：88。
- 发行与供应链卫生：84。

“各环节均 95+”在这些短板关闭前不成立。不能用 657 个通过用例去平均掉 15 个未接线故障窗口、0 次真实 Provider 调用或 3 个 high。

## 3. 本轮可复核证据

### 3.1 本轮亲自复跑

| 检查入口 | 本轮结果 | 证据边界 |
|---|---:|---|
| `npm run check` | 退出码 0 | 当前 TypeScript 静态检查通过 |
| `npm run test:discovery` | 106/106 | 106 个正式测试文件均被 package scripts 显式引用，无静默遗漏 |
| `npm test` | pretest 19/19；主测试 658 total、657 pass、1 skip、0 fail | 本机自动化主门禁通过；skip 不能当作 pass |
| `npm run test:coverage` | 24,442/26,908 = 90.8354%；loaded 111/119 = 93.2773%；gate passed | 单次本轮样本；正式保守口径仍采用连续样本最低 90.7723% |
| `npm run test:process-chaos` | 12/12，0 fail | 专项测试和已接线窄范围真子进程窗口通过；不等于 GATE-40 完成 |
| Windows 定向 5 文件测试 | 42 total、41 pass、1 skip、0 fail | JSON 持久化、Windows rename retry、Workspace junction、IPC/Browser 边界通过；文件 symlink 权限分支 skip |
| `npm run provider:smoke` | offline completed，5 fixture requests，`liveCalls=0` | 只证明离线 fixture 与预算/脱敏门禁，不证明真实 Provider |
| `npm run doctor` | 7/7 | Windows、Node 20、关键文件、依赖、构建产物与临时目录可用；只检测 Provider 配置名称，不读取配置值，也不执行真实调用 |
| `npm run electron:build` | 通过；Vite 1795 modules | 源码工作树内构建成立；未证明安装器或真窗口人工操作 |
| `npm run security:scan` | passed，512/513 candidate files scanned | 没有高置信凭据命中；不是第三方 SAST/恶意依赖审计 |
| `npm run release:check` | local READY，11 pass、0 warning、0 blocking | 只代表仓库自定义的本地门禁；不得替代 `docs/RELEASE-CHECKLIST.md` 的生产发布硬门 |
| `npm audit --omit=dev --registry=https://registry.npmjs.org --json` | 0 vulnerability | 仅运行时依赖口径 |
| `npm audit --registry=https://registry.npmjs.org --json` | 3 high，退出码 1 | 完整开发/构建依赖树仍未关闭高危项 |

### 3.2 代码抽查结论

1. `src/runtime/json-file-runtime-persistence.ts` 使用同目录临时文件、原子 rename、generation CAS 和跨进程锁，且对 Windows 目标文件 delete-sharing 的短暂 `EPERM` 做有界重试。该实现能降低半份 JSON 和旧状态覆盖风险。
2. `src/runtime/process-safe-file-lock.ts` 以不可变 claim 文件、Bakery 风格排队和进程存活端点降低跨进程锁被误偷风险。它是单机协调方案，不是分布式一致性协议。
3. `src/runtime/execution-lease-coordinator.ts` 明确写出 fencing 只保护本地提交，不保证远端 Model/Tool exactly-once。这一边界表述正确。
4. `src/runtime/model-invocation-startup-recovery.ts` 对 `submitted` 或执行结果未知的调用转入 `outcome_unknown`/显式恢复，而不是启动时直接重调 Provider，符合可靠性研究目标。
5. `src/runtime/outcome-unknown-resolution-service.ts` 不允许外部 API 伪造 Invocation identity/digest，并在工具风险信息不足时采用保守风险等级。
6. `src/llm/provider-capability-smoke.ts` 明确记录生产适配器的 idempotency key、状态查询、Provider 端取消均为 `not-wired`，且 `exactlyOnceClaim=not-claimed`。离线 Smoke 自己带探针头部，不能反向证明生产适配器已接线。
7. `src/runtime/json-file-runtime-persistence.ts` 的持久化路径是 `writeFile + rename`，未见文件与父目录 `fsync` 证据。因此可声称“进程崩溃下避免半份 JSON”，不应声称“断电后持久性已证明”。

### 3.3 现有 Artifact 与文档证据

- `.tmp/gate40-pilot-25/process-chaos-gate40-pilot-manifest.json`：`plannedCaseCount=40`、`runnableCaseCount=25`、`localPassedCaseCount=25`、`blockedCaseCount=15`、`formallyVerifiedCaseCount=0`、`completeGate40=false`；预注册仍为 draft，8-window list 未冻结。
- `docs/COVERAGE.md`：连续两次保守覆盖为 90.7797% 与 90.7723%，门禁为 90.25%/93.0%，文档已明确禁止把它表述成 95%。
- `docs/runtime-capacity-baseline-2026-08-19.md`：只有 30 秒 short-soak；100 ms Fake Provider 下并发 8 已进入退化，2 ms 高压下所有并发档都有吞吐衰减；文档自身要求继续补 30 分钟和 2 小时测试。
- `docs/RELEASE-CHECKLIST.md`：安装器、签名、升级、回滚、长稳、真实 Provider 与发布批准均未勾选，顶层结论保持生产 `BLOCKED`。
- `.github/workflows/ci.yml`：存在 Windows `windows-latest` + Node 20 全门禁声明，但没有本轮可核验的远端 run 结果，也没有上传门禁摘要/覆盖/GATE-40/SBOM 的 artifact 步骤。

## 4. 95 分差距的量化说明

### 4.1 覆盖率差距

- 当前保守基线：24,425/26,908 = 90.7723%。
- 达到 95.00% 至少需要 25,563 条覆盖行。
- 在分母不变化的理想条件下，仍差 **1,138 条真实覆盖行**。
- 本轮单次结果 24,442 条，对 95% 仍差 1,121 条；单次较高采样不能替代连续稳定门禁。
- loaded 111/119 = 93.2773%；按现口径达到 95% 至少需加载 114 个文件，即还差 3 个。8 个未加载项多数是纯类型/声明模块，不能靠无意义导入“刷绿”；应先版本化区分 runtime-bearing 与 type-only 口径，再对运行时模块设 100% discovery/load 要求。

### 4.2 故障窗口差距

- 候选矩阵：40/40 已列出。
- 已接线本地 pilot：25/40 passed。
- 未接线：15/40 blocked，分别来自 `FW-TOOL-EFFECT-RECEIPT`、`FW-RECEIPT-COMMIT`、`FW-PROOF-COMMIT` 三个窗口各 5 seeds。
- 正式证据：0/40 Verified；预注册状态 draft，`completeGate40=false`。

### 4.3 Windows 差距

- 已通过：中文工作树路径、Node 20、原子 rename 的 Windows sharing retry、目录 junction 越界拒绝、IPC/Browser/Sandbox 定向测试与 Electron build。
- 未通过：需要文件符号链接权限的 SkillLoader 越界用例。
- 未形成证据：全新标准用户、安装器首次启动/卸载、长路径、非开发者机器、升级/回滚。

### 4.4 供应链与交付差距

- 运行时依赖审计 0，不代表整个 Electron 构建链 0。
- 完整审计仍有 3 个 high：直接依赖 Electron 41.6.1、其 `extract-zip` 链、传递依赖 `nanoid`。审计建议 Electron 升至 41.10.6；任何升级都必须重新跑全门禁。
- CI 文件“存在”不等于当前候选“远端已通过”。当前没有可追溯 run URL、同 SHA 摘要或上传的证据包。

### 4.5 文档与门禁可信度差距

根 `README.md` 的“当前验证基线”仍写：86/86、515/515、Electron 74/74、Process Chaos 4/4，与本轮 106/106、657+1、12/12 不一致。`scripts/release-readiness.ts` 的 README 检查只搜索 `Electron`、`Multi-Agent/多 Agent`、`当前不应声称` 三类关键词，仍输出“README describes the current product and claim boundary”。

这不是核心 Runtime 故障，但会直接损害复试答辩与发布证据可信度。95+ 工程必须做到“门禁验证事实”，而不只是“门禁验证文档存在”。

## 5. 达到工程 95+ 的可落地补足方案

### P0：先关闭可由当前仓库完成的 95 分缺口（建议 2～4 天）

#### P0-1 统一数字事实源，修复 release gate 的假阳性

实施：

1. 让 `test:discovery`、主测试、coverage、Process Chaos、Provider Smoke、audit 和 release check 输出统一、版本化 JSON 摘要。
2. README、答辩文档与 PPT 只引用或由该摘要生成，不再手工复制数字。
3. `release:check` 读取摘要并校验 README 的基线数字；摘要缺失、SHA 不一致或数字过期时至少 `warning`，正式候选时直接 `blocking`。
4. 将“local-ready”与“production-ready”拆成不同状态字段，避免同一个 `READY` 造成误读。

验收：

- README 只出现 106/106、658 total、657 pass、1 conditional skip、12/12、coverage 保守基线等当前口径。
- 人工把 README 中任一数字改旧，`npm run release:check` 必须非零退出。
- 报告明确输出 `scope=local`、`productionReady=false`。

#### P0-2 把覆盖率稳定抬到 95，而不是降门槛

实施：

1. 用 coverage JSON 对未覆盖行按模块排序，优先补 WAL、Lease/Fencing、启动恢复、权限、IPC、MCP 异常、Snapshot 损坏和 Windows I/O 分支。
2. 每个新增测试必须断言可观察行为和持久化结果，禁止无断言执行、无意义导入或排除困难文件。
3. 为关键可靠性目录增加可加权 branch/function 报告；Node 20 文本均值只保留诊断用途。
4. 连续至少 3 次采样，取最低值设门禁，并预留不少于 0.5 个百分点波动余量。

验收：

- 现有分母口径下 line coverage 连续 3 次最低值 `>=95.00%`。
- runtime-bearing 源文件加载率 `=100%`；type-only 文件采用显式、版本化清单，不得静默改分母。
- WAL、Lease、恢复、权限、IPC 关键目录 branch coverage `>=95%`。

#### P0-3 消除 Windows 条件 skip

实施：

1. 在受控 Windows CI job 启用允许创建文件符号链接的权限或 Developer Mode。
2. 保留现有目录 junction 用例，再运行文件 symlink 越界用例。
3. 增加标准用户负例：无法创建 symlink 时应明确记录环境阻断，而正式兼容证据必须来自具备权限的 job。

验收：

- 主门禁 `fail=0, skipped=0`。
- `SkillLoader 拒绝 SKILL.md 符号链接越出根目录` 实际执行并通过。
- 报告保存 Windows 版本、权限条件和用例输出。

### P1：完成可靠性正式证据（建议 3～7 天）

#### P1-1 接线剩余 15 个 GATE-40 case

实施：

1. 为 W02 Tool effect/receipt、W07 Receipt/commit、W08 Proof/commit 增加生产 App Server fault injector。
2. 每个窗口定义独立 Oracle：副作用次数、receipt 唯一性、proof/evidence 提交唯一性、恢复终态和残留 PID。
3. 先跑 local pilot 40/40；任何失败保留 Raw、Manifest 与最小复现命令。
4. pilot 通过后冻结预注册摘要、8-window 清单、5 seeds、排除规则和失败判据，再跑 formal；不得把 pilot 改名成 formal。

验收：

- `planned=40, runnable=40, passed=40, failed=0, blocked=0`。
- `formallyVerifiedCaseCount=40`、`completeGate40=true`。
- 每个 case 有 Raw/Manifest/Oracle，进程残留为 0，重复业务副作用为 0。

#### P1-2 让 CI 从“声明存在”升级为“当前候选可追溯通过”

实施：

1. 冻结唯一候选版本和源码 SHA。
2. 在 Windows runner 执行锁定安装、check、discovery、主测、coverage、Electron、Benchmark、Runtime-E2E、Process Chaos、doctor、SBOM、security 与 release checks。
3. 上传 JSON 摘要、覆盖报告、GATE-40 manifest、SBOM、构建摘要和环境信息。
4. 分支保护要求该 job 为必选门禁；失败不得通过重新运行后丢弃首次失败证据。

验收：

- 同一候选 SHA 的远端 CI 全绿，并能从产物反查所有门禁数字。
- 干净 Windows runner 可从 `npm ci` 走到 Electron build，无工作树缓存依赖。

#### P1-3 关闭供应链 high

实施：

1. 获得依赖升级授权后，将 Electron 升到官方修复范围，并解析 `extract-zip`、`nanoid` 的安全版本。
2. 只提交必要的 package/lockfile 变化，重新生成 SBOM。
3. 全量复跑本报告列出的门禁，重点回归 Electron Main/Preload/Browser/IPC 与打包链。

验收：

- 官方 registry 完整 `npm audit`：critical=0、high=0。
- SBOM 与 lockfile 组件数量、版本和依赖关系一致。
- 主测、覆盖、Electron build、Process Chaos 无回归。

### P2：把“本机工程原型”补成可交付证据（建议 1～2 周，部分需外部授权）

#### P2-1 长稳与容量

- 按预注册阈值完成 30 分钟与 2 小时运行，不再以 30 秒 short-soak 代替长期稳定性。
- 记录 RSS/句柄/磁盘增长、事件循环延迟、吞吐衰减、重复/丢失 Return、恢复时间和残留进程。
- 对当前 Fake 100 ms 并发 8 退化、2 ms 全档吞吐衰减进行 profile 和数据结构优化后复跑。

验收：预注册并发档位下无重复/丢失 Return、无残留 PID、内存和磁盘斜率不越界、尾/头吞吐比达到门槛。

#### P2-2 干净 Windows 安装、升级与回滚

- 生成可校验安装器或 portable 制品，记录 SHA-256。
- 在全新标准用户上验证安装、首次启动、离线 Demo、状态恢复、卸载。
- 演练 N→N+1 状态迁移、中断升级和回滚，验证无静默数据丢失与无重复副作用。

验收：`docs/RELEASE-CHECKLIST.md` 对应项有同一候选 SHA 的证据，不再是空勾选。

#### P2-3 真实 Provider 最小闭环（需要用户明确费用与数据授权）

- 先决定是否接线 Provider idempotency key、状态查询和服务端取消；不支持的能力继续标 `unsupported/unknown`。
- 在模型 allowlist、请求数、单次/总费用、超时和脱敏门禁下执行最小 live smoke。
- 覆盖成功、429/5xx、超时、取消、请求状态查询和结果未知处置。

验收：`liveCalls>0` 且报告包含模型版本、请求数、预算和失败分类；仍不得声称端到端 exactly-once。未获得授权时，此项必须保持 blocked，不能伪造通过。

#### P2-4 提升断电级持久性证据

- 评估在临时文件写入后执行文件 flush/fsync、rename 后刷新父目录的跨平台实现与代价。
- 增加进程强杀、写入中断、磁盘错误和重复恢复循环；真实断电结论需要可控环境实验，不得由单元测试替代。

验收：冻结持久性承诺边界；如果不实现 fsync，则文档明确只保证进程崩溃/原子替换语义，不声称断电 durability。

## 6. 硬阻塞与授权边界

以下事项未完成前，相应环节不能达到 95，也不能由文案“补成通过”：

1. **真实 Provider：** 当前 `liveCalls=0`；需要用户明确账号、模型、预算、请求上限与数据授权。
2. **GATE-40 formal：** 当前 15 blocked、formal 0、预注册 draft；需要新增故障注入与 Oracle，再冻结后正式运行。
3. **Windows symlink：** 当前机器缺文件符号链接权限；需要具备权限的 Windows 环境实际执行。
4. **远端 CI 与独立环境：** 当前只看到工作流文件，未看到本轮候选 SHA 的远端运行证据。
5. **供应链：** 完整 audit 仍有 3 high；升级会修改依赖和 lockfile，必须经过授权并全量回归。
6. **安装签名/升级回滚：** 需要发行方案、证书或明确的 portable 边界，以及非开发者环境。

## 7. 对外推荐口径

可对复试老师诚实表述：

> “God-Agent 的 Runtime 主链和自动化测试已经比较完整，本轮正式发现 106 个测试文件，主测试 658 项中 657 通过、1 个 Windows 权限条件跳过，源码行覆盖的连续保守基线是 90.7723%。我把当前工程质量评为约 92 分，而不是 95 分：因为完整混沌矩阵还有 15 个窗口用例未接线、正式 GATE-40 为 0/40，真实 Provider 调用为 0，完整构建依赖还有 3 个 high。下一步会先统一证据总账、把覆盖和 Windows 门禁补齐，再冻结预注册并完成 40/40 正式实验。”

禁止表述：

- “所有测试 658/658 全部通过”——实际是 657 pass + 1 conditional skip。
- “源码覆盖率已经 95%”——保守基线是 90.7723%。
- “GATE-40 已完成”——当前 formal 0/40，`completeGate40=false`。
- “真实 Provider 已验证”——当前 `liveCalls=0`。
- “Release READY 代表可以生产发行”——本地 11/11 与生产发布清单不是同一口径。
- “实现 exactly-once”——代码只主张本地 WAL/Fencing/幂等边界，不保证远端 Provider 或外部工具端 exactly-once。

## 8. 最终判定

- 当前工程质量：**92/100**。
- 95+ 状态：**未达到**。
- 最短提升路径：先完成 README/证据一致性门禁、覆盖率 95、Windows symlink 零 skip、GATE-40 40/40 formal、当前 SHA 远端 CI 和完整依赖 high=0。
- 生产发行状态：继续遵循 `docs/RELEASE-CHECKLIST.md` 的 **BLOCKED**；不得被本地 `release:check` 的 11/11 覆盖。
- 置信度：**高（约 0.94）**。高置信部分来自本轮实测和代码抽查；真实 Provider、第三方复现、安装签名、长期运行和断电 durability 因未执行而保持未知/阻塞。
