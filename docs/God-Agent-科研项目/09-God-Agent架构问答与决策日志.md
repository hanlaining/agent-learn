# God-Agent 架构问答与决策日志

## 副标题：科研闭环、中央控制 Runtime 与 Harness 分层的持续讨论记录

> 文档编号：D09
> 文档性质：持续迭代的架构问答、术语澄清与决策记录
> 当前状态：中央 Runtime 仍为讨论稿；Research Artifact v0.1 已获授权执行
> 首次记录日期：2026-08-20
> 当前事实工作区：`<integration-worktree>`
> 关联文档：D07《中央大脑统一 Agent Runtime 持续架构讨论》、D08《God-Agent 整体成熟度、科研闭环与 SOP 支撑审计》

---

## 1. 文档使用约定

本文用于持续记录 God-Agent 架构讨论中的：

- 用户提出的关键问题；
- 当前回答与推荐方案；
- 尚未达成共识的选择；
- 已确认的架构原则；
- 被否决的方案及理由；
- 后续需要验证的假设和证据。

本文不是已经批准的实施计划。除非用户明确说“确认方案，可以实现”，否则本文中的内容只代表讨论、分析和候选决策，不授权修改代码、执行 Git 操作或变更 PR。

后续每次实质性架构回答均应追加新的日期和条目，不覆盖历史结论。若结论发生变化，必须保留旧结论，并记录变化原因和新证据。

---

## 2. 2026-08-20：先形成科研闭环，再持续迭代

### 2.1 用户判断

> 要先把这个科研形成闭环，然后我们在这个基础上不断迭代和升级。

### 2.2 当前回答

这个顺序是合理的，但必须先把“科研闭环”限定为一个可完成、可证伪的研究问题，不能把整个“中央大脑 Runtime”都作为第一轮科研成果，否则范围仍然无法收口。

推荐第一阶段只研究当前证据最强的方向：

> 在崩溃、重试、并发 Owner 和不可查询外部副作用条件下，WAL、Lease/Fencing、Return Receipt 与 Snapshot CAS 能否提升 Agent Runtime 的执行安全性和可恢复性，并将额外开销控制在可接受范围内？

### 2.3 第一轮科研闭环门槛

第一轮科研闭环应同时满足：

1. 冻结研究问题、假设、系统边界和禁止表述；
2. 冻结实验版本，后续功能不得改变这一轮实验对象；
3. 完成 Dynamic 双 App Server 的完整 E3 Process Chaos 矩阵；
4. 完成 full、no-WAL、no-recovery、no-lease 等基线与消融；
5. 保存原始 JSON/CSV、环境信息、日志、哈希和复现命令；
6. 统计安全违规率、恢复成功率、重复提交率、`outcome_unknown` 率、延迟与资源开销；
7. 记录失败实验和反例，不能只保留成功结果；
8. 在干净环境进行至少一次独立复现；
9. 形成“研究问题 → 假设 → 机制 → 实验 → 原始数据 → 结论 → 局限”的完整链路；
10. 完成一份可交给导师审阅的技术报告，并冻结为 Research v1。

### 2.4 推荐的演进顺序

```text
Research v1：可靠执行与故障恢复
    ↓ 冻结论文证据和实验版本
Runtime v2：Task Contract + 权威状态
    ↓
Research v2：Completion Proof 与完成可信度
    ↓
Runtime v3：持续 Supervisor Loop
    ↓
Research v3：主动监督、恢复协调与多专家裁决
```

每次升级都应建立在上一阶段的冻结基线上，避免架构持续变化导致实验数字、消融对象和论文结论失效。

### 2.5 范围裁决

第一轮论文不应研究“God-Agent 是否已经实现中央大脑”，而应研究“可靠 Agent Runtime 的执行协议是否有效”。

- 中央大脑 Runtime：长期产品愿景和后续研究计划；
- 可靠执行协议：当前最有可能形成严谨科研闭环的研究切口；
- 多 Agent 数量、角色数量和测试数量：不能直接作为科研创新；
- 端到端 exactly-once：当前不得宣称；
- GATE-40：当前仍未完成。

### 2.6 待确认决策 RQ-D01

是否将第一轮科研闭环正式限定为：

> Agent Runtime 在崩溃与并发条件下的可靠执行和恢复机制。

如果确认，则 Context Compiler、Decision Kernel、Supervisor Loop 和专家团智能程度不进入第一轮论文主实验，只作为后续工作和演进路线。

