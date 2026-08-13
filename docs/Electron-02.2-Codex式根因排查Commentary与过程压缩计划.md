# Electron 02.2：Codex 式根因排查 Commentary 与过程压缩计划

> 对齐日期：2026-08-12  
> 项目：`D:\练手\agent-learn`  
> 当前状态：02.2A、02.2B、02.2C 已完成并验证；等待确认后进入 Runtime 03  
> 前置切片：Electron 02.1A、Runtime 01、Runtime 02 已完成并验证  
> 后续切片：Runtime 03 历史持久化、Runtime 04 结构化安全错误

## 1. 本次调整结论

Runtime 02 已完成 RuntimeSession 有序展示、安全 Markdown、处理时间、流式批量更新、Activity 折叠、滚动锁和终态保留，但仍没有达到用户期待的 Codex 式排查体验。

当前差距不是单纯样式问题，而是两个层面同时缺失：

1. Agent 没有稳定生成“准备检查什么、发现了什么、为什么能锁定根因、下一步验证什么”的公开 Commentary；
2. Renderer 目前只折叠 Activity，没有把 Commentary、Activity 和公开 Reasoning Summary 组成一个可整体压缩的“公开过程区”。

因此新增独立切片 Runtime 02.2，置于 Runtime 03 之前：

```text
Runtime 01 有序数据模型
→ Runtime 02 实时 UI 基础能力
→ Runtime 02.2 根因排查 Commentary 与过程压缩
→ Runtime 03 历史持久化与恢复
→ Runtime 04 结构化安全错误
```

Runtime 02.2 不是重做 Runtime 02，而是补齐其最重要的产品语义。

## 2. 目标与非目标

### 2.1 目标

- 工具调用前稳定出现简短、自然的公开排查目标；
- 获得关键证据后，在继续调用工具时公开说明阶段发现；
- 证据充分时明确使用“已经锁定根因”；
- 验证前说明准备检查的边界或反例；
- Commentary、Activity、Reasoning Summary 按真实事件顺序穿插；
- 整个公开过程区可以展开和压缩；
- 内部连续 Activity 可以进一步压缩为操作组；
- 成功完成后自动压缩过程区，最终回答独立保持可见；
- 失败、取消、超时默认保留并展开已有过程；
- 不输出或伪造模型私有 Chain-of-Thought。

### 2.2 非目标

- 不展示私有 Chain-of-Thought；
- 不解密或展示 Provider encrypted reasoning；
- 不根据原始 Tool Result 在 Renderer 中自动编造“发现”或“根因”；
- 不修改 Runtime 历史持久化格式；
- 不实现 Permission 弹窗、Sources 安全打开、Changes 或 Terminal；
- 不扩展 MCP、Skill 或 Multi-Agent；
- 不新增依赖；
- 不进入 Runtime 03 或 Runtime 04。

## 3. 安全与产品边界

OpenAI Responses 的 reasoning tokens 属于模型内部推理，不通过 API 作为完整思维链公开。产品可以展示的只有：

- 模型主动生成的公开 Commentary；
- Provider 明确返回的公开 Reasoning Summary；
- Runtime 产生的结构化 Activity；
- Runtime 生成的克制、安全、非推断式兜底状态。

因此产品文案使用“公开排查过程”或“推理摘要”，不使用“完整思维链”。

任何公开内容都不能包含：

- Key、Token、Cookie、Authorization 或环境变量；
- 原始 Tool arguments；
- 未限制的 Tool Result；
- 完整敏感绝对路径；
- 原始请求、JSON-RPC、IPC channel 或异常对象；
- 没有证据支持的根因判断。

## 4. 最终用户体验

### 4.1 运行中：公开过程默认展开

```text
┌──────────────────────────────────────────────────────────────┐
│ ▾ 已处理 12 秒 · 正在排查输入边界                           │
│                                                              │
│ 我先检查输入构造、压缩触发条件和 Provider 请求边界，         │
│ 确认 129 items 是在哪一层漏过限制的。                        │
│                                                              │
│ ▾ 检查输入链路 · 3 项                                        │
│   ✓ 已读取 Context Builder                                   │
│   ✓ 已检查 Token Budget                                      │
│   ◌ 正在核对 Provider 编码                                   │
│                                                              │
│ 目前发现 Token Budget 只检查 Token 数量。大量短消息虽然      │
│ Token 很少，但 Item 数仍会超过 128；这很可能是主要根因。     │
│                                                              │
│ ▾ 验证边界行为 · 3 项                                        │
│   ✓ 127 items：允许                                          │
│   ✓ 128 items：允许                                          │
│   ! 129 items：仍被提交                                      │
│                                                              │
│ 已经锁定根因：Runtime 缺少独立 Item Count Budget，           │
│ Provider 联网前也没有最终数量断言。                          │
│                                                              │
│ 我接下来补软阈值、硬上限和边界测试。                         │
└──────────────────────────────────────────────────────────────┘
```

