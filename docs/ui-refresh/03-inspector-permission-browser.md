# 03｜Workbench Inspector、权限、模型、浏览器与错误态

## 给负责人 Chat 的指令

只负责右侧 Inspector 和辅助状态。使用本地 mock，不伪造尚未接入能力；与 02 通过 eventId/requestId 和公开 props/events 协作。

## 状态

`VERIFIED`；现有 Inspector、权限、模型、浏览器和未接入空态已通过 Electron 与新增 UI 门禁验证，本轮未扩大其真实能力边界。

## 允许修改路径

- 新增 `src/electron/renderer/inspector/*`
- 新增 `src/electron/renderer/modals/*`
- 新增 `src/electron/renderer/browser-preview/*`
- 新增 `src/electron/renderer/status-pages/*`
- 与上述模块对应的测试

## 禁止修改路径

- 02 负责的会话消息、Composer、Timeline 数据结构
- 共享色板、路由、Runtime 后端和真实权限执行器
- `package.json`、lockfile、环境文件

## 功能要求

- Inspector tabs：变更、活动、终端、浏览器、扩展。
- 未接入态必须准确显示“变更检查尚未接入”“桌面终端尚未接入”。
- 权限风险：read、execute、sensitive；操作只有“允许一次”“拒绝”。
- 模型菜单：low、medium、high、xhigh；无效值回退 medium。
- 浏览器只允许安全本地预览 URL；拒绝 `file:`、`javascript:`、`data:` 和非白名单 host。
- 错误页支持安全摘要、重试、取消和恢复；部署成功页展示证据摘要和预览链接占位。

## 验收标准

- [ ] 五个 tab 切换不重置中央任务，滚动和筛选按 tab 独立保存。
- [ ] 权限弹层默认焦点安全；重复点击、断网、过期、撤销均不产生重复副作用。
- [ ] 弹层有 dialog/aria-modal/focus trap；Esc 和遮罩行为符合产品定义。
- [ ] 浏览器地址栏只能接受安全本地 URL；不依赖外网。
- [ ] success/error/deferred 状态文案、颜色和按钮动作准确。

## 测试用例

| ID | 场景 | 预期 |
|---|---|---|
| INS-P01 | 切换五个 tab | 内容正确、焦点正确、布局不跳动 |
| INS-N01 | 缺字段/401/403/500 | 安全错误空态，不崩溃、不伪造数据 |
| PA-P01 | read→允许一次 | 当前 request 仅执行一次并记录审计 |
| PA-N01 | sensitive→Esc/拒绝 | 不批准、不执行、焦点回到触发控件 |
| PA-I01 | 重复 approve 回包 | 只有一条决策和一次执行 |
| PA-R01 | 重启后 open request | 回到待审批，不自动放行 |
| BR-P01 | 本地预览→刷新→后退 | tab 历史隔离，按钮状态正确 |
| BR-N01 | 危险 URL | 拒绝导航，不发起请求 |
| ERR-R01 | error→retry | 生成新 attempt，旧失败只读，不重复节点 |
| A11Y-01 | 键盘操作所有 tab/弹层 | 无焦点丢失，ARIA 状态准确 |

## 验收命令

执行 Inspector/Modal/Browser 单测、E2E 关键路径、a11y、typecheck、lint、Electron build 和状态截图。

## 完成回报

- 变更摘要：
- 测试命令与通过数：
- 截图证据路径：
- 未解决问题/阻塞：
- 回滚提交：建议 `inspector-overlays-quality-gates`。
