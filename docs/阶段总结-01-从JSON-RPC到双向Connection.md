# 阶段总结 01：从 JSON-RPC 到双向 Connection

> 项目：Agent Learn<br>
> 日期：2026-08-01<br>
> 当前阶段：`T01`、`T02` 已完成，下一步进入 `T03`<br>
> 学习目标：理解 Codex-like Client 与 App Server 怎样通过协议连接，而不是完整复刻 Codex。

## 1. 当前形成的整体认识

Agent 不是由某一个神秘框架直接生成的，而是把多个职责清晰的小组件组合起来：

```text
Client
→ Transport（stdio / WebSocket）
→ JSONL Framing
→ JSON-RPC Protocol
→ Connection
→ App Server Dispatcher
→ Runtime
→ Model / Tool
→ Approval / Sandbox
```

这些组件各自解决不同问题，不能混为一层。

## 2. 每一层分别负责什么

| 层 | 职责 | 当前项目中的对应实现 |
|---|---|---|
| Transport | 搬运字节或字符串 | 后续接入 `stdin/stdout` |
| JSONL | 用换行符划分消息边界 | `src/protocol/jsonl.ts` |
| JSON-RPC | 定义请求、通知和响应的消息语义 | `src/protocol/json-rpc.ts` |
| Request Map | 用 `id` 把 Response 关联回原 Request | `src/protocol/request-map.ts` |
| Connection | 组合编解码、关联、发送和消息分发 | `src/protocol/connection.ts` |
| Handler | 处理具体 method | 后续注册 `initialize` 等 Handler |
| Runtime | 维护状态并决定下一步动作 | `T03/T04` 实现 |
| Tool | 真正读文件、改代码或执行命令 | `T06/T07` 实现 |
| Approval | 获取用户是否同意 | `T07` 实现 |
| Sandbox | 技术上强制限制操作边界 | `T06/T07` 实现最小版本 |

一句话总结：

> stdio 负责运输，JSONL 负责切包，JSON-RPC 负责表达含义，Connection 负责组合与分发，Runtime、Handler 和 Tool 才负责真正干活。

## 3. stdin、stdout 和 stderr

每个进程都有三条标准数据流：

| 名称 | 含义 | 用途 |
|---|---|---|
| `stdin` | Standard Input | 接收输入 |
| `stdout` | Standard Output | 输出协议数据或正常结果 |
| `stderr` | Standard Error | 输出日志和错误信息 |

客户端启动 App Server 子进程后，两个方向的关系是：

```text
Client child.stdin  ─────→ App Server process.stdin
Client child.stdout ←───── App Server process.stdout
```

两个单向管道组合成双向通信。

协议启用后，App Server 不能随意使用 `console.log()`，因为它会写入 `stdout`，可能把调试文字混进 JSONL 协议。日志应该进入 `stderr`：

```ts
console.error("App Server started");
// 或
process.stderr.write("App Server started\n");
```

## 4. JSON-RPC 解决什么问题

JSON-RPC 定义消息属于哪一种语义：

```text
method + id     = Request，需要等待 Response
method、无 id   = Notification，不等待 Response
id + result     = Success Response
id + error      = Error Response
```

项目当前定义了四种消息外壳，并使用联合类型表示任意一条合法消息：

```ts
type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccessResponse
  | JsonRpcErrorResponse;
```

联合类型的意思不是继承，而是 `JsonRpcMessage` 可以是这四种类型中的任意一种。

类型守卫负责把外部的 `unknown` 数据判断为具体消息，非法结构会被拒绝。

## 5. JSONL 解决什么问题

JSON-RPC 没有规定连续消息怎样划分。JSONL 约定一行就是一条 JSON 消息：

```jsonl
{"id":1,"method":"initialize","params":{}}
{"method":"initialized","params":{}}
{"id":1,"result":{"ready":true}}
```

线上字符串实际包含换行符：

```text
第一条 JSON\n第二条 JSON\n第三条 JSON\n
```

真实数据流可能出现半条消息或一次到达多条消息，因此需要 Buffer：

```text
第一次：{"id":1,"meth
第二次：od":"initialize"}\n
```

`JsonlMessageBuffer` 会先缓存不完整部分，直到遇到 `\n` 才交给 JSON 解析和 JSON-RPC 类型守卫。

## 6. Request Map 为什么存在

发送 Request 后不能假设下一个 Response 就属于它，因为多个请求可能同时等待：

```text
发送 Request id=1 ─┐
发送 Request id=2 ─┼→ 等待中
发送 Request id=3 ─┘

收到 Response id=2
→ Request Map 找到 id=2 对应的 Promise
→ resolve(result) 或 reject(error)
```

Request Map 的本质是：

```ts
Map<JsonRpcId, PendingRequest>
```

它需要处理：

- 成功响应；
- 错误响应；
- 未知 ID；
- 重复 ID；
- 连接关闭时拒绝全部未完成请求。

## 7. Connection 怎样组合这些零件

