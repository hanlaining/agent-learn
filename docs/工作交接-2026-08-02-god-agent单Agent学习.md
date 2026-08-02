# god-agent 单 Agent Runtime 学习交接

> 交接日期：2026-08-02<br>
> 项目目录：`D:\练手\agent-learn`<br>
> 当前阶段：单 Agent 主链路已经跑通，下一步实现跨 Turn Context Builder<br>
> 当前 CLI：`god-agent` 调试型学习 CLI<br>
> 测试基线：TypeScript 检查通过，自动化测试 45/45

## 一、学习目标

从零手写一个 Codex-like 单 Agent Runtime，重点理解底层架构，不使用 LangChain 隐藏核心流程。

当前学习顺序：

```text
Protocol
→ Connection
→ App Server
→ Runtime Lifecycle
→ Agent Loop
→ LLM
→ Tool Calling
→ Event System
→ 多轮 Context
→ Compaction
→ Tool Registry
→ Permission
→ Sandbox
→ Persistence
→ CLI 产品化
→ Electron
```

当前明确不做 Multi-Agent，先把单 Agent 玩透。

## 二、当前已经完成

### 1. JSON-RPC

已完成：

- Request
- Notification
- Success Response
- Error Response
- 联合类型
- 类型守卫
- 非法消息拒绝

核心文件：

```text
src/protocol/json-rpc.ts
tests/json-rpc-test.ts
```

### 2. JSONL

已完成：

- 一行一条 JSON-RPC 消息
- 换行分帧
- 半条消息缓存
- 一次到达多条消息
- 非法 JSON 拒绝

核心文件：

```text
src/protocol/jsonl.ts
tests/jsonl-test.ts
```

### 3. Request Map 与双向 Connection

已完成：

- Request ID 分配
- Promise 与 Response 关联
- 错误 Response reject
- 未知 ID 处理
- 连接关闭后清理 Pending Request
- Client 请求 App Server
- App Server 反向请求 Client
- Notification

核心文件：

```text
src/protocol/request-map.ts
src/protocol/connection.ts
tests/request-map-test.ts
tests/connection-test.ts
```

### 4. App Server

已完成：

```text
initialize
initialized
thread/start
turn/start
turn/run
finance/monthly-summary
```

App Server 的 `stdout` 只输出 JSONL 协议数据，调试日志写入 `stderr`。

核心文件：

```text
src/app-server/main.ts
src/app-server/handlers.ts
tests/app-server-handlers-test.ts
```

### 5. Runtime 生命周期

已经实现：

```text
Thread
└─ Turn
   ├─ user_message
   ├─ tool_call
   ├─ tool_result
   └─ assistant_message
```

Turn 状态：

```text
in_progress
completed
failed
```

核心文件：

```text
src/runtime/lifecycle.ts
src/runtime/lifecycle-store.ts
src/runtime/turn-start.ts
src/runtime/turn-run.ts
tests/lifecycle-store-test.ts
```

### 6. 金融领域与确定性 Tool

已实现：

```text
finance_monthly_summary
```

功能：

- 月份参数校验
- 已入账收入
- 已入账支出
- 净现金流
- 分类支出
- 交易数量
- 无数据月份返回零值

金额使用最小货币单位“分”，不使用浮点数。

真实样例：

```text
收入：¥10,000.00
支出：¥3,150.00
净现金流：¥6,850.00
```

金额由确定性 TypeScript Tool 计算，LLM 只负责选择 Tool 和解释结果。

曾发现模型把 `¥3,150.00` 错写成 `¥315.00`，目前已在 Tool Result 中加入确定性生成的 `Money.display`，要求模型原样复制。

核心文件：

```text
src/domains/finance/types.ts
src/domains/finance/fixtures.ts
src/domains/finance/summary.ts
src/tools/finance-monthly-summary-tool.ts
tests/finance-summary-test.ts
```

### 7. 真实 LLM Provider

当前默认配置：

```text
Base URL：https://llmapi.lovbrowser.com/v1
模型：gpt-5.4-mini
Key：只读取 OPENAI_API_KEY
```

支持：

- OpenAI Responses 兼容请求
- SSE 流式响应
- 跨网络 chunk 解析
- Function Call
- Tool Result 回放
- LovBrowser 无状态端点兼容
- `usePreviousResponseId: false`

核心文件：

```text
src/llm/types.ts
src/llm/openai-responses.ts
tests/openai-responses-test.ts
```

不要把 Key 写入源码、文档、日志或 Git。

### 8. Agent Loop

已经跑通：

```text
用户问题
→ Model
→ Function Call
→ Tool
→ Tool Result
→ Model
→ Final Answer
```

支持：

- 最大 Tool 轮数
- 未知 Tool 拒绝
- Turn 完成
- Turn 失败
- Model/Tool/Assistant 事件

核心文件：

```text
src/agent/agent-loop.ts
tests/agent-loop-test.ts
```

当前金融 Tool 仍然硬编码在 Agent Loop 中，后续通过 Tool Registry 解耦。

### 9. Event System

已实现事件：

