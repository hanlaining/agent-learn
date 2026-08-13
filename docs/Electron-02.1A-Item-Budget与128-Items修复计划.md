# Electron 02.1A：Item Budget 与 128 Items 修复计划

> 日期：2026-08-12  
> 项目：`D:\练手\agent-learn`  
> 状态：总体方案待确认，尚未修改业务代码  
> 前置诊断：[`Electron-02.1-Codex客户端差距与流式Reasoning排查.md`](./Electron-02.1-Codex客户端差距与流式Reasoning排查.md)

## 1. 结论

本切片只解决一个问题：在 OpenAI Responses Provider 发起请求前，同时约束 Token Budget 和 Provider 最终 input item 数量，防止短小但数量很多的 items 绕过 Token Compaction，最终因超过 128 items 而被上游拒绝。

推荐采用两层防线：

- Runtime 软阈值：120 个 Provider items，达到时复用现有 Context Compaction；
- Provider 硬上限：128 个最终编码后的 input items，超过时必须在本地、联网前拒绝。

本切片不修改 Reasoning UI、错误 UI、Activity 持久化、Permission、Skill、MCP 或 Multi-Agent。

## 2. 已验证证据

2026-08-11 已重新运行当前基线：

```text
npm run check          通过
npm test               172/172 通过
npm run electron:build 通过
```

使用当前真实 `ContextBuilder → TokenBudget → AgentLoop` 做了不联网隔离诊断：

| 输入 items | Token 估算 | Token 是否触发压缩 | 实际提交 items |
|---:|---:|:---:|---:|
| 127 | 635 | 否 | 127 |
| 128 | 640 | 否 | 128 |
| 129 | 645 | 否 | 129 |

当前 App Server 使用：

```ts
usePreviousResponseId: false
```

因此一个逻辑 `LlmFunctionOutput` 会在 OpenAI Provider 边界编码为：

```text
function_call
+ function_call_output
= 2 个 Provider items
```

隔离诊断结果：

| 逻辑 Tool Outputs | 最终 Provider items |
|---:|---:|
| 64 | 128 |
| 65 | 130 |

这证明：

1. Token Budget 和 Item Budget 是两个独立维度；
2. 不能用 `request.input.length` 直接代表 Provider items；
3. Runtime 需要提前估算，Provider 必须对最终编码结果做精确断言；
4. 当前本机状态没有保存原始 135-item 请求，因此本切片要用确定性测试覆盖 135，而不是依赖不可重复的线上故障。

## 3. 当前链路与缺口

当前链路：

```text
LifecycleStore
→ ContextBuilder 构造 LlmMessage[]
→ TokenBudget 只检查 token
→ 达到 96k tokens 才调用 ContextCompactor
→ AgentLoop.requestModel()
→ OpenAiResponsesProvider.createInputItems()
→ 生成 body.input
→ fetch
```

缺口：

- `TokenBudget` 没有 item 维度；
- `ContextCompactor` 的摘要请求只按 token 裁剪；
- 压缩后的替换历史只按 user message token 数保留，短消息很多时仍可能保留过多 items；
- Agent Loop 的初次请求和 Tool 续轮没有统一的 item 预检；
- 无状态 Tool Output 会在 Provider 边界从 1 个逻辑 item 膨胀为 2 个 Provider items；
- Provider 对最终 `body.input.length` 没有硬断言；
- 超限后只能依赖上游 HTTP 400，既晚又难诊断。

## 4. 设计原则

### 4.1 两层检查，不依赖单点

Runtime 负责提前决策：是否应压缩、是否无需联网就已确定越界。

Provider 负责最后兜底：只相信实际编码完成后的 `body.input.length`，超过 128 时禁止调用 `fetch`。

### 4.2 按 Provider 编码成本计数

Item Budget 的计数单位不是 Lifecycle Item，也不是简单的逻辑输入数组长度，而是“预计会编码成多少个 Provider input items”。

当前计数规则：

| Runtime 输入 | 有状态续接 | 当前无状态续接 |
|---|---:|---:|
| 字符串 input | 1 | 1 |
| User/Assistant Message | 1 | 1 |
| Function Output | 1 | 2 |

`functionOutputItemCost` 必须是显式配置，不能隐藏在魔法判断中。App Server 要让它与 `usePreviousResponseId` 使用同一配置来源，避免两边漂移。

### 4.3 软阈值与硬上限职责不同

- 120 是自动 Compaction 的软阈值；
- 128 是绝不允许越过的 Provider 硬上限；
- 120～128 的 8-item 空间用于边界余量和未来输入形态扩展；
- Provider 硬断言仍然是最终事实，不能只依赖软阈值。

### 4.4 不静默丢弃 Tool Call/Result 配对

Tool 续轮中的 `function_call` 和 `function_call_output` 是协议配对，不能为凑数量随意删除一半，也不能伪造模型未执行过的结果。

如果一轮模型返回的 Function Calls 在无状态回放后必然超过 128：

1. 在执行任何 Tool 前完成预检；
2. 本地拒绝该轮；
3. 不执行有副作用的 Tool；
4. 不发送超限请求；
5. 错误只包含安全计数，不包含 Tool 参数或输出正文。