`JsonRpcConnection` 不是新的底层协议，而是一层方便使用的封装：

```text
JsonRpcConnection
├─ JsonlMessageBuffer
├─ RequestMap
├─ JSON-RPC 类型守卫
├─ Request Handler Map
├─ Notification Handler Map
└─ write(data)
```

它向上提供容易理解的方法：

```ts
connection.sendRequest(...);
connection.sendNotification(...);
connection.onRequest(...);
connection.onNotification(...);
connection.receive(...);
```

发送链路：

```text
Runtime / Handler
→ connection.sendRequest()
→ 构造 JSON-RPC Request
→ JSON.stringify + "\n"
→ write(data)
→ stdio
```

接收链路：

```text
stdio 收到 chunk
→ connection.receive(chunk)
→ JSONL Buffer
→ JSON.parse
→ JSON-RPC 类型守卫
→ Response 进入 Request Map
  或 Request/Notification 进入 Handler
```

## 8. 双向能力到底来自哪里

JSON-RPC 本身不是通道，JSONL 也不是通道。双向能力来自：

1. 底层同时存在两个方向的管道；
2. Client 和 App Server 都能发送 Request、接收 Response；
3. 两端都拥有自己的 Connection 和 Request Map。

因此 App Server 可以反向请求客户端审批：

```json
{
  "id": "server-approval-1",
  "method": "approval/request",
  "params": {
    "tool": "run_command",
    "command": "npm test"
  }
}
```

客户端使用相同 `id` 返回决定，App Server 的 Request Map 就能唤醒原来等待审批的 Promise。

## 9. Approval 和 Sandbox 不是同一件事

```text
Policy   = 判断操作风险以及是否需要询问
Approval = 用户是否同意
Sandbox  = 系统技术上是否允许
```

完整安全链路应该是：

```text
模型请求 Tool
→ Tool Policy
→ 必要时反向 Approval Request
→ 用户 AllowOnce / Deny
→ Sandbox 再次检查技术边界
→ Executor 执行
→ Audit 记录
→ Tool Result 返回 Runtime
```

即使用户同意，Sandbox 仍然可以拒绝越过 Workspace 的操作。

第一版需要的是最小安全边界，而不是立即实现完整操作系统级隔离：

- 路径标准化并限制在 Workspace；
- 阻止 `../` 越界；
- 子进程固定工作目录；
- 命令超时和取消；
- 环境变量过滤；
- `AllowOnce` 只作用于当前调用；
- 所有 Tool 统一经过 Policy、Approval 和 Executor。

## 10. Agent 是否使用树形思维

Agent 的模块拆分和生命周期看起来像树：

```text
Agent
├─ Client
├─ Protocol
├─ App Server
├─ Runtime
├─ Model
├─ Tools
└─ Security
```

但运行核心不是一棵静态树，而是状态机和循环：

```text
用户输入
→ 模型决策
→ Tool Call
→ Tool 执行
→ Tool Result
→ 模型继续决策
→ 最终回答
```

当前理解可以概括为：

> 用树形思维拆解 Agent，用状态机和循环运行 Agent，用事件流连接模块，用 Map 关联并发请求。

## 11. 模型与 Agent 分别决定什么

```text
模型：理解需求、生成代码、选择下一步动作
Agent：提供循环、上下文、工具、权限和执行能力
```

最强的模型如果没有写文件工具，也只能在回复中输出代码；真正修改项目的是 `apply_patch`、`write_file`、`run_command` 等 Tool。

第一版若要成为能写代码的迷你 Codex，至少需要：

```text
list_files
read_file
apply_patch
run_command
```

并让写入和命令统一经过 Workspace 边界、审批和最小 Sandbox。

## 12. Skill 怎样选择、协同和处理冲突

Skill 不是一个自动运行的 Agent，而是一份可复用的任务手册。默认机制不是让所有 Skill 分别生成结果，再比较谁做得更好，而是先路由、再加载：

```text
用户需求
→ 模型查看 Skill Catalog（name + description）
→ 选择最契合的一个或多个 Skill
→ 加载所选 Skill 的完整 SKILL.md
→ 把 Skill 指令注入当前 Turn
→ 模型按照手册规划并调用 Tool
→ 返回最终结果
```

### 12.1 单个 Skill 路由

当某个 Skill 与任务明确匹配时，模型通常只加载该 Skill：

```text
“分析这个 Excel”
→ spreadsheet Skill
```

这是相关性路由，不是把所有 Skill 都执行一遍进行质量竞赛。

### 12.2 多个 Skill 协同

职责互补时，可以同时加载多个 Skill，并按照依赖顺序协同：

```text
“分析销售数据，并制作汇报 PPT”
→ spreadsheet Skill：分析数据并生成表格
→ presentation Skill：使用分析结果生成演示文稿
```

多个 Skill 同时进入一个 Turn，并不等于自动启动多个并行 Agent。默认仍由同一个模型统一规划顺序。

### 12.3 Skill 什么时候会打架

Skill 的作用范围重叠或指令互相矛盾时可能发生冲突，例如：

