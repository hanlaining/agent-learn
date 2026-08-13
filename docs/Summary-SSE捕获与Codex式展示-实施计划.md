# Summary SSE 捕获与 Codex 式展示实施计划

## 1. 目标

在 `agent-learn` 中建立一条可验证的公开推理摘要链路：

```text
上游公开 reasoning summary
  -> Summary SSE 捕获与归一化
  -> LlmStreamEvent
  -> Agent Event System
  -> CLI / TUI Thinking 区
```

本功能只处理 Provider 明确公开的 reasoning summary，不读取、推断或伪造模型隐藏思维。金额计算仍由确定性 Tool 完成，LLM 只负责选择和解释。

## 2. Codex 原版如何实现

本计划以本地 `D:\练手\codex` 源码为对照：

1. `codex-rs/core/src/client.rs` 的 `build_reasoning` 在模型支持时构造 `reasoning.summary`。
2. `codex-rs/codex-api/src/sse/responses.rs` 解析：
   - `response.reasoning_summary_part.added`
   - `response.reasoning_summary_text.delta`
3. 每个摘要增量保留 `summary_index`，再转换成 Codex 内部 `ResponseEvent`。
4. `codex-rs/core/src/session/turn.rs` 把 Provider 事件转换成 Runtime 事件。
5. TUI 只累计和展示公开摘要；`response.reasoning_text.delta` 与公开摘要是不同事件，不能混用。

Codex 不会从最终回答反推摘要，也不会在 Provider 没返回摘要时生成一段假的 Thinking。

## 3. 当前项目已有能力与缺口

已有能力：

- 请求体包含 `reasoning.summary`。
- 能解析 `response.reasoning_summary_text.delta`。
- 已打通 Provider -> Agent Loop -> Event System -> CLI。
- 无摘要时安全回退，不展示伪造内容。

仍有缺口：

- 摘要增量没有保留 `summary_index`。
- 没有解析 `response.reasoning_summary_part.added`。
- 没有完整关联 reasoning item、摘要分段和完成时机。
- 当前 `https://llmapi.lovbrowser.com/v1/responses` 的真实 SSE 未返回 summary 事件。
- 当前 CLI 是行式 `readline`，尚无 Codex 式可折叠 Thinking 面板。

## 4. 是否需要建立 Bridge

### 情况 A：Provider 原生返回 Summary SSE

不需要 Bridge。`OpenAiResponsesProvider` 直接捕获并归一化事件即可。

### 情况 B：当前 LovBrowser 中转不返回 Summary SSE

需要适配层，但优先做成 `agent-learn` 进程内的 Provider Adapter，不额外启动 HTTP 服务。

```text
OpenAI Responses 原生事件 ─┐
                            ├─ SummarySseNormalizer -> Runtime
LovBrowser 公开摘要事件 ───┘
```

适配层只能转发上游真实存在的公开摘要。如果 LovBrowser 的远程接口、Browser Bridge 和浏览器页面都没有提供公开摘要，Adapter 也不能制造 summary。

### 当前 LovBrowser Browser Bridge 的事实

本地 LovBrowser 源码目前只暴露 `/v1/chat/completions` 流式接口。它轮询 ChatGPT 页面回答 DOM，再包装成 `chat.completion.chunk` 的 `delta.content`；它不是 `/v1/responses`，也没有输出 `response.reasoning_summary_text.delta`。

因此不能把“Bridge 支持 SSE”等同于“Bridge 支持 Summary SSE”。

## 5. 推荐架构

```text
┌─────────────────────────────────────────────────────────────┐
│ Agent Loop                                                  │
│  只消费 Provider 无关的 LlmStreamEvent                     │
└───────────────────────────▲─────────────────────────────────┘
                            │
┌───────────────────────────┴─────────────────────────────────┐
│ SummarySseNormalizer                                       │
│  part.added -> reasoning_summary_part_added                 │
│  text.delta -> reasoning_summary_delta                      │
│  item.done / response.completed -> summary completed        │
└───────────────▲──────────────────────────────▲──────────────┘
                │                              │
┌───────────────┴──────────────┐  ┌────────────┴──────────────┐
│ OpenAI Responses SSE Source │  │ LovBrowser Summary Source │
│ 原生 Responses 事件         │  │ 仅转发已验证的公开摘要    │
└──────────────────────────────┘  └───────────────────────────┘
```

