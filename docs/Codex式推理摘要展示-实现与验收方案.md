# Codex 式推理摘要展示：实现与验收方案

## 1. 目标

在现有 `god-agent` 单 Agent Runtime 中，展示与 Codex 同类的“可公开推理摘要”：

```text
模型请求 reasoning.summary
→ Provider 接收 reasoning summary SSE
→ Agent Loop 转换为 Agent Event
→ CLI 缓存并展示 Thinking 标题
→ 推理块结束后展示摘要正文
→ Assistant 正文继续流式输出
```

本功能展示的是模型服务主动返回的 `reasoning summary`，不是模型私有思维链。Runtime 不生成、猜测或伪造思考内容。

## 2. 范围边界

本次只处理：

- 修复阻断真实 Responses API 请求的严格 Tool Schema。
- 显式请求 `reasoning.summary`。
- 完成 reasoning summary 的 SSE、Event System 和 CLI 展示链路。
- 增加定向测试、CLI 端到端测试和真实 CLI 验收。

本次不处理：

- 不展示模型私有 Chain of Thought。
- 不实现模型内部 Tokenizer、Reasoning 算法或视觉编码。
- 不改金额计算职责，金额继续由确定性金融 Tool 计算。
- 不进入 Multi-Agent、MCP、Skill、Electron、OS 级隔离等范围。
- 不将全部 Runtime 调试日志暴露到普通 CLI；`--debug` 行为继续保留。
- 不创建分支、Worktree，不提交、不推送，不读取或输出 Key。

## 3. Codex 源码对齐依据

本地参考源码位于 `D:\练手\codex`。

| Codex 机制 | Codex 源码 | god-agent 对应实现 |
| --- | --- | --- |
| 构造 `reasoning.summary` | `codex-rs/core/src/client.rs` 的 `build_reasoning` | `src/llm/openai-responses.ts` |
| 摘要级别 `auto/concise/detailed/none` | `codex-rs/protocol/src/config_types.rs` 的 `ReasoningSummary` | Provider 的 `ReasoningSummary` 类型 |
| 解析摘要 SSE | `codex-rs/codex-api/src/sse/responses.rs` | `OpenAiEventStreamAccumulator` |
| 转换 Runtime Event | `codex-rs/core/src/session/turn.rs` | `AgentLoop.handleModelStreamEvent` |
| TUI 接收摘要 | `codex-rs/tui/src/chatwidget/protocol.rs` | `CliAgentEventRenderer.render` |
| 缓存摘要、提取粗体标题 | `codex-rs/tui/src/chatwidget/streaming.rs` | 新增 CLI 摘要缓冲与解析逻辑 |
| 完成后显示摘要正文 | `codex-rs/tui/src/history_cell/messages.rs` | CLI 使用 `• ` 输出公开摘要正文 |

对齐原则：

1. 由 Provider 请求并接收模型摘要，不由 Agent Runtime 自己编造。
2. Delta 先进入 Event System，CLI 不直接解析厂商 SSE。
3. 实时阶段优先展示 `**标题**` 中的标题；完成后展示去掉标题的摘要正文。
4. 模型不返回摘要时，只显示 `Thinking…`，最终回答仍正常输出。
5. `--debug` 在用户可见摘要之外，继续显示 Model、Tool、Permission 等内部日志。

## 4. 目标呈现效果

### 4.1 模型返回带标题的摘要

```text
You › 分析 2026 年 7 月财务情况

Thinking…
Thinking: 检查月度账本
• 我需要调用确定性金融工具取得收入、支出和分类数据。

[Permission] 工具 finance_monthly_summary 请求执行，允许吗？[y/N] y

Assistant › 2026 年 7 月净现金流为 ¥6,850.00……
```

### 4.2 模型不返回摘要

```text
You › 你好

Thinking…

Assistant › 你好，有什么可以帮你？
```

### 4.3 Debug 模式

```text
[Model] round 1 started
[Reasoning summary]
**检查月度账本**

我需要调用确定性金融工具取得数据。
[Model] selected 1 tool(s)
```

普通模式的推理摘要属于用户可见模型输出，不等同于 `--debug` 的 Runtime 内部日志。

