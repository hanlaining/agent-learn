# God-Agent 95+ 持续精进总账

> 最新证据快照：`113/113`；主测试 `736`，`735pass`、1 skip、0 fail；源码覆盖 `26146/28672 = 91.19%`，加载 `116/122`。

> 建立日期：2026-08-24  
> 当前基线：`main@3c78dca7747c4a87c611007a9148fc36604a1b0a`  
> 原则：分母预先冻结；只以可复核证据加分；Mock/Fake 不替代真实 Provider、真实副作用或外部复现；文档存在不等于实现完成。

## 1. 当前状态

| 环节 | 当前分 | 95 分线 | 当前状态 |
|---|---:|---:|---|
| 工程研究原型 | 93 | 95 | No-Go |
| 考研复试项目 | 90 | 95 | No-Go |
| 科研证据闭环 | 69 | 95 | No-Go |
| 论文就绪度 | 47 | 95 | No-Go |
| 生产发行成熟度 | 68 | 95 | No-Go |

任何一项未到 95，总目标保持 Active。

## 2. 不可通过以下方式加分

- 修改评分文字或降低验收阈值；
- 把确定性 Mock 的 30/30 写成真实业务成功率；
- 把测试文件数、文档页数或代码行数直接换成完成度；
- 把本机单窗口 Process Smoke 写成完整 GATE-40；
- 把 App Server ready 写成真实 Provider 已验证；
- 把同一作者、同一机器复跑写成第三方独立复现；
- 把计划、Designed、Draft 或 NotVerified 项标成 Verified；
- 用“未观察到重复”推导 exactly-once。

## 3. 五类 95 分硬门槛

### 3.1 工程研究原型 95+

必须同时满足：

- 主测试、所有测试文件发现门禁、关键专项门禁连续通过；
- CI 在干净环境自动执行 check、test、Electron build、Benchmark、Runtime-E2E 和 Process Smoke；
- 关键状态机、恢复、权限和 IPC 边界没有未收录测试；
- 有覆盖率报告和核心模块阈值，关键路径分支覆盖达到预注册阈值；
- 当前 Commit 对应的冻结 Artifact 完整且可校验；
- 无 P0/P1 已知确定性回归；
- 至少一次干净 Windows 环境从安装到启动的全链验证。

### 3.2 考研复试项目 95+

必须同时满足：

- README 与当前能力、启动命令、测试数字、证据边界一致；
- 一条离线必达 Demo 和一条真实 Provider 可选 Demo 均有预检；
- 三分钟讲稿、架构图、故障时序图、结果表、限制页齐全；
- 在无网络、无 Key、依赖异常三种情况下有稳定降级方案；
- 至少 3 次完整计时彩排和 1 次非作者试讲，问题记录闭环；
- Electron 真窗口的核心路径完成截图/视频和人工验收；
- 高频追问、原创/AI 辅助边界、参考资料和许可证清单可现场出示。

### 3.3 科研证据闭环 95+

必须同时满足：

- RQ/H0/H1、主要终点、估计量、样本量、seed、故障计划、排除/重跑和停止规则正式预注册并冻结摘要；
- 指标 Schema/Validator 能区分 protocol handling、business completion、false completion、unknown 和 evidence coverage；
- 完成预注册 GATE-40 全窗口，以及样本量依据要求的正式重复；
- 完成 Dynamic、固定 Workflow、模型窗口、工具副作用、Return、Lease 和持久化损坏实验；
- 真实 Provider 和至少一类可查询/一类不可回放外部副作用在受预算条件下运行；
- 有 Raw QA、配对检查、置信区间、效应量、零失败上界和多重比较处理；
- 最新 Commit、配置、预注册、Raw、分析、报告和 Manifest 一致绑定；
- 第二机器或第二执行者完成独立复现。

### 3.4 论文就绪度 95+

必须同时满足：

- 研究问题、相关工作和相对 Temporal/LangGraph/同类系统的差异清楚；
- 至少一个内部基线和一个可比外部基线，任务、预算、Oracle 与故障计划公平；
- 正式实验完成且统计方法与预注册一致；
- 正面、负面、无显著差异和异常结果全部保留；
- 威胁有效性覆盖构念、内部、外部、统计和复现；
- 论文图表由 Raw 一键生成，数字不可人工修改；
- Artifact 可公开、可校验并通过独立复现；
- 完成至少一轮非作者方法审查和一轮论文级同行审读，P0/P1 意见关闭。

### 3.5 生产发行成熟度 95+

必须同时满足：