```text
turn/started
model/started
reasoning/summary_delta
model/completed
tool/started
tool/completed
assistant/delta
turn/completed
turn/failed
```

App Server 通过反向 JSON-RPC Notification：

```text
agent/event
```

实时推送给 Client。

只显示：

- Runtime 真实状态
- 模型公开的推理摘要
- Assistant 文本增量

不展示或伪造隐藏思维链。

核心文件：

```text
src/agent/events.ts
tests/agent-events-test.ts
```

### 10. 交互式 CLI

当前 CLI 名称：

```text
god-agent
```

运行：

```powershell
cd D:\练手\agent-learn
npm run dev
```

支持：

- 启动 App Server 子进程
- 创建一个 Thread
- 连续读取用户输入
- 每次输入创建一个 Turn
- 实时显示 Agent Event
- `/exit`
- 退出后关闭 App Server
- 无后台残留进程

核心文件：

```text
src/cli/main.ts
```

当前 CLI 是学习调试 Harness，不是最终产品 CLI。

故意保留：

```text
[app-server]
[Turn]
[Model]
[Tool]
Item ID
Turn ID
```

目的是观察 Runtime 内部链路。

CLI 产品化放在第一阶段最后处理，届时再实现：

```text
You ›
Assistant ›
Thinking 状态
输入队列
Ctrl+C 取消
--debug
--help
--version
真正的 god-agent 可执行命令
```

## 三、当前真实限制

### 1. 尚无跨 Turn 上下文

虽然多个 Turn 属于同一个 Thread，但 Agent Loop 目前只读取当前 Turn 的第一条 `user_message`。

因此：

```text
你> 分析 7 月财务
你> 刚才最大的支出是什么？
```

第二轮暂时不知道“刚才”指什么。

### 2. Thread 只在内存中

退出进程后 Thread 消失，尚未持久化。

### 3. Tool 硬编码

Agent Loop 直接依赖金融 Tool，尚无通用 Tool Registry。

### 4. 尚无 Permission 与 Sandbox

虽然 Connection 已验证 App Server 可以反向请求 Client，但真实 Tool Permission 流程尚未接入 Agent Loop。

### 5. 尚无取消、超时恢复和重试策略

Provider 有 HTTP 超时和有限重试语义，但还没有完整的 Turn Cancel、恢复和幂等机制。

### 6. 尚无 Skill Loader 与 MCP Client

已经理解概念，但当前阶段不要提前接入。

### 7. 尚无 Electron UI

当前 CLI 是学习入口。Electron 应在 Runtime 核心稳定后进入。

## 四、下一步：跨 Turn Context Builder

下一教学切片只做跨 Turn Context，不同时实现 Compaction。

目标：

```text
Thread 下所有已完成 Turn
        ↓
读取 user_message / assistant_message
        ↓
按时间顺序转换为 LLM Message
        ↓
追加当前用户输入
        ↓
发送给模型
```

建议新增：

```text
src/runtime/context-builder.ts
tests/context-builder-test.ts
```

需要先回答和设计：

1. Context、LifecycleStore 和 Provider 分别负责什么？
2. 哪些 Item 应进入模型上下文？
3. `tool_call` 和 `tool_result` 是否需要跨 Turn 保留？
4. 当前 Provider 的 input 类型怎样扩展为多轮消息？
5. 如何避免把当前 `user_message` 重复加入两次？
6. Failed Turn 是否进入 Context？
7. 怎样写确定性测试证明顺序正确？

最小验收：

```text
Turn 1：
用户：分析 2026 年 7 月财务
助手：净现金流为 ¥6,850.00

Turn 2：
用户：刚才最大的支出是什么？
```

第二次模型请求中必须包含：

```text
Turn 1 user_message
Turn 1 assistant_message
Turn 2 user_message
```

这一切先通过 Fake/Scripted LLM 测试，不依赖真实模型。

## 五、Context 之后的顺序

```text
1. 跨 Turn Context Builder
2. Token Budget
3. Context Compaction
4. Tool Registry
5. Permission
6. Sandbox
7. Thread 持久化
8. Cancel / Timeout / Retry / Resume
9. CLI 产品化
10. Electron
```

暂不进入：

```text
Skill Loader
MCP
Multi-Agent
Rust Runtime
Tauri
生产级金融操作
```

## 六、Codex Compaction 已学习到的结论

Codex Compaction 不是 ZIP，而是有损语义 Checkpoint：

```text
长历史
→ Token 阈值
→ 截断大型 Tool Output
→ 生成 Handoff Summary
→ 保留最近真实用户消息
→ 重建当前 Instructions 和 World State
→ 替换历史
→ 创建新 Context Window
```

当前源码显示：

- 本地摘要路径保留最近约 20,000 Token 的真实用户消息。
- Remote Compaction V2 客户端保留最近约 64,000 Token 的 user/developer/system 消息。
- Tool Output 过大时先替换成截断占位。
- 当前 Instructions、权限和 World State 从 Session 重新注入。
- 每次压缩有 window ID、replacement history 和 Trace。
- Remote `/responses/compact` 内部模型与训练算法未在客户端源码公开。

