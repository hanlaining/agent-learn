# 真实 Reasoning Summary 未展示原因与验收计划

## 1. 结论先行

此前真实 Agent 只显示 `Thinking…`、没有显示 reasoning summary 正文，根因不是 CLI 不会解析，也不是 LovBrowser 中转必然丢弃 Summary SSE，而是当时的模型请求只明确发送了：

```json
{
  "reasoning": {
    "summary": "auto"
  }
}
```

请求缺少一个非 `none` 的 `reasoning.effort`。`summary` 只表示“如果模型进行了可公开摘要的推理，则请求返回摘要”；它不会代替 `effort` 开启推理。此前默认模型 `gpt-5.4-mini` 的官方模型页说明其默认 reasoning effort 为 `none`，所以只设置 `summary: "auto"` 并不能保证产生 Summary SSE。

真实对照实验已经证明：在相同 Key、相同 LovBrowser 中转、相同 `gpt-5.4-mini` 下，把请求改成：

```json
{
  "reasoning": {
    "effort": "medium",
    "summary": "auto"
  }
}
```

远端立即返回：

```text
response.reasoning_summary_part.added
response.reasoning_summary_text.delta
response.reasoning_summary_text.done
response.reasoning_summary_part.done
```

因此，已经有直接证据表明：

1. 当前 Key 可以调用真实远程模型。
2. `https://llmapi.lovbrowser.com/v1/responses` 可以透传 Reasoning Summary SSE。
3. `agent-learn` 已经具备解析和展示 Summary SSE 的能力。
4. 早先没有摘要的关键差异是请求中的 reasoning effort，而不是 Mock、Renderer 或 SSE Parser。

官方说明：Reasoning Summary 需要通过 `reasoning.summary` 显式请求；不同模型支持情况不同，原始 reasoning tokens 不会通过 API 暴露。参考：<https://developers.openai.com/api/docs/guides/reasoning#reasoning-summaries>。

## 2. 真实验证证据

### 2.1 没有有效 effort 时的真实 Agent 结果

使用当前机器中的真实 Key，调用真实远程地址：

```text
https://llmapi.lovbrowser.com/v1/responses
```

当 Agent 请求没有明确提供有效的 reasoning effort 时，终端结果是：

```text
Thinking…
Assistant › 正常回答正文
```

这表示模型回答链路正常，但上游没有发送 `response.reasoning_summary_text.delta`，所以 CLI 没有可展示的公开摘要正文。

### 2.2 显式设置 effort 后的真实原始 SSE

真实协议探针发送：

```json
{
  "model": "gpt-5.4-mini",
  "input": [
    {
      "role": "user",
      "content": [
        {
          "type": "input_text",
          "text": "Compare Context, Message History, and LifecycleStore in three concise points."
        }
      ]
    }
  ],
  "stream": true,
  "reasoning": {
    "effort": "medium",
    "summary": "auto"
  }
}
```

真实返回为 HTTP 200，并收到两个 Summary Delta：

```text
**Comparing Context, Message History, LifecycleStore**
**Defining scope, persistence, and usage distinctions**
```

事件集合包含：

```text
response.created
response.in_progress
response.output_item.added
response.reasoning_summary_part.added
response.reasoning_summary_text.delta
response.reasoning_summary_text.done
response.reasoning_summary_part.done
response.output_item.done
response.content_part.added
response.output_text.delta
response.output_text.done
response.completed
```

该实验没有使用 Mock Server。

### 2.3 当前工作区最新代码的真实 Agent 结果

当前工作区在并发修改后已经包含：

```ts
reasoningSummary: "auto"
reasoningEffort: "high"
```

当前默认模型也已变为：

```text
gpt-5.6-sol
```

使用当前最新代码再次走真实 Key 和真实远端后，CLI 已显示：

```text
Thinking…
Thinking: Clarifying Context, Message History, and LifecycleStore roles
• Clarifying Context, Message History, and LifecycleStore roles

Assistant › 1. Context ...
```

这进一步证明真实 Summary 已经从远端进入 Provider、Agent Event System 和 CLI。

注意：该次自动验收脚本在检测到第一个 Assistant Delta 后过早发送了 `/exit`，因此随后显示 `Turn cancelled`。这属于验收脚本退出时机问题，不是 Reasoning Summary 获取失败。

## 3. 参数语义

### `reasoning.effort`

控制模型实际投入多少推理计算。常见取值由具体模型决定，例如：

```text
none / minimal / low / medium / high / xhigh / max
```

如果模型默认 effort 为 `none`，只请求 summary 不会自动把 effort 提升为 `medium` 或 `high`。

### `reasoning.summary`

控制是否请求模型返回可公开的推理摘要。推荐值：

