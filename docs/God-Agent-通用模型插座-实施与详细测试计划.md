# God-Agent 通用模型插座：实施与详细测试计划

## 1. 目标与验收口径

本任务把 God 的模型底座改造成可扩展的通用插座，参考 Gundam/LovBrowser Bridge 的 OpenAI-compatible 接入方式，同时保留原有 OpenAI Responses 链路。

最终固定依赖方向：

```text
Profile（连接谁、用什么模型）
  → Adapter Registry（说哪种协议）
    → ConfigurableLlmProvider / LlmProvider（God 内部统一契约）
      → Agent Loop / App Server / CLI / WAL / Runtime
```

验收通过必须同时满足：

1. 新增同协议上游时只增加 Profile，不修改 Agent Loop。
2. 新增协议时只注册 Adapter，并实现统一 `LlmProvider` 契约。
3. Gundam Bridge、LovBrowser Bridge、Ollama 和其他 Chat Completions 兼容服务可复用 `openai-compatible`。
4. 未配置 Profile 时，原 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL` 行为不变。
5. Profile 不允许保存 API Key、Token、Cookie 或 Authorization 明文。
6. WAL 能区分不同 Adapter/Profile，原 Responses WAL 身份保持兼容。
7. 能力声明忠于真实协议，不为 Chat Completions 虚构 Reasoning Summary、Hosted Web Search、状态查询或远端取消。
8. 静态检查、定向测试、完整自动化测试全部通过；真实 Bridge 的手工项有明确步骤和证据口径。

## 2. 范围与非范围

### 2.1 本次范围

- Profile JSON 的加载、校验、激活和环境变量覆盖。
- Adapter Registry 的注册、查找、能力声明和 Provider 创建。
- `openai-responses` 原链路的零迁移装配。
- `openai-compatible` 的 `/v1/chat/completions` 流式和非流式响应。
- 文本增量、单/多 Tool Call 分片聚合、工具结果回放。
- 超时、主动取消、HTTP 错误、SSE 错误和断流行为。
- App Server 能力展示、模型列表/切换、缺少密钥时的明确错误。
- CLI、WAL 启动恢复、Provider capability smoke 的集成回归。

### 2.2 明确不在本次范围

- 不把不同厂商的私有扩展字段统一成虚假的通用能力。
- 不为 Chat Completions 假设 `previous_response_id`、请求状态查询或远端取消端点。
- 不在 Provider 内暗中重试；一次 WAL `submitted` 只对应一次远端 POST。
- 不提交真实 Profile、API Key、本机状态、日志、缓存或构建产物。
- 不合并 PR，不修改 `main` 或其他 worktree。

## 3. 分阶段实施计划

### 阶段 A：基线与隔离

1. 从线上最新 `origin/main` 建立独立 worktree。
2. 创建任务分支 `god-universal-bridge_hln`。
3. 记录基线提交，确认任务分支只跟踪本任务文件。
4. 禁止 rebase、禁止修改其他分支和 worktree。

完成标准：分支基于目标线上基线，工作目录与其他任务隔离。

### 阶段 B：统一契约和 Profile

1. 增加 `ConfigurableLlmProvider`，只扩展模型读取和切换能力。
2. 定义 Profile 文档结构：连接地址、Adapter、默认模型、模型清单、密钥环境变量名和 Adapter 选项。
3. 校验空值、类型、重复 ID、非法环境变量名、空模型清单和敏感字段。
4. 标准化 OpenAI 风格 base URL，统一补齐 `/v1`。
5. 未提供 Profile 文件时，由旧 `OPENAI_*` 环境构造兼容 Profile。

完成标准：Profile 是纯配置数据，密钥值只在运行时从环境变量读取。

### 阶段 C：Adapter Registry 与内置插头

1. 建立 Adapter 注册表，拒绝空 ID 和重复注册。
2. 注册 `openai-responses`，沿用既有 Responses Provider。
3. 注册 `openai-compatible`，实现 Chat Completions Provider。
4. 每个 Adapter 公开工具调用、推理摘要、托管搜索和 previous response id 能力。
5. Provider Bootstrap 负责选择 Profile、读取密钥、创建模型目录并形成 WAL 身份。

完成标准：Agent Core 不感知 Gundam、Ollama 或具体供应商名字。

### 阶段 D：Chat Completions 协议翻译

1. 把 God 的 system/user/assistant/tool 历史翻译为 Chat Completions `messages`。
2. 把 God Tool schema 翻译为 `tools[].function`。
3. 请求固定走 `/chat/completions`，默认开启流式响应。
4. 解析 SSE 文本增量和跨分片 Tool Call。
5. 兼容非流式 JSON 返回。
6. 透传主动取消信号并叠加单请求超时。
7. 对 HTTP 错误、流内错误、空流和非法 JSON 给出明确失败。

完成标准：兼容插头输出标准 `LlmResponse`，Agent Loop 无需分支判断。

### 阶段 E：Runtime 集成与兼容

1. App Server 启动时通过 Bootstrap 获取 Provider、模型清单、能力和缺失原因。
2. 模型切换只能选择当前 Profile 声明的模型。
3. Web Search 只在 Adapter 确实支持且 Profile 未关闭时展示。
4. 缺少必需密钥时 App Server 仍可启动，但 `turn/run` 返回 Profile 级明确错误。
5. 原 Responses 链路继续使用历史 WAL provider 名 `openai_responses`；其他连接使用 `adapter:profile`。
6. capability smoke 对兼容插头发送真实 Chat Completions 请求，拒绝不存在的 status/cancel 操作。

完成标准：CLI、App Server、Electron 消费的 Runtime 能力一致，恢复语义不倒退。

### 阶段 F：审查、测试和 PR

1. 并行进行架构边界、测试矩阵和 PR 就绪审查。
2. 按 P0→P3 汇总发现，P0/P1 必须修复；P2 需修复或在 PR 说明理由；P3 记录为后续项。
3. 执行静态检查、定向测试和完整测试。
4. 核对差异与敏感文件，只暂存公开列出的任务文件。
5. 提交并推送独立分支，创建面向 `main` 的 PR；不执行合并。

完成标准：自动化全部通过，PR 描述包含架构、安全、兼容性、限制和测试证据。

## 4. 测试环境与证据要求

### 4.1 自动化环境

- Node.js 和 npm 使用仓库锁定/现有版本。
- 测试上游默认使用本机临时 HTTP Server 或 mock fetch，不访问真实付费 API。
- 临时 Profile 和状态文件写入系统临时目录，测试结束自动删除。
- 每个测试必须断言请求路径、请求头、请求体、输出事件或失败类型中的至少一项关键契约。

### 4.2 手工真实 Bridge 环境

- Gundam/LovBrowser Bridge 已启动并明确其监听端口。
- 测试 Profile 位于仓库外，不包含密钥值。
- 若 Bridge 无需 Key，设置 `apiKeyRequired: false`；需要 Key 时只设置对应环境变量。
- 证据至少包括：启动日志中的 Profile/Adapter、一次纯文本响应、一次 Tool Call、请求路径或 Bridge 访问日志、退出状态。
- 真实调用有成本时先限制模型、请求数和超时，不运行无限重试。

## 5. 详细测试用例

状态说明：`自动` 表示纳入仓库自动化；`手工` 表示需要真实本地/外部服务；`审查` 表示通过源代码或差异核验。

### 5.1 Profile 与配置安全

| ID | 类型 | 前置条件 | 执行步骤 | 预期结果 |
|---|---|---|---|---|
| CFG-01 | 自动 | 不设置 `AGENT_LLM_PROFILES_PATH` | 设置旧 `OPENAI_MODEL`、`OPENAI_BASE_URL`，加载配置 | source 为 `legacy-env`；Adapter 为 `openai-responses`；地址补 `/v1`；模型保持旧值 |
| CFG-02 | 自动 | Profile 文件含两个合法 Profile | 设置 `activeProfile=gundam` 后加载 | 选择 gundam；返回完整模型清单和正确 Adapter |
| CFG-03 | 自动 | 同 CFG-02 | 设置 `AGENT_LLM_PROFILE=responses` | 环境变量覆盖 JSON 的 `activeProfile` |
| CFG-04 | 自动 | Profile 没有 `activeProfile` | 加载文件 | 默认选择数组第一项 |
| CFG-05 | 自动 | `AGENT_LLM_PROFILE` 指向不存在 ID | 加载配置 | 明确报 `Unknown active LLM profile`，不静默回退 |
| CFG-06 | 自动 | Profile 文件是非法 JSON | 加载配置 | 明确报 `Invalid LLM profiles JSON`，保留 cause |
| CFG-07 | 自动 | 缺少 `profiles` 或数组为空 | 解析配置 | 分别报结构错误和空数组错误 |
| CFG-08 | 自动 | 两个 Profile ID 相同 | 解析配置 | 拒绝并指出重复 ID |
| CFG-09 | 自动 | 分别放入 `apiKey`、`token`、`cookie`、`authorization` | 逐项解析 | 四种敏感明文字段全部拒绝，提示使用 `apiKeyEnv` |
| CFG-10 | 自动 | `apiKeyEnv` 为 `A-B`、空格或数字开头 | 解析配置 | 拒绝非法环境变量名 |
| CFG-11 | 自动 | `apiKeyRequired=true` 且环境变量缺失/空白 | 启动 Bootstrap | Provider 不创建；返回包含 Profile ID 与变量名的 unavailable reason |
| CFG-12 | 自动 | `apiKeyRequired=false` 且无 Key | 启动兼容插头 | Provider 正常创建；请求不含 Authorization 头 |
| CFG-13 | 自动 | base URL 分别带/不带 `/v1` 和尾斜杠 | 解析配置 | 最终都标准化为唯一 `/v1`，不出现 `/v1/v1` |
| CFG-14 | 自动 | `models=[]` 或元素字段类型错误 | 解析配置 | 拒绝空目录和非法模型元素 |
| CFG-15 | 自动 | options 中 timeout 为 0/小数/字符串 | 创建 Provider | 明确拒绝，避免不确定超时 |
| CFG-16 | 审查 | 工作区已有全部候选文件 | 搜索 API Key、Bearer、Token、Cookie 和常见密钥格式 | 只允许测试假值/字段名，不存在真实凭据 |

### 5.2 Registry、能力与模型选择

| ID | 类型 | 前置条件 | 执行步骤 | 预期结果 |
|---|---|---|---|---|
| REG-01 | 自动 | 创建内置 Registry | 调用 `list()` | 精确包含 `openai-responses`、`openai-compatible` |
| REG-02 | 自动 | 注册合法 Adapter | 用相同 ID 再注册 | 第二次被拒绝，不覆盖首个 Adapter |
| REG-03 | 自动 | 空白 Adapter ID | 注册 | 明确报 ID 不能为空 |
| REG-04 | 自动 | 未注册 ID | 调用 `require()` | 明确报 `Unknown LLM adapter` |
| REG-05 | 自动 | 获取 `list()` 结果 | 修改返回 capabilities 后再次读取 | Registry 内部能力不被外部修改 |
| CAP-01 | 自动 | 两个内置 Adapter | 读取能力 | Responses 支持 reasoning/web search/previous id；Compatible 均不伪造这些能力 |
| CAP-02 | 自动 | Responses Profile 设置 `options.webSearch=false` | Bootstrap | 最终 `hostedWebSearch=false` |
| MOD-01 | 自动 | Profile 未显式包含默认模型 | 构建模型目录 | 默认模型自动追加且只出现一次 |
| MOD-02 | 自动 | App Server 已启动 | 选择目录中的另一模型 | Provider 与 Runtime `currentModel` 同步更新 |
| MOD-03 | 自动 | App Server 已启动 | 选择目录外模型 | 拒绝切换，当前模型不改变 |

### 5.3 Chat Completions 请求翻译

| ID | 类型 | 前置条件 | 执行步骤 | 预期结果 |
|---|---|---|---|---|
| CHAT-01 | 自动 | 有 system 指令和字符串输入 | 创建响应 | messages 顺序为 system→user，model/stream 正确 |
| CHAT-02 | 自动 | system 为空 | 创建响应 | 不发送空 system message |
| CHAT-03 | 自动 | 历史包含 user/assistant 消息 | 创建响应 | 角色和文本顺序完整保留 |
| CHAT-04 | 自动 | 历史包含工具结果 | 创建响应 | 先重放对应 assistant tool_call，再发送 tool 消息，call id 对齐 |
| CHAT-05 | 自动 | 注册多个 Tool | 创建响应 | 每项转为 `type=function`；schema/required/additionalProperties 保留 |
| CHAT-06 | 自动 | Tool 清单为空 | 创建响应 | 请求不含 tools/tool_choice/parallel_tool_calls |
| CHAT-07 | 自动 | 有 Tool | 创建响应 | `tool_choice=auto` 且 `parallel_tool_calls=true` |
| CHAT-08 | 自动 | 配置 API Key | 创建响应 | Authorization 精确为 Bearer；错误消息和日志不回显 Key |
| CHAT-09 | 自动 | 无 Key 本地服务 | 创建响应 | 不产生空 Bearer 头 |
| CHAT-10 | 自动 | 输入项超过预算 | 创建响应 | 网络调用前抛预算错误，fetch 次数为 0 |

### 5.4 流式 SSE 与非流式 JSON

| ID | 类型 | 前置条件 | 执行步骤 | 预期结果 |
|---|---|---|---|---|
| SSE-01 | 自动 | SSE 含两段文本 delta | 消费至 `[DONE]` | 文本按顺序拼接；每段发 `output_text_delta` |
| SSE-02 | 自动 | 单 Tool Call 的 id/name/arguments 跨三个 chunk | 消费流 | 各字段无丢失、无重复，最终 JSON 参数完整 |
| SSE-03 | 自动 | 两个 Tool Call 交错分片且 index 不同 | 消费流 | 按 index 稳定排序，各自片段不串线 |
| SSE-04 | 自动 | delta 同时含文本与 Tool Call | 消费流 | 文本事件和 Tool Call 都保留 |
| SSE-05 | 自动 | SSE 使用 CRLF、注释行、多 data 行 | 消费流 | 正确分块；忽略非 data 行；合法多行 payload 可解析 |
| SSE-06 | 自动 | SSE 在 `[DONE]` 前结束 | 消费到 EOF | 已完成内容按明确策略返回；不得死等 |
| SSE-07 | 自动 | HTTP 200 但 body 为 null | 创建响应 | 明确报 stream body missing |
| SSE-08 | 自动 | SSE data 含 `error.message` | 消费流 | 整次调用失败并保留上游错误消息 |
| SSE-09 | 自动 | SSE 中夹杂无法解析的心跳/脏块 | 消费流 | 忽略无效块，后续合法块仍可处理 |
| JSON-01 | 自动 | Content-Type 非 SSE，合法 JSON 文本响应 | 创建响应 | 返回文本、ID，且发文本增量事件 |
| JSON-02 | 自动 | 非流式响应含多个 Tool Call | 创建响应 | 全部转成统一 functionCalls |
| JSON-03 | 自动 | 非流式 body 非 JSON/顶层非对象 | 创建响应 | 明确报 Invalid Chat Completions response |
| JSON-04 | 自动 | 非流式缺少 ID | 创建响应 | 生成非空兼容 ID，响应仍可审计 |

### 5.5 错误、超时、取消与重试语义

| ID | 类型 | 前置条件 | 执行步骤 | 预期结果 |
|---|---|---|---|---|
| ERR-01 | 自动 | 上游返回 401 JSON error | 创建响应 | 错误含 401 和上游 message，不含请求密钥 |
| ERR-02 | 自动 | 上游返回 503 纯文本长错误 | 创建响应 | 错误含 503；正文受长度上限约束 |
| ERR-03 | 自动 | fetch 抛网络错误 | 创建响应 | 原错误向上抛，Provider 不发第二次 POST |
| ERR-04 | 自动 | timeoutMs 很短且上游不返回 | 等待调用 | 单请求超时终止；只发送一次请求 |
| ERR-05 | 自动 | 外部 AbortController | 请求发出后主动 abort | 调用以外部 reason 失败；fetch 收到 aborted signal |
| ERR-06 | 自动 | 外部取消早于 timeout | 主动 abort | 取消原因优先，不误报普通超时 |
| ERR-07 | 自动 | 流读取过程中断并抛错 | 消费响应 | 调用失败，不伪造成功完成 |
| ERR-08 | 审查 | WAL 已启用 | 核对 Provider 与恢复逻辑 | 生产 Adapter 不隐藏重试；`submitted` 与 POST 一一对应 |

### 5.6 Runtime、WAL、CLI、Electron 与并发

| ID | 类型 | 前置条件 | 执行步骤 | 预期结果 |
|---|---|---|---|---|
| RUN-01 | 自动 | 无 Profile，旧 Responses 环境有 Key | 启动并执行 Turn | 路由仍为 Responses；WAL provider 仍是 `openai_responses` |
| RUN-02 | 自动 | compatible Profile | 执行 Turn | WAL provider 为 `openai-compatible:<profile-id>` |
| RUN-03 | 自动 | 必需 Key 缺失 | 启动 App Server，再调用 turn/run | 服务可启动；调用返回含 Profile/环境变量的明确错误 |
| RUN-04 | 自动 | 无 Key compatible Profile + 临时 HTTP Server | 从 CLI 输入用户消息 | 请求到 `/v1/chat/completions`；CLI 展示最终回答并正常退出 |
| RUN-05 | 自动 | compatible Profile | 查询 Runtime capabilities | `llm=true`、当前模型/模型清单正确、`webSearch=false` |
| RUN-06 | 自动 | Responses Profile | 查询 Runtime capabilities | 根据 Profile options 正确声明 web search |
| RUN-07 | 自动 | 有未完成 ModelInvocation WAL | 重启 App Server | 启动恢复器仍创建并等待完成，provider 身份可读 |
| RUN-08 | 自动 | Electron 使用 App Server capabilities | 加载桌面端控制器/UI 测试 | 原 UI/模型选择测试不回归，Compatible 不展示伪能力 |
| CON-01 | 自动/扩展 | 两个并发 Chat 使用同一 Profile | 同时执行 Turn | 每个响应/事件/WAL 归属正确，无跨 Chat 串流 |
| CON-02 | 自动/扩展 | 两个并发 Chat 分别选择允许模型 | 同时执行 Turn | 请求 model 各自符合 Runtime 的既有模型作用域语义 |
| CON-03 | 自动/扩展 | 一个 Chat 取消，另一个继续 | 并发执行后取消其一 | 被取消调用停止；另一调用不受影响并完成 |

说明：模型选择当前属于 App Server 进程级 Provider 状态；如果产品要求“每个 Chat 永久绑定不同模型”，应单独引入 Chat/Profile binding，而不是在本任务中暗改现有作用域。`CON-02` 用于暴露和确认这一边界。

### 5.7 Capability Smoke 与真实 Gundam Bridge

| ID | 类型 | 前置条件 | 执行步骤 | 预期结果 |
|---|---|---|---|---|
| SMK-01 | 自动 | compatible fixture 配置 | 执行 create/retry smoke | 每次请求走 `/chat/completions`，body 含 system/user，报告 completed |
| SMK-02 | 自动 | compatible live 配置包含 status/cancel | 校验配置 | 在发送网络请求前拒绝，说明协议未接线 |
| SMK-03 | 自动 | Responses fixture 配置 | 执行既有 smoke | 原 create/status/cancel/retry 测试不回归 |
| LIVE-01 | 手工 | Gundam Bridge 运行，无 Key | 激活 gundam Profile，启动 CLI，发送纯文本问题 | 启动日志显示正确 Profile/Adapter；收到非空回答；无 Authorization 要求 |
| LIVE-02 | 手工 | Bridge 后端支持 Function Calling | 请求读取一个安全测试文件 | God 收到 Tool Call、执行工具、回传结果并生成最终回答 |
| LIVE-03 | 手工 | Bridge 可查看访问日志 | 完成一次调用后核对日志 | 路径为 `/v1/chat/completions`；模型和请求次数符合预期；无隐藏重试 |
| LIVE-04 | 手工 | Bridge 关闭或端口错误 | 执行一次 Turn | 快速得到明确连接错误；Runtime 不假成功，WAL 进入既有未知结果处置 |
| LIVE-05 | 手工 | Bridge 人为延迟超过 timeout | 执行一次 Turn | 到期取消；进程可继续处理后续命令 |
| LIVE-06 | 手工 | 两个 CLI/Chat 同时连接 Bridge | 并发发送不同标记消息 | 两边回答不串线，Bridge 请求数等于调用数 |

## 6. 自动化执行顺序

为了让失败定位从窄到宽，按以下顺序执行：

```powershell
# 1. 类型和装配检查
npm run check

