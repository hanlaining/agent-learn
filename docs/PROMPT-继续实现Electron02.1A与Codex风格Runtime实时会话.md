# 新任务 Prompt：Electron 02.1A 与 Codex 风格 Runtime 实时会话

复制下面代码块内的内容到新任务：

```text
请继续开发 Codex-like 单 Agent Runtime 与 Electron 桌面客户端。

项目目录：
D:\练手\agent-learn

开始前必须完整阅读：

D:\练手\agent-learn\docs\Electron-02-Codex风格桌面客户端实现记录.md
D:\练手\agent-learn\docs\Electron-02.1-Codex客户端差距与流式Reasoning排查.md
D:\练手\agent-learn\docs\Electron-02.1A-Item-Budget与128-Items修复计划.md
D:\练手\agent-learn\docs\PROMPT-继续实现Electron03右侧工作区.md
D:\练手\agent-learn\docs\MCP-实现记录与验收手册.md

本任务有两个连续目标，但必须按独立切片推进，不能一次混改：

第一阶段：Electron 02.1A，修复 Item Budget 与 128 Items 故障。
第二阶段：实现面向普通用户的 Codex 风格 Runtime 实时会话。

优先级与执行顺序：

Electron 02.1A A1
→ A2
→ A3
→ A4
→ 完整验收
→ 等待我确认
→ Runtime 01 数据模型
→ Runtime 02 实时 UI
→ Runtime 03 历史恢复
→ Runtime 04 安全错误

未经我确认，不要从 02.1A 自动进入 Runtime UI；也不要把全部切片一次性编码。

## 当前已复核的 Item Budget 结论

当前源码只有 Token Budget，没有独立 Item Count Budget。

不联网隔离诊断已证明：

- 127 条短消息约 635 tokens，不压缩，提交 127 items；
- 128 条短消息约 640 tokens，不压缩，提交 128 items；
- 129 条短消息约 645 tokens，不压缩，仍提交 129 items；
- 当前 App Server 使用 usePreviousResponseId: false；
- 1 个逻辑 Function Output 会编码为 function_call + function_call_output，即 2 个 Provider items；
- 64 个 Tool Outputs 编码为 128 items；
- 65 个 Tool Outputs 编码为 130 items。

02.1A 推荐参数：

- Runtime 软阈值：120；
- Provider 硬上限：128；
- 无状态 Function Output 成本：2；
- Compaction 摘要请求最多 120 items；
- 替换历史最多保留最近 32 条真实 user messages，再追加 1 条摘要；
- 必然超限的 Function Calls 必须在任何 Tool 执行前失败。

预算必须按 Provider 最终编码成本计算，不能简单使用 request.input.length。Provider 完成 body.input 编码后必须执行最终硬断言；129 和 135 要在 fetch 前被拒绝。

02.1A 只修改 Item Budget、Compactor 双预算、Agent Loop 接线、Provider 硬断言、App Server 集中配置和对应测试。不要顺带修改 Reasoning UI、Permission、Skill、MCP、持久化格式或 Multi-Agent。

## Codex 风格 Runtime 的准确目标

我要的不是只有 Planning、Searched、Ran、Edited 的执行日志，而是截图中 Codex 那种面向用户的实时会话：

1. Agent 在执行过程中持续输出自然语言 Commentary；
2. Tool、Search、Read、Command 等 Activity 穿插在 Commentary 之间；
3. 公开 Reasoning Summary 可以折叠展示；
4. 最后单独显示正式 Assistant 回答；
5. 完成后操作明细自动折叠，但自然语言过程仍可读；
6. 失败、取消或超时后保留已经产生的过程；
7. 支持“已处理 X 秒/分钟”、平滑流式、自动跟随和用户滚动锁。

目标内容顺序：

用户消息
→ Runtime Commentary
→ Activity
→ Runtime Commentary
→ Reasoning Summary
→ Tool/Search/Command
→ Runtime Commentary
→ 最终 Assistant 回答

示例：

用户：
请修复 128 Items 问题

已处理 6 秒

我先检查 Context Builder、Agent Loop 和 Provider 的输入编码路径，确认上限应该在哪一层处理。

Planning item budget investigation
✓ 已读取 4 个相关文件
◌ 正在分析 Provider 编码

已处理 18 秒

已确认当前只有 Token Budget。短消息数量很多时，即使只有几百个 Token，也会直接提交超过 128 个 input items。

我现在构造 127、128、129 三个边界，验证真实提交数量。

Running boundary verification
✓ 127 items：允许
✓ 128 items：允许
◌ 正在验证 129 items

最终回答：
Item Budget 修复完成。120 items 自动压缩，128 为硬上限，129+ 在联网前拒绝，全部测试通过。

## Runtime Commentary 归类规则

模型第 N 轮开始：

- output_text.delta 先进入 streaming 临时块；
- 如果本轮最终存在 Function Calls，这段文本确认为 Runtime Commentary；
- 如果本轮没有 Function Calls，这段文本确认为最终 Assistant 回答；
- 最终文本只能显示一次，不能同时留在 Commentary 和 Assistant；
- 如果模型直接调用 Tool 且没有文本，Runtime 可以用固定安全模板补充“正在检查相关实现……”；
- 兜底文案不能包含原始 Tool 参数、Key、env、完整路径或 Tool Result 正文。

Runtime 有序内容至少包含：

- RuntimeCommentary；
- RuntimeActivity；
- RuntimeReasoningSummary；
- RuntimeSafeError；
- RuntimeSession.items，严格保持真实事件顺序。

Reasoning 必须按 turnId、模型 round 和 summaryIndex 分块。只能展示 Provider 明确返回的公开 Reasoning Summary，禁止请求、保存或输出模型私有 Chain-of-Thought 或 encrypted reasoning。

## Runtime UI 最小体验

- Commentary、Reasoning 和最终回答支持安全 Markdown；
- 当前步骤使用低干扰 running 动画；
- 同一 Activity 更新原条目，不重复新增 started/searching/completed；
- 用户在底部时自动跟随；
- 用户向上滚动时停止自动跟随；
- Turn 完成约 500ms 后折叠 Activity；
- Commentary 默认继续可见；
- 用户手动展开后不强制折叠；
- Failed、Cancelled、Timed out 必须结束全部 running 状态；
- 失败后已经显示的 Commentary、Activity 和 Sources 不能消失；
- Runtime 03 完成后，切换任务和重启客户端都能恢复过程。

## 安全边界

- Renderer 不能访问 Node、文件系统、child_process、process.env、原始 JSON-RPC 或 IPC channel；
- Main 与 Preload 继续使用固定 IPC 白名单和安全 DTO；
- Key、Token、Cookie、Authorization、env、完整绝对路径、原始 Tool arguments、未限制 Tool Result、原始请求和错误对象不能进入 Renderer；
- App Server stdout 只能承载 JSONL，清洗后的诊断只能写 stderr；
- Sources 必须使用安全打开链路；
- Runtime UI 不是 Raw Logs、Developer Console 或 Chain-of-Thought Viewer。

## 开始前必须

1. 检查项目内适用的 AGENTS.md；
2. 检查当前源码、package.json、测试和上述文档；
3. 保留所有现有未提交修改；
4. 不创建分支或 Worktree；
5. 未经本轮明确授权，不执行任何 Git 命令；
6. 不执行 commit、push、PR、merge、rebase、reset 或 checkout；
7. 不读取、修改或输出 Key；
8. 重新运行 npm run check、npm test、npm run electron:build；
9. 若测试基线不是 172/172，先查明并如实报告；
10. 先复核当前代码和 127/128/129 诊断，不要只相信 Prompt；
11. 按文件说明用途、验证命令和回滚点；
12. 一次只实施一个已确认切片。

## 验收

02.1A 至少覆盖：

- 119/120 软阈值；
- 127/128/129/135 硬边界；
- 64/65 个无状态 Tool Outputs；
- Compaction 后当前用户目标不丢失；
- 最新 Tool Result 不丢失；
- 必然超限时 Tool 执行次数为 0；
- Cancel、Timeout、CLI、Electron 无回归；
- npm run check、完整 npm test、npm run electron:build 通过。

Runtime Mode 至少覆盖：

- Tool 前公开文本成为 Commentary；
- Commentary 与 Activity 按真实顺序穿插；
- 最终 Assistant 文本只显示一次；
- Reasoning 按 round 和 summaryIndex 分块；
- 安全 Markdown；
- 已处理时间、自动滚动、滚动锁和完成后折叠；
- 失败、取消、超时保留过程并结束 running 动画；
- 历史恢复；
- Renderer 敏感信息隔离；
- CLI 行为不回归。

现在先完成：

1. 重新检查基线；
2. 复核 02.1A 方案与当前源码是否一致；
3. 列出 A1 准备修改的文件、用途、测试和回滚点；
4. 等待我确认后只实施 A1。

不要直接开始 Runtime UI，也不要一次实施 A1～A4。
```