### 4.5 Compaction 只处理它真正拥有的数据

当前跨 Turn Context 只回放 User 与 Assistant 消息。公开 Reasoning Summary 和托管 Web Search 是流式事件，不是当前 Lifecycle 回放项。

因此 02.1A 只压缩真实 `LlmMessage` 历史，不伪造“Search/Reasoning 中间项压缩”。未来 02.1E 建立 Activity 持久化后，再为新增 Item 类型扩展计数策略。

## 5. 建议的数据结构

新增独立模块 `src/runtime/item-budget.ts`，职责只有计数、评估和安全断言，不负责摘要或修改输入。

建议接口：

```ts
interface ItemBudgetOptions {
  maxInputItems: number;
  compactThresholdItems: number;
  functionOutputItemCost: 1 | 2;
}

interface ItemBudgetAssessment {
  estimatedItems: number;
  remainingItems: number;
  maxInputItems: number;
  compactThresholdItems: number;
  shouldCompact: boolean;
  exceedsLimit: boolean;
}

class ItemBudget {
  assess(input: string | readonly LlmInputItem[]): ItemBudgetAssessment;
  assertWithinLimit(input: string | readonly LlmInputItem[]): void;
  assessFunctionOutputCount(count: number): ItemBudgetAssessment;
}
```

超限错误建议使用独立类型：

```ts
class InputItemBudgetExceededError extends Error {
  readonly estimatedItems: number;
  readonly maxInputItems: number;
}
```

错误消息只允许出现计数，例如：

```text
Provider input item limit exceeded: 130 > 128
```

禁止携带：

- 用户消息正文；
- Tool 参数或结果；
- Provider Key；
- 环境变量；
- 本机绝对路径；
- 原始请求对象。

## 6. 目标数据流

### 6.1 首次模型请求

```text
ContextBuilder.build(turnId)
→ 得到当前 LlmMessage[]
→ TokenBudget.assess(input)
→ ItemBudget.assess(input)
→ token 或 item 达到软阈值？
   ├─ 否：继续
   └─ 是：ContextCompactor.compact(input)
          → 摘要输入同时限制 token 和 item
          → 替换历史限制最近 user message 数量
          → 保留当前用户目标
→ 重新评估 Token Budget
→ 重新评估 Item Budget
→ Runtime 硬断言
→ Provider 编码 body.input
→ Provider 对 body.input.length 做最终硬断言
→ fetch
```

### 6.2 Tool 续轮

```text
模型返回 functionCalls
→ 根据 functionCalls.length 预估后续 Provider items
→ 预计超过 128？
   ├─ 是：不执行任何 Tool，本地安全失败
   └─ 否：Permission → Tool 执行 → ToolOutputLimiter
→ ItemBudget 再检查真实 LlmFunctionOutput[]
→ Provider 编码 function_call + function_call_output
→ 最终 body.input.length 硬断言
→ fetch
```

这里不对 Tool Output 做“删项压缩”。Tool Output 的文本大小继续由现有 `ToolOutputLimiter` 控制；item 数量由 `ItemBudget` 控制。

### 6.3 Compaction 请求自身

```text
原始历史
→ 每条消息先执行现有 token 截断
→ 从最新向前同时受 maxSummaryInputTokens 限制
→ 同时受 maxSummaryInputItems=120 限制
→ 最后追加 CODEX_COMPACTION_PROMPT
→ Provider 最终硬断言
→ 得到摘要
→ 最多保留最近 32 条真实 user messages
→ 追加 1 条 summary message
→ 替换历史最多 33 items
```

`maxSummaryInputItems=120` 包含最后的 Compaction Prompt，所以最多选择 119 条历史消息。

替换历史建议最多保留 32 条真实 user messages，再加 1 条摘要。这个数量远低于 120，可为后续 Turn 留出确定空间；当前用户消息位于历史末端，必须优先保留。

## 7. 阈值选择依据

### 7.1 Provider 硬上限：128

128 来自历史上游诊断记录，并作为本切片兼容目标。Provider 必须对实际编码结果执行 `<= 128` 断言。

即使未来上游提升限制，也应通过显式配置和测试调整，不能从错误文案动态猜测。

### 7.2 Runtime 软阈值：120

选择 120 的理由：

- 比 128 少 8 个 items；
- 等价于当前无状态模式下 4 组完整 Function Call/Output；
- 不会像 110 那样过早压缩正常历史；
- 经过 Compaction 后替换历史最多约 33 items，不会反复贴着阈值运行；
- Provider 最终仍有 128 硬断言，软阈值不是唯一安全措施。

### 7.3 最近用户消息上限：32

当前 Compactor 已通过摘要保存较早上下文，替换历史中的真实 user messages 主要用于保留近期目标和原话。

32 条是本切片建议默认值，必须通过以下测试证明：

- 当前用户目标永远保留；
- 最近消息顺序不变；
- 边界之外的信息已进入摘要；
- 再次 Compaction 不保留旧摘要为真实用户消息；
- 输出 item 数稳定低于软阈值。