### 4.2 用户手动压缩整个过程区

```text
▶ 已处理 12 秒 · 读取 2 项 · 验证 3 项 · 正在处理
```

压缩后隐藏：

- Commentary；
- Activity 操作组；
- 公开 Reasoning Summary。

压缩后仍显示：

- 已处理时间；
- Read、Search、Run、Edit 等安全数量摘要；
- 当前状态；
- 独立的最终回答或安全错误。

### 4.3 成功完成

成功完成约 500ms 后自动压缩整个公开过程区：

```text
▶ 已处理 31 秒 · 读取 4 项 · 搜索 2 项 · 运行 3 项

Item Budget 修复完成。

- 120 items 自动压缩
- 128 items 为硬上限
- 129+ items 在联网前拒绝
```

用户手动重新展开后，本次会话不再强制自动压缩。

### 4.4 失败、取消或超时

终态默认保留并展开已有公开过程：

```text
▾ 已处理 45 秒 · 请求未完成

我已经确认输入数量会越过 Provider 上限，正在验证拒绝位置。

✓ 已检查输入构造
✓ 已完成第一次边界测试
! Provider 请求失败

请求未能完成，请重试。
```

用户仍可以手动压缩过程区。终态必须停止所有 running 动画。

## 5. 两级压缩模型

### 5.1 一级：公开过程区

一级容器包含：

```text
Commentary
+ Activity Group
+ Reasoning Summary
```

不包含：

```text
Final Assistant
RuntimeSafeError
```

状态规则：

| Turn 状态 | 初始展示 | 自动行为 |
|---|---|---|
| running | 展开 | 不自动压缩 |
| completed | 先展开 | 约 500ms 后压缩 |
| failed | 展开 | 不自动压缩 |
| cancelled | 展开 | 不自动压缩 |
| timed_out | 展开 | 不自动压缩 |

用户手动操作优先于自动行为。每个 `turnId` 单独记录本次渲染生命周期内的手动选择；Runtime 03 再决定是否持久化该偏好。

### 5.2 二级：连续 Activity 操作组

只把事件顺序中相邻、同一模型轮次的 Activity 合并为展示组，不跨 Commentary 或 Reasoning Summary 重排。

示例：

```text
Commentary A
Activity read 1
Activity read 2
Activity search 1
Commentary B
Activity ran 1
```

派生为：

```text
Commentary A
Activity Group(read 1, read 2, search 1)
Commentary B
Activity Group(ran 1)
```

操作组标题只从结构化 `activityKind`、状态和安全标题派生，不读取原始 Tool 参数或结果，不伪造业务结论。

## 6. 公开 Commentary 协议

在 Agent Instructions 中增加面向用户的公开进度协议。

### 6.1 首次工具调用前

用 1～2 句话说明：

- 准备检查哪些对象；
- 这一步要确认什么；
- 不列出内部完整计划或私有推理。

推荐：

```text
我先检查输入构造、压缩触发条件和 Provider 请求边界，确认数量限制在哪一层失效。
```

禁止：

```text
让我想想。
我将执行工具。
以下是我的完整思维链……
```

### 6.2 获得关键证据后

如果下一步仍需调用 Tool、Search 或 Command，先公开说明：

- 已确认的事实；
- 该事实意味着什么；
- 下一步准备如何验证。

证据不足时使用：

```text
目前发现……
当前迹象表明……
这很可能是……，我继续验证……
```

证据充分时才使用：

```text
已经锁定根因：……
```

### 6.3 开始验证前

公开说明需要验证的边界、反例或回归范围，例如：

```text
我现在验证 127、128、129 三个边界，并确认拒绝发生在联网和工具执行之前。
```

### 6.4 更新频率

- 只在目标、发现、判断或下一步发生实质变化时输出；
- 不为每一次 Read、Search 或 Tool 调用重复生成同义句；
- 单段优先控制在 1～3 个短段落；
- Commentary 面向普通用户，不输出 Raw Logs。

### 6.5 最终回答

- 最终回答继续遵守“先结论，再证据或结果”；
- 不逐字重复全部 Commentary；
- 可以简要回顾根因，但必须把交付结果、验证结果和剩余风险说清楚；
- 最终回答只出现一次。

## 7. 无公开文本时的安全兜底

