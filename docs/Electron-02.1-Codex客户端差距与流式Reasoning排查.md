# Electron 02.1：Codex 客户端差距与流式 Reasoning 排查

> 日期：2026-08-11  
> 项目：`D:\练手\agent-learn`  
> 文档性质：上一轮问题交接与诊断记录。文中“已观察”来自实际界面或诊断信息；“待复核”必须由当前源码、测试和可用运行记录独立验证，不能直接当成最终结论。

## 1. 当前实现基线

项目当前已经具备：

- JSON-RPC、JSONL、RequestMap 和双向 Connection；
- App Server；
- Thread、Turn、Item、LifecycleStore；
- Runtime 状态持久化和恢复；
- 跨 Turn Context Builder；
- o200k Tokenizer 与 Codex 式滚动 Compaction；
- OpenAI Responses SSE；
- Reasoning Summary SSE 捕获；
- Web Search、Sources 和 Citation；
- Agent Loop、Tool Registry、Workspace Sandbox 和 Permission 底层机制；
- Cancel、Timeout、Retry、Resume；
- god-agent CLI、Skill Loader、stdio MCP Tool 端到端；
- Electron Main 启动 App Server，完成 `initialize / initialized`；
- React + Vite Renderer；
- 左侧任务历史、新建、标题搜索和切换；
- 中央消息、流式回答和停止；
- Tool、Search、Reasoning Activity；
- 左右侧栏收缩、Runtime capabilities 展示；
- Main、Preload、Renderer 安全分层。

上一轮记录的自动化基线是：

```text
npm run check          通过
npm test               172/172 通过
npm run electron:build 通过
```

该结果只能作为历史参考，新任务必须重新运行验证。

## 2. 已观察到的真实故障

问题截图中出现：

- Web Search Activity 可以逐条显示；
- Reasoning Summary 被拼成一个连续字符串；
- `**Planning...**` 等 Markdown 被原样显示；
- 最后一个“正在联网搜索”没有完成；
- Turn 最终只显示“Agent 执行失败，请重试”。

上一轮诊断记录指向：

- 对应 Turn 被持久化为 `failed`；
- 失败发生在 Agent Loop 第 6 轮；
- 上游错误类型为 `invalid_response`；
- Responses 返回 HTTP 400；
- 上游最多接受 128 个 input items；
- Runtime 实际提交了 135 个 input items。

以上 128/135 数据在本轮仍标记为“待独立复核”。必须同时核对当前源码、输入构造路径、已有状态记录或可重复测试，不能只依赖本交接文档。

## 3. 待复核的根因假设

当前 Compaction 主要根据 Token Budget 触发，但没有独立的 Item Count Budget。

多轮 Web Search 后，显式回放的 User、Assistant、Reasoning、Search Call、Tool Call、Tool Result 等 item 持续增加。即使 token 尚未超限，item 数也可能超过 Provider 的 128 上限。

待验证的数据流：

```text
LifecycleStore 中的历史 Item
→ Context Builder 重建 Provider input
→ Token Budget 判断是否压缩
→ Agent Loop 追加本轮 Reasoning / Search / Tool items
→ OpenAI Responses Provider 请求
→ input items 可能超过 128
→ HTTP 400 invalid_response
→ Turn failed
→ DesktopController 把具体错误收敛成统一失败文案
```

### 3.1 2026-08-11 独立复核结果

本轮已从当前源码、脱敏状态元数据和隔离诊断重新复核，结果如下：

1. `TokenBudget` 只计算 token，没有 item 数量字段、软阈值或硬上限；
2. `AgentLoop` 只在一次 Turn 的首次 Provider 请求前检查 Token Budget，达到 token 阈值才调用 `ContextCompactor`；
3. `ContextCompactor.prepareSummaryInput()` 也只按 token 裁剪，压缩请求本身没有 item 数上限；
4. App Server 当前为 LovBrowser 无状态端点配置 `usePreviousResponseId: false`；一个逻辑 `LlmFunctionOutput` 会在 Provider 边界编码成一对 `function_call + function_call_output`，即两个 Provider items；
5. Provider 发起网络请求前没有对最终编码后的 `body.input.length` 做断言；
6. `DesktopController.sendMessage()` 和 `turn/failed` 会把上游具体错误统一替换为“Agent 执行失败，请重试”；
7. 当前 Lifecycle 只持久化 User、Assistant、本地 Tool Call 和本地 Tool Result。Provider 的公开 Reasoning Summary 与托管 Web Search 只作为流式事件转发，并没有作为 Lifecycle Item 显式回放。因此交接中“Runtime 显式回放 Reasoning / Search Call”的描述不符合当前源码，不能作为 135 items 的已证实组成。

