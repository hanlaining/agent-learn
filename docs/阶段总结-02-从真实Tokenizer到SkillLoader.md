# 阶段总结 02：从真实 Tokenizer 到 Skill Loader

本阶段在现有 Summary SSE、联网搜索和 130/130 基线上继续推进，最终停在第一版 Skill Loader，未进入 MCP、Electron 或 Multi-Agent。

## 完成切片

1. `src/runtime/token-counter.ts`：使用 `o200k_base` BPE 计算正文 Token，并把计数器抽象为可替换接口。
2. `src/runtime/context-compactor.ts`：按 Codex 本地算法用全历史生成摘要，从最新往前保留最多 20,000 Token 的真实用户消息，并把带固定前缀的摘要作为最后一条 user 消息。
3. `src/runtime/tool-output-limiter.ts`：只裁剪交给模型的 Tool Output 副本，LifecycleStore 继续保存完整确定性结果。
4. `src/permissions/`：审批支持本次允许和本会话允许，并按 Tool 名称、安全描述和风险级别精确复用。
5. `src/sandbox/workspace-command-runner.ts`：命令运行在独立进程组，取消、超时和输出超限会终止进程树；这仍不是容器或虚拟机。
6. `src/skills/skill-loader.ts`：校验 Skill 根目录、符号链接、数量、大小、Frontmatter、重复名称和目录名。
7. `src/tools/read-skill-tool.ts`：启动时只把 Skill 名称与描述放进 Instructions，模型需要时再调用 `read_skill` 获取正文。
8. `skills/finance-analysis/SKILL.md`：示例 Skill 继续要求金额由确定性金融 Tool 计算。

## Skill Loader 数据流

```text
<workspace>/skills/<name>/SKILL.md
  -> SkillLoader 安全校验
  -> Agent Instructions 只注入 name + description
  -> 模型判断任务匹配
  -> read_skill(name)
  -> 完整 instructions 作为 Tool Result 返回模型
```

这种方式叫渐进披露：不把所有 Skill 全文永久塞进 Context，只在确实需要时读取。

## 核心源码导航与注释说明

核心实现保留中文注释，注释重点说明设计原因、安全边界和容易误解的数据流，而不是逐行重复代码含义。

### 1. Token 计算与 Context 压缩

- [`src/runtime/token-counter.ts`](../src/runtime/token-counter.ts)：`TokenCounter` 是可替换的计数接口；`OpenAiBpeTokenCounter` 使用 `o200k_base` BPE 计算正文 Token；`truncateTextToTokens` 按 Token 上限保留文本头尾。注释说明该结果适合做 Runtime 预算，但不冒充服务端完整账单值。
- [`src/runtime/token-budget.ts`](../src/runtime/token-budget.ts)：统一判断当前上下文是否达到压缩阈值，不再使用字符数粗略代替 Token 数。
- [`src/runtime/context-compactor.ts`](../src/runtime/context-compactor.ts)：`compact` 用完整当前历史生成 Handoff Summary；`prepareSummaryInput` 把 Codex 合成提示词放在最后并限制摘要请求；`selectRetainedUserMessages` 从最新往前保留真实 user 消息、过滤旧摘要，再把新摘要作为替换历史最后一条 user 消息。压缩阶段禁止业务 Tool。
- [`tests/context-compactor-test.ts`](../tests/context-compactor-test.ts) 与 [`tests/token-budget-test.ts`](../tests/token-budget-test.ts)：验证真实 Token 预算、最近消息保留、超长消息截断和压缩输入上限。

### 2. Tool Output 的完整结果与模型副本