当前状态：**已确认。** 用户已明确要求先收口科研可复制成果，再在其基础上迭代；本轮按 Research Artifact v0.1 执行，中央 Runtime 继续保持远期讨论状态。

---

## 3. 2026-08-20：Runtime 控制 Harness 和下层 Runtime 的含义

### 3.1 用户问题

针对 D08 的“8.3 尚不能做到”：

- 父 Agent 先持久化完整 Task Contract 和 Task Graph；
- Child 任一完成后立即验证和解锁下游节点；
- 父 Agent在 Child 运行中接收增量状态；
- 主动追加指导，并在安全消息边界生效；
- Heartbeat 中断后按副作用等级替换执行者；
- 多专家冲突后触发独立 Arbiter；
- 基于真实 Artifact/Test/Oracle 而非摘要文本审查；
- 崩溃后从持久事实恢复 Supervisor Loop；
- 由 Completion Proof Engine 形成总目标唯一完成裁决。

用户进一步澄清：

> 什么导致的？Runtime 没做好，还是 Harness 没做好？我说的 Runtime 应该是控制 Harness + Runtime 的一个 Runtime。

### 3.2 核心理解

用户所说的 Runtime 不是“某个 Agent 的执行循环”，而是更高一层、负责控制所有 Harness 和下层执行 Runtime 的中央控制 Runtime。

当前 8.3 做不到，主要原因不是 Harness 完全没做好，也不是已有可靠性 Runtime 没有价值，而是：

> 当前完成较多的是 Worker Runtime 的可靠执行底座，缺少的是位于它上方的 Central Control Runtime。

通俗解释：当前已经有比较可靠的“工人和工具”，但还没有一个持续在线、掌握全局事实、能够调度工人、检查结果和决定是否完成的“中央大脑”。

### 3.3 推荐的三层术语

```text
God Runtime（整个产品和广义 Runtime）
│
├─ Central Control Runtime / God Control Runtime
│  ├─ Goal 与 Task Contract
│  ├─ State Authority
│  ├─ Task Graph 与 Scheduler
│  ├─ Supervisor 与 Recovery Coordinator
│  ├─ Verifier / Arbiter
│  └─ Completion Proof / Finalization Gate
│
├─ Worker Runtime（每个 Chat / Job / Agent 的执行 Runtime）
│  ├─ Run 生命周期
│  ├─ WAL
│  ├─ Lease / Fencing
│  ├─ Cancel / Recovery
│  └─ Tool / Model Invocation
│
└─ Agent Harness（单个 Agent 的认知与行动循环）
   ├─ Context
   ├─ Model
   ├─ Tool Call
   ├─ Observation
   └─ Continue / Stop
```

严格定义：

| 层级 | 核心职责 | 当前程度 |
|---|---|---|
| Agent Harness | 驱动单个 Agent 思考、调用模型和工具、接收观察并继续下一步 | 已有较强基础 |
| Worker Runtime | 管理一个 Chat/Job/Agent 的状态、WAL、Lease、取消、恢复和工具执行 | 已实现较多，主体达到 E2 |
| Central Control Runtime | 管理总目标、Task Graph、全部 Worker、监督、验证、恢复和最终裁决 | 目前主要停留在设计层 |

整个产品可以统称为广义的 **God Runtime**。架构内部必须使用 `Central Control Runtime` 和 `Worker Runtime` 区分上下层，否则“Runtime 控制 Runtime”会持续造成术语冲突。

### 3.4 8.3 缺口的责任归属

| 尚不能做到 | 主要缺失层 | 根本原因 |
|---|---|---|
| 持久化 Task Contract 和 Task Graph | Central Control Runtime | 没有统一总任务契约和权威任务图 |
| Child 完成后立即验证并解锁下游 | Central Control Runtime | 当前是 `Promise.all` 批量等待，不是事件驱动调度 |
| 接收 Child 增量状态 | Worker Runtime + Harness 协议 | 没有标准化 Observation/Event 上报协议 |
| 运行中主动追加指导 | Harness + Central Control Runtime | 没有持久 Mailbox、安全消息边界和 Guidance 协议 |
| Heartbeat 中断后替换执行者 | Central Control Runtime + Worker Runtime | 缺少存活判定、执行权转移和副作用分级策略 |
| 专家冲突后触发 Arbiter | Central Control Runtime | 没有冲突检测、裁决策略和独立权限边界 |
| 基于 Artifact/Test/Oracle 审查 | Verification Plane | Evidence 仍偏向模型摘要，缺少证据注册表和验证器 |
| 崩溃后恢复 Supervisor Loop | Central Control Runtime | 没有事件日志、权威投影、持久等待和唤醒注册 |
| Completion Proof 唯一完成裁决 | Finalization Plane | 当前完成主要由状态聚合产生，不是由证据证明产生 |

