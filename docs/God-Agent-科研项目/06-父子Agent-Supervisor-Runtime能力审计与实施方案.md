# God-Agent 父子 Agent / Supervisor Runtime 能力审计与实施方案

> 文档编号：D06
> 状态：Discussion Draft / 未批准实施
> 审计日期：2026-08-19
> 审计对象：`<integration-worktree>` 当前工作区内容
> 用户提供的集成分支：`god-runtime-phase1-integration_hln`
> 用户提供的待验收对象：PR #31，基线 `origin/main@dfc11ce9b20da3b087ec9a86daa9c78746423555`
> 操作边界：本轮只读排查、运行既有离线测试并新增本文档；未修改代码，未操作 Git/PR，未调用真实 Provider

## 0. 执行摘要

当前 God-Agent **可以在受控条件下演示**以下闭环：父 Agent 在一次模型响应中提出多个 `run_agent` 调用，Runtime 并行运行多个叶子 Agent，每个叶子使用独立内部 Thread/Turn，完成后经过 Reviewer、Return Outbox/Receipt，再唤醒父 Agent形成一次最终回答。

当前 God-Agent **还不能做到目标形态**：父 Agent先持久化完整任务图，异步派发多个叶子 Agent，在它们运行期间持续接收增量事件，识别阻塞并追加指导或替换执行者，对代码/测试等真实证据做独立审查，崩溃后恢复监督循环，最后依据总任务验收合同作唯一裁决。

因此当前最准确的裁决是：

> God-Agent 已具有“同步批量父子协作 + 持久 Return + 部分恢复”的工程原型，不是“持续主动监督的专家团 Runtime”。

这不是推翻已有工作。现有 Job、Task、Run、Evidence、Return、WAL、Lease 和 Snapshot 是后续建设的底座；需要替换的是“父 Tool 调用栈同步等待所有 Child”的控制方式，并补齐 Supervisor、Capability 和证据裁决语义。

## 1. 本次审计所采用的目标语义

本文件将第一版目标限定为**一层父子结构**：

```text
用户总目标
  -> Parent Agent / Supervisor
     -> Leaf Agent A
     -> Leaf Agent B
     -> Leaf Agent C
     -> 可选独立 Reviewer / Arbiter
  -> Parent 形成唯一最终结果
```

叶子 Agent 不再创建业务孙 Agent。Reviewer 可以作为 Runtime 管理的验证节点存在，但不拥有总目标最终裁决权。

“同时分配”严格解释为：

1. 父 Agent先形成可验证的 Task 合同和依赖关系；
2. Runtime 对无依赖、权限允许且资源不冲突的 Task 并行派发；
3. 有依赖或写冲突的 Task进入等待队列；
4. 任一 Task完成就触发验证和后续 ready 计算，不要求整批统一结束；
5. 父 Agent在关键事件或截止条件触发时重新决策，而不是持续空转调用模型。

## 2. 证据范围与等级

### 2.1 本轮实际检查

- 阅读了 Dynamic Engine、AgentLoop、`run_agent`、MultiAgentScheduler、AgentRuntimeStore、Return Coordinator、固定 Team Workflow、权限、Workspace、MCP 与 App Server 生产组装入口。
- 核对了父子 Agent、DAG、Review、Return、恢复、取消、能力交集和 Process Chaos 的既有测试。
- 复跑父子/Dynamic/稳定性/协调状态专项：64/64 通过。
- 复跑 Runtime-E2E：9/9 通过，其中包含当前真 App Server 强杀/重启窄范围用例。
- 未调用真实 Provider；模型行为验证使用确定性 Scripted/Fake Provider。

### 2.2 证据边界

- 64/64 主要证明组件和既定集成条件，等级最高为 E2。
- Runtime-E2E 9/9 不得解释为 GATE-40 已完成。
- 当前仍只能说“Team Workflow Return 的窄范围 E3 Process Check 已通过”，即既有记录中的 1/40。
- Dynamic 双 App Server 全边界 Process Chaos 尚未完成。
- 本地 Snapshot CAS、Return Receipt 和 Invocation WAL 不能推出端到端 exactly-once。
- 本文没有通过 Git 命令核验分支、commit 或工作树状态，分支/PR/基线信息来自用户陈述。