详细学习笔记：

```text
D:\练手\hln-knowledge-base\agent 学习笔记\01-入门与架构选型\从0到1手写Agent-框架选型与MVP学习路线.md
```

重点阅读第 28、29 节。

## 七、验证命令

```powershell
cd D:\练手\agent-learn

npm run check
npm test
npm run dev
```

当前基线：

```text
npm run check → 通过
npm test      → 45/45
npm run dev   → 真实 LLM、Tool Calling、SSE 和交互式 CLI 已通过
```

新 Chat 修改代码后必须重新运行：

```powershell
npm run check
npm test
```

涉及真实链路时再运行：

```powershell
npm run dev
```

## 八、协作与教学要求

新 Chat 必须遵守：

- 使用中文教学。
- 先讲当前文件是干什么的，再给代码。
- 核心代码写中文注释。
- 一次只推进一个可验证切片。
- 用户说“next”时继续下一个学习切片。
- 用户说“你来实现”时直接实现并验证。
- 用户说“我来手戳”时一次给完整文件内容和解释。
- 不假装隐藏思维链是可展示内容。
- 金额只能由确定性 Tool 计算。
- 不提前进入 Multi-Agent。
- 不覆盖现有未提交学习修改。
- 不创建分支或 Worktree。
- 不提交、不推送。
- 不修改或输出 Key。
- 不擅自清理用户文件。
- 调试型 CLI 的日志当前故意保留，不要提前产品化。

## 九、容易重复踩的坑

### CLI 类初始化顺序

`CliAgentEventRenderer` 是 class，必须在 class 声明完成后再调用 `main()`，否则会触发：

```text
Cannot access 'CliAgentEventRenderer' before initialization
```

### stdout 与 stderr

App Server：

```text
stdout → 只能输出 JSONL 协议
stderr → 调试日志
```

CLI 会把 App Server stderr 转发到终端，所以当前日志会和提示符交错。这是学习阶段的已知表现。

### 金额单位

```text
minorUnits = 分
display = 确定性代码生成的人民币元字符串
```

不要让模型自己换算 `minorUnits`。

### LovBrowser 中转

默认根地址会自动补 `/v1`。

LovBrowser 不保存 `previous_response_id`，Tool Calling 需要显式回放 Function Call 与 Tool Result。

### 当前多轮不等于有记忆

同一 Thread 下能创建多个 Turn，不代表这些 Turn 已经自动进入模型 Context。

## 十、禁止新 Chat 重做的内容

不要重新实现：

- JSON-RPC
- JSONL
- Request Map
- Connection
- Initialize 握手
- Thread/Turn/Item
- 金融汇总
- OpenAI Responses Provider
- SSE 解析
- Agent Loop
- Event System
- 交互式 CLI

先检查现有代码与测试，再从 Context Builder 继续。

## 十一、新 Chat 的第一步

新 Chat 应先：

1. 阅读本交接文档。
2. 阅读 `package.json` 和 Context 相关源码。
3. 运行 `npm run check` 与 `npm test`。
4. 用简短中文复述当前状态。
5. 解释 Context Builder 的职责和文件设计。
6. 等用户选择“手戳”或“你来实现”。

不要一上来重构整个项目。

## 十二、明天新 Chat 可直接使用的 Prompt

```text
请继续教我从 0 到 1 手写单 Agent Runtime。

项目目录：
D:\练手\agent-learn

请先完整阅读交接文档：
D:\练手\agent-learn\docs\工作交接-2026-08-02-god-agent单Agent学习.md

同时阅读总学习文档第 28、29 节：
D:\练手\hln-knowledge-base\agent 学习笔记\01-入门与架构选型\从0到1手写Agent-框架选型与MVP学习路线.md

当前已完成 JSON-RPC、JSONL、双向 Connection、App Server、Thread/Turn/Item、真实 LLM、金融 Tool、Agent Loop、SSE、Event System 和交互式 god-agent CLI，测试基线是 45/45。

不要重新实现已经完成的部分。下一步只进入“跨 Turn Context Builder”，暂时不要同时做 Compaction、Tool Registry、Permission、Sandbox、Skill、MCP、Electron 或 Multi-Agent。

开始前请：

1. 检查当前源码和测试。
2. 运行 npm run check 和 npm test。
3. 用中文简短复述当前架构。
4. 告诉我 Context Builder 要解决什么问题、准备新增或修改哪些文件。
5. 每个文件先说明用途，核心代码写中文注释。
6. 一次只推进一个可验证切片。
7. 我说“我来手戳”时给我完整代码和讲解；我说“你来实现”时直接实现并验证。
8. 保留所有现有未提交修改，不创建分支或 Worktree，不提交、不推送，不读取或输出 Key。
9. 金额继续由确定性 Tool 计算，LLM 只选择和解释。
10. 调试型 CLI 的内部日志当前故意保留，不要提前做 CLI 产品化。

先从 Context、Message History、LifecycleStore 三者的区别开始教我。
```