```text
Skill A：代码必须采用函数式写法
Skill B：代码必须采用面向对象写法
```

又例如用户只说“生成报告”，但 PDF Skill 和 Word Skill 都认为自己适用，而输出格式没有被明确。

冲突处理建议：

```text
系统与安全规则
> 开发者规则
> 用户明确要求
> 用户明确点名的 Skill
> 模型隐式选择的 Skill
> Skill 内的一般建议
```

两个 Skill 仍无法同时满足时，应选择作用范围更具体的 Skill，或者向用户确认，不能把矛盾指令随意混合。

### 12.4 显式选择和隐式选择

```text
隐式选择：模型根据 name + description 判断是否适用
显式选择：用户直接点名一个或多个 Skill
```

用户明确点名时，应优先尊重显式选择；点名多个 Skill 时，需要全部考虑，并明确它们的执行顺序和冲突处理。

### 12.5 “让多个 Skill 比赛”属于什么

下面这种模式不是默认 Skill 机制：

```text
Skill A 生成方案 A
Skill B 生成方案 B
Judge 比较并选择更好的方案
```

它属于多 Agent 候选生成与评审，需要额外的 Orchestrator、独立上下文、多次模型调用和 Judge，而不是普通 Skill Loader。

当前项目后续实现 Skill 时，推荐先完成：

1. 扫描 Skill 元数据并建立 Catalog；
2. 根据用户需求选择相关 Skill；
3. 加载完整 `SKILL.md`；
4. 检查多个 Skill 的作用范围和冲突；
5. 注入当前 Turn Context；
6. 由同一个 Runtime 规划 Tool 调用。

本阶段的理解可以概括为：

> Skill 默认由模型根据任务进行路由；互补 Skill 可以协同，冲突 Skill 需要优先级或用户确认；默认不存在“全部执行后比谁更好”的竞赛。

## 13. 当前进度

已经理解、实现并验证到：

- JSON-RPC 四种消息类型；
- 联合类型与类型守卫；
- 协议单元测试；
- JSONL 编解码；
- 数据流分块 Buffer；
- Request Map；
- `JsonRpcConnection` 双向封装；
- Client 请求 App Server；
- App Server 反向请求 Client 审批；
- 真实 `stdin/stdout` 跨进程通信；
- `initialize` / `initialized` 应用层握手；
- 模拟金融流水与确定性月度汇总；
- `finance/monthly-summary` 跨进程业务请求；
- CLI 财务摘要展示。

当前验证结果：

```text
npm test      → 29 个测试全部通过
npm run check → TypeScript 类型检查通过
npm run dev   → 真实握手与金融月度汇总通过
```

`T02` 和最小金融 Walking Skeleton 已经完成。当前项目仍不是完整 Agent，但 Client 与 App Server 之间可靠、可测试、可替换传输层的协议地基已经建立，并且已经承载了一条真实业务链路。

金融 MVP 当前链路：

```text
CLI
→ finance/monthly-summary Request
→ JSONL + stdio
→ App Server
→ 确定性 Finance Summary
→ JSON-RPC Response
→ CLI 展示收入、支出、净现金流和分类支出
```

金额由确定性 TypeScript 代码计算。未来的模型只能选择 Tool 和解释结果，不能成为账本金额的事实来源。

## 14. 下一阶段

自动实现到这里停止。接下来由学习者手写 `T03` Runtime 接入，按照单线顺序继续：

1. 定义 Thread / Turn / Item 最小类型；
2. 建立内存生命周期 Store；
3. 注册 `thread/start` 和 `turn/start` Handler；
4. 规定只有完成 `initialize` 后才能创建 Thread；
5. 输出并测试生命周期 Trace；
6. 为 `T04` 的 Fake Model 与 Agent Loop 准备状态容器。

建议从以下入口开始：

```text
src/runtime/lifecycle.ts
src/runtime/lifecycle-store.ts
```

第一步把 `LifecycleStore` 注入 App Server，然后新增 `thread/start` Handler。金融业务可以作为 Thread 中的真实用例继续使用。

本阶段的完成标准：

```text
initialize 前拒绝创建 Thread
initialize 后可以创建 Thread
Thread 下可以创建 Turn
Turn 下可以追加 Item
非法父子关系必须被拒绝
生命周期变化能够形成确定性 Trace
```

## 15. 阶段结论

目前最重要的收获不是记住某个框架 API，而是理解 Coding Agent 的通信地基怎样一层层组合：

```text
操作系统提供通道
→ JSONL 提供消息边界
→ JSON-RPC 提供消息语义
→ Request Map 提供异步关联
→ Connection 提供双向封装
→ App Server 提供业务入口
→ Runtime、Model 和 Tool 组成 Agent 执行循环
→ Approval 与 Sandbox 为执行建立安全边界
```

这套分层使未来可以把 stdio 替换成 WebSocket，把 TypeScript Runtime 替换成 Rust Runtime，同时尽量保持上层协议和业务语义不变。