### 2.3 文档元数据漂移

D00–D05 的页头仍记录 `main@928fe38...`，而本轮用户给出的基线是 `origin/main@dfc11ce...`，并且当前对象是 PR #31。该差异属于文档事实源漂移，不能静默选择其中之一。

在方案确认后，应统一核验并更新 D00–D05 的事实基线；本轮不修改这些核心文档，以免把尚未达成共识的设计写成 Accepted 需求。

## 3. 当前真实执行链

### 3.1 Dynamic 父子链

```text
Parent Turn / AgentLoop
  -> Parent Model 一次返回一个或多个 run_agent Function Call
  -> 若本轮所有调用都是 run_agent，则 Promise.all 并行执行
  -> MultiAgentScheduler
     -> 为每个 Worker 建立独立内部 Thread/Turn
     -> 等待依赖与内存并发槽位
     -> 同步 await Worker execute()
     -> 记录 Worker summary Evidence
     -> Reviewer 读取任务、验收条件和 Worker summary
     -> 创建 Return(ready)
  -> 当前这一批全部返回后，父 continuation 执行
  -> Return consumed + Receipt
  -> Parent 输出一次最终文本
```

这条链能够真实并行 Worker，但父 Agent在等待这一批 `Promise.all` 时没有运行自己的监督循环。

### 3.2 固定 Team Workflow 链

当前 `software_product_delivery_v2` 是固定阶段链：

```text
Product -> Engineering -> Quality -> Lead -> Return God
```

它具有版本化 Stage、Checkpoint、Return 和恢复逻辑，但不是父 Agent动态拆分并行叶子任务的通用专家团，也不是可配置 fan-out/fan-in 模板。

## 4. 能力矩阵