如果测试发现 32 与现有行为冲突，应调整为更小的确定值；不能取消 item 上限退回纯 token 逻辑。

## 8. 文件清单与用途

### 8.1 新增文件

#### `src/runtime/item-budget.ts`

用途：

- 定义 Item Budget 配置和评估结果；
- 按 Provider 编码成本计算预计 items；
- 校验正整数、软阈值不高于硬上限；
- 提供安全超限错误；
- 不读取消息正文，不执行 Compaction，不访问网络。

#### `tests/item-budget-test.ts`

用途：

- 验证字符串、Message、Function Output 的计数；
- 验证有状态成本 1 和无状态成本 2；
- 验证 119/120、127/128/129/135 边界；
- 验证非法配置；
- 验证错误只包含安全计数。

### 8.2 修改文件

#### `src/agent/agent-loop.ts`

用途：

- 注入或创建默认 `ItemBudget`；
- 首次请求同时评估 Token 与 Item；
- 任一软阈值达到时复用现有 `ContextCompactor`；
- 压缩后重新评估并执行硬断言；
- 每次 `requestModel()` 前进行 Runtime 预检；
- Function Calls 返回后、执行 Tool 前预检无状态回放成本；
- 保留现有最大 Tool 轮次、Cancel、Timeout 和 Lifecycle 终态逻辑。

不在本文件中实现 Provider 编码，也不把请求内容写入错误或事件。

#### `src/runtime/context-compactor.ts`

用途：

- 为摘要请求增加 `maxSummaryInputItems`；
- 选取摘要输入时同时满足 token 和 item 限制；
- 为替换历史增加 `maxRetainedUserMessages`；
- 保持从最新向前选择、恢复原始顺序和排除旧摘要的现有行为；
- 明确保证当前用户目标保留。

#### `src/llm/openai-responses.ts`

用途：

- 在 `body.input` 完成最终编码后读取精确 `length`；
- 超过配置的 `maxInputItems` 时，在 `fetchWithRetry()` 前抛出安全错误；
- 允许正好 128；
- 129 和 135 必须保证 Fetch 调用次数为 0；
- 保持 SSE、Retry、Cancel、Reasoning 和 Web Search 行为不变。

#### `src/app-server/main.ts`

用途：

- 集中声明当前 Provider 输入策略：

```text
usePreviousResponseId = false
maxInputItems = 128
compactThresholdItems = 120
functionOutputItemCost = 2
```

- 同一组配置同时传给 `OpenAiResponsesProvider` 和 `ItemBudget`；
- 避免 Provider 使用无状态回放，而 Runtime 却按有状态成本计数。

不把阈值暴露给 Renderer，也不读取新的环境变量。

#### `tests/context-compactor-test.ts`

用途：

- 验证大量短消息不会让摘要请求越过 120；
- 验证 Compaction Prompt 始终位于最后；
- 验证当前用户目标和最近 32 条用户消息保留；
- 验证替换历史最多 33 items；
- 验证现有 token 截断和二次压缩行为不回归。

#### `tests/agent-loop-test.ts`

用途：

- 验证 item 达阈值、token 未达阈值时仍触发 Compaction；
- 验证压缩后 Agent Loop 继续完成；
- 验证 Provider 调用前执行最终预检；
- 验证过多 Function Calls 不会执行任何 Tool；
- 验证边界内最新 Tool Result 原样进入下一次模型请求；
- 验证 LifecycleStore 仍保存完整 Tool Result；
- 验证 Cancel、Timeout 和最大 Tool 轮次不回归。

#### `tests/openai-responses-test.ts`

用途：

- 验证 127、128、129、135 个最终 Provider items；
- 验证正好 128 可以进入 Fetch；
- 验证 129、135 在联网前被拒绝；
- 验证 64 个无状态 Tool Outputs 编码成 128；
- 验证 65 个编码成 130 并被拒绝；
- 验证错误不包含输入、Tool 参数或 Tool 输出；
- 保持 Retry、Cancel、SSE、Reasoning 和 Web Search 测试通过。

#### `tests/electron-desktop-controller-test.ts`

用途：

- 模拟 Runtime 返回安全 Item Budget 错误；
- 验证 Renderer 仍只收到固定失败文案；
- 验证 DesktopEvent 不包含请求正文、Tool 参数或原始错误对象。

02.1B 才负责实现结构化安全错误 DTO；02.1A 不扩大 Electron 错误展示能力。

#### `package.json`

用途：

- 把新增的 `tests/item-budget-test.ts` 加入当前显式测试列表。

不新增依赖，不修改 `package-lock.json`。

## 9. 实施切片

实现时仍拆成四个可独立验证的小切片，不一次铺开所有文件。

### 切片 A1：Item Budget 纯模块

目标：建立确定性的 item 计数规则，不接入 Agent Loop。

变更文件：

- `src/runtime/item-budget.ts`；
- `tests/item-budget-test.ts`；
- `package.json`。

验证命令：

```powershell
npx tsx --test tests/item-budget-test.ts
npm run check
```