不建议一开始建立独立 Sidecar HTTP Bridge。单 Agent Runtime 的教学目标是理解事件边界，进程内 Adapter 更小、更容易测试。只有未来多个客户端都要复用这层协议时，再拆独立 Bridge 服务。

## 6. 分片实施计划

一次只推进一个切片；当前切片验证通过后再进入下一片。

### Slice 1：对齐 Codex 的 Summary SSE 协议模型

目标：原样捕获 `summary_index` 和摘要分段事件，不改 CLI 布局。

计划修改：

- `src/llm/types.ts`
  - 为摘要增量增加 `summaryIndex`。
  - 新增 `reasoning_summary_part_added`。
- `src/llm/openai-responses.ts`
  - 解析 `response.reasoning_summary_part.added`。
  - 解析带 `summary_index` 的 `response.reasoning_summary_text.delta`。
  - 严格区分公开 summary 与 `response.reasoning_text.delta`。
- `src/agent/events.ts`
  - 增加 Provider 无关的摘要分段事件。
- `src/agent/agent-loop.ts`
  - 把摘要分段和增量送入现有 Event System。
- `tests/openai-responses-test.ts`
  - 使用与 Codex 同形的 SSE fixture 验证捕获顺序。
- `tests/agent-events-test.ts`、`tests/agent-loop-test.ts`
  - 验证事件校验与转发。

核心类型草图：

```ts
export type LlmStreamEvent =
  | {
      type: "reasoning_summary_part_added";
      // 同一 reasoning item 内公开摘要的分段序号。
      summaryIndex: number;
    }
  | {
      type: "reasoning_summary_delta";
      // 增量必须归属到明确的摘要分段，不能混进最终回答。
      summaryIndex: number;
      delta: string;
    };
```

验证命令：

```text
npx tsx --test tests/openai-responses-test.ts tests/agent-events-test.ts tests/agent-loop-test.ts
npm run check
```

回滚点：只回退上述协议和测试文件，不影响 Tool、Context、Permission、Sandbox 等模块。

### Slice 2：Provider 能力探测与脱敏诊断

目标：明确某个 Provider 到底有没有返回 summary，避免把 Renderer 问题和上游能力问题混为一谈。

计划新增或修改：

- `src/llm/summary-sse-diagnostics.ts`
  - 只统计 SSE 事件名、顺序和必要结构字段。
  - 不记录正文、Key、Cookie 或 Authorization。
- `src/llm/openai-responses.ts`
  - `--debug` 下输出脱敏后的事件结构。
- 对应单元测试
  - 验证诊断信息不会包含正文和认证数据。

验收结果分为：

- `native-summary`：原生返回公开摘要。
- `output-only`：只有最终回答 SSE。
- `unsupported`：接口或模型明确不支持。

### Slice 3：LovBrowser 进程内 Summary Adapter（条件切片）

进入条件：Slice 2 证明远程 Provider 不返回 summary，同时真实 LovBrowser 浏览器流中能验证存在公开摘要事件。

目标：在本项目中读取并归一化 LovBrowser 已公开的摘要，不修改 LovBrowser 仓库。

计划新增：

- `src/llm/summary-source.ts`
  - 定义 Provider 无关的摘要来源接口。
- `src/llm/lovbrowser-summary-source.ts`
  - 连接本机 LovBrowser 的已授权 Bridge/CDP 能力。
  - 只捕获经过验证的公开摘要字段。
- `src/llm/summary-sse-normalizer.ts`
  - 把 LovBrowser 事件转换为 Slice 1 定义的事件。
- `tests/lovbrowser-summary-source-test.ts`
  - 使用录制后脱敏的 fixture 测试，不依赖真实账号。

