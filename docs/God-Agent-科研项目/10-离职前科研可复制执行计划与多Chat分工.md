# God-Agent 离职前科研可复制执行计划与多 Chat 分工

## 副标题：以最新集成基线构建 Research Artifact v0.1 的并行实施、验收与 PR 门禁

> 文档编号：D10
> 制定日期：2026-08-20
> 当前状态：RRA-01～RRA-06 已交付，处于总控验收整改；baseline Commit、Artifact、干净副本复现和 PR 均未完成
> 唯一工作区：`<integration-worktree>`
> 当前分支：`god-runtime-phase1-integration_hln`
> 当前本地 HEAD：`e65767f960967a21ab2191503363e53280d4ba62`
> Git 原则：员工 Chat 不执行 Git；总控 Chat 在全部门禁通过后统一处理提交和 PR

---

## 1. 本轮唯一目标

在不扩展“中央大脑”概念、不调用真实 Provider、不夸大科研结论的前提下，把最新 God-Agent 现有可靠性成果转化为 **Research Artifact v0.1**：

> 第三方获得固定源码后，能够依据仓库内说明运行离线协议基准、生产实现 Runtime-E2E 基准和窄范围真实进程 Chaos 检查，获得可校验原始产物，并明确每项结论的证据等级与限制。

本轮不是完整论文投稿，也不承诺在同一 PR 中完成中央 Runtime、完整专家团或 GATE-40 全矩阵。

---

## 2. 最新基线事实

### 2.1 已确认

- 工作区：`<integration-worktree>`；
- 分支：`god-runtime-phase1-integration_hln`；
- HEAD：`e65767f960967a21ab2191503363e53280d4ba62`；
- 已有协议级 GATE-30/GATE-100 Runner；
- 已有生产实现 Runtime-E2E GATE-30/GATE-100 Runner；
- 已有真实 App Server 强杀与恢复的 Process Chaos Harness；
- 当前科研测试不需要真实 Provider；
- D06–D09 当前属于未跟踪文档，必须保护，禁止员工 Chat 删除或覆盖。

### 2.2 当前主要缺口

1. `research/*/results/` 被整体忽略，结果摘要引用的原始 JSON/CSV/Repro 未进入可移交 Artifact；
2. 缺少统一 Artifact Manifest、哈希清单、环境元数据和结果完整性验证入口；
3. Process Chaos 只有 Team Workflow Return 窄范围检查，没有正式矩阵、Schema 和稳定的门禁报告；
4. 缺少第三方从零执行的统一复现 SOP；
5. 缺少 Claim → Mechanism → Test → Artifact → Conclusion 的统一证据矩阵；
6. PR #31 与本轮 Research Artifact 的最终提交关系尚需在集成阶段确认，不能默认把大范围新增直接塞进已有 PR。

---

## 3. 并行拆分原则

- 每个 Chat 只负责一个清晰可验收的小需求；
- 文件所有权必须互斥；
- 员工 Chat 不创建分支、不提交、不推送、不创建 PR；
- 员工 Chat 不修改 D00–D10；
- 员工 Chat 不改核心生产 Runtime，除非任务明确列出；
- 每个 Chat 必须先阅读最新工作区而不是旧 `<legacy-checkout>`；
- 所有新增结果不得调用真实 Provider；
- 测试失败必须保留原因，不得为了全绿删掉反例或弱化断言；
- 如果发现必须修改他人所有文件，立即停止并报告总控 Chat。

---

## 4. 小需求 RRA-01：科研 Artifact 归档与完整性校验

### 4.1 负责人

员工 Chat A：Research Artifact 工程师。

### 4.2 目标

建立一个不依赖真实 Provider 的最小 Artifact 归档层，使已生成的 JSON、CSV、Repro 和环境信息可以被统一收集、哈希、验证和移交。

### 4.3 文件所有权

允许创建或修改：

- `research/reproducibility/**`；
- 与该目录对应的独立测试文件，优先放入 `research/reproducibility/tests/**`。

禁止修改：

- `package.json`；
- `src/**`；
- `research/runtime-e2e-benchmarks/src/process-chaos-*.ts`；
- `docs/**`；
- 其他 Chat 的文件。

### 4.4 最小需求