回滚点：删除新增模块和测试，并从 `package.json` 测试列表移除该文件；不影响现有 Runtime。

### 切片 A2：Compactor 双预算

目标：保证 Compaction 请求和替换历史都不会因短消息数量过多而逼近 128。

变更文件：

- `src/runtime/context-compactor.ts`；
- `tests/context-compactor-test.ts`。

验证命令：

```powershell
npx tsx --test tests/item-budget-test.ts tests/context-compactor-test.ts
npm run check
```

回滚点：恢复 Compactor 原有纯 token 选择逻辑；A1 纯模块仍可独立保留。

### 切片 A3：Agent Loop 接入

目标：首次请求按 Token 或 Item 触发压缩，并在 Tool 执行前防止必然超限的续轮。

变更文件：

- `src/agent/agent-loop.ts`；
- `tests/agent-loop-test.ts`。

验证命令：

```powershell
npx tsx --test tests/item-budget-test.ts tests/context-compactor-test.ts tests/agent-loop-test.ts tests/turn-cancel-test.ts
npm run check
```

回滚点：移除 Agent Loop 的 Item Budget 接线；Token Budget、Cancel、Timeout 和 Tool Loop 保持原实现。

### 切片 A4：Provider 硬断言与客户端回归

目标：在最终网络边界兜住所有漏网情况，并完成 CLI/Electron 回归。

变更文件：

- `src/llm/openai-responses.ts`；
- `src/app-server/main.ts`；
- `tests/openai-responses-test.ts`；
- `tests/electron-desktop-controller-test.ts`。

验证命令：

```powershell
npx tsx --test tests/openai-responses-test.ts tests/agent-loop-test.ts tests/electron-desktop-controller-test.ts
npm run check
npm test
npm run electron:build
node bin/god-agent.js --version
```

回滚点：移除 Provider 硬断言和 App Server 配置接线；A1～A3 仍能单独回滚。任何真实回滚都必须逐文件执行，不能使用破坏性 Git 命令。

## 10. 测试矩阵

### 10.1 Item Budget 单元测试

| 场景 | 预期 |
|---|---|
| 字符串 input | 计为 1 |
| 119 条消息 | 不触发压缩 |
| 120 条消息 | 触发压缩 |
| 127 条消息 | 未超过硬上限 |
| 128 条消息 | 未超过硬上限 |
| 129 条消息 | 超过硬上限 |
| 135 条消息 | 超过硬上限 |
| 64 个无状态 Tool Outputs | 计为 128 |
| 65 个无状态 Tool Outputs | 计为 130 |
| 软阈值大于硬上限 | 构造时拒绝 |
| 非正整数阈值 | 构造时拒绝 |

### 10.2 Compaction 测试

| 场景 | 预期 |
|---|---|
| 129 条极短消息 | 因 Item Budget 触发压缩 |
| 摘要请求 | 最多 120 items |
| 替换历史 | 最多 32 条真实 user + 1 条摘要 |
| 当前用户目标 | 始终保留且顺序正确 |
| 旧 Compaction Summary | 不当成真实 user message 保留 |
| 单条超长消息 | 继续受 token 截断保护 |
| 二次 Compaction | 不重复堆叠旧摘要 |

### 10.3 Agent Loop 测试

| 场景 | 预期 |
|---|---|
| Token 达阈值、Item 未达 | 触发现有 Compaction |
| Item 达阈值、Token 未达 | 同样触发 Compaction |
| 压缩后模型返回最终文本 | Turn 正常 completed |
| 65 个无状态 Tool Calls | Tool 执行次数为 0，本地失败 |
| 边界内 Tool Calls | Permission、执行、结果回放正常 |
| 最新 Tool Result | 模型副本存在；Lifecycle 完整结果存在 |
| Cancel | Turn 进入 interrupted |
| Timeout | Turn 进入 timed_out |
| 最大 Tool 轮次 | 现有保护不变 |

### 10.4 Provider 测试

| 最终 `body.input.length` | 预期 Fetch 次数 |
|---:|---:|
| 127 | 1 |
| 128 | 1 |
| 129 | 0 |
| 135 | 0 |

### 10.5 回归测试

- CLI 默认模式；
- CLI `--debug`；
- CLI 消息队列；
- CLI `/cancel`；
- MCP Tool 闭环；
- Electron App Server 握手和关闭；
- Electron 流式 Assistant、Reasoning、Search Activity；
- Provider SSE、Retry、Cancel；
- Runtime 持久化和 Checkpoint 恢复。

## 11. 验收标准

以下条件必须全部满足：