| 目标能力 | 当前裁决 | 当前证据 | 关键限制 |
|---|---|---|---|
| 父 Agent接收总目标 | 可以 | 生产入口和 E2 测试 | 总目标验收合同尚未成为独立 Finalization Gate |
| 父模型自主提出子任务 | 部分可以 | Prompt + `run_agent` | 依赖模型临场输出，没有版本化 Plan/Graph 合同与计划校验 |
| 一轮同时分配多个叶子 Agent | 可以/E2 | AgentLoop 对全 `run_agent` 调用使用 `Promise.all`；专项通过 | 必须由模型在同一响应中一次性发出；不是异步 spawn |
| 叶子 Agent独立 Thread/Turn | 可以/E2 | 每个 Worker 建立内部 Thread/Turn；返工复用原 Task Thread | 进程、文件系统、MCP 连接和 Workspace 并未完全隔离 |
| 叶子 Agent不再递归委派 | 生产路径可以 | Child allowlist 显式排除 `run_agent` | 组件 Scheduler仍支持深度模型；产品与组件语义需统一 |
| DAG、环检测和 hard dependency | 部分可以/E2 | AgentRuntimeStore、Scheduler 测试通过 | 没有“先提交完整图再派发”的事务；依赖 Task ID 通常要前序执行后才得到 |
| Job/全局并发限制 | 部分可以/E2 | `maxConcurrent`、全局活动数和 Job 轮转测试 | queue/active/fairness 状态主要在内存；无 CPU、进程、Provider 并发隔离 |
| 文件冲突调度 | 仅提示性/E2 | `fileClaims` 影响 ready 判定 | Tool 不校验实际访问路径是否属于 claim；声明可以为空或不真实 |
| Return 不丢不重复消费 | 较强的本地 E2 | Outbox、claim/consume、Receipt、恢复测试 | 不代表父模型调用和外部副作用端到端 exactly-once |
| 父 Agent形成一次最终回答 | 部分可以/E2 | 完整 Scripted AgentLoop 闭环通过 | “只输出一次”不等于“满足总目标”；缺总验收条件逐项证据映射 |
| 父 Agent持续监听进度 | 不可以 | 没有 Parent 可消费的增量 Supervisor Event Loop | UI 能查询状态，但父 Agent等待期间不运行 |
| 对运行中的叶子主动追加指导 | 不可以 | 无 task-level steer/send-input 控制接口 | 当前只能等 Return 后重试/返工，或取消整棵子树 |
| 自动识别停滞并替换 Agent | 不可以 | 有 lease 字段和 lost 分类 | 没有周期 heartbeat 续租、watchdog、replacement policy |
| 重启后恢复 Scheduler | 不可以/已知缺口 | `recoverJob()` 会丢弃内存等待队列 | D01 的 FR-DYN-006 已标 Proposed |
| 独立 Reviewer | 形式上可以/E2 | Reviewer 使用独立 Run/Thread，支持一次有界返工 | Reviewer 主要读取 Worker summary，默认无工具，不能独立检查代码、diff、测试或来源 |
| Evidence Gate | 部分可以 | Evidence/Review 类型和终态检查存在 | Worker summary 的 `supported` 即可覆盖笼统 acceptance；未逐条绑定 Required Output/Criteria |
| 多专家冲突裁决 | 不可以 | 暂无通用 Arbitration/Quorum 协议 | 固定 Reviewer 不是多候选证伪和最终仲裁 |
| Tool/Skill 权限取交集 | 可以/E2 | Profile 与 Job allowlist 交集、Child 禁止 `run_agent` | 主要是名称 allowlist，不是带资源范围和配额的 Capability Grant |
| MCP 隔离 | 不可以达到目标 | MCP Tool统一注册、调用和取消已有 | Manager/Server 进程全局共享；无 Job namespace、并发/费用配额和故障域合同 |
| Job/Task 资源预算 | 不可以达到目标 | 有 maxSubagents、maxConcurrent、单 Turn Tool Round | 无累计 Token、Tool 次数、输出字节、费用、CPU/内存/进程预算账本 |
| 真实工作区隔离 | 不可以达到目标 | WorkspaceSandbox 防路径逃逸 | 多叶子默认操作同一 Workspace；无每 Task worktree/overlay；file claim 不构成安全边界 |
| 主动监督的真实进程恢复 | 不可以 | 当前只有 Team Return 窄范围 1/40 | Dynamic 并行 + Supervisor + guidance/replacement 的 Process Chaos 尚不存在 |

## 5. 为什么当前实现不是持续 Supervisor

### 5.1 同步 Tool 调用栈是核心限制

`run_agent` 直到子 Agent完成才返回；同轮多个子 Agent虽然并行，但父 Agent仍被 `Promise.all` 阻塞。它只能在整批 Return 都可用后再次调用模型。

直接结果：

- 先完成的子任务不能立即触发父级语义决策；
- 父 Agent看不到运行中进度事件；
- 不能针对单个 Child 发送补充输入；
- 一个慢 Child 会形成批次 barrier；
- 父调用栈崩溃时，任务调度和 Parent continuation 恢复耦合复杂。

### 5.2 Task Graph 是执行中逐步形成，不是先验计划合同

当前父模型直接调用 `run_agent`，Runtime 在调用时创建 Task。虽然 Store 可以保存边并拒绝环，但不存在独立的：

```text
propose graph -> validate graph -> commit graph version -> dispatch ready tasks
```

因此目前不能证明父 Agent先对总任务完成了可审计拆分，也不能在开始副作用前统一检查范围、依赖、预算、角色和验收条件。

### 5.3 父 Agent不是运行时事实的权威

Parent Prompt 中写了“你是监工”只能约束模型行为，不能代替确定性机制。状态、租约、权限、预算、取消、重试上限和终态必须由 Runtime Kernel执行；父模型只能在受限 Action Schema 中选择策略。

### 5.4 当前 Review 独立性不足