模型可能直接调用 Tool，不产生 output text。Runtime 只允许补充动作型兜底，不允许补充发现型或根因型兜底。

建议按结构化事件选择：

```text
读取类：正在检查相关实现和调用链……
搜索类：正在查找与问题有关的线索……
验证类：正在验证当前判断和边界行为……
权限类：正在等待必要的操作许可……
通用类：正在检查相关实现……
```

Runtime 不得从 Tool Result 自动生成：

```text
已经找到根因……
已经确认问题是……
```

这类结论只能来自模型公开 Commentary 或确定性的 Runtime 规则。

最小版本如果在模型响应完成前无法知道工具类型，继续使用通用兜底；分类兜底作为可选增强，不能为了文案提前解析或暴露原始 Tool 参数。

## 8. 数据与事件流

现有 RuntimeSession 数据模型可以复用，不新增持久化字段：

```text
Agent Instructions 要求公开 Commentary
→ Responses output_text.delta
→ RuntimePendingOutput
→ 本轮存在 Function Calls
→ RuntimeCommentary
→ Activity 按真实顺序插入
→ 下一模型轮次公开阶段发现
→ 最后一轮无 Function Calls
→ RuntimeAssistant
```

Renderer 只派生 UI 结构：

```text
RuntimeSession.items
→ splitProcessAndOutcome()
   ├─ process: commentary / activity / reasoning_summary
   └─ outcome: assistant / error
→ groupContiguousActivities(process)
→ RuntimeProcessPanel（整体可压缩）
→ RuntimeOutcome（始终独立可见）
```

不改变真实事件顺序，不把 Reasoning Summary 当 Commentary，不把 Activity 当根因说明。

## 9. 预计代码改动

### `src/agent/agent-loop.ts`

- 在基础 Agent Instructions 中加入公开 Commentary 协议；
- 保持现有 Function Calls 分类规则；
- 保持无文本 Tool Call 的安全兜底；
- 如分类兜底需要 Tool 类型，只使用已清洗的结构化定义，不读取或输出原始参数；
- 不改 Tool 执行、Permission、Item Budget 或 Context 逻辑。

### `src/electron/renderer/runtime-ui.ts`

- 新增过程与结果拆分纯函数；
- 新增连续 Activity 分组纯函数；
- 新增整个过程区的折叠摘要；
- 新增终态默认展开策略；
- 保持安全 Markdown、事件帧合并和滚动判断不变。

### `src/electron/renderer/RuntimeTimeline.tsx`

- 将现有单一 Timeline 拆成公开过程区和独立结果区；
- 一级折叠控制整个公开过程；
- 二级折叠控制 Activity 操作组；
- Reasoning Summary 保持独立可折叠；
- 成功后约 500ms 自动压缩；
- 失败、取消、超时默认展开；
- 用户手动选择优先。

### `src/electron/renderer/styles.css`

- 增加 Codex 风格过程摘要行；
- 增加操作组、展开态、压缩态和终态样式；
- 保持低干扰动画与 reduced-motion 支持；
- 最终回答继续使用明确分隔线。

### `tests/agent-loop-test.ts`

- 断言业务模型请求包含公开 Commentary 协议；
- 断言 Tool 前公开文本仍分类为 Commentary；
- 断言无文本 Tool Call 兜底不包含伪造发现、根因、参数或结果；
- 断言最终回答只出现一次。

### `tests/electron-runtime-ui-test.ts`

- 过程与结果正确拆分；
- Activity 只在相邻且同轮时分组；
- 不跨 Commentary 重排；
- 整体压缩摘要计数正确；
- completed 自动压缩；
- failed、cancelled、timed_out 默认展开；
- 手动展开优先；
- 终态无 running 动画。

### `package.json`

仅当测试入口需要同步时修改；不新增依赖，不修改 `package-lock.json`。

## 10. 实施切片

Runtime 02.2 继续按小切片推进，不与 Runtime 03 混合。

### 02.2A：公开 Commentary 协议

目标：让真实模型稳定输出排查目标、阶段发现、根因判断和验证计划。

文件：

- `src/agent/agent-loop.ts`
- `tests/agent-loop-test.ts`

验证：

```powershell
npm run check
npx tsx --test tests/agent-loop-test.ts
```

回滚点：只撤销 Agent Instructions 和对应测试，不修改 RuntimeSession 或 UI。

### 02.2B：整个公开过程区可压缩（已完成）

目标：Commentary、Activity、Reasoning Summary 共同构成可整体压缩的过程区，最终回答保持独立。

文件：