- [ ] 119 items 不因 Item Budget 压缩；
- [ ] 120 items 触发 Compaction；
- [ ] 127、128、129、135 边界均有确定性测试；
- [ ] 128 个最终 Provider items 可以发送；
- [ ] 129 和 135 在 `fetch` 前本地拒绝；
- [ ] Token 未超限但 Item 超限时仍会压缩或安全失败；
- [ ] Compaction 请求自身不超过 120 items；
- [ ] 压缩后当前用户目标不丢失；
- [ ] 最近用户消息顺序不变；
- [ ] 最新 Tool Result 在合法续轮中不丢失；
- [ ] LifecycleStore 仍保存完整 Tool Result；
- [ ] 必然超限的 Function Calls 不执行任何 Tool；
- [ ] 超限错误不包含消息正文、Tool 参数、输出、Key、env 或路径；
- [ ] Renderer 不接收原始请求和原始错误对象；
- [ ] Cancel 和 Timeout 无回归；
- [ ] 最大 Tool 轮次无回归；
- [ ] CLI 默认模式和 `--debug` 无回归；
- [ ] Electron 无回归；
- [ ] `npm run check` 通过；
- [ ] `npm test` 全部通过，测试数量如实增加；
- [ ] `npm run electron:build` 通过；
- [ ] `node bin/god-agent.js --version` 仍输出 `god-agent 1.0.0`；
- [ ] 不新增依赖，不修改 lockfile；
- [ ] 不修改 Runtime 持久化格式。

## 12. 风险与处理

### 风险 1：Runtime 估算与 Provider 最终编码漂移

处理：App Server 使用同一组配置驱动 `usePreviousResponseId` 和 `functionOutputItemCost`；Provider 仍对最终编码结果做精确断言。

### 风险 2：Compaction 结果仍接近阈值

处理：替换历史增加最多 32 条真实 user messages 的确定上限，目标输出约 33 items，而不是只靠 token 估算。

### 风险 3：为满足上限错误删除 Tool 配对

处理：禁止删半组或静默漏回 Tool Result。必然超限时在 Tool 执行前失败。

### 风险 4：过早压缩降低上下文质量

处理：软阈值选择 120，并由 Handoff Summary 加最近 32 条真实用户消息保留任务连续性；通过当前目标和最近上下文测试验证。

### 风险 5：把 02.1B 错误 DTO 混入本切片

处理：02.1A 只使用内部安全错误和现有桌面固定失败文案。结构化错误分类、错误码和可展示诊断留给 02.1B。

### 风险 6：误把 Provider Search/Reasoning 当成持久化 Item

处理：当前只按真实 LLM input 类型计数。等 Activity Persistence 建模后，再明确扩展 Provider item 映射。

## 13. 回滚边界

本切片只允许涉及：

- Item Budget 新模块；
- Context Compactor 的 item 上限；
- Agent Loop 的双预算接线；
- OpenAI Provider 最终断言；
- App Server 的集中阈值配置；
- 对应测试和 `package.json` 测试列表。

本切片不得回滚或修改：

- JSON-RPC / JSONL / Connection；
- LifecycleStore 持久化格式；
- Tokenizer 和现有 Token Budget 语义；
- Skill Loader；
- MCP；
- Permission 机制；
- CLI 输入队列与取消；
- Electron Main/Preload/Renderer 安全分层；
- Reasoning、Search、Sources UI；
- 用户现有未提交修改。

未经明确授权，不执行任何 Git、commit、push、PR、merge、rebase、reset 或 checkout。需要回滚时按本计划的切片和文件逐项恢复，不使用破坏性命令。

## 14. 明确不在本切片实现

- 结构化安全错误 DTO（02.1B）；
- 分块流式 Reasoning 数据模型（02.1C）；
- Markdown 和 Codex 风格过程 UI（02.1D）；
- Activity 历史恢复（02.1E）；
- Permission 弹窗；
- Sources 安全打开；
- 任意 Shell 或 Terminal；
- MCP 扩展；
- Multi-Agent、Supervisor 或 Sub-Agent；
- Worktree、并行任务或产品级多任务 Runtime 重写；
- Provider 限制的在线探测或从错误文案动态调整阈值。

## 15. 实施前确认项

开始修改业务代码前，需要确认以下方案：

1. Runtime 软阈值使用 120；
2. Provider 硬上限使用 128；
3. 无状态 Function Output 成本按 2 计算；
4. Compaction 摘要请求最多 120 items；
5. 替换历史最多保留最近 32 条真实 user messages，再追加 1 条摘要；
6. 必然超限的 Function Calls 在任何 Tool 执行前失败；
7. 本轮只实现 02.1A，不顺带实现 02.1B～02.1E。

确认后按 A1 → A2 → A3 → A4 顺序实施，每个切片完成验证后再进入下一切片。

## 16. 总体产品目标：Codex 风格 Runtime 实时会话

02.1A 修复的是当前 Runtime 会真实失败的基础问题。完成 02.1A 后，桌面客户端的下一目标不是继续堆叠调试日志，而是实现面向普通用户的 Codex 风格 Runtime Mode。

Runtime Mode 的核心不是只展示 `Planning / Searched / Ran / Edited` 等执行步骤，而是让 Agent 在执行过程中持续输出自然、简短、公开的实时会话片段，再把 Tool、Search、Command 等结构化状态穿插在这些会话片段之间。

目标展示顺序：

```text
用户消息
→ Runtime 实时会话片段
→ 可折叠 Activity
→ Runtime 实时会话片段
→ 可折叠 Reasoning Summary
→ Tool / Search / Command 状态
→ Runtime 实时会话片段
→ 最终 Assistant 回答
```