实现前门禁：

1. 用户启动并登录 LovBrowser 客户端。
2. 只读抓取一次事件结构，确认公开摘要字段的真实名称。
3. 不保存或输出 Cookie、Token、请求头和正文。
4. 如果只能看到最终回答而看不到公开摘要，停止该切片，不写猜测式解析器。

注意：如果 LovBrowser 只提供 Chat Completions `delta.content`，本切片不会把它冒充 summary。

### Slice 4：Codex 式 Thinking 状态模型

目标：摘要捕获与 UI 状态解耦，先用纯状态测试验证折叠逻辑。

计划新增：

- `src/cli/thinking-state.ts`
  - 保存 `idle / streaming / completed / unavailable`。
  - 按 `summaryIndex` 保存多个公开摘要分段。
- `tests/cli-thinking-state-test.ts`
  - 验证增量、分段、完成、无摘要和异常顺序。

状态规则：

- 有 summary：显示标题和公开摘要正文。
- 无 summary：显示 `Thinking…`，完成后标记“Provider 未返回公开摘要”。
- 不显示 `reasoning_text`，不显示隐藏思维。

### Slice 5：Codex 式全屏 TUI 展示

进入条件：先确认单独的 ASCII UI 草图和 TUI 技术选型。

目标：实现可折叠 Thinking、固定底部多行输入框和可展开 Thread 侧栏。

预计结构：

```text
┌ god-agent ─────────────────────────────┬ Threads ───────────┐
│ You                                    │ > 当前会话          │
│ 请分析这个任务                         │   历史会话          │
│                                        │                    │
│ ▾ Thinking: 检查任务约束               │ Turn: running       │
│   我会先检查输入，再调用必要工具。       │ Queue: 0            │
│                                        │                    │
│ Assistant                              │                    │
│ ……                                     │                    │
├────────────────────────────────────────┴────────────────────┤
│ > 输入消息……                                               │
│ Enter 发送 · Shift+Enter 换行 · Ctrl+B 侧栏 · Ctrl+R 思考   │
└─────────────────────────────────────────────────────────────┘
```

这一切片不与 Summary 捕获协议同时实现。

### Slice 6：真实端到端验收

验收矩阵：

| 场景 | 预期 |
|---|---|
| Provider 返回一个 summary part | Thinking 流式显示该段 |
| Provider 返回多个 `summary_index` | 按顺序分段显示 |
| summary 后开始输出回答 | Thinking 先完成，Assistant 再输出 |
| Provider 不返回 summary | 明确显示不可用，不伪造 |
| SSE 被拆成半个 UTF-8 字符 | 解码后内容完整 |
| 用户中断 Turn | 捕获与渲染同时停止 |
| `--debug` 开启 | 保留内部日志，但不泄露敏感信息 |

最终验证：

```text
npm run check
npm test
npm run god-agent
```

真实验收必须保存“事件类型与顺序”证据，但不能保存 Key、Cookie、Authorization 或隐藏 reasoning 内容。

## 7. 明确不做

- 不生成或猜测模型隐藏思维。
- 不把最终回答包装成 reasoning summary。
- 不把 `response.reasoning_text.delta` 当公开 summary。
- 不在本阶段实现 Compaction、MCP、Skill、Multi-Agent 或 Electron。
- 不修改金额计算归属。
- 不提前删除调试型 CLI 内部日志。
- 不创建分支、Worktree，不提交、不推送。

## 8. 实施顺序结论

推荐顺序：

```text
Slice 1 协议对齐
  -> Slice 2 能力探测
  -> 根据真实结果决定是否进入 Slice 3
  -> Slice 4 Thinking 状态
  -> 用户确认 UI 草图
  -> Slice 5 TUI
  -> Slice 6 真实验收
```

第一步不是直接造一个 Bridge，而是先把 Codex 的 Summary SSE 协议完整接住，再用脱敏诊断证明上游是否缺事件。只有确认 LovBrowser 浏览器侧确实存在公开摘要而远程接口没有透传时，才建立进程内 Adapter。