- 有可安装/可卸载的签名发行物、版本升级和回滚策略；
- 支持环境 doctor、配置迁移、Crash Report、结构化日志、指标和追踪；
- 真实 Provider 的重试、取消、状态查询、限流、预算与故障语义有明确能力矩阵和验证；
- 持久层完成容量、损坏恢复、备份恢复和断电语义验证；
- 权限、Sandbox、MCP、文件边界、秘密管理和依赖供应链通过安全审计；
- 完成稳态、短浸泡、长浸泡、资源泄漏和恢复积压测试；
- 发布门禁、CI、制品校验、SBOM、许可证和 Release Notes 完整；
- 有明确支持范围、已知限制、故障手册和可重复的干净机器验收。

## 4. 执行波次

| 波次 | 目标 | 主要交付 | 预期影响 |
|---|---|---|---|
| S1 入口与门禁 | 消除事实漂移和静默漏测 | README、Demo preflight、test discovery、CI、科研预注册 Validator | 工程/复试/科研基础 |
| S2 工程质量 | 建立覆盖率、安全与发行门禁 | coverage、IPC/Outcome/MCP 门禁、doctor、installer 草案、SBOM | 工程/生产 |
| S3 完整 E3 | 扩展真进程故障矩阵 | GATE-40、Dynamic/Workflow 窗口、Raw/Manifest | 科研/论文 |
| S4 正式实验 | 冻结并运行统计有效实验 | 样本量、重复、真实 Provider/副作用、统计报告 | 科研/论文 |
| S5 外部有效性 | 完成公平基线与独立复现 | 外部框架基线、第二环境复现、Artifact release | 科研/论文 |
| S6 发行验收 | 达到可交付产品标准 | installer、签名、升级/回滚、长稳、故障手册 | 生产/复试 |

## 5. 当前切片 S1 验收

- [x] README 与当前事实一致；
- [x] 安全离线 Demo preflight 有正反例测试；
- [x] 86 个正式测试文件都能被机器发现并进入至少一个入口；
- [x] CI 工作流已定义，强制离线 Provider 并覆盖核心门禁；
- [ ] CI 首次远端运行通过（尚未 commit/push，不能伪造远端结果）；
- [x] 预注册 Schema/Validator 拒绝缺项、摘要漂移和未授权 live Provider；
- [x] 全量主测试、专项测试、Electron build 本机串行全绿；
- [x] 无跨 Agent 文件冲突和非预期源码修改；
- [x] 本总账更新真实结果，未完成项保持未勾选。

## 5.1 S1 本机证据

- TypeScript check：通过；
- test discovery：86/86 个正式测试文件零漏项、零陈旧引用；
- Runtime Store pretest：19/19；
- 主测试：515/515；
- W0 contracts：46/46；
- RT95 ledger validator：通过，但仍为 Engineering 0/100 Verified、Research 0/66 Verified；
- Electron 专项：74/74；
- Benchmark：10/10；
- Reproducibility Manifest：9/9；
- Runtime-E2E：10/10；
- Process Chaos：4/4；
- Electron build：通过；
- Demo preflight：READY；
- Provider capability：offline，`liveCalls=0`。

S1 提升的是入口、门禁和预注册输入质量，不是正式实验结果。因此科研、论文和生产分数只做有限上调，所有目标仍为 No-Go。

## 5.2 覆盖率探针负结果

使用 Node.js 20 内置 V8 coverage 对 515 项主测试入口做首次探针，得到包含测试文件在内的总体结果：

- line：92.29%；
- branch：85.20%；
- function：91.06%。

该口径仍把测试文件本身计入总体，不能作为最终 `src/` 覆盖率门禁；它只能证明当前距离“核心源代码分支覆盖 95%”仍有明显差距。

第一次全量覆盖插桩还使一个并发 Handler 测试超过测试夹具的 1 秒 Lease TTL，从而在最终 fenced commit 失败。普通模式 515/515 不受影响。该用例目标是同进程 busy 序列而非 Lease 过期，因此已把测试专用 TTL 调为 10 秒；目标文件在普通模式 26/26、覆盖模式 26/26 复验通过。后续仍需重新执行全量覆盖，并建立只统计 `src/`、可机器拒绝低于阈值的正式门禁。

## 5.3 S2/S3 当前增量证据

截至 2026-08-24 当前工作树，新增证据如下：

> 统一证据键：`evidence-scores=93/90/69/47/68`；`loaded=116/122`；`formalVerified=0`。权威机器快照见 `docs/evidence/current-evidence.json`。