不能退化为：

```text
Planning
Searched
Ran
Edited
```

因为只有步骤标签时，用户仍然不知道 Agent 当前的判断、下一步意图和阶段性结论。

## 17. 目标界面草图

### 17.1 Turn 运行中

```text
┌──────────────────────────────────────────────────────────────┐
│ 用户                                                         │
│ 请修复 128 Items 问题                                        │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│ 已处理 6 秒                                                  │
│                                                              │
│ 我先检查 Context Builder、Agent Loop 和 Provider 的输入编码  │
│ 路径，确认上限应该在哪一层处理。                              │
│                                                              │
│ Planning item budget investigation                     ˅     │
│ ✓ 已读取 4 个相关文件                                        │
│ ◌ 正在分析 Provider 编码                                     │
│                                                              │
│ 已处理 18 秒                                                 │
│                                                              │
│ 已确认当前只有 Token Budget。短消息数量很多时，即使只有几百  │
│ 个 Token，也会直接提交超过 128 个 input items。               │
│                                                              │
│ 我现在构造 127、128、129 三个边界，验证真实提交数量。          │
│                                                              │
│ Running boundary verification                          ˅     │
│ ✓ 127 items：允许                                            │
│ ✓ 128 items：允许                                            │
│ ◌ 正在验证 129 items                                         │
└──────────────────────────────────────────────────────────────┘
```

### 17.2 Turn 完成后

自然语言过程保留；操作明细默认折叠：

```text
我先检查了当前输入构造和 Provider 编码路径。

已确认 Token Budget 无法阻止大量短 items 越界，因此增加了
独立 Item Budget，并在 Provider 请求前加入最终断言。

⌄ 已处理 31 秒 · 读取 4 个文件 · 运行 3 项验证

Item Budget 修复完成。

- 120 items 自动压缩
- 128 items 为硬上限
- 129+ items 在联网前拒绝
- 全部测试通过
```

### 17.3 Turn 失败后

已经产生的过程不能被统一错误文案覆盖或删除：

```text
我已经完成上下文检查，正在验证 Provider 边界。

⌄ 已处理 45 秒 · 搜索 2 次 · 请求未完成

✓ 已分析上下文
✓ 已完成第一次搜索
! Provider 请求失败

请求未能完成，请重试。
[查看安全错误摘要]
```

Cancel 和 Timeout 也必须结束所有 running 动画，并分别显示“已取消”和“已超时”，不能继续呈现“正在运行”。

## 18. Runtime 内容模型

### 18.1 实时过程会话

```ts
interface RuntimeCommentary {
  id: string;
  turnId: string;
  round: number;
  kind: "commentary";
  status: "streaming" | "completed";
  markdown: string;
  startedAt: string;
  completedAt?: string;
}
```

`RuntimeCommentary` 是用户可见的过程沟通，例如：

```text
我先检查当前实现，确认问题发生在 Runtime 计数还是 Provider 编码阶段。

当前源码只检查 Token Budget。我接下来会构造 127、128、129 条短消息，验证它们是否会绕过压缩。
```

它不是原始日志，不是 Tool 参数，也不是模型私有 Chain-of-Thought。

### 18.2 结构化 Activity

```ts
interface RuntimeActivity {
  id: string;
  turnId: string;
  round: number;
  kind:
    | "planning"
    | "explored"
    | "searched"
    | "read"
    | "ran"
    | "edited"
    | "context";
  status:
    | "running"
    | "completed"
    | "failed"
    | "cancelled";
  title: string;
  summary?: string;
  safeDetails?: string[];
  startedAt: string;
  completedAt?: string;
}
```

Activity 回答“具体执行到了哪里”，但不能替代 Commentary。

### 18.3 公开 Reasoning Summary

```ts
interface RuntimeReasoningSummary {
  id: string;
  turnId: string;
  round: number;
  summaryIndex: number;
  kind: "reasoning_summary";
  status: "streaming" | "completed";
  markdown: string;
}
```

只允许保存和显示 Provider 明确返回的公开 Reasoning Summary。禁止请求、推导、保存或展示模型私有 Chain-of-Thought。

### 18.4 错误条目

```ts
interface RuntimeSafeError {
  id: string;
  turnId: string;
  kind: "error";
  code: string;
  title: string;
  safeMessage: string;
  retryable: boolean;
}
```

错误只传安全分类和用户可读摘要，不能把原始请求、响应正文或异常对象送进 Renderer。

### 18.5 Turn 有序内容

```ts
type RuntimeContent =
  | RuntimeCommentary
  | RuntimeActivity
  | RuntimeReasoningSummary
  | RuntimeSafeError;

interface RuntimeSession {
  turnId: string;
  status:
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "timed_out";
  startedAt: string;
  completedAt?: string;
  items: RuntimeContent[];
}
```

`items` 必须保持真实事件顺序，才能形成“会话 → 操作 → 会话 → 最终回答”，不能由 Renderer 按类型重新分组。

## 19. Runtime Commentary 的来源与归类