Reviewer 是独立模型 Run，但默认收到的是任务、验收条件和 Worker 的文字结论，而且被禁止使用工具。它无法独立读取实际产物。

因此应区分：

- **Context independence**：Reviewer 不共享 Worker 隐藏上下文；当前部分具备。
- **Evidence independence**：Reviewer 能自行读取受控 artifact/test/source；当前不具备。
- **Decision independence**：Reviewer 的 pass/fail 不被 Worker 文案诱导；当前没有充分证明。

### 5.5 Capability 目前是名称过滤，不是资源授权对象

`allowedTools`/`allowedSkills` 能阻止未授权名称，但不能表达：

- 只能读取哪些路径；
- 只能写哪个 Task worktree；
- 某 MCP Tool 允许哪些参数和远端 namespace；
- 最多调用多少次、并发多少、输出多少字节；
- 授权何时过期、能否委派、由谁批准。

`permissionMode` 当前也没有形成完整的独立执行语义；`accessMode` 主要决定是否自动批准，而不是细粒度 capability。

## 6. 两种演进方案

### 方案 A：在同步 `run_agent` 上增加轮询和控制接口

做法：保留同步 Tool 模型，增加 `get_child_status`、`send_child_input`、超时和分批等待；父 Agent通过多轮 Tool Call轮询。

优点：

- 改动较小；
- 能较快做出“父 Agent看状态并追加消息”的 Demo；
- 可复用现有 AgentLoop 和 Return Coordinator。

缺点：

- 父 Agent仍依附一次 Turn/Tool 调用栈；
- 轮询浪费模型和 Tool 预算；
- 重启恢复、早完成早验收和事件顺序仍不自然；
- 很难严格区分“父 Agent决策失败”和“Worker 执行失败”；
- 容易把 UI 状态查询包装成持续监督。

裁决：只适合短期 Demo，不推荐作为最终 Runtime。

### 方案 B：持久 Task Graph + 事件驱动 Supervisor（推荐）

做法：把“创建 Task”“派发 Run”“等待 Return”“父级决策”拆成独立持久阶段。`spawn` 立即返回 Task/Run handle，父 Agent进入持久 `WAITING_EVENTS`，不占用同步 Tool 调用栈。事件或 deadline 唤醒 Supervisor Decision。

优点：

- 天然支持先完成先验收、fan-out/fan-in 和无全局 barrier；
- 父进程重启后可从 Job/Task/Event/Return 事实恢复；
- 可把确定性调度与 LLM 决策严格分层；
- 更适合作为科研对象，可对 Supervisor、恢复和证据门禁做消融。

缺点：

- 需要调整当前控制流，不能只加几个 Tool；
- 必须重新定义状态机、事件幂等和唤醒语义；
- 需要迁移/兼容现有同步 `run_agent`。

裁决：选择方案 B；保留 `run_agent` 作为兼容 facade，但内部转换成 `create task -> enqueue -> await durable join`，不再让它拥有调度事实。

## 7. 推荐的目标架构

```text
Control Plane
  Requirement / Goal Contract
  Task Graph Planner + Validator
  Supervisor State Machine
  Scheduler / Deadline / Recovery Policy
  Finalization Gate

Execution Plane
  Worker Run Executor
  Reviewer / Arbiter Executor
  Model Invocation + Tool Invocation WAL
  Terminal / Process Runtime

Capability Plane
  Tool / Skill / MCP Registry
  CapabilityGrant + Namespace + Quota Ledger
  Workspace / Worktree Isolation
  Permission and Credential Broker

Persistence Plane
  Job / Task / Run / Invocation / Return
  Append-only Event / Outbox / Receipt
  Lease / Fencing / Snapshot or Job Partition
  Evidence / Artifact Metadata / Audit
```

共享的是 Registry、执行器实现和持久化机制；隔离的是每个 Job/Task/Run 的实例状态、取消域、Capability Grant、配额账本、工作区 namespace、MCP 调用上下文和事件路由。

## 8. Supervisor Loop 合同