## 5. 文件用途与预计修改

### `src/tools/workspace-tools.ts`

用途：定义 `list_files`、`read_file` 的模型 Tool Schema 和执行参数校验。

修改：让 `list_files.path` 满足 `strict: true` 的 Schema 约束；根目录使用显式 `"."`，避免“Schema 声明可省略、Provider 又要求全部字段必填”的矛盾。

### `tests/workspace-tools-test.ts`

用途：验证 Workspace Tool 定义和执行行为。

修改：断言 `list_files` 的 Schema 将 `path` 列入 `required`，并保留根目录执行测试。

### `src/llm/types.ts`

用途：定义 Provider 与 Agent Loop 之间的厂商无关接口。

修改：增加推理摘要完成事件，使 CLI 不依赖 OpenAI SSE 细节判断摘要何时结束。

### `src/llm/openai-responses.ts`

用途：构造 Responses API 请求、解析 SSE，并转换为 `LlmStreamEvent`。

修改：

- 增加 `ReasoningSummary` 配置类型。
- 请求体加入 `reasoning: { summary: "auto" }`。
- 继续解析 `response.reasoning_summary_text.delta`。
- 在 reasoning Item 完成、Assistant 文本开始或 Response 完成时，可靠发出一次摘要完成事件。
- 不把 `reasoning.encrypted_content` 当作可显示文本。

### `tests/openai-responses-test.ts`

用途：验证 Provider 请求体、SSE 分帧和事件顺序。

修改：断言请求包含 `reasoning.summary`，并覆盖“摘要 Delta → 摘要完成 → Assistant Delta”的顺序。

### `src/agent/events.ts`

用途：定义 App Server、Agent Loop 和 CLI 共享的 Agent Event。

修改：增加 `reasoning/summary_completed`，仍保持 Event System 是 CLI 的唯一输入。

### `src/agent/agent-loop.ts`

用途：编排 Model、Tool、Permission，并把 Provider Event 转换为 Agent Event。

修改：转发推理摘要完成事件，不在 Agent Loop 中解析或改写摘要内容。

### `src/cli/main.ts`

用途：交互式 CLI 和 Agent Event 渲染。

修改：

- 普通模式缓存推理摘要。
- 从首个完整 `**标题**` 提取 Thinking 标题。
- 摘要完成后移除标题并以 `• ` 展示正文。
- 无摘要时保持现有 `Thinking…` 回退。
- `--debug` 保留完整增量和内部日志。

### `tests/agent-events-test.ts`、`tests/agent-loop-test.ts`

用途：验证新增事件结构和 Provider → Agent Event 映射。

修改：覆盖摘要完成事件，防止事件在中间层丢失。

### `tests/cli-smoke-test.ts`

用途：使用本地假 Responses Server 验证真实子进程 CLI 输出。

修改：发送可控 SSE，断言 Thinking 标题、摘要正文、Assistant 正文的内容和先后顺序，并确认普通模式不泄漏 Runtime Debug 日志。

## 6. 分片实施方案

### 切片 1：恢复合法模型请求

- 目标：消除 `Invalid schema for function 'list_files'` 400。
- 修改文件：`src/tools/workspace-tools.ts`、`tests/workspace-tools-test.ts`。
- 验证：`npx tsx --test tests/workspace-tools-test.ts`、`npm run check`。
- 回滚点：只撤销上述两个文件中的本切片改动，不影响其余 Runtime。

### 切片 2：补齐推理摘要协议链路

- 目标：请求公开摘要，并以明确的 Delta/Completed 事件穿过 Provider 和 Agent Loop。
- 修改文件：`src/llm/types.ts`、`src/llm/openai-responses.ts`、`src/agent/events.ts`、`src/agent/agent-loop.ts` 及对应测试。
- 验证：`npx tsx --test tests/openai-responses-test.ts tests/agent-events-test.ts tests/agent-loop-test.ts`、`npm run check`。
- 回滚点：Provider 的 `reasoning` 参数和新增完成事件可整体撤销，不影响 Tool 执行。

### 切片 3：Codex 式 CLI 呈现