```text
auto
```

它返回的是模型生成的公开摘要，不是模型逐字的隐藏思维链。

### 推荐组合

```json
{
  "stream": true,
  "reasoning": {
    "effort": "medium",
    "summary": "auto"
  }
}
```

对于更复杂的 Agent 任务，可以在模型支持的前提下使用 `high`；需要通过延迟、费用和回答质量验收后再确定默认值。

## 4. 为什么 Mock 测试通过但早先真实链路不展示

Mock 用例直接伪造并发送：

```text
response.reasoning_summary_part.added
response.reasoning_summary_text.delta
```

所以它只能证明以下下游链路正确：

```text
Summary SSE Parser
→ LlmStreamEvent
→ Agent Event System
→ CLI Thinking 展示
```

Mock 不负责证明真实 Provider 一定会产生摘要。

真实链路还多了一层前置条件：

```text
请求参数和模型能力
→ 模型实际执行 reasoning
→ Provider 生成 Summary SSE
→ Agent 下游解析和展示
```

早先失败发生在第一层；下游展示代码没有拿到可展示的 Summary Delta。

## 5. 后续验收计划

本计划阶段先不修改业务代码。

### Slice 1：锁定当前请求配置

目标：确认实际启动时最终发送的模型、effort、summary、stream 和 Base URL。

检查项：

- 实际模型是否为预期模型。
- `reasoning.effort` 是否为模型支持的非 `none` 值。
- `reasoning.summary` 是否为 `auto`。
- `stream` 是否为 `true`。
- 请求是否发往 `https://llmapi.lovbrowser.com/v1/responses`。
- 日志和验收输出不得包含 Key、Authorization 或 Cookie。

完成条件：保存脱敏后的最终请求结构。

### Slice 2：真实原始 SSE 验收

目标：绕过 CLI，只检查远端返回的原始事件类型和顺序。

通过条件：

- HTTP 状态为 200。
- Content-Type 为 `text/event-stream`。
- 至少收到一个 `response.reasoning_summary_text.delta`。
- 最终收到 `response.completed`。
- Summary Delta 出现在 Assistant `response.output_text.delta` 之前。

失败时分类：

- HTTP 400：检查模型、input 数组、reasoning 参数或网关兼容格式。
- HTTP 401/403：检查 Key 或权限，但不输出 Key。
- HTTP 200 但无 Summary Delta：检查实际 effort、模型能力和 Provider 路由。

### Slice 3：真实 Agent 端到端验收

目标：确认 Summary 从真实 SSE 一直传到 CLI，而不是只在原始探针里存在。

预期顺序：

```text
Thinking…
Thinking: <真实摘要标题>
• <真实摘要正文>
Assistant › <完整回答>
god-agent 已退出
```

验收脚本必须等待 Turn 完成或 CLI 重新出现输入提示后再发送 `/exit`，不能在第一个 Assistant Delta 出现时退出。

### Slice 4：自动化回归

目标：保证后续修改不会再次遗漏 effort 或破坏事件顺序。

必须覆盖：

- 请求体同时包含 `reasoning.effort` 和 `reasoning.summary`。
- Provider 正确解析多个 `summary_index`。
- `response.reasoning_text.delta` 不得当成公开摘要展示。
- Summary 完成后才开始 Assistant 展示。
- 无 Summary 时仍安全回退为 `Thinking…`。
- CLI 完整退出，不出现 `Turn cancelled` 或退出竞态。

## 6. 最终验收标准

只有同时满足以下条件，才能判断真实 Reasoning Summary 展示完成：

1. 使用真实 Key 和真实远程 `/v1/responses`，不是 Mock。
2. 脱敏请求证明确实发送非 `none` 的 `reasoning.effort` 和 `summary: "auto"`。
3. 原始 SSE 中真实存在 `response.reasoning_summary_text.delta`。
4. CLI 显示真实 Summary 标题或正文。
5. Assistant 回答完整结束。
6. Turn 正常完成，CLI 正常退出。
7. 不展示或伪造隐藏思维链，不把 Assistant 正文冒充 Summary。

## 7. 当前判断

当前问题的诊断已经从“怀疑中转不透传 Summary”修正为：

> 早先请求缺少有效的 reasoning effort；`summary: "auto"` 本身不会保证模型进行推理并返回摘要。真实对照实验补上 `effort: "medium"` 后，同一 LovBrowser 真实链路立即返回 Summary SSE。当前并发更新后的代码已默认发送 `effort: "high"`，并在真实 Agent CLI 中成功显示 Summary。

因此，下一步重点不是重新实现 Summary Parser，而是锁定当前请求参数、避免并发改动覆盖，并完成一次等待 `response.completed` 的真实端到端验收。
