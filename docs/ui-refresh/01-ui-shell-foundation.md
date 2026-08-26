# 01｜小清新视觉系统与三栏应用壳

## 给负责人 Chat 的指令

只负责视觉基础和三栏壳。先读取仓库实际结构，再按下方边界实施；不要顺手修改会话、Runtime、权限、浏览器或测试基线之外的文件。

## 状态

`DONE`；已完成浅色小清新令牌和现有三栏壳的主题迁移，未改变业务状态语义。

## 目标

建立浅色小清新设计令牌、稳定的三栏桌面壳、可调整 Pane Divider，以及可被其他功能切片复用的 Button、Badge、StatusDot、Card、EmptyState 和 Modal 基础样式。

## 允许修改路径

- `src/electron/renderer/styles.css`
- `src/electron/renderer/index.html`
- 新增 `src/electron/renderer/ui/*` 或同等明确的基础组件目录
- 与上述组件一一对应的测试文件

## 禁止修改路径

- `src/electron/renderer/RuntimeTimeline.tsx`
- 会话数据、Runtime 状态机、权限策略、浏览器导航逻辑
- 其他 Chat 的需求文件和视觉基线
- `package.json`、lockfile、环境文件，除非主控 Chat 另行批准

## 设计要求

- 背景 `#F6F8F3`，面板 `#FFFFFF`，薄荷绿 `#E7F1E8`，植物绿 `#78A98A`，珊瑚 `#D9897B`，太阳黄 `#E8C56A`。
- 不使用大面积黑色、不使用高饱和红、不使用重阴影和无意义渐变。
- 左栏任务历史、中栏工作区、右栏 Inspector 默认约 220 / auto / 244px。
- 分隔器支持鼠标拖拽、键盘调整、最小/最大边界和安全回退。
- 所有交互元素具备 hover/focus/disabled/loading/error/success 状态；焦点必须可见。

## 验收标准

- [ ] 1024×1024、1280×800、1440×900、1920×1080 均无重叠、横向溢出和裁切。
- [ ] 右栏最小 220px、最大 420px；左栏不能挤压中央输入框至不可用。
- [ ] Tab 顺序符合左→中→右；Enter/Space 激活；Esc 关闭提示或弹层。
- [ ] 颜色、圆角、边框和间距全部来自令牌，不散落魔法值。
- [ ] 视觉截图没有黑块、强渐变、随机文本或外部浏览器框。

## 测试用例

| ID | 场景 | 预期 |
|---|---|---|
| SHELL-P01 | 默认窗口启动 | 三栏出现，无白屏、无 console error |
| SHELL-P02 | 拖拽分隔器到最小/最大 | 不越界、不重叠，中央工作区仍可用 |
| SHELL-N01 | 分隔器输入 NaN/负值 | 夹紧到安全默认值，不崩溃 |
| SHELL-R01 | 刷新/重启 | 布局回到产品定义的默认或已保存值 |
| SHELL-A01 | 键盘 Tab/Enter/Space/Esc | 顺序和行为正确，焦点可见 |
| SHELL-V01 | 固定视口截图 | 色板、圆角、边框和留白通过视觉检查 |

## 验收命令

由主控 Chat 根据仓库实际脚本执行并记录命令；至少包括：renderer 单测、typecheck、lint、Electron build、固定 viewport 截图。

## 完成回报

- 变更摘要：
- 测试命令与通过数：
- 截图证据路径：
- 未解决问题/阻塞：
- 回滚提交：建议 `ui-foundation-shell`，由主控 Chat 在获批后处理 Git。