1. 定义 Artifact Manifest 结构；
2. 收集相对路径、字节数、SHA-256 和内容类型；
3. 记录基线 Commit、运行命令、Node/OS 信息、开始结束时间和 Provider 使用声明；
4. 拒绝目录穿越、绝对路径泄漏、重复路径和 Manifest 自包含哈希；
5. 提供 `create` 与 `verify` 两种入口；
6. Manifest 排序和序列化必须确定；
7. 验证文件缺失、内容篡改和多余文件时必须非零退出；
8. 不把 Token、Key、环境变量值或本机敏感路径写入 Artifact。

### 4.5 验收

- 新增单元测试覆盖创建、验证、篡改、缺失和路径安全；
- 两次基于同一输入的规范化 Manifest 内容一致；
- `npm run check` 通过；
- 独立测试命令通过；
- 输出一段可供总控集成的使用说明。

---

## 5. 小需求 RRA-02：真实进程 Chaos 可复现门禁

### 5.1 负责人

员工 Chat B：Process Chaos 与恢复验证工程师。

### 5.2 目标

把当前 Team Workflow Return 窄范围真实进程实验从“可运行脚本”提升为可重复执行、可机器校验、失败时可复现的正式窄范围门禁；不虚构完整 GATE-40。

### 5.3 文件所有权

允许创建或修改：

- `research/runtime-e2e-benchmarks/src/process-chaos-*.ts`；
- `research/runtime-e2e-benchmarks/schema/process-chaos-*.json`；
- 专属于 Process Chaos 的测试文件。

禁止修改：

- `package.json`；
- `src/**` 生产 Runtime；
- `research/reproducibility/**`；
- `docs/**`；
- 现有 GATE fixture，除非先报告总控。

### 5.4 最小需求

1. 明确该实验当前只有哪些 fault window；
2. 报告中写入 Schema 版本、运行环境、进程 PID 变化、故障点确认、恢复结果和 Fake Provider 请求计数；
3. 为报告建立运行时校验和 JSON Schema；
4. CLI 对失败返回非零退出码；
5. 输出稳定的单例复现命令；
6. 任何工作目录和 App Server 子进程都必须可靠清理；
7. 测试不得读取真实 Key 或调用真实 Provider；
8. 文案和字段必须明确这是窄范围 E3，不是完整 GATE-40。

### 5.5 验收

- Process Chaos 专项测试通过；
- 至少一次真实子进程强杀、重启、恢复检查通过；
- 报告通过 Schema 和运行时验证；
- 重复执行不会遗留 App Server 进程；
- `npm run check` 通过；
- 不宣称完整 E3、exactly-once 或生产可用。

---

## 6. 小需求 RRA-03：第三方复现 SOP 与 Claim–Evidence Matrix

### 6.1 负责人

员工 Chat C：科研复现与证据审稿人。

### 6.2 目标

编写一套只依赖仓库内容的复现说明和证据矩阵，使新接手者能够区分协议 Model Check、生产实现 Implementation Check 和窄范围 Process Check。

### 6.3 文件所有权

允许创建：

- `research/REPRODUCIBILITY.zh-CN.md`；
- `research/CLAIMS-EVIDENCE.zh-CN.md`；
- 必要时创建 `research/ARTIFACT-INDEX.zh-CN.md`。

禁止修改：

- `src/**`；
- `tests/**`；
- `package.json`；
- `research/**/src/**`；
- D00–D10；
- 其他 Chat 的文件。

### 6.4 最小需求

1. 列出支持的 Node/npm/Windows 环境与依赖安装步骤；
2. 从空结果目录开始运行 GATE-30、Runtime-E2E GATE-30 和 Process Chaos；
3. 说明每个命令的输入、输出、预计耗时、退出条件和是否调用真实 Provider；
4. 说明如何生成和验证 Artifact Manifest；
5. 建立每个科研 Claim 对应的机制、测试、Artifact、证据等级和限制；
6. 明确旧摘要哈希在原始文件缺失时不能独立核验；
7. 明确 Process Chaos 只有窄范围 1/40；
8. 提供干净环境复现记录模板和失败报告模板；
9. 禁止出现“完整 E3”“GATE-40 已完成”“端到端 exactly-once”“生产可用”等表述。

### 6.5 验收