不联网、使用真实 `ContextBuilder → TokenBudget → AgentLoop` 的隔离诊断结果：

| 构造的输入 items | Token 估算 | Token 是否触发压缩 | 实际交给 Provider 抽象的 items |
|---:|---:|:---:|---:|
| 127 | 635 | 否 | 127 |
| 128 | 640 | 否 | 128 |
| 129 | 645 | 否 | 129 |

无状态 Tool Output 编码诊断：

| 逻辑 Tool Outputs | 最终 Provider items |
|---:|---:|
| 64 | 128 |
| 65 | 130 |

因此已经独立证明：短小 items 可以在远未达到 Token Compaction 阈值时越过 128；预算必须按 Provider 最终编码后的数量计算，不能直接使用逻辑 `request.input.length`。

本机现存 Runtime 状态只有 5 个 Thread、12 个 Turn 和 20 个 Item，没有 135-item 请求快照；最近一次失败 Turn 约 45 秒结束，与当前 Provider 的 45 秒请求超时配置一致，但状态文件没有持久化错误 DTO，无法仅凭该文件区分超时、HTTP 400 或其他 Provider 错误。因此：

- “Item Budget 缺失并可导致 129+ items 被提交”已经由本轮独立复现确认；
- “历史故障恰好提交 135、上游恰好限制 128”与交接诊断一致，但当前落盘证据不足以再次还原原始请求；
- 02.1A 必须新增确定性的 127/128/129/135 构造测试，以及 Provider 发起网络请求前的最终本地断言。

## 4. Token Budget 与 Item Budget 的区别

Token Budget 控制的是文本和结构序列化后占用的模型上下文容量。一个很长的 item 可能消耗很多 token。

Item Budget 控制的是请求数组中独立 input item 的个数。大量短小的 Reasoning、Search Call、Tool Call 和 Tool Result 即使 token 总量不高，也可能先触发 Provider 的 item 数量上限。

两种预算互相独立：通过 Token Budget 检查不代表一定通过 Item Count 检查。Provider 调用前必须同时满足两者。

## 5. 流式 Reasoning 当前差距

上游并非完全没有实时 Reasoning。已有链路是：

```text
OpenAI Responses SSE
→ reasoning_summary_part_added
→ reasoning_summary_delta
→ reasoning_summary_completed
→ Agent Loop AgentEvent
→ App Server agent/event
→ DesktopController
→ Preload 安全 DTO
→ React reducer
→ App.tsx
```

Renderer 的主要差距：

1. 所有 reasoning delta 被拼进一个全局字符串；
2. 没有按 `summaryIndex`、模型轮次和 Item 分块；
3. 没有完整表达 part added / completed 状态；
4. 没有 Markdown 渲染；
5. 没有当前项 streaming 状态；
6. 没有 Codex 风格 Thought / Explored / Searched / Ran / Edited 时间线；
7. 没有“已处理 X 分钟”；
8. Turn 完成后不会自动折叠；
9. `thread/history` 主要恢复 User 与 Assistant，不能完整恢复公开 Reasoning、Tool、Search 和 Sources；
10. 错误后不能恢复完整过程。

安全边界：只能展示模型公开返回的 Reasoning Summary。禁止请求、保存或输出模型私有 Chain-of-Thought。

## 6. 客户端审计出的其他差距

### P0

- Markdown 未渲染；
- Workspace 名称和本机绝对路径写死在 Renderer；
- Sources 已显示，但安全打开链接链路未完成；
- Electron Permission UI 未完成，当前固定 Deny；
- Turn 运行时不能安全切换、新建或继续发送消息；
- Activity 历史不能恢复；
- 没有独立 Item Count Budget；
- DesktopController 会把具体错误吞成统一文案。

### P1

- Tools、Skills、MCP、Search 主要是数量或能力统计；
- Settings 和更多任务操作没有真实处理器；
- “添加上下文”固定 disabled；
- Changes 与 Terminal 是占位；
- 右侧检查器不能拖拽；
- 没有 Projects、Pin、Rename、Archive、Quick Chat；
- 没有 Model、Reasoning Effort、Permission Mode；
- 没有附件、图片、文件 Mention；
- 没有 `/plan`、`/goal`、`/review`；
- 没有 Artifact/File Preview、Plugin 管理、Scheduled Tasks、通知；
- 没有 Worktree 与产品级并行任务。

## 7. 当前架构判断

更准确的目标架构是：

```text
单任务单 Agent
+ 产品级多任务并行
+ 可选 Sub-Agent
```

多轮模型请求不等于 Multi-Agent。当前实现是：