- 目标：普通模式显示公开摘要，Debug 模式继续显示内部日志。
- 修改文件：`src/cli/main.ts`、`tests/cli-smoke-test.ts`。
- 验证：`npx tsx --test tests/cli-smoke-test.ts`、`npm run check`。
- 回滚点：只撤销 CLI Renderer 和 Smoke Test，不影响 Provider/Event 链路。

### 集成验收

- `npm run check`
- `npm test`
- 检查 Key 是否仅“已配置/未配置”，不读取或输出值。
- 若当前终端已有 Key，运行真实 `god-agent`，至少验证一次无 Tool 问题和一次金融 Tool 问题。
- 若真实中转不返回摘要，记录请求已开启但 Provider 未返回对应 SSE；CLI 必须正常回退，不能伪造摘要。

## 7. 验收标准

- 输入“你好”不再出现 Tool Schema 400。
- 每个严格 Tool Schema 的 `required` 包含全部 `properties` 字段。
- Responses 请求明确携带 `reasoning.summary`。
- 推理摘要事件先于 Assistant 文本事件完成。
- 普通 CLI 能显示 Thinking 标题和摘要正文。
- 没有摘要时最终回答不受影响。
- `--debug` 继续显示 Runtime 内部日志。
- Permission、Tool、Cancel、FIFO、Context、持久化等既有行为不回归。
- TypeScript 检查通过，全量测试全部通过。

## 8. 实施记录

| 阶段 | 状态 | 验证结果 | 备注 |
| --- | --- | --- | --- |
| 变更前基线 | 已完成 | `npm run check`；`npm test` 123/123 | 当前真实请求被 `list_files` Schema 400 阻断 |
| 切片 1 | 已完成 | Workspace Tool 4/4；`npm run check` 通过 | `list_files.path` 改为严格 Schema 必填，根目录显式传 `.` |
| 切片 2 | 已完成 | Provider/Event/Agent Loop 23/23；`npm run check` 通过 | 默认请求 `reasoning.summary=auto`，增加摘要完成事件，raw reasoning 不进入公开摘要 |
| 切片 3 | 已完成 | CLI Smoke Test 6/6；`npm run check` 通过 | 已验证 Thinking 标题 → 摘要正文 → Assistant 的内容和顺序，普通模式无 Debug 日志 |
| 集成验收 | 已完成 | `npm run check`；`npm test` 126/126；真实 CLI 2 次通过 | “你好”和复杂比较问题均越过 Tool Schema 并得到回答；当前 LovBrowser 中转未返回 reasoning summary |

## 9. 真实 Provider 验收结论

2026-08-03 使用当前终端已配置的 Provider 环境进行验收，全程未读取或输出 Key：

1. 输入“你好”，真实 CLI 成功得到 Assistant 回答，不再出现 `list_files` Schema 400。
2. 输入“请比较 Context、Message History 和 LifecycleStore 的区别，用三点回答”，真实 CLI 成功得到完整回答。
3. 使用 `reasoning.summary: "detailed"` 做协议探针，Provider 仍只返回 Assistant 文本事件。
4. 原始 SSE 事件名称集合为：

```text
response.created
response.in_progress
response.output_item.added
response.content_part.added
response.output_text.delta
response.output_text.done
response.content_part.done
response.output_item.done
response.completed
```

其中没有 `response.reasoning_summary_text.delta`。这说明当前 LovBrowser 中转没有提供公开推理摘要，而不是 god-agent 漏解析了另一种 reasoning 事件。

因此当前结果分为两层：

- Runtime 与 CLI：Codex 式摘要请求、事件传递和呈现已经实现，并由真实 CLI 子进程 + 可控 SSE 端到端测试验证。
- 当前默认中转：只返回 Assistant 文本，所以实际预览会安全回退为 `Thinking…`；更换为能返回 `response.reasoning_summary_text.delta` 的兼容 Provider 后，会自动出现 Thinking 标题和摘要正文，无需修改 Agent Loop 或 CLI。

不能为了强行显示效果而让 Agent Runtime 伪造“思考”，也不能把 Assistant 正文冒充 reasoning summary。