责任优先级应表述为：

1. Central Control Runtime 缺失是主要原因；
2. Worker Runtime 的上下行控制协议不完整是第二原因；
3. Harness 缺少可被安全控制的接口是第三原因；
4. Tool、Skill、MCP 本身不是当前主要瓶颈。

### 3.5 Harness 需要补充的受控接口

现有 Harness 即使可以完成 Model–Tool 循环，也不等于可以被中央 Runtime 安全控制。候选标准接口包括：

- `start` / `resume` / `pause` / `cancel`；
- `checkpoint`；
- `heartbeat`；
- `observation`；
- `progress`；
- `safe_point`；
- `inject_guidance`；
- `request_context`；
- `report_evidence`；
- `report_blocked`；
- `report_outcome_unknown`。

其中 `safe_point` 是关键不变量。中央 Runtime 不能在 Child 正在写文件或执行外部副作用时任意插入新指令，必须等 Child 到达可证明安全的控制边界。

### 3.6 当前可靠性 Runtime 与中央 Runtime 的区别

当前 WAL、Lease、Fencing、Receipt 和 Snapshot CAS 主要解决：

> 一个执行实例发生竞争、崩溃、重试或迟到提交时，怎样尽量不破坏状态。

中央 Control Runtime 需要解决：

> 面对一个总目标和多个执行实例，下一步应该让谁做什么，什么时候等待、验证、替换、返工或宣布完成。

已有可靠性机制是中央 Runtime 的必要底座，但不会自然组合成中央大脑。中间还需要明确的控制协议：

```text
Central Control Runtime 发出 Command
    ↓
Worker Runtime 接受并持久化执行权
    ↓
Harness 执行并产生 Observation / Event
    ↓
Central Control Runtime 更新权威状态
    ↓
Scheduler / Supervisor / Verifier 作出下一步决策
    ↓
Completion Proof 判断能否完成
```

### 3.7 最高架构原则候选

中央 Runtime 不能把父模型的一段上下文当作全局权威状态。

推荐原则：

> 模型负责提出判断、计划和候选动作；确定性 Central Control Runtime 负责检查权限、状态转移、不变量、证据和最终提交。

例如父模型提出“Child A 已完成，可以结束总任务”时，确定性的 Completion Gate 仍必须检查：

- Task Contract 是否仍为当前版本；
- 每条验收条件是否绑定有效证据；
- 测试是否真实执行；
- Artifact digest 是否匹配；
- 是否存在未处理失败；
- 是否存在 `outcome_unknown`；
- Child Proof 聚合是否完整；
- 最终状态版本是否仍有效。

只有全部通过才能提交 `completed`；否则必须拒绝完成，生成缺失证据并继续调度。

### 3.8 当前架构裁决

God-Agent 的“中央大脑”不应等同于一个更大的 Prompt，也不应等同于普通父 Agent。更准确的定义是：

> 一个长期运行、事件驱动、拥有权威状态的中央控制系统；模型只是其决策器官之一，Harness 和 Worker Runtime 是它管理的执行器官。

### 3.9 待确认决策 ARCH-D01

是否接受以下内容作为 God-Agent 的最高执行不变量：

> 模型只能提出决策和候选动作；确定性 Central Control Runtime 才拥有权威状态变更、权限授予和最终完成裁决权。

当前状态：**待用户确认。**

---

## 4. 当前决策事项

| 编号 | 问题 | 推荐答案 | 状态 |
|---|---|---|---|
| RQ-D01 | 第一轮科研是否只研究可靠执行与故障恢复 | 是，先形成可证伪闭环 | 已确认 |
| ARCH-D01 | 模型是否只能提案，由确定性中央 Runtime 掌握最终状态权 | 是，作为最高不变量 | 待确认 |
| HANDOFF-D01 | 离职前是否先完成 Research Artifact v0.1，再扩展完整 E3 与统计 | 是，先完成最小科研可复制闭环 | 已确认 |

---

## 5. 2026-08-20：离职前优先形成最小科研可复制包

### 5.1 用户的新优先级

> 先不考虑“大脑”的问题，那个只是一个概念。当前需要继续深入思考，先把眼下已有成果尽快转化为科研可复制的东西；用户预计下周离职。

### 5.2 范围调整

