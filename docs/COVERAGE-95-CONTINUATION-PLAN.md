# 覆盖率 95% 继续推进记录

更新时间：2026-08-25（本机串行验证）

## 当前结论

最新主控候选（2026-08-25 15:52，未提交工作区）已补齐正式测试发现遗漏并把测试总数推进到 840；连续两次 `npm test` 为 838 pass、2 条条件 skip、0 fail。独占 coverage 为 26,870/28,774 = 93.3829% 与 26,869/28,774 = 93.3794%，loaded source 116/122 = 95.082%。这仍低于源码行覆盖 95.00%，距离 95% 约 465 行；不得把 loaded 95.082% 写成总体 95+。

本轮没有把未达标结果写成完成态。新增 Runtime Event 工厂、Agent Loop 审批等待/取消/拒绝、Runtime failure 分类的真实行为测试；`npm test` 最新为 **822 total；820 pass；2 conditional skip；0 fail**。独占 coverage 在并发时序下观测到 **26,798/28,736 = 93.2558%**、**26,807/28,736 = 93.2872%**、**26,825/28,736 = 93.3498%**、最新 **26,808/28,736 = 93.2906%** 等样本；按最新一次记录仍距 95.00% 差 491 行，不能宣称 95% 或 95+。加载源码文件为 **116/122 = 95.082%**。一次全量首跑出现 3 个既有 CLI/MCP `outcome_unknown`/等待超时，随后独占复跑通过；该抖动保留为风险，不视为全绿。Electron 专项最新 **85/85** 通过，但当前没有 Electron 开发窗口进程，不能声称已启动运行态。

全量 `npm test` 本轮结果为 **811 total；809 pass；2 conditional skip；0 fail**。两条 skip 仍按条件跳过记录，不能写成 811/811 全通过。

## 本轮新增的真实行为测试

- 模型 Invocation WAL 在 `submitted` 快照恢复时转为 `outcome_unknown`，且 Provider 调用数保持为 0。
- 模型 Invocation WAL 在 `failed_terminal` 快照恢复时直接拒绝，不重新调用 Provider。
- Tool 执行抛错时持久化 `outcome_unknown`，不进入后续模型轮次。
- Turn 参数解析、取消结果、Token Budget、Tool Output Limiter、Tool Invocation 身份摘要、Runtime Lease 的正反边界。

## 固定验收循环

每个覆盖切片必须按以下顺序执行，并保留独占结果：

1. 对应专项测试；
2. `npm run check`；
3. `npm test`；
4. `npm run test:coverage`。

只有连续两次独占源码行覆盖达到 95.00% 以上，且分母仍为 122 文件/28,736 行，才允许进入统一材料收口。不得通过删除测试、排除源码、修改覆盖脚本、调整分母或降低阈值制造达标。

## 本轮新增测试切片

- `tests/runtime-event-test.ts`：非法 generation、版本、authority、时间、因果前驱、item correlation 与非 plain JSON 对象。
- `tests/agent-loop-test.ts`：审批等待取消、审批成功清理监听器、审批 Provider 拒绝后的 Turn 失败。
- `tests/team-runtime-v2-test.ts`：显式 runtime failure code、状态/消息分类与安全兜底。

## 下一最小切片

优先补 `src/app-server/main.ts` 的未覆盖真实启动/关闭边界，以及 `src/agent/agent-loop.ts` 的并发运行、恢复重放和权限拒绝路径；完成后重复固定验收循环。若新增测试只覆盖类型声明映射而没有实际行为增益，不计入收口依据。

## 证据边界

本机离线测试、Fake/Mock Provider、local pilot 和同作者复跑仍只能作为本机工程证据，不能写成真实 Provider、正式实验、独立复现或生产放行。正式科研与生产评分继续保持 No-Go，直到外部条件真实满足。