Supervisor 不应无限循环调用模型。推荐采用**事件驱动、确定性触发、LLM 策略决策**：

```text
读取 Goal + 当前 Graph + 新事件 + 剩余预算
  -> Runtime 先做确定性归约
     - 更新 Task/Run/Return 事实
     - 计算 ready/blocked/lost/deadline/quota
  -> 仅在需要语义判断时唤醒 Parent Model
  -> Parent 只能返回结构化 SupervisorAction
  -> Runtime 校验权限、不变量和预算
  -> 提交 Action + 新状态
  -> 派发/等待/请求用户/终止
```

建议的 `SupervisorAction`：

| Action | 含义 | Runtime 必须检查 |
|---|---|---|
| `WAIT` | 等待指定事件或 deadline | 不允许无期限等待；必须有 wake condition |
| `GUIDE_TASK` | 给某 Task追加版本化指导 | 只能在消息边界生效；不可篡改已发出的模型请求 |
| `RETRY_TASK` | 同 Task 新建 attempt | attempt、预算、幂等和副作用结果必须允许 |
| `REPLACE_AGENT` | 同 Task换 Profile/Model 新建 Run | 不改变 Task 合同；旧 Run进入明确终态 |
| `REPLAN_GRAPH` | 新建 Graph revision | 已发生副作用和已验收 Evidence 不得被静默删除 |
| `REQUEST_USER` | 需要产品选择、权限或未知副作用处置 | 阻塞原因、可选项和影响必须结构化 |
| `REQUEST_REVIEW` | 创建 Reviewer/Arbiter Task | 必须满足独立性与 capability 约束 |
| `ACCEPT_TASK` | 接受 Task Return | acceptance criteria 必须逐项有 Evidence |
| `REJECT_TASK` | 拒绝并返工/失败 | 记录反例、责任来源和下一动作 |
| `FINALIZE_JOB` | 形成最终结果 | Finalization Gate 全部通过，或明确 partial/failed |

必须有反循环保护：最大 Supervisor decisions、最大 graph revisions、每 Task attempts、最大无进展次数、Job deadline 和总预算。

## 9. Capability / Namespace / Quota 模型

建议将当前名称 allowlist 升级为版本化 `CapabilityGrant`：

```text
CapabilityGrant
  subject: job/task/run
  capability: tool/skill/mcp/terminal/filesystem/model
  actions: read/write/execute/call/delegate
  resource selectors: paths, command recipes, MCP server/tool/tenant
  namespace: workspace/worktree/process/session
  risk class: read/execute/sensitive/irreversible
  quota: calls/concurrency/tokens/bytes/wall-time/cost/processes
  expiry: deadline/generation
  delegation: non-delegable or strictly narrower
  provenance: user/profile/template/job-policy
```

有效权限使用“多层交集”，任何子层只能收紧：

```text
User Grant ∩ Product Policy ∩ Job Snapshot ∩ Role Pack ∩ Task Scope ∩ Tool Contract
```

### 9.1 文件系统推荐

对会写代码的叶子 Task，推荐：

- 共享只读基线；
- 每个写 Task使用独立 worktree/overlay；
- Parent/Integrator 在专用集成空间审查和合并产物；
- `fileClaims` 只作为调度优化，真正安全边界由 Tool/Sandbox 根据 Task Capability校验。

如果 MVP 暂时只使用一个 Workspace，就必须明确降级：只允许一个写 Task并发，其他 Task只读。不能把 `fileClaims` 当成强隔离。

### 9.2 MCP 推荐

- Registry 和 server definition 可以共享；
- 每次调用必须带 Job/Task/Run/Invocation identity；
- 授权、取消、deadline、输出预算和结果路由按 Invocation 隔离；
- 不支持请求级隔离/取消的 MCP Server 使用每 Job 进程或禁止并发共享；
- Server 崩溃不得将其他 Job 的调用标成成功或消费错误 Return。

## 10. 分阶段实施计划

以下阶段在用户明确说“确认方案，可以实现”之前均为 Proposed。