- 所有命令均能在当前 `package.json` 或源码入口中找到；
- 路径不依赖作者个人临时目录；
- Claim 不超过当前证据等级；
- 新手能够仅按文档完成最小运行；
- 与 D08/D09 的科研诚信口径一致。

---

## 7. 小需求 RRA-04：Runtime-E2E 确定性与路径脱敏修复

### 7.1 负责人

员工 Chat D：Runtime-E2E 复现缺陷排查工程师，任务 ID `01a01d1a-3c92-7bf2-b7fb-c267c8880d52`。

### 7.2 触发原因

总控在最新 integration 工作区多次执行 `npm run benchmark:runtime-e2e:gate30`，确定性双跑既出现过通过，也重复出现退出码 1。该失败会阻断科研复现和 PR，不能按偶发噪声忽略。

结构化投影差异已经定位为两条 `no-lease-return-parent-feedback` 用例的 `recoveryResult`。SnapshotConflict 的错误代码、generation 和语义相同，唯一差异是错误消息中包含每次 `mkdtemp` 生成的本机绝对临时目录。

### 7.3 修复边界

- 在异常记录源头将 case 临时目录规范化为稳定占位符；
- 保留异常代码、类型、generation 冲突、相对文件名和所有安全/恢复指标；
- 不允许通过删除整个 `recoveryResult`、Failure、Evidence、Unknown Outcome 或重复副作用字段使测试变绿；
- 增加直接的路径脱敏与确定性回归测试；
- 不修改生产 `src/**`，不调用真实 Provider，不执行 Git。

### 7.4 验收

- 投影不包含作者机器绝对路径；
- Runtime-E2E 专项通过；
- Runtime-E2E GATE-30 连续复跑通过；
- 类型检查通过；
- 旧失败反例和根因进入科研文档与 Artifact 记录。

---

## 8. 总控 Chat 的职责

当前 Chat 不与员工争抢实现文件，主要负责：

1. 维护 D09/D10 决策和执行记录；
2. 监控三个新 Chat，及时解除阻塞和阻止范围扩张；
3. 检查员工之间是否发生文件冲突；
4. 对三项结果做交叉审查；
5. 必要时做最小集成修改，例如统一命令入口；
6. 运行类型检查、专项测试、全量主测试、Lease 和 Electron；
7. 在代码、测试和文档验收后创建 baseline Commit；
8. 以 baseline SHA 建立三层 Artifact 和哈希，并在同机干净源码副本执行一次复现 SOP；
9. 更新科研日志中的真实结果、失败反例和阶段结论；
10. Artifact 与科研诚信门禁通过后创建 artifact Commit，再 Push 并更新 PR；外部第三方复现不作为本次 PR 前置。

---

## 9. 集成测试门禁

### G0：静态和单元测试

- `npm run check`；
- `npm run pretest`；
- 三个新增需求的专项测试。

### G1：既有回归

- `npm test`；
- `npm run test:lease`；
- `npm run test:electron`；
- `npm run test:benchmarks`；
- `npm run test:runtime-e2e`。

### G2：科研 Runner

- GATE-30 协议基准；
- Runtime-E2E GATE-30；
- Process Chaos 窄范围真进程检查；
- Artifact Manifest 创建和二次验证；
- 不调用真实 Provider。

### G3：干净环境复现

- 从没有旧 `results/` 的目录开始；
- 只按照 `REPRODUCIBILITY.zh-CN.md` 执行；
- 保存完整命令、退出码、环境版本、耗时和异常；
- 从原始 Artifact 重算摘要并比对；
- 记录所有人工介入。

### G4：科研诚信

- Claim–Evidence Matrix 每一行均可追溯；
- 失败结果没有被删除；
- 1/40、GATE-40 未完成、Fake Provider 和本地单文件 CAS 等限制准确保留；
- 不宣称生产可用或端到端 exactly-once。

---

## 10. Git 与 PR 方案

### 10.1 员工阶段

- 所有员工 Chat 禁止执行 Git；
- 不提交临时结果、Key、机器配置、缓存和进程日志；
- 只交付分配文件和测试结果。

### 10.2 集成阶段

总控 Chat 将先列出最终拟提交文件，排除无关变化和敏感文件，再统一提交。

