# 02｜任务历史、会话与 Runtime Timeline

## 给负责人 Chat 的指令

只消费 01 的壳和视觉令牌，完成左侧任务历史、中间会话、Composer 和 Runtime Timeline。真实模型与工具一律 mock；禁止修改 Inspector、权限和浏览器逻辑。

## 状态

`DONE`；Runtime Timeline 已增加安全空态、状态标签、ARIA、动态播报和错误提示，原有事件顺序与折叠语义保持不变。

## 允许修改路径

- `src/electron/renderer/App.tsx`（仅负责会话区域组装；若与其他 Chat 冲突，先提交阻塞说明）
- `src/electron/renderer/history-groups.ts`
- `src/electron/renderer/RuntimeTimeline.tsx`
- `src/electron/renderer/runtime-ui.ts`
- 新增 `src/electron/renderer/conversation/*`、`fixtures/*`
- 上述模块对应测试

## 禁止修改路径

- 共享色板和壳组件 API
- `src/electron/desktop-controller.ts`、preload 和 Runtime 后端语义
- Inspector、权限、浏览器、部署页面
- 真实 Provider、真实工具或真实文件副作用

## 功能状态

- Idle 首页：最近任务、空会话、输入框和 Runtime 空时间线。
- Task composition：任务输入、权限模式、模型选择、子 Agent 开关。
- Runtime execution：reasoning、tool、search 节点和实时进度。
- completed/error/retry：成功摘要、安全错误、幂等重试。
- Timeline 节点状态：queued、running、awaiting_permission、completed、failed、cancelled、retrying。

## 验收标准

- [ ] 空会话留白充足，标题 ≤28px，短标签只使用需求白名单。
- [ ] 搜索支持中文、英文、大小写、空格、无结果和清空；分组顺序稳定。
- [ ] Composer 空值禁用；Enter 发送；Shift+Enter 换行；发送中可取消；失败可重试。
- [ ] Timeline 按 `startedAt + eventId` 稳定排序，重复 eventId 不重复渲染。
- [ ] 展开/收起状态在新增事件、刷新和重新进入线程后符合产品定义。
- [ ] 错误文案安全，不泄漏 token、绝对路径、堆栈或内部请求内容。

## 测试用例

| ID | 场景 | 预期 |
|---|---|---|
| CONV-P01 | 首次打开 | 显示空会话和最近任务，无 404/异常 |
| CONV-P02 | 有效输入发送 | 只创建一条用户消息，按钮进入 loading |
| CONV-N01 | 空输入/空响应 | 发送不可用或显示安全错误，不产生伪成功 |
| CONV-I01 | 重复发送/重复 retry | 同一 actionId 不产生重复消息或重复节点 |
| RT-P01 | idle→running→completed | 顺序、颜色、耗时和完成状态准确 |
| RT-N01 | 缺 eventId/未知状态/乱序事件 | 安全占位、稳定排序、不崩溃 |
| RT-R01 | 应用重启/网络恢复 | 时间线恢复且晚到事件不能回滚 cancelled |
| RT-A01 | 键盘展开节点 | aria-expanded、焦点和非颜色状态正确 |

## 验收命令

执行 renderer 单测、RuntimeTimeline 单测、集成/E2E、typecheck、lint、Electron build，并生成 idle/task/runtime/error 四张固定截图。

## 完成回报

- 变更摘要：
- 测试命令与通过数：
- 截图证据路径：
- 未解决问题/阻塞：
- 回滚提交：建议 `conversation-runtime-states`。