### 19.1 模型真实公开输出

模型在调用 Tool 前可输出简短、面向用户的阶段说明：

```text
我先检查相关文件，确认当前预算逻辑在哪里执行。
```

如果该模型轮次随后返回 Function Calls，这段公开文本归入 `RuntimeCommentary`，而不是最终回答。

### 19.2 Runtime 安全兜底

如果模型直接调用 Tool、没有输出任何公开说明，Runtime 可以根据结构化事件补充一条克制的状态：

```text
正在检查相关实现……
```

兜底文案必须来自固定模板，只能使用清洗后的 Tool 显示名或动作类型，不能包含原始参数、环境变量、Key、完整路径或 Tool Result 正文。

### 19.3 每轮模型输出归类

```text
模型第 N 轮开始
→ output_text.delta 进入临时 streaming 块
→ response 完成
   ├─ 存在 Function Calls
   │  → 文本确认为 RuntimeCommentary
   │  → 执行 Tool
   │  → 开始下一轮模型请求
   │
   └─ 不存在 Function Calls
      → 文本确认为最终 Assistant 回答
      → UI 从临时位置平滑提升为最终回答
      → 禁止重复显示两份相同文本
```

当前 `LlmResponse` 已同时包含 `text` 和 `functionCalls`，但现有 Agent Loop 在存在 Function Calls 时没有把 `text` 作为过程会话持久化。Runtime 01 必须明确支持这个归类，而不是把所有 `output_text_delta` 都直接写成最终 Assistant 消息。

## 20. Runtime 用户体验规则

### 20.1 流式与滚动

- Commentary 和公开 Reasoning Summary 按小段流式显示；
- Renderer 使用动画帧或短时间窗口批量合并 Delta，避免每个字符触发完整重渲染；
- 用户停留在底部时自动跟随；
- 用户主动向上滚动后暂停自动跟随；
- 提供轻量“回到底部”入口；
- 新条目出现时不能让页面大幅跳动。

### 20.2 状态更新

- 同一 Tool、Search 或 Command 使用稳定 ID 更新原条目；
- 不把 `started / searching / completed` 渲染成三条重复记录；
- 当前步骤使用低干扰的呼吸或旋转状态；
- completed、failed、cancelled、timed_out 必须停止动画；
- 失败后保留所有已完成条目和 Commentary。

### 20.3 折叠行为

- Turn 运行中默认展开当前 Activity；
- Turn 完成后延迟约 500ms 自动折叠操作明细；
- Commentary 默认继续可见，不应全部折叠消失；
- 用户手动展开后，本次会话不再强制自动折叠；
- 折叠标题显示“已处理 X 秒/分钟”和 Read、Search、Run、Edit 数量；
- 切换任务或重启客户端后恢复用户上次的展开状态可作为后续增强，不阻塞最小版本。

### 20.4 Markdown

- Commentary、Reasoning Summary 和最终回答支持相同的安全 Markdown 子集；
- 至少支持段落、列表、粗体、行内代码、代码块和安全链接；
- 禁止原始 HTML、脚本、事件属性和危险协议；
- Sources 链接必须继续走 Electron 安全打开链路，不能直接交给页面导航。

## 21. Runtime 安全边界

Renderer 可以看到：

- 用户可见 Commentary；
- Provider 公开 Reasoning Summary；
- 清洗后的 Activity 标题和状态；
- 工作区相对路径或安全文件名；
- 受限命令显示名，例如 `npm run check`；
- 结构化安全错误。

Renderer 不能看到：

- 模型私有 Chain-of-Thought；
- Provider encrypted reasoning；
- Key、Token、Cookie 或 Authorization；
- 环境变量；
- 任意完整本机绝对路径；
- 原始 Tool arguments；
- 未限制的 Tool Result；
- 原始 JSON-RPC、IPC channel 或异常对象；
- App Server stdout 上除 JSONL 以外的诊断文本。

Main、Preload、Renderer 继续使用固定白名单 DTO；Renderer 不能访问 Node、文件系统、`child_process` 或 `process.env`。

## 22. Runtime Mode 实施路线

Runtime Mode 必须在 02.1A 通过后再实施，并拆成独立切片。

### Runtime 01：过程会话与有序数据模型

目标：支持 Commentary、Activity、Reasoning Summary、Safe Error 的有序 RuntimeSession，不先追求完整视觉。

主要范围：

- 扩展 LLM/Agent Event，使模型有 Function Calls 时的公开文本成为 Commentary；
- 按 `turnId + round + summaryIndex` 分块；
- 区分 Commentary 与最终 Assistant；
- 保持事件顺序；
- 不重复最终文本；
- 建立安全 DTO。

验证：事件顺序、Delta 合并、Function Calls 归类、最终回答提升、失败/取消/超时终态。

回滚点：只撤销 RuntimeSession 新模型和接线，不触碰 02.1A、Token Budget、Item Budget、Skill 或 MCP。

### Runtime 02：Codex 风格实时 UI

目标：实现截图风格的过程会话、内嵌 Activity、处理时间、平滑滚动和完成后折叠。