- [`src/runtime/tool-output-limiter.ts`](../src/runtime/tool-output-limiter.ts)：`ToolOutputLimiter` 只裁剪准备交给模型的 Tool Output，避免日志或目录结果占满 Context Window。
- [`src/tools/tool-registry.ts`](../src/tools/tool-registry.ts)：`AgentToolExecution.result` 是 Runtime 保存的完整确定性结果，`modelOutput` 是筛选后允许模型阅读的结果；这两个字段的区别已写在接口中文注释中。
- [`src/agent/agent-loop.ts`](../src/agent/agent-loop.ts)：Tool 执行后，先把 `execution.result` 写入 LifecycleStore，再用 `ToolOutputLimiter` 限制 `execution.output` 后发给模型。
- [`tests/tool-output-limiter-test.ts`](../tests/tool-output-limiter-test.ts)：验证未超限结果保持不变，以及超限结果带截断标记且不超过 Token 预算。

### 3. Permission 与进程执行边界

- [`src/permissions/permission-gate.ts`](../src/permissions/permission-gate.ts)：定义 `read`、`execute`、`sensitive` 风险级别，以及本次允许和本会话允许。
- [`src/permissions/json-rpc-permission-gate.ts`](../src/permissions/json-rpc-permission-gate.ts)：通过双向 JSON-RPC 向 CLI 请求审批；会话授权按照 Tool 名称、安全描述和风险级别精确复用。注释说明原始 arguments 留在可信 Runtime 内。
- [`src/cli/permission-handler.ts`](../src/cli/permission-handler.ts)：把审批请求展示给用户，并解析拒绝、允许一次和本会话允许。
- [`src/sandbox/workspace-command-runner.ts`](../src/sandbox/workspace-command-runner.ts)：只执行预注册命令，不接受模型拼接的 Shell 字符串；取消、超时或输出超限时终止进程树。注释明确这是最小执行边界，不等价于容器、虚拟机或完整 OS 隔离。
- [`tests/json-rpc-permission-gate-test.ts`](../tests/json-rpc-permission-gate-test.ts) 与 [`tests/workspace-command-runner-test.ts`](../tests/workspace-command-runner-test.ts)：验证审批复用、风险级别、拒绝路径、超时、取消和输出限制。

### 4. Skill Loader 与渐进披露

- [`src/skills/skill-loader.ts`](../src/skills/skill-loader.ts)：`SkillLoader.create` 发现并校验 `<root>/<name>/SKILL.md`；`list` 只返回名称和描述；`read` 才返回完整正文；`createCatalogInstructions` 生成注入 Agent 的 Skill 目录。路径校验会阻止符号链接逃逸。
- [`src/tools/read-skill-tool.ts`](../src/tools/read-skill-tool.ts)：注册只读的 `read_skill` Tool。它只能读取 Loader 已发现和校验的 Skill，因此不重复弹出 Permission 审批；参数 Schema 强制要求 `name` 且拒绝额外字段。
- [`src/app-server/main.ts`](../src/app-server/main.ts)：默认加载 `<workspace>/skills`，也支持 `AGENT_SKILLS_PATH`；将 Skill 目录追加到 Agent Instructions，并在发现 Skill 后注册 `read_skill`。
- [`skills/finance-analysis/SKILL.md`](../skills/finance-analysis/SKILL.md)：第一份示例 Skill，继续约束金额由确定性金融 Tool 计算，LLM 只负责选择和解释。
- [`tests/skill-loader-test.ts`](../tests/skill-loader-test.ts) 与 [`tests/read-skill-tool-test.ts`](../tests/read-skill-tool-test.ts)：验证正常发现、重复名称、目录名不匹配、路径逃逸、按名称读取和严格参数 Schema。

### 推荐阅读顺序

```text
token-counter.ts
  -> context-compactor.ts
  -> tool-output-limiter.ts
  -> agent-loop.ts
  -> permission-gate.ts
  -> workspace-command-runner.ts
  -> skill-loader.ts
  -> read-skill-tool.ts
  -> app-server/main.ts
```

## 验证结果

```text
npm run check  通过
npm test       142/142 通过
```

下一阶段边界：可以选择 MCP Client 或 Electron；当前不同时进入两者，也不进入 Multi-Agent。