从本条开始，Central Brain、Decision Kernel、Context Compiler、持续 Supervisor 和完整专家团全部降为远期概念，不作为离职前的交付目标，也不作为第一轮科研闭环的完成条件。

离职前的唯一主目标调整为：

> 形成一个最小科研可复制包，使没有参与开发的人能够获得固定版本，按照说明在干净环境运行实验，得到原始结果，核对结果哈希，并理解哪些结论成立、哪些结论尚未成立。

该目标不等于一周内完成正式论文，也不要求临时补齐整个 God-Agent。它优先保障研究资产不会因人员、设备、环境或上下文变化而丢失。

### 5.3 “科研可复制”的分级定义

| 等级 | 定义 | 当前判断 |
|---|---|---|
| R0：文字可读 | 有需求、方案和结果摘要 | 已达到 |
| R1：作者可重跑 | 原作者在当前机器可再次运行 | 基本达到，但原始结果归档不足 |
| R2：干净环境可复现 | 未参与者按文档在新环境得到可核对结果 | 尚未达到 |
| R3：实验可重复 | 固定样本、重复次数、统计方法和置信区间 | 尚未达到 |
| R4：外部独立复现 | 外部人员无口头指导完成复现并反馈 | 尚未达到 |

离职前推荐目标为 **R2 最小闭环**。如果时间允许，再补 R3 的重复实验和统计部分。不要直接把目标写成 R4 或“论文已完成”。

### 5.4 两种收口方案

#### 方案 A：最小可复制科研包，推荐

预计压缩为 3–5 个有效工作日，重点是冻结和移交现有证据：

1. 冻结研究问题和当前允许的最小结论；
2. 固定唯一代码基线；
3. 建立环境、依赖、命令和实验矩阵清单；
4. 重新产生并保存原始 JSON/CSV/日志；
5. 为所有 Artifact 建立 Manifest、SHA-256 和 Schema；
6. 在干净环境按 SOP 完成一次复现；
7. 记录复现失败、人工步骤、环境差异和修复过程；
8. 形成独立复现报告和离职交接说明。

该方案允许保留当前真实边界：Process Chaos 仍只有 Team Workflow Return 窄范围 1/40。只要实验范围、结果和限制可以被第三方重新执行和核对，它就是一个诚实的 Research Artifact v0.1。

#### 方案 B：同时补齐完整 E3 和统计闭环

预计至少需要 7–10 个高强度有效工作日，目标包括：

- GATE-40 剩余 39/40；
- Dynamic 双 App Server 全部 Commit Boundary；
- 多轮重复实验；
- 置信区间、效应量和异常样本分析；
- 完整消融和外部基线。

该方案科研价值更强，但离职前失败概率明显更高。一旦出现新的恢复缺陷，代码修复、重新验证和原始数据重跑会互相挤压，可能最终既没有完整 E3，也没有可移交的 Artifact。

#### 推荐裁决

先完成方案 A，使研究资产达到 R2；只有在 R2 已通过后，剩余时间才投入方案 B。不能为了追求更大的实验数字而牺牲固定基线、原始数据和复现说明。

### 5.5 最小科研可复制包的交付物

建议最终形成以下结构；具体文件名在实施前再确认：

```text
Research Artifact v0.1
├─ 研究范围与 Claim Boundary
├─ 固定代码版本与版本清单
├─ 环境和依赖清单
├─ 实验矩阵与用例编号
├─ 可执行复现入口
├─ 原始 JSON / CSV / Process Log
├─ Artifact Manifest + SHA-256
├─ 结果汇总与统计脚本说明
├─ Claims → Tests → Evidence 对照表
├─ 失败反例与 outcome_unknown 记录
├─ 干净环境复现报告
├─ 已知限制与禁止表述
└─ 离职交接与后续研究清单
```

其中最重要的不是增加文档数量，而是建立可追踪链路：

```text
研究主张
  → 假设
  → 机制
  → 实验用例
  → 原始数据
  → 汇总结果
  → 结论
  → 局限
```

任何结论如果不能沿该链路回到原始 Artifact，就不能进入最终科研结论。

### 5.6 离职前五日压缩计划

以下按五个有效工作日规划；如果实际剩余时间不同，需要重新压缩：

