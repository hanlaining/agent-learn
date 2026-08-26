# God-Agent 源码覆盖率门禁

本文档描述 `scripts/verify-source-coverage.ts` 的统计口径。门禁以本地 Node 20、`package.json` 中 `scripts.test` 明确列出的主测试文件为输入，不把 `pretest`、独立研究门禁或 Electron 专项测试偷算进主测试结果。

## 统计边界

- 范围严格限定为仓库内 `src/**/*.ts`；`tests/`、`scripts/`、`research/`、依赖和 `src/**/*.tsx` 均不计入。
- Node 20 的 `--experimental-test-coverage` 没有按路径 include/exclude 和内置阈值能力，且文本报告的 `all files` 会混入测试文件。因此门禁解析逐文件行，规范化 Windows 路径后再次做仓库边界检查，绝不使用 `all files` 数字。
- 行覆盖率按源文件物理行和 Node 报告的 uncovered line ranges 精确重算；没有出现在报告中的 `src/**/*.ts` 文件按 0 行覆盖处理。这避免“从未加载的源码被静默忽略”。
- Node 20 文本报告不公开每个文件的 branch/function 分母。文档和 JSON 仅提供已加载源码文件的逐文件百分比算术均值作为诊断信息，不将其伪装成标准加权覆盖率，也不据此声称 95%。
- 子测试进程非零退出、覆盖报告缺失或畸形、重复源码行、路径越界、uncovered 范围非法、Node 百分比与重算行数不一致，都会令门禁失败（fail closed）。

## 运行与机器输出

当前脚本已接入 `package.json` 与 Windows CI，正式入口为：

```powershell
npm run test:coverage
```

成功采样后输出一行 `SOURCE_COVERAGE_SUMMARY=<json>`，其中包含源码文件总数/加载数、未加载文件、精确覆盖行数、阈值、失败原因和总判定，便于 CI 保存与解析。该 JSON 是门禁接口；人类可读的两行百分比只是摘要。

## 2026-08-24 基线与当前阈值

## 2026-08-25 独占复采样（临时、未收口）

以下数字来自候选 `f3320cb9eb241e7717433a54e7b88d327e754821` 的未提交本地工作树，采样时间为 `2026-08-25 16:54:23 +08:00`。它们是当前最新观测，不是最终统一证据快照：

- `src/**/*.ts`：123 个文件、28,804 行；
- 已加载源码：117/123 = 95.122%；
- 源码行覆盖：26,873/28,804 = 93.2961%；
- 两次独占运行结果一致；距 95.00% 仍差 526 行；
- `npm test`：843 total，841 pass，2 conditional skip，0 fail；
- 门禁阈值仍为 90.25% 行覆盖和 93.0% loaded source，未修改阈值或分母。

由于正式覆盖目标尚未达到，`docs/evidence/current-evidence.json` 和最终材料暂不改写；旧段落保留为历史采样记录，不能与本次临时采样混用。

在 Node 20.19.0 上，当前 `scripts.test` 的 94 个主测试文件完成正式覆盖采样后，最新有效结果为：

- `src/**/*.ts`：122 个文件、28,672 行；
- 已加载源码：116 个文件，95.082%；
- 未加载源码：6 个纯类型或声明文件，仍按 0 覆盖计入；
- 最新稳定采样为 26,146/28,672 = 91.19%；V2/V3 协调器、Router fail-closed 与恢复边界专项均进入正式覆盖集合，新增源码没有从分母排除；
- 仅作诊断的已加载文件算术均值为 line 89.6367%、branch 88.72%、function 95.9134%，这些不是全仓加权覆盖率；
- 分母相较 26,781 行快照累计增加 127 行：119 行来自 `afterModelResponsePersisted`（W01）、`beforeStageResultCommit`（W06）与 App Server 对应的 Process Chaos 控制边界接线；5 行来自 CLI 运行中直接退出竞态修复；3 行来自 Model Invocation 快照稳定 ID 校验。本轮没有排除或隐藏这些新行。
- 新增的确定性回归覆盖“活动 Turn 收到 `/exit` 后，取消完成先清空 `activeTurn`”的竞态；CLI 不再读取已经清空的状态。
- 新增 hotpaths4 以真实断言覆盖 Model/Tool/Lifecycle Store、MCP 配置、Agent Event、Runtime Session、JSON-RPC、Composer/Command Palette 与 Shared Board 边界。它同时发现并修复 `ModelInvocationStore.fromSnapshot` 未复核稳定 Invocation ID 的持久化完整性缺口。

门禁据此设置为：

- 源码行覆盖率不低于 **90.25%**；
- 源码加载率不低于 **93.0%**。

源码行阈值保持 90.25%，加载率阈值保持 93.0%。最新稳定样本分别高出门槛 0.94 和 2.082 个百分点；加载率已经超过 95%，但全仓物理行覆盖仍只有 91.19%，至少还差 1,093 行才达到 95%。它们是当前事实上的防回退基线，不是项目完整度 95% 的宣称。未来只有在新增测试提升真实覆盖后才能上调，不能为了通过而下调。

当前未加载文件会在 `SOURCE_COVERAGE_SUMMARY` 的 `sourceFiles.unloaded` 中逐项输出；其中包含纯类型、声明文件和尚未被主测试触达的兼容/契约模块。若后续决定把纯类型声明排除，必须先修改并评审口径，不能静默改变历史分母。