# 2. Profile / Registry 定向测试
npx tsx --test tests/provider-profile-test.ts

# 3. Chat Completions 协议定向测试
npx tsx --test tests/openai-chat-completions-test.ts

# 4. Runtime 集成和 Smoke 定向测试
npx tsx --test tests/provider-capability-smoke-test.ts tests/model-invocation-startup-recovery-test.ts tests/cli-smoke-test.ts

# 5. 完整回归（package.json 会先运行 pretest）
npm test
```

失败处理规则：

1. 任何 P0/P1 或现有回归失败都阻止提交。
2. 定向测试失败时先修复并重跑该文件，再跑完整测试。
3. 完整测试存在偶发失败时必须复现和说明，不以“可能 flaky”直接忽略。
4. 真实 Bridge 未提供/未启动不阻止离线自动化结论，但 PR 必须把 LIVE 项标为待环境验收，不能写成已通过。

## 7. 提交前检查清单

- [ ] 三路并行审查结果已汇总，P0/P1 清零。
- [ ] `npm run check` 通过。
- [ ] Profile、Chat Completions、Smoke、CLI/WAL 定向测试通过。
- [ ] `npm test` 和自动执行的 pretest 全部通过。
- [ ] `git diff --check` 无空白错误。
- [ ] 候选文件不含 `.env`、真实 Profile、密钥、Cookie、本机路径、状态文件、日志、缓存和构建产物。
- [ ] 无业务必要的锁文件未提交。
- [ ] 已向用户公开拟提交文件清单。
- [ ] 只在 `god-universal-bridge_hln` 上 commit/push。
- [ ] PR base 为 `main`，PR 未合并。

## 8. 最终验收记录模板

| 项目 | 结果 | 证据 |
|---|---|---|
| 静态检查 | 通过 | `npm run check`；Electron TypeScript `--noEmit` |
| Profile/Registry 定向测试 | 通过 | 包含显式 Profile 密钥隔离、递归敏感字段、重复模型和 Registry |
| Chat Completions 定向测试 | 通过 | 包含 SSE/JSON、多 Tool、断流、取消、超时、空响应和错误脱敏 |
| Smoke、CLI、WAL 定向测试 | 通过 | 合并定向套件 70/70；后续新增用例已进入完整回归 |
| 完整主测试 | 通过 | 510/510 |
| pretest | 通过 | 19/19 |
| Electron 专项 | 通过 | 74/74 |
| 真实 Gundam Bridge | 未执行 | 当前机器未提供正在运行的真实 Bridge；LIVE-01～LIVE-06 保留为环境验收，PR 不宣称已通过 |
| 架构审查 | 已处置 | 修复并行 Tool 结果回放、模型选择覆盖、能力暴露和重复模型 ID |
| 测试矩阵审查 | 已处置本次阻断 | 修复隐式 Key 泄漏、SSE 失败关闭、超时/取消、不完整响应；真实供应商与跨进程压力项保留为 live/后续门禁 |
| PR 就绪审查 | 通过 | 第二轮最终静态复审 P0=0、P1=0，可以提交 PR |
