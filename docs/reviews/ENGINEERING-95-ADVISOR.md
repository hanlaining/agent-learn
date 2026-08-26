# God-Agent 工程 95 独立复核与实施记录

> 最后复核：2026-08-24  
> 范围：当前共享工作树的 V2/V3 Runtime、工程测试、正式 `src/**/*.ts` 覆盖门  
> 约束：未降低阈值、未改变统计口径、未排除新增源码、未修改依赖或 lockfile、未执行 Git 操作  
> 最终裁决：**93/100，工程 95+ No-Go。** 加载率已真实超过 95%，全仓加权物理行覆盖提升到 92.2119%，仍未达到 95%。

## 1. 本轮真实实施

### 1.1 两个原纯类型模块进入生产运行时边界

没有用空 `import` 制造 loaded，而是在 V2/V3 共用的 `ExecutionEngineRouter` 落地三个 fail-closed 边界：

- 启动前校验 Execution Context 的 Job、Thread、Root Run、执行类型、Workflow 版本及可选 drive；
- 用户反馈进入 Engine 前校验 Turn ID、非空文本和精确字段；
- Engine Snapshot 返回 App Server 前校验 Engine/Job 身份一致、精确字段、可选状态值及时间戳。

由此 `src/execution/execution-context.ts` 与 `src/execution/execution-engine.ts` 被生产路由真实调用，能够发现并拒绝错误 Job Snapshot、错误 Engine Snapshot、畸形启动 Context 和畸形反馈，不是仅为覆盖数字存在的代码。

正式覆盖首轮还真实发现 `drive` 被校验器误列为必填，导致合法 Workflow Context 失败。实现已改为真正可选，并新增无 drive 正例；对应 App Server feedback 恢复与真实子进程 crash/restart 用例均复验通过。

### 1.2 V3 关键失败与恢复分支

V3 专项新增以下真实行为：

- 设计确认前反馈不能提前进入；设计反馈让产品原稿和 Mock 复用原 Task 进入第二 attempt；
- 设计重试达到上限后 fail closed；
- 非结构化输出只允许一次 JSON 格式修复；
- Provider/执行异常第一次进入 rework，第二次收敛为 failed/failed_terminal，并触发失败回调；
- 冻结需求方案、产品原稿和 Mock 的真实路径与 hash 进入后续验收提示；
- 规范化 `./`、`/**` 后仍能拒绝前后端重叠文件声明。

## 2. 变更文件

- `src/execution/execution-context.ts`
- `src/execution/execution-engine.ts`
- `src/execution/execution-engine-router.ts`
- `tests/team-runtime-v2-test.ts`
- `tests/team-runtime-v3-test.ts`
- `tests/agent-runtime-store-test.ts`
- `tests/requirement-store-test.ts`
- `tests/coverage-hotpaths4-store-test.ts`
- `tests/electron-app-server-client-test.ts`
- `tests/dynamic-agent-execution-engine-test.ts`
- `tests/fixed-software-team-test.ts`
- `tests/mcp-manager-test.ts`
- `tests/run-command-tool-test.ts`
- `tests/execution-lease-coordinator-test.ts`
- `tests/workspace-command-runner-test.ts`
- `tests/context-compactor-test.ts`
- `tests/electron-runtime-ui-test.ts`
- `docs/reviews/ENGINEERING-95-ADVISOR.md`
- `docs/reviews/THINK-TANK-ENGINEERING-CURRENT.md`

未修改 package、覆盖脚本、覆盖阈值、README、PPT、依赖、lockfile 或其他智囊报告。

## 3. 验证结果

| 验证 | 结果 |
|---|---|
| `npm run check` | 通过 |
| V2 Router/Workflow 专项 | 10/10 pass，0 fail |
| `npm run test:v3` | 10/10 pass，0 fail |
| V2 + V3 组合专项 | 20/20 pass，0 fail |
| App Server child-blocked feedback 恢复用例 | 单项通过 |
| 真实 App Server crash/restart 用例 | 单项通过 |
| `npm run test:coverage` | 通过，94 个正式主测试文件形成有效 `SOURCE_COVERAGE_SUMMARY` |
| 本轮四文件工程专项 | 55/55 pass，0 fail |
| 第三波高风险专项 | 51/51 pass，0 fail |
| 补强切片专项 | 100/100 pass，0 fail |

专项覆盖变化：