```text
Electron Client
└─ 单个 App Server
   └─ 单个 Agent Loop
      └─ 同时只运行一个 Turn
```

因此当前仍是严格的 Single-Agent Runtime。短期不应直接重写 Multi-Agent，应先稳定 Context、Item Budget、Reasoning、Permission、Cancel、Error、Activity Persistence 和 Workspace 隔离。

## 8. 后续建议切片

不要一次修改全部问题：

1. Electron 02.1A：Item Budget 与 128 Items 修复；
2. Electron 02.1B：结构化安全错误 DTO；
3. Electron 02.1C：分块流式 Reasoning 数据模型；
4. Electron 02.1D：Markdown 和 Codex 式过程 UI；
5. Electron 02.1E：Activity 历史恢复。

推荐先做 02.1A，因为它对应当前真实失败链路的直接根因假设；但必须先完成独立复核。

## 9. Electron 02.1A 目标

Provider 调用前同时检查：

- Token Budget；
- Item Count Budget；
- Tool Output Budget；
- 最大 Agent Loop 轮次。

实现约束：

- 为 Item Budget 建立独立模块或清晰职责；
- 达到安全阈值时复用现有 Compaction；
- 压缩 Tool/Search 中间项；
- 保留当前用户目标、最近上下文和最新 Tool Result；
- Provider 调用前做最终断言；
- 防止后续搜索轮次再次提交超过 Provider 上限的 items；
- 保持已有 Token Compaction 行为；
- 不重写 Runtime、Skill 或 MCP。

128 上限需要预留安全空间。运行时阈值可在 110～120 items 范围内评估，但具体数值必须根据当前输入结构、Provider 追加项和测试确定，不能未经分析硬编码。

## 10. Electron 02.1A 最小测试范围

- 127、128、129 items；
- 选定的运行时安全阈值边界；
- 多轮 Web Search；
- 压缩后继续完成 Agent Loop；
- 当前用户目标不丢失；
- 最新 Tool Result 不丢失；
- 超限错误不会把敏感请求内容发送给 Renderer；
- Cancel 与 Timeout 不回归；
- CLI 不回归；
- Electron 不回归。

## 11. 金融与法务长期方向

长期可演进为：

```text
Supervisor / Router
├─ Finance Agent
├─ Legal Agent
└─ Review / Compliance Gate
```

短期先使用专业化 Single-Agent Profile，长期再加入 Supervisor 和 Sub-Agent：

```ts
interface AgentProfile {
  id: "finance" | "legal";
  instructions: string;
  skillNames: string[];
  toolNames: string[];
  mcpServerNames: string[];
  permissionPolicy: string;
}
```

金融金额、利息和税额必须由确定性 Tool 计算；付款、转账和写账必须人工审批。法务结论必须保留法域、日期和正式来源；合同提交、修改和签署必须人工审核。跨领域任务只通过结构化 DTO 传递最小必要信息，禁止任意共享完整上下文。

## 12. 协作和安全边界

- 一次只推进一个可验证切片；
- 保留现有未提交修改；
- 不创建分支或 Worktree；
- 未经明确授权，不执行任何 Git 命令，也不执行 commit、push、PR、merge 或 rebase；
- 不读取、修改或输出 Key；
- 不提交 `.env`、本机路径配置、IDE 文件、日志或缓存；
- App Server stdout 只能承载 JSONL，清洗后的诊断写 stderr；
- Renderer 不能访问 Node、文件系统、`child_process`、`process.env` 或原始 JSON-RPC；
- Main 与 Preload 继续使用固定 IPC 白名单；
- 默认 CLI 和 `--debug` 行为必须保留；
- 涉及 Reasoning UI 时，必须先给 ASCII 草图并等待确认。

## 13. 2026-08-12 后续路线对齐

本文件第 8 节的 02.1B～02.1E 是早期诊断建议，后续已经按更清晰的 Runtime 01～04 切片实施。当前准确顺序为：

```text
已完成：Electron 02.1A Item Budget
已完成：Runtime 01 有序数据模型
已完成：Runtime 02 实时 UI 基础能力
下一步：Runtime 02.2 根因排查 Commentary 与过程压缩
然后：Runtime 03 历史持久化
最后：Runtime 04 结构化安全错误
```

Runtime 02.2 的详细方案见：

- [`Electron-02.2-Codex式根因排查Commentary与过程压缩计划.md`](./Electron-02.2-Codex式根因排查Commentary与过程压缩计划.md)

该调整明确：Activity 只能说明执行到哪里，不能替代自然语言排查过程；整个公开过程区支持压缩，但模型私有 Chain-of-Thought 仍然禁止展示或伪造。
