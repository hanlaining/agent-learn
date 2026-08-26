# God-Agent 工程顾问独立审计

> 审计日期：2026-08-24  
> 审计范围：当前共享工作树的工程研究原型，不包含尚未运行的远端 CI、真实 Provider、签名安装包或第三方复现。  
> 结论：**93/100，No-Go（未达到 95）**。

## 1. 独立评分

| 维度 | 得分 | 满分 | 客观依据 |
|---|---:|---:|---|
| 自动化正确性与测试发现 | 24 | 25 | test discovery 106/106；主测试 658 项中 657 pass、1 个 Windows 文件符号链接权限条件 skip、0 fail |
| 关键可靠性语义 | 24 | 25 | WAL、Outcome Unknown、Lease/Fencing、Return、恢复、取消、IPC、CLI、MCP 均有正反行为测试；GATE-40 local pilot 为 25 passed/15 blocked，尚无 formal Verified |
| 源码覆盖与防回退 | 18 | 20 | 连续两次保守样本最低为 24,425/26,908 = 90.7723%；加载率 111/119 = 93.2773%；门禁已抬至 90.25%/93.0% |
| 构建、CI 与可复现性 | 14 | 15 | 本机 check、测试、覆盖及既有构建门禁可执行；当前候选仍缺远端 CI 与干净机器同 SHA 证明 |
| 工程边界与发行卫生 | 13 | 15 | Provider 离线边界、Security Scan、SBOM、Release Readiness 已建立；完整依赖审计仍有 3 个 high，签名/升级/回滚未完成 |
| **总分** | **93** | **100** | **工程质量明显高于普通课程 Demo，但证据不足以判为 95+** |

总账与本报告现均按稳定覆盖门禁和新增持久化完整性校验采用 93。它仍必须保持 No-Go，不能把本地工程得分扩写成科研、论文或生产 95+。

## 2. 本轮可复核证据

- `npm run check`：通过；
- `npm run test:discovery`：106/106，零遗漏、零陈旧引用；
- `npm test`：pretest 19/19；主测试 658 项，657 pass、1 conditional skip、0 fail；
- `npm run test:coverage-hotpaths3`：12/12；
- `npm run test:coverage-hotpaths4`：13/13；
- `npm run test:coverage`：新门禁下连续两次为 24,427/26,908 = 90.7797% 与 24,425/26,908 = 90.7723%，loaded 111/119 = 93.2773%，90.25%/93.0% 门禁均通过；
- `npm run test:process-chaos`：12/12；GATE-40 local pilot 为 25 passed、0 failed、15 blocked、formal Verified 0，60 个观测 PID 残留 0；
- 新行为证据覆盖 CLI 入口与交互状态、离线 Provider 失败恢复、运行中状态/队列/取消、debug 推理与搜索流、Workspace Tool 参数 fail-closed、Runtime UI、Execution Lease、MCP discovery/分页/取消/异常退出，以及 Model/Tool/Lifecycle Store、MCP 配置、Agent Event、Runtime Session、JSON-RPC、Composer/Command Palette、Shared Board 的确定性边界；
- 覆盖分母相较 26,781 行快照累计增加 127 行：119 行来自 Agent Loop 的 `afterModelResponsePersisted`（W01）、Workflow 的 `beforeStageResultCommit`（W06）与 App Server 对应的 Process Chaos 控制边界接线；5 行来自 CLI 退出竞态修复；3 行来自 Model Invocation 快照稳定 ID 校验。本审计按新分母计分，没有隐藏新增代码；
- 覆盖复跑真实暴露了活动 Turn 输入 `/exit` 时的竞态：取消完成会在 `await` 期间清空 `activeTurn`。实现现固定原 Turn 快照后等待 completion，并新增确定性回归用例；CLI smoke 连续三轮及主测试均通过。
- 稳定性补测还暴露 `ModelInvocationStore.fromSnapshot` 未重新校验稳定 Invocation ID；现已 fail closed，并以损坏、重复、自相矛盾快照正反例锁定。

## 3. 为什么仍不是 95+

1. 以连续两次中的较低样本计算，精确源码行覆盖为 90.7723%，距离 95% 仍差 1,138 条覆盖行；Node 20 文本报告又不能提供全局加权 branch/function 分母，不能把已加载文件均值冒充关键路径分支覆盖。
2. 8 个未加载文件是纯类型或声明文件，虽然纳入分母是保守做法，但加载率仍只有 93.2773%，没有达到更高的 95%目标。
3. Windows 文件符号链接安全分支在当前机器因系统权限条件 skip；它不是失败，但也不是已验证通过。
4. 当前证据来自本机共享工作树，尚无当前候选 SHA 的远端 CI、干净 Windows 安装到启动链或第二机器复现。
5. GATE-40 local pilot 已把可运行窗口提升为 25 passed/15 blocked，但 formal Verified 仍是 0/40；真实 Provider 调用仍为 0。
6. 完整开发/构建依赖审计仍有 3 个 high；签名发行、升级、回滚和长稳不属于已完成证据。

## 4. 达到工程 95+ 的最短补足路径

| 优先级 | 必须补足 | 可判定验收 |
|---|---|---|
| P0 | 冻结当前候选并跑远端 CI | 同一 Commit 的 check、主测试、覆盖、Electron build、Benchmark、Runtime-E2E、Process Chaos 全绿 |
| P0 | 关键路径覆盖继续提升 | `src` 行覆盖达到预注册目标；为 WAL、Lease、恢复、权限和 IPC 建立可加权的 branch gate 或 Istanbul 等价报告 |
| P0 | 关闭 GATE-40 工程阻断 | 40/40 窗口均有 Raw/Manifest，blocked=0，且故障钩子不会造成重复业务副作用 |
| P1 | 干净 Windows 复验 | 新环境从依赖安装、构建、启动到离线 Demo 全链通过，记录环境与制品摘要 |
| P1 | 关闭供应链高危项 | 依赖升级授权后完成回归，官方 registry 审计 high=0，SBOM 与 lockfile 一致 |
| P1 | 消除条件 skip | 在具备符号链接权限的 Windows 环境执行对应逃逸测试并保存结果 |

在这些证据完成前，合理表述是：“工程研究原型 93 分，源码行覆盖连续采样的保守基线为 90.7723%，但工程 95+ 仍 No-Go。”