开始编码前必须再次确认最终 ASCII 草图。

主要范围：

- 新建 Runtime Session/Timeline 组件；
- Commentary Markdown 流式渲染；
- Activity 状态更新；
- 已处理时间；
- 自动跟随与用户滚动锁；
- 完成后折叠；
- 失败保留过程；
- 最终回答视觉分隔。

验证：真实 Electron 手动验收、长文本不跳动、用户向上滚动不被拉回、Turn 完成后无重复消息。

### Runtime 02.2：Codex 式根因排查 Commentary 与过程压缩

目标：补齐 Runtime 02 已能展示、但不能稳定产生的公开排查叙事，并把 Commentary、Activity 和公开 Reasoning Summary 组成可整体压缩的过程区。

详细方案：

- [`Electron-02.2-Codex式根因排查Commentary与过程压缩计划.md`](./Electron-02.2-Codex式根因排查Commentary与过程压缩计划.md)

主要范围：

- Agent 在 Tool 前公开说明排查目标；
- 获取关键证据后公开说明阶段发现和下一步；
- 严格区分“目前怀疑”与“已经锁定根因”；
- 成功后自动压缩整个公开过程区，而不仅是 Activity；
- 失败、取消和超时默认展开并保留过程；
- 最终 Assistant 和安全错误始终位于过程区外；
- 不展示或伪造模型私有 Chain-of-Thought。

验证：公开 Commentary 协议、Function Calls 分类、过程与结果拆分、两级折叠、终态行为、CLI 回归和 Electron 构建。

### Runtime 03：Activity 历史持久化与恢复

目标：切换任务、重启客户端或失败后，可以恢复 Commentary、公开 Reasoning、Tool、Search、Sources 和安全错误。

主要范围：

- 版本化 Runtime Activity 持久化结构；
- `thread/history` 返回安全 RuntimeSession；
- 新旧状态迁移或向后兼容；
- 失败 Turn 保留过程；
- 不持久化私有推理或敏感参数。

### Runtime 04：结构化安全错误与细节查看

目标：替代统一“Agent 执行失败”，让用户知道是超时、取消、输入预算、Provider 或 Tool 错误，同时不泄露敏感数据。

主要范围：

- 安全错误 code；
- 用户文案；
- retryable；
- 可折叠安全详情；
- 02.1A 的 Item Budget 错误映射；
- Renderer DTO 白名单。

## 23. Runtime Mode 验收标准

- [ ] 模型调用 Tool 前的公开文本实时显示为 Commentary；
- [ ] 模型调用 Tool 前的公开文本说明本阶段排查目标，而不是只有通用状态；
- [ ] 关键证据后可以公开说明阶段发现、判断依据和下一步验证；
- [ ] 证据不足时不把怀疑写成已锁定根因；
- [ ] Commentary 与 Tool/Search/Command 状态按真实顺序穿插；
- [ ] 有 Function Calls 的文本不会误当最终回答；
- [ ] 无 Function Calls 的最后文本只显示一次最终回答；
- [ ] Reasoning 按模型轮次和 `summaryIndex` 分块；
- [ ] 只展示公开 Reasoning Summary；
- [ ] Commentary、Reasoning 和最终回答支持安全 Markdown；
- [ ] 同一 Activity 更新原条目，不生成重复步骤；
- [ ] 显示“已处理 X 秒/分钟”；
- [ ] Turn 完成后 Activity 自动折叠，Commentary 继续可读；
- [ ] 整个公开过程区支持手动压缩，最终 Assistant 始终独立可见；
- [ ] 成功完成后整个公开过程区自动压缩；
- [ ] 失败、取消和超时默认展开已有过程；
- [ ] 用户手动展开后不被强制折叠；
- [ ] 用户在底部时自动跟随，向上滚动后停止跟随；
- [ ] Cancel、Timeout 和 Failed 结束全部 running 动画；
- [ ] 失败后已产生的 Commentary 和 Activity 不消失；
- [ ] 切换任务后可以恢复 Runtime 历史；
- [ ] 重启客户端后可以恢复 Runtime 历史；
- [ ] Renderer 不收到 Key、env、绝对路径、原始 Tool 参数或原始错误对象；
- [ ] CLI 默认模式和 `--debug` 行为保持兼容；
- [ ] 现有 Tool、Search、Reasoning、Sources 能力不回归；
- [ ] `npm run check`、完整测试和 `npm run electron:build` 全部通过。

## 24. 总体执行顺序

```text
Electron 02.1A
  A1 Item Budget 纯模块
  → A2 Compactor 双预算
  → A3 Agent Loop 接入
  → A4 Provider 硬断言与回归

确认 02.1A 验收通过
  ↓
Runtime 01 过程会话与有序数据模型
  ↓
Runtime 02 Codex 风格实时 UI
  ↓
Runtime 02.2 根因排查 Commentary 与过程压缩
  ↓
Runtime 03 Activity 历史持久化
  ↓
Runtime 04 结构化安全错误
```

每个切片都必须独立说明目标、文件、验证命令和回滚点；上一切片未验证通过，不进入下一切片。