- test discovery：113/113 个正式测试文件已显式接入；最新完整主测试共 736 项，735 pass、1 个 Windows symlink 权限条件 skip、0 fail；
- Security Scan：扫描 Git tracked/untracked-but-not-ignored 候选，当前 516/517 候选文件中 516 个文本文件完成扫描，高置信凭据命中 0；路径逃逸 fail-closed，不回显命中内容；
- Release Readiness：11 pass、0 warning、0 blocking；README 已刷新为当前证据，且门禁会在“当前验证基线”的 discovery 数字漂移时阻断；该 READY 仍只代表本仓库定义的本地门禁，不代表签名安装包或生产认证；
- 统计原语：11/11，包含 Wilson 95% CI、零失败上界、率差、率比、确定性成对 Bootstrap、Holm-Bonferroni 与 Raw 配对 QA；报告固定不声称显著性；
- 源码覆盖正式口径：`src/**/*.ts` 122 个文件、28,672 行，已加载 116 个；当前稳定结果为 26,146/28,672 = 91.19%，加载率 95.082%；加载子门已过 95，但全仓行覆盖仍不能写成 95%；
- 研究协议四个本地 P0 已关闭：8×5 权威窗口、RQ1/RQ2 与 H0/H1 对齐、Wilson 半宽目标修正为可复验 0.15、Raw→McNemar→配对区间→Holm Draft E2E；正式科研/论文仍为 69/47；
- 彩排统一证据入口已加固为候选绑定、独立 nonce、双 Artifact、摘要复验和参与者/观察者分离；当前真实记录仍为空，0/3 与 0/1 不变；
- Release 新增官方依赖风险硬门，真实结果 11/12、BLOCKED，唯一结构阻断为 0 critical / 3 high；
- 本轮新增 CLI、Workspace Tool、Runtime UI、Execution Lease、MCP stdio 与 hotpaths4 的 Store/配置/事件/协议/Shared Board 正反边界测试；覆盖复跑暴露并修复了活动 Turn 直接 `/exit` 竞态，以及 Model Invocation 损坏快照未重新校验稳定 ID 的完整性缺口。覆盖分母同期累计增加 127 行，未从分母排除；
- Process Chaos：候选矩阵 40/40 不重不漏；八个真进程窗口按 5 seeds 运行 local pilot，40 passed、0 failed、0 blocked，Raw 完整且残留 PID 为 0；正式 Verified 仍 0/40，`completeGate40=false`；专项测试 17/17；
- Runtime Doctor：当前 Windows/Node 20/构建环境 7/7 ready；CycloneDX 1.5 SBOM 从真实 lockfile 确定生成 169 个组件（12 直接、157 传递）；
- 论文流水线：6/6，可从统计 JSON 确定生成 Markdown 与两份 CSV；IMRaD 草案与 Claim Table 已建立，正式结果仍为 TODO/NotVerified；
- 最小答辩展示包：7 页均已渲染人工查看，未见明显 overflow/overlap；7/7 notes 含 `[Sources]`，数字与阶段分已按本节刷新；
- Electron、W0、Benchmark、Reproducibility、Runtime-E2E、Process Chaos、build、Demo、Provider offline 门禁复跑通过；Provider 仍为 `liveCalls=0`。

### 当前供应链负结果

- 默认 `npmmirror.com` 不实现 npm audit API，不能把镜像报错解释为“无漏洞”；
- 单次指定官方 registry 后，运行时依赖审计（`--omit=dev`）为 0 漏洞；
- 包含开发/构建链的完整审计发现 3 个 high：Electron 41.6.1、其 `extract-zip` 链，以及 `nanoid`；官方修复建议涉及 Electron 41.10.6 与 lockfile 变更；
- 在依赖升级得到授权、完成回归和重新审计之前，生产发行成熟度保持 No-Go。

本轮分数上调来自可执行门禁、统计实现、真进程 pilot 与可展示材料，不来自把 Draft、候选矩阵或本机 Fake 结果改名为正式实验。科研/论文仍受未冻结预注册、formal Verified=0、真实 Provider、外部基线与独立复现硬阻断。

## 6. 外部依赖与授权边界

以下事项不能由本机代码自动伪造完成：

- 真实 Provider 付费实验：需要用户明确预算、模型、调用上限和授权；
- 第三方独立复现：需要第二执行者或明确的第二环境；
- 代码签名：需要发行证书与安全保管流程；
- 外部基线实验：可能需要联网安装依赖并确认许可证、预算和比较范围；
- 非作者试讲/同行审读：需要实际参与者反馈。

这些条件未满足时继续完成其他可执行项，但相应评分不得越过证据上限。
> 2026-08-24 统一证据快照：113/113，736（735pass，1 skip，0fail），26146/28672（91.19%），116/122，17/17，40passed，0blocked，formalverified0，livecalls=0，11/12，3high；评分 93/90/69/47/68。