当前 PR #31 已承载 Phase 1 Integration。本轮 Research Artifact 涉及新的科研交付范围，推荐优先考虑独立 `_hln` 研究分支和独立 PR，避免在待验收 PR 中继续扩大范围；但必须先确认 PR #31 的最新远端状态以及用户希望“更新 #31”还是“另开新 PR”。

### 10.3 PR 创建门禁

Git/Artifact 采用两阶段门禁：

1. G0/G1、文件清单和科研文档验收通过后，总控可创建 **baseline Commit**，只用于冻结可复现源码、测试和说明；
2. 以 baseline Commit 的 40 位 SHA 生成三层 Artifact、执行 G2、同机干净源码副本 G3、Manifest `create`/`verify` 和 G4；
3. 上述 Artifact 门禁通过后，总控创建 **artifact Commit**，其中 Manifest 继续绑定 baseline SHA；
4. 只有 artifact Commit 完成后，才允许 Push 到对应 `_hln` 分支并更新现有 PR；
5. PR 描述必须附两次 Commit、测试结果、Artifact 哈希、已知限制和未完成项。

若 baseline 冻结前出现无法重建详情、后续又未复现的 flake，可以在满足以下条件时带风险进入 baseline：科研日志与 Claim Matrix 保留原始汇总和证据缺口；保存后续完整复跑输出；PR 明确写“未定位、未修复”；不得用复跑成功替换首次失败。NEG-011 当前满足披露条件，但若再次出现失败，必须重新打开门禁。

外部第三方无指导复现属于 R4/E4 后续目标，不是本次 PR 前置；同机干净副本通过也不得写成“第三方已复现”。

禁止直接推送 `main`，禁止 rebase，禁止把测试数量包装成科研创新。

---

## 11. 预计交付顺序

```text
基线确认
  → 六个员工 Chat 分批并行
  → 文件冲突检查
  → 单项验收
  → 总控集成
  → G0/G1 回归
  → baseline Commit
  → G2 科研 Runner 与 Manifest
  → G3 同机干净源码副本复现
  → G4 科研诚信审查
  → artifact Commit
  → Push/更新 PR
```

---

## 12. 当前状态

| 项目 | 状态 |
|---|---|
| 最新本地基线确认 | 已完成 |
| RRA-01 下发 | 已创建 `01a01cf6-85b2-73e2-a5a8-f8d8d806cf64` |
| RRA-02 下发 | 已创建 `01a01cf6-8d33-7132-b896-4553ea0f3635` |
| RRA-03 下发 | 已创建 `01a01cf6-93c3-7810-bb5f-50444ce09021` |
| RRA-04 下发 | 已创建 `01a01d1a-3c92-7bf2-b7fb-c267c8880d52`，已完成 |
| RRA-05 下发 | 已创建 `01a01d23-347c-7811-9733-8e644e148bf5`，已完成 D01/D02 同步 |
| RRA-06 下发 | 已创建 `01a01d23-3892-7f90-93bd-d87d8aba229d`，已完成 D03/D04 同步 |
| 员工交付 | RRA-01–RRA-06 已完成；总控验收发现文档闭环问题，当前整改中，尚未最终签字 |
| 集成测试 | Manifest 9/9、Runtime-E2E 10/10；Process NEG-010 修复后员工四轮及总控单轮均 2/2。全量主测试总控首次 482 tests / 481 pass / 1 fail，失败详情因截断丢失；立即复跑和员工随后三轮均 482/482，三轮完整 TAP 无失败标记、Process #387 均 `ok`、无残留。NEG-011 未定位、未修复，允许披露风险后进入 baseline；仍待 Artifact/同机干净副本最终冻结 |
| Process 原始状态 | 报告字段已安全；v0.1 公开包已选择排除仍含本机绝对计划路径的 raw `runtime-state.json`，只纳入报告、Lease、环境、命令与限制；raw state 可由 Runner 重建，Claim 同步降级 |
| 同机干净源码副本复现 | 未开始；完成后也不得称外部第三方复现 |
| Git/PR | 未开始 |

下一步：以 NEG-011 未解释 flake 作为显式风险完成 baseline 冻结，在 PR 与 Artifact 中保留首次 481/482、日志缺失和后续四次成功；再以 baseline SHA 生成三层 Artifact、Manifest，并进入同机干净源码副本复现。