- `src/electron/renderer/runtime-ui.ts`
- `src/electron/renderer/RuntimeTimeline.tsx`
- `src/electron/renderer/styles.css`
- `tests/electron-runtime-ui-test.ts`

验证：

```powershell
npm run check
npx tsx --test tests/electron-runtime-ui-test.ts
npm run test:electron
```

回滚点：只撤销过程区拆分、折叠状态和样式，不回滚 Runtime 02 已有安全 Markdown、滚动锁或帧级合并。

### 02.2C：操作组压缩与终态验收（已完成）

目标：压缩连续 Activity，确认成功、失败、取消和超时的 Codex 式展示。

文件：

- 仅补充 02.2B 的 UI 派生函数、组件和测试；
- 不新增持久化结构。

验证：

```powershell
npm run check
npm run test:electron
npm test
npm run electron:build
node bin/god-agent.js --version
```

回滚点：只撤销 Activity 分组和终态展示增强。

完成 02.2C 验收后停止，等待确认再进入 Runtime 03。

## 11. 自动化验收标准

- [x] Agent Instructions 明确要求 Tool 前公开排查目标；
- [x] Agent Instructions 明确区分“目前怀疑”与“已经锁定根因”；
- [x] Agent Instructions 要求关键证据后说明发现和下一步；
- [x] Tool 前公开文本归类为 Commentary；
- [x] 无文本兜底不伪造发现或根因；
- [x] Commentary、Activity 和 Reasoning Summary 保持真实事件顺序；
- [x] 整个公开过程区可以压缩和展开；
- [x] 最终 Assistant 与安全错误位于过程区外；
- [x] 成功完成约 500ms 后自动压缩；
- [x] 失败、取消、超时默认展开并保留过程；
- [x] 用户手动展开后不被强制压缩；
- [x] 连续 Activity 分组不跨 Commentary 或 Reasoning 重排；
- [x] 公开 Reasoning Summary 仍按 `round + summaryIndex` 分块；
- [x] 终态停止全部动画；
- [x] Renderer 不接收敏感参数、原始结果或私有推理；
- [x] CLI 默认模式和 `--debug` 不回归；
- [x] `npm run check`、完整测试和 `npm run electron:build` 通过。

## 12. 人工验收步骤

在 Electron 客户端发送一个需要多步读取和验证的任务，例如：

```text
请检查 Item Budget 的 127、128、129 边界，找出可能的越界原因并验证。
```

依次确认：

1. 第一次工具调用前出现自然语言排查目标；
2. Activity 穿插在 Commentary 之间，而不是占据全部过程；
3. 获取关键证据后出现“目前发现”或“当前迹象表明”；
4. 证据充分后才出现“已经锁定根因”；
5. 点击顶部摘要可以压缩整个过程区；
6. 展开后 Commentary、Activity 和 Reasoning 顺序不变；
7. 成功后过程自动压缩，最终回答仍完整可见；
8. 取消或制造失败后，已有过程默认保持展开；
9. 页面不显示私有思维链、原始 Tool 参数、完整绝对路径或敏感信息。

真实模型输出具有一定随机性，因此自动化测试负责验证协议、分类和 UI 状态机；人工验收负责确认文案质量和 Codex 式体验。

## 13. 风险与控制

### 风险 1：模型仍直接调用 Tool

控制：保留安全动作型兜底；不能用 Runtime 编造阶段发现。

### 风险 2：Commentary 太频繁

控制：提示词限制只在目标、发现、判断或下一步实质变化时更新，并限制段落长度。

### 风险 3：Commentary 与最终回答重复

控制：最终回答强调交付结论和验证结果，不逐字复述全部过程；UI 继续按 Function Calls 分类。

### 风险 4：压缩破坏事件顺序

控制：只做 Renderer 派生分组；不修改 RuntimeSession.items，不跨 Commentary、Reasoning 或模型轮次合并。

### 风险 5：将摘要误称为完整思维链

控制：UI 固定使用“公开过程”和“公开推理摘要”，文档及测试禁止 Chain-of-Thought Viewer 语义。

## 14. 最终执行顺序

```text
已完成：Electron 02.1A Item Budget
已完成：Runtime 01 有序数据模型
已完成：Runtime 02 实时 UI 基础能力

下一步：Runtime 02.2A 公开 Commentary 协议
  → Runtime 02.2B 整体过程压缩
  → Runtime 02.2C 操作组与终态验收

等待确认
  ↓
Runtime 03 Activity 历史持久化与恢复
  ↓
Runtime 04 结构化安全错误
```

未经用户确认，不从 Runtime 02.2 自动进入 Runtime 03。