- `src/execution/v3-product-delivery-coordinator.ts`：line **90.63% → 95.07%**，增加 4.44 个百分点；branch 80.49%，function 97.10%；
- `src/execution/execution-context.ts`：line 62.50%，function 100%；
- `src/execution/execution-engine.ts`：line 56.38%，function 100%。这两个文件包含大量接口声明，运行时函数路径已被正反例覆盖，但物理类型行仍按现有保守口径计入未覆盖。

## 4. 正式全仓覆盖增量

| 指标 | 实施前稳定样本 | 当前正式样本 | 增量 |
|---|---:|---:|---:|
| 已加载源码 | 114/122 | **116/122** | **+2 文件** |
| 加载率 | 93.4426% | **95.0820%** | **+1.6394 pp** |
| 覆盖物理行 | 25,896 | **26,439** | **+543 行** |
| `src` 物理行分母 | 28,576 | **28,672** | +96 行真实生产校验 |
| 加权行覆盖 | 90.6215% | **92.2119%** | **+1.5904 pp** |

第二波结束时正式样本为 **26,162/28,672，91.2458%**；第三波最新正式样本为 **26,439/28,672，92.2119%**，新增 **277 条覆盖行、+0.9661 pp**。相对第三波协同基线 26,146 行净增 **293 行**。源码加载率保持 **116/122，95.0820%**。

当前仍未加载的 6 个文件为：

- `src/agents/agent-run.ts`
- `src/domains/finance/types.ts`
- `src/electron/renderer/global.d.ts`
- `src/electron/renderer/vite-env.d.ts`
- `src/llm/types.ts`
- `src/shortcuts/action-types.ts`

它们均为纯类型或声明文件。本轮没有以空加载、删除类型行或修改统计范围把它们伪装成已覆盖。

## 5. 客观评分

| 维度 | 得分 | 满分 | 依据 |
|---|---:|---:|---|
| 自动化正确性与测试治理 | 24 | 25 | check、V2/V3 专项和正式 coverage 子进程绿色；仍有 Windows 符号链接权限条件 skip |
| V2/V3 架构与可靠性 | 24 | 25 | V3 happy path、返工、设计反馈、格式修复、失败上限、真实 receipt、完整 Return 与重启恢复均有证据 |
| 源码覆盖与防回退 | 18 | 20 | loaded 已达 95.08%，V3、Dynamic Engine、Requirement Design Writer 等关键模块达到或接近 95%；全 `src` 加权行仍仅 92.21% |
| 构建、CI 与可复现性 | 14 | 15 | 本地静态检查和正式覆盖通过；缺当前候选同 SHA 的远端 CI、干净机和第二机器 |
| 工程边界与发行卫生 | 13 | 15 | Context/Feedback/Snapshot、权限、WAL、Lease、Return 等边界增强；供应链与发行外部门仍未收口 |
| **总分** | **93** | **100** | **工程能力增强，但 95 的全仓覆盖与外部复现门没有满足** |

## 6. 距离工程 95+ 还差什么

当前分母 28,672 行要达到至少 95.00%，最低需要 27,239 条覆盖行；当前为 26,439，仍差 **800 条覆盖行**。这是假设后续只增加测试、不再增加生产源码分母时的最短数学距离。

必须继续满足以下不降口径门：

1. 全 `src` 加权物理行覆盖达到至少 95.00%，并连续两次原始 coverage 命令形成有效 summary；
2. 优先覆盖 App Server、Workflow/Runtime Store、CLI/MCP 和恢复路径的真实分支，不用空 import 消耗剩余纯类型文件；
3. 为关键可靠性路径建立可加权 branch gate；当前 Node 文本报告的 loaded-file branch mean 不能冒充全仓加权分支覆盖；
4. 在具备符号链接权限的 Windows 环境消除条件 skip；
5. 当前候选同 SHA 的远端 CI、干净 Windows 与第二机器复现全部绿色。

## 7. 最终裁决

本轮已经完成可证据化进展：loaded 从 114 提升到 116，正式加载率超过 95%；V3 协调器专项行覆盖超过 95%；正式全仓覆盖门重新绿色。新增生产校验还在首次覆盖复跑中发现并修复了真实 optional 字段缺陷。

但“loaded 95%”不等于“工程 95+”。全仓加权物理行覆盖仍为 92.2119%，距离 95% 还差 800 行，且远端同 SHA 与干净机证据缺失。因此当前客观结论是：**93/100，工程 95+ No-Go，继续精进。**