### S0：冻结语义和 ADR（只改设计文档）

目标：先定义对象、状态机、不变量和非目标，不写运行时代码。

交付：

- 一层 Parent -> Leaf 的 MVP 边界；
- Goal/Job/Task/Run/Invocation/Return/Event 的严格定义；
- Supervisor 与 Scheduler 的责任分界；
- Graph revision、取消树、deadline、重试和未知副作用语义；
- 同步 `run_agent` 的兼容迁移方案。

退出门禁：所有非法状态转换、崩溃窗口和权限边界能写成可测试不变量。

### S1：持久 Task Graph 与异步派发

目标：把 Task 创建与 Worker 执行解耦，去掉父 Tool 调用栈对 Child 生命周期的所有权。

核心切片：

1. `TaskGraphProposal` 与一次性校验/提交；
2. 持久 ready queue facts，不保存不可恢复的 Promise；
3. Scheduler 从事实重建可运行集合；
4. `spawn` 返回 handle，Parent进入 `waiting_events`；
5. 任一 Return 到达即可触发对应 join/review，不等待整批。

退出门禁：三 Task 场景中 A/B 并行、C 等待 A+B；在 Parent 等待和任一 Worker 运行时分别 kill/restart，不能重复创建 Task 或丢 Return。

### S2：事件驱动 Supervisor Loop

目标：让父 Agent真正承担监控、引导、恢复协调和重新规划，但不成为状态事实源。

核心切片：

1. 版本化 Runtime Event；
2. deterministic wake rules；
3. 结构化 `SupervisorAction`；
4. task-level guide/cancel/retry/replace；
5. stall detector、deadline 与 bounded no-progress policy；
6. Supervisor decision WAL 和幂等提交。

退出门禁：Child blocked、silent、timeout、permission denied、provider error 五种场景下，Parent 分别给出正确的等待/指导/替换/询问用户/终止动作，且不影响其他 Child。

### S3：证据审查与最终裁决

目标：从“审查摘要”升级为“审查可定位证据”。

核心切片：

1. Acceptance Criterion 与 Evidence ID 多对多映射；
2. Artifact digest、test result、source citation 和 uncertainty 字段；
3. Reviewer 获得最小只读 capability，可独立读取产物；
4. Reviewer 与 Worker 上下文隔离；
5. 多候选冲突时创建 Arbiter；
6. Finalization Gate 拒绝无证据完成和虚假 pass。

退出门禁：Worker 只声称“测试通过”但没有 test Evidence 时，Reviewer 和 Job 都不得完成；伪造或过期 Artifact digest 必须拒绝。

### S4：Capability、Workspace 与 Quota 隔离

目标：一个 Child/Job 的越权、超额或崩溃只影响自己的故障域。

核心切片：

1. CapabilityGrant 和 Quota Ledger；
2. Task scope 强制进入 Tool/MCP/Terminal 执行上下文；
3. 写 Task worktree/overlay 或单写者降级策略；
4. MCP request/session 隔离；
5. Token、Tool、输出、墙钟、费用、进程配额；
6. 分层取消与资源最终释放。

退出门禁：Job A 耗尽 Tool/MCP/Token 额度或 MCP 崩溃时，Job B 继续；越界写在副作用前拒绝。

### S5：恢复与科研门禁

目标：证明上述新 Supervisor 链在真实进程故障下仍满足不变量。

核心切片：

1. 补 Dynamic 双 App Server 全边界 E3；
2. 为 Graph commit、dispatch、progress、guide、replace、review、finalize 增加 kill windows；
3. full 与 no-supervisor/no-evidence-gate/no-durable-queue 消融；
4. 记录任务成功、恢复正确性、重复副作用、人工介入、成本和延迟；
5. 保留失败、反例和不支持假设的结果。

退出门禁：先完成预注册的小型 GATE，再决定是否扩展；不得沿用“测试多所以可靠”的推理。

## 11. MVP 范围控制

为避免项目变成大杂烩，推荐 MVP 只承诺：