| 时间 | 唯一目标 | 验收结果 |
|---|---|---|
| 第 1 日 | 冻结范围、Claim、基线和实验清单 | 不再漂移的 Research v0.1 范围 |
| 第 2 日 | 重跑当前可证明实验并保存原始输出 | 原始数据、日志、环境信息齐全 |
| 第 3 日 | 建立 Manifest、哈希和 Claim–Evidence Matrix | 每个数字都能追溯到 Artifact |
| 第 4 日 | 在干净环境按文档独立复现 | 形成完整复现记录，记录所有失败和人工步骤 |
| 第 5 日 | 修正文档、冻结包并完成交接验收 | 新接手者无需依赖口头记忆即可继续 |

若只剩三日，则优先级依次为：固定基线、保存原始证据、干净环境复现。界面、美化、中央大脑设计和新增角色全部暂停。

### 5.7 当前四个最高风险

1. **基线风险**：PR #31 尚未合并；本地 integration worktree 与仓库可获取版本可能不一致；
2. **证据风险**：结果摘要存在，但 `research/*/results/` 缺少摘要所引用的原始 JSON/CSV/Repro；
3. **环境风险**：当前测试成功可能依赖本机状态，尚无干净环境第三方演练；
4. **交接风险**：如果离职后无法访问当前机器、工作区或相关账号，未归档材料可能永久丢失。

所有归档和转移必须遵守实际代码、数据和单位资产的授权边界，不应把凭据、Token、公司私有数据或机器配置写入科研包。

### 5.8 离职前完成门禁

Research Artifact v0.1 只有同时满足以下条件，才可称为“最小科研可复制闭环”：

- 唯一代码版本可被重新获得；
- 文档中的命令与实际命令一致；
- 原始结果文件真实存在且有哈希；
- 汇总数字可以从原始结果重新计算；
- 至少一次干净环境复现有完整记录；
- 失败和限制没有被删除；
- 未调用真实 Provider 的实验被明确标注；
- Team Workflow Return 仅表述为窄范围 E3 1/40；
- GATE-40 未完成被明确标注；
- 不宣称端到端 exactly-once、生产可用或外部普适性；
- 接手者可以仅凭仓库内说明启动下一轮工作。

### 5.9 当前建议

在剩余时间不确定的情况下，不应立即开始补中央 Runtime，也不应立刻追求全部 39 个 Process Chaos 窗口。第一步应先做只读资产冻结审计，明确：

- 最后可工作的准确日期；
- 离职后是否仍能访问 GitHub 仓库；
- 当前工作区是否会被回收；
- 哪一台干净机器可用于独立复现；
- PR #31 是否能在离职前完成验收；
- 哪些材料依法、依规可以归档到个人或公开仓库。

### 5.10 决策 HANDOFF-D01

是否采用以下优先级：

> 先在离职前完成 R2 最小科研可复制包；R2 验收通过后，再用剩余时间补 GATE-40、统计和更强科研结论。

当前状态：**已确认。** 用户已授权先完成 Research Artifact v0.1 的最小科研可复制闭环，再在冻结基线上迭代 GATE-40、统计与更强科研结论。

---

## 6. 持续变更日志

### 2026-08-20：建立持续架构问答日志

- 建立 D09 持续讨论文档；
- 记录“先科研闭环、后持续升级”的范围建议；
- 记录 Central Control Runtime、Worker Runtime 与 Agent Harness 的三层区分；
- 解释 D08 章节 8.3 的主要缺口归属；
- 登记 RQ-D01 与 ARCH-D01 两项待确认决策；
- 未修改代码，未授权进入实现。

### 2026-08-20：将离职前科研可复制设为最高优先级

- 将“中央大脑”降为远期概念，不纳入离职前目标；
- 定义 R0–R4 科研可复制等级；
- 推荐先完成 R2 最小可复制科研包；
- 比较 3–5 日最小收口方案与 7–10 日完整 E3 方案；
- 给出五日压缩计划、交付物、风险和完成门禁；
- 登记 HANDOFF-D01 待确认决策；
- 未修改代码，未授权执行 Git 或进入实现。

### 2026-08-20：确认 HANDOFF-D01 并授权 Research Artifact v0.1

- 用户确认先完成最小科研可复制闭环，再持续迭代升级；
- 用户授权拆分 RRA-01～RRA-06、多 Chat 并行、统一验收，并在门禁通过后由总控提交和更新 PR；
- Central Brain、完整 Supervisor 和完整 GATE-40 继续保持非目标；
- Git/Artifact 顺序采用两阶段：先冻结 baseline Commit，再以其 SHA 生成和复核 Artifact，最后提交 Artifact 并更新 PR；
- 外部第三方复现仍未完成，属于 R4/E4 后续目标，不作为本次 PR 前置。