## 9. 实施记录

### 2026-08-03：Slice 1 已完成

已完成内容：

- `LlmStreamEvent` 新增 `reasoning_summary_part_added`。
- 摘要分段和增量都保留非负整数 `summaryIndex`。
- Responses SSE 解析器支持：
  - `response.reasoning_summary_part.added`
  - `response.reasoning_summary_text.delta`
- 缺少合法 `summary_index` 的摘要事件不会进入 Runtime。
- `response.reasoning_text.delta` 继续与公开摘要严格隔离。
- Agent Loop 新增：
  - `reasoning/summary_part_added`
  - 带 `summaryIndex` 的 `reasoning/summary_delta`
- 行式 CLI 已识别摘要分段事件；普通模式保持现有展示，`--debug` 可看到分段边界。
- 测试 fixture 覆盖两个摘要分段、事件顺序和非法事件校验。

验证结果：

```text
npx tsx --test tests/openai-responses-test.ts tests/agent-events-test.ts tests/agent-loop-test.ts
24/24 通过

npx tsx --test tests/cli-smoke-test.ts
6/6 通过

npm run check
通过

npm test
127/127 通过
```

本切片没有接入 LovBrowser Browser Bridge，也没有改变 Provider 默认地址。真实 Provider 仍需实际返回 Summary SSE，CLI 才会出现公开摘要正文。

### 2026-08-03：Codex 新会话实测与请求参数对齐

通过本机 Codex 客户端创建了一个不读取文件、不调用 Tool 的独立测试会话。第一轮简单比较题没有产生 reasoning item；第二轮约束排序题产生了一个公开摘要：

```text
Determining optimal task order
```

rollout 中的脱敏 Turn 配置为：

```text
model = gpt-5.6-sol
effort = high
summary = auto
model_provider = lovbrowser
```

结合 `codex-rs/core/src/client.rs` 的 `build_responses_request`，Codex 同形请求还包含：

```json
{
  "reasoning": {
    "effort": "high",
    "summary": "auto"
  },
  "include": ["reasoning.encrypted_content"],
  "tool_choice": "auto",
  "parallel_tool_calls": true,
  "store": false,
  "stream": true,
  "service_tier": "fast"
}
```

最初的 A/B 同时改变了模型和请求参数，只能证明“两个组合表现不同”，不能证明 5.6 是 Summary 的必要条件。后续控制变量实测得到：

| 控制实验 | 结果 |
|---|---|
| `gpt-5.4` + `effort:high` + `summary:auto` | 返回完整 Summary SSE |
| `gpt-5.4-mini` + 同样参数 | 返回完整 Summary SSE |
| `gpt-5.6-sol` + 同样参数 | 返回完整 Summary SSE |
| `gpt-5.4-mini` + 只有 `summary:auto` | 0 个 Summary 事件 |
| `gpt-5.4-mini` + `summary:auto` + `include` | 0 个 Summary 事件 |
| `gpt-5.4-mini` + `summary:auto` + `effort:high` | 返回完整 Summary SSE |

准确结论是：

- Summary 成功不是因为从 5.4 系列升级到 5.6。
- 在当前 Provider 中，关键请求差异是缺少 `reasoning.effort=high`。
- `include:["reasoning.encrypted_content"]` 负责携带加密推理状态，不是可见 Summary 的生成开关。
- 模型只需要支持 Reasoning Summary；当前实测的三个模型都支持。
- Runtime 仍必须完整解析 Summary SSE，否则上游返回了也无法展示。

本切片修改：

- Provider 默认发送 `reasoning.effort=high` 和 Codex 同形控制字段。
- 默认包含 `reasoning.encrypted_content`，但继续禁止把它当作可显示文本。
- App Server 当前默认模型为 `gpt-5.6-sol`，仍允许 `OPENAI_MODEL` 覆盖；这属于默认模型选择，不是 Summary 的必要条件。
- Provider 单测和 CLI Smoke Test 同时断言完整脱敏请求参数。