- 本地单机；
- 一层 Parent -> 最多 4 个并发 Leaf；
- 软件分析/代码任务；
- 一个 Job 一个明确 Workspace；写任务采用 worktree 或单写者；
- 事件驱动 Supervisor 的 wait/guide/retry/replace/review/finalize；
- 确定性 Fake Provider 的可重复 E2，加少量真进程 E3；
- 不支持递归专家树、云端多租户、跨机器调度、任意插件市场和生产 SLA。

固定 Team Workflow 暂时保持独立，不在 S1/S2 中同时重写。待 Dynamic Supervisor 语义稳定后，再决定是否让 Team Template 复用同一 Graph Kernel。

## 12. 建议新增的验收用例

| ID | 场景 | 必须结果 |
|---|---|---|
| TC-SUP-001 | Parent 提交 A/B -> C 的 Graph | A/B 并行，C 只在两者通过后执行 |
| TC-SUP-002 | A 先完成、B 长时运行 | A 立即审查并可解锁仅依赖 A 的节点，无全局 barrier |
| TC-SUP-003 | Parent 在 waiting_events 时进程退出 | 重启从持久事实恢复，不重复 spawn |
| TC-SUP-004 | Child heartbeat 中断 | 标记 lost；按策略替换，不把未知副作用当普通失败重跑 |
| TC-SUP-005 | Parent 对运行中 Child 追加指导 | 指导只在安全消息边界生效，版本和 receipt 唯一 |
| TC-SUP-006 | Child 拒绝权限 | 只阻塞该 Task；Parent 自动降级、换方案或请求用户 |
| TC-SUP-007 | Worker summary 声称测试通过但无证据 | Reviewer/Finalization Gate 拒绝完成 |
| TC-SUP-008 | 两个专家结论冲突 | 保留双方 Evidence，触发 Arbiter，不做简单多数文本投票 |
| TC-SUP-009 | Task 越过 allowedPaths 写文件 | Tool 执行前拒绝；其他 Task继续 |
| TC-SUP-010 | Job A 耗尽配额 | A 停止新 Invocation，B 不受影响 |
| TC-SUP-011 | 取消一个 Child | 不误取消兄弟；父可重派或收敛为 partial |
| TC-SUP-012 | Parent finalize 与迟到 Return 竞争 | 形成唯一终态；迟到结果仅审计，不复活 Job |

## 13. 对四份持续核心文档的后续更新建议

方案确认后再同步，不能只更新本文：

- D01：把“持续 Supervisor”“一层 Leaf MVP”“CapabilityGrant”“Finalization Gate”写成需求与非目标，并下调目前被过度概括的 DAG/Review 状态。
- D02：将 S0–S5 纳入实施顺序；异步 Graph/Supervisor 应先于通用 Role Pack 扩张。
- D03：加入 TC-SUP-001～012、真实进程窗口、证据独立性和 capability 越界门禁。
- D04：记录本次审计的负结果：同步 `Promise.all` 不等于持续监督；摘要 Reviewer 不等于独立证据审查；`fileClaims` 不等于文件系统隔离。

D00 和 D05 也应在事实基线和研究问题变化时同步，但本轮不提前修改。

## 14. 本轮最终裁决

1. 当前 God-Agent **能做到**“父模型一次拆出多个子任务并并行运行多个叶子 Agent”的确定性测试闭环。
2. 当前 God-Agent **不能做到**“父 Agent在多个叶子运行期间持续监督、主动指导、自动替换、基于真实证据裁决并在崩溃后恢复监督循环”。
3. 不应继续在同步 `run_agent` 上堆角色数量；应先完成持久 Task Graph、事件驱动 Supervisor、证据 Gate 和 Capability 隔离。
4. 推荐第一版只做一层 Parent -> Leaf。递归子孙 Agent、通用专家市场和生产分布式调度不是当前 MVP。
5. 在用户明确确认方案前，本文所有实施阶段保持 Proposed，不进入代码施工。
