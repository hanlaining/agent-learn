# Chat Job 沉淀为 Skill：完整实施计划

日期：2026-08-12  
项目：`D:\练手\agent-learn`  
状态：需求方案，尚未施工。  
本轮范围：只记录设计与实施计划，不修改功能代码，不安装 Skill，不执行 Git 操作。

关联资料：

- [Chat 独立 Job 与单 Job Agent 树：解决方案](./Chat独立Job与单Job-Agent树-解决方案.md)
- [Codex 式父子 Agent 协作与共享数据板：完整实施计划](./Codex式父子Agent协作与共享数据板-完整实施计划.md)
- [阶段总结 02：从真实 Tokenizer 到 SkillLoader](./阶段总结-02-从真实Tokenizer到SkillLoader.md)

## 1. 需求结论

在主工作区顶部标题栏、Runtime 状态左侧增加一个入口：

```text
┌──────────────────────────────────────────────────────────────────┐
│ 当前 Chat 标题                   [沉淀为 Skill]  ● Runtime 已连接 │
└──────────────────────────────────────────────────────────────────┘
```

按钮文案第一版统一为：`沉淀为 Skill`。

该按钮不是“点击后立即生成并覆盖本机文件”的快捷操作，而是打开一个提炼向导，把当前 Chat 中选定 Job 的已验证执行事实转成可预览、可编辑、可校验的 Skill 草稿。只有用户确认目标目录并通过校验后，才允许安装。

完整流程：

```text
选择来源 Job
  → 创建不可变来源快照
  → Runtime 提炼 Skill 草稿
  → 用户预览和编辑
  → 安全检查与结构校验
  → 保存草稿 / 安装新 Skill / 显式更新已有 Skill
```

## 2. 产品目标与非目标

### 2.1 产品目标

- 将一次已经完成且有证据支持的 Chat Job，提炼为以后能重复触发的工作流程。
- 优先复用 Job 的结构化 Runtime 数据，而不是只让模型总结聊天文本。
- 让用户在安装前看清楚 Skill 名称、触发条件、输入、步骤、输出、权限和所有生成文件。
- 草稿与已安装 Skill 分离，避免半成品立即影响后续 Agent。
- 对密码、Token、Cookie、个人信息、机器路径和无证据结论做强制过滤。
- 支持从成功 Job 沉淀正常流程，也支持从失败 Job 沉淀“排查/恢复流程”，但两者不得混淆。
- 生成结果遵循标准 Skill 目录结构，并能被项目现有 `SkillLoader` 或选定的外部 Skill 根目录发现。

### 2.2 第一版非目标

- 不复制隐藏思维链、完整模型上下文或原始未过滤日志。
- 不自动把所有附件、工作区文件或命令输出塞进 Skill。
- 不自动安装、不静默覆盖同名 Skill、不自动修改全局配置。
- 不把失败、取消、未验收的业务结果包装成“已验证最佳实践”。
- 不在第一版支持跨多个 Job 自动合并为一个 Skill；后续可以在已有草稿上追加来源快照。
- 不保证任意 Job 都适合沉淀；一次性问题应允许用户取消操作。

## 3. UI 位置与交互设计

### 3.1 顶部入口

入口位于截图红框所示区域，即主工作区标题栏中间偏右、Runtime 状态左侧。该位置同时满足：

- 它作用于当前 Chat / 当前 Job，而不是全局设置。
- 不占用消息输入区，避免被误解为一次对话指令。
- 能与当前 Runtime 和 Job 状态联动。

桌面宽度不足时，按钮可收缩为图标，并通过 tooltip 显示“将当前 Job 沉淀为 Skill”；移动到窄窗口时，应保留在标题栏溢出菜单中，不能直接消失。

### 3.2 按钮状态

| 当前状态 | 按钮表现 | 点击结果 |
|---|---|---|
| 新 Chat 尚未持久化 | 禁用 | 提示“发送第一条任务后可沉淀” |
| 当前 Chat 没有 Job | 禁用 | 提示“当前 Chat 尚无可用 Job” |
| Job 正在运行 | 可用但标注“运行中” | 允许基于当前时点创建快照草稿，并提示内容可能不完整；推荐完成后操作 |
| Job 已完成且验收通过 | 正常启用 | 默认来源，进入提炼向导 |
| Job 已完成但缺少独立 Review | 可用并显示风险提示 | 可以保存草稿，安装前要求用户确认“未完全验收” |
| Job 失败 | 受限可用 | 只能选择“排查 / 恢复 Skill”，失败结论不得作为成功输出 |
| Job 已取消或超时 | 受限可用 | 只能提炼已经有 Evidence 支持的局部流程或恢复流程 |
| Job 正在删除、Chat 位于回收站 | 禁用 | 先恢复 Chat 后再操作 |
| 正在提炼 | loading + 禁止重复提交 | 展示阶段进度，允许关闭面板后后台继续 |

按钮状态只由真实持久化数据决定，不能根据页面上是否出现了一段最终回答来猜测 Job 是否成功。

### 3.3 提炼向导

第一版建议使用右侧抽屉或居中大弹窗，分四步：

1. **选择来源**
   - 默认选中当前 Chat 最新 Job。
   - 显示 Job 标题、状态、开始/结束时间、任务数、证据数和 Review 状态。
   - 当前 Chat 有多个历史 Job 时允许切换，但不允许跨 Chat 混选。
   - 运行中 Job 必须显示快照时间。

2. **提炼设置**
   - Skill 类型：正常工作流 / 排查与恢复。
   - 名称、展示名、描述和典型触发语句。
   - 输入变量：例如项目路径、环境、账号角色、文件路径、目标分支。
   - 输出合同：例如修改文件、报告、截图、测试结果。
   - 可选内容：脚本、参考资料、模板资源；默认均按“必要才生成”。

3. **预览与编辑**
   - 左侧显示目录树，右侧显示所选文件内容。
   - 用户可以修改生成内容，但来源事实和用户编辑应分别记录。
   - 单独展示“已排除内容”和“安全告警”，让过滤行为可解释。
   - 提供 Job 证据引用清单，能回看使用了哪些 Evidence、Review 和 Shared Board 条目。

4. **校验与落地**
   - 执行名称、Frontmatter、目录结构、引用文件、敏感信息和目标路径校验。
   - 默认主按钮为“保存草稿”。
   - “安装 Skill”是独立危险度更高的操作，必须显示目标目录和文件清单并二次确认。
   - 检测到同名 Skill 时，不提供静默覆盖；只能取消、改名或进入显式更新流程。

建议按钮与提示文案：

```text
主入口：沉淀为 Skill
向导操作：重新提炼 / 保存草稿 / 校验 / 安装 Skill
运行中提示：当前 Job 尚未结束，本草稿仅包含 2026-08-12 18:30 前的已确认事实。
失败 Job 提示：该 Job 未成功完成，只能沉淀排查、诊断或恢复步骤。
```

## 4. 沉淀来源与数据边界

### 4.1 允许作为来源的数据

应按照“结构化事实优先，文本总结补充”的顺序提取：

1. 当前 Job 的用户目标、明确边界与验收标准。
2. `AgentTask` 合同、Task DAG、依赖关系和最终状态。
3. 成功的 `AgentRun`，包括角色、执行步骤和已确认输出。
4. `AgentEvidence` 中的来源、产物、Diff、测试、截图、Review 和远端状态证据。
5. `SharedBoardEntry` 中已经确认的事实、决策、测试结果、产物索引和约束。
6. Job 创建时固化的模型、Tool、Skill、权限和团队配置快照。
7. Return Outbox 中已被父 Agent 接收且有 Ack 的结构化结果。
8. 用户在 Chat 中明确纠正、确认或拒绝的方案。
9. 最终回答中的可复用说明，但只能作为辅助材料，不能覆盖结构化事实。

### 4.2 必须排除的数据

- 隐藏思维链、内部 reasoning 原文和完整模型上下文。
- 未过滤的 stdout/stderr、原始网络响应、浏览器存储或诊断转储。
- API Key、Token、Cookie、密码、Authorization Header、私钥和恢复码。
- 未经用户明确选择的个人信息、账号、邮箱、电话号码和业务敏感数据。
- 本机临时目录、随机端口、进程号、一次性 ID 和只在当前机器成立的绝对路径。
- 失败或未验收的模型自述、没有 Evidence 支持的结论。
- 被用户否决的方案、已回滚的变更和失败 Run 的错误输出；除非 Skill 类型明确为排查 / 恢复，且这些内容被改写为失败识别规则。
- 与目标重复工作无关的闲聊、状态播报和临时协作消息。

### 4.3 路径与值的参数化

提炼器不应简单删除所有机器信息，而应把确实影响流程的具体值改写为输入变量。例如：

```text
D:\练手\agent-learn
→ {{project_root}}

https://test.example.com
→ {{target_base_url}}

固定测试账号角色
→ {{account_role}}
```

变量必须包含用途说明、是否必填、允许值和安全级别。秘密值只能声明“运行时由用户或安全凭据系统提供”，不得写入默认值或示例值。

## 5. SkillDraft 领域模型

建议新增持久化的 `SkillDraft`，它是 Job 来源快照与本机已安装 Skill 之间的安全缓冲层：

```ts
interface SkillDraft {
  id: string;
  sourceThreadId: string;
  sourceJobId: string;
  sourceSnapshotAt: string;
  sourceJobStatus: AgentJobStatus;
  sourceReviewStatus: "passed" | "missing" | "failed";

  name: string;
  displayName: string;
  description: string;
  kind: "workflow" | "diagnostic_recovery";
  status:
    | "extracting"
    | "draft"
    | "validating"
    | "valid"
    | "invalid"
    | "installing"
    | "installed"
    | "failed";

  triggerExamples: string[];
  inputVariables: SkillInputVariable[];
  workflowSteps: SkillWorkflowStep[];
  outputContract: SkillOutputContract[];
  permissionContract: SkillPermissionContract;

  evidenceIds: string[];
  boardEntryIds: string[];
  generatedFiles: SkillDraftFile[];
  excludedFindings: SkillExcludedFinding[];
  validationIssues: SkillValidationIssue[];

  revision: number;
  createdAt: string;
  updatedAt: string;
  installedPath?: string;
  installedAt?: string;
}
```

配套类型至少包含：

```ts
interface SkillInputVariable {
  key: string;
  label: string;
  description: string;
  required: boolean;
  sensitivity: "public" | "workspace" | "secret";
  example?: string; // sensitivity=secret 时禁止出现
}

interface SkillWorkflowStep {
  id: string;
  title: string;
  instruction: string;
  dependsOn: string[];
  requiredEvidenceKinds: string[];
  failurePolicy: "stop" | "retry" | "fallback" | "ask_user";
  sourceTaskIds: string[];
}

interface SkillDraftFile {
  relativePath: string;
  content: string;
  origin: "generated" | "source_artifact" | "user_edited";
  sha256: string;
}

interface SkillValidationIssue {
  severity: "error" | "warning" | "info";
  code: string;
  file?: string;
  message: string;
  remediation?: string;
}
```

关键约束：

- 来源快照一旦创建不可变；重新读取运行中的 Job 必须产生新 revision 或新草稿。
- 用户编辑生成文件时保留 revision，防止后台重新提炼覆盖手工修改。
- `installed` 只表示某个已校验 revision 已写入目标目录；继续编辑草稿后应回到 `draft`。
- 删除 Chat 或 Job 时，不连带删除已安装 Skill；草稿按独立保留策略处理。

## 6. Job 到 Skill 的提炼规则

### 6.1 确定候选工作流

提炼器先读取 Task DAG，只选择满足以下条件的节点：

- 节点成功完成，或者其局部产物已被 Review 明确接受。
- 必需输出均有 Evidence 覆盖。
- 对父任务的 Return 已送达并 Ack，避免使用父 Agent 尚未接收的中间结论。
- 节点没有被后续返工结论替代。

然后把 DAG 压缩为面向重复执行的步骤：相邻且职责一致的低层节点可以合并；不同权限边界、不同验收点或可并行分支必须保留。

### 6.2 提炼输入和触发条件

- 将用户多次提及或影响分支判断的具体值识别为输入变量。
- 将一次性任务描述改写为适用范围清晰的触发描述。
- 生成 3–8 条正向触发示例，并生成不适用范围；描述不能宽泛到几乎所有任务都会命中。
- 原 Job 中已经调用的 Skill 只作为依赖候选，不能自动复制其内容。

### 6.3 提炼步骤和验收点

每个工作流步骤应包含：

- 何时执行、需要哪些输入和前置条件。
- 应读取哪些结构化事实或文件，而不是把一次运行时值写死。
- 允许使用的 Tool / Skill 和所需权限。
- 产出什么，以及必须由哪类 Evidence 证明完成。
- 常见失败、重试边界、恢复方式和何时必须询问用户。

提炼器应保留已证实的关键顺序，不保留“为了当前对话而产生的播报顺序”。能够并行的分支可以在 Skill 中明确为并行候选，但不能强制依赖某一种 Agent 数量。

### 6.4 成功、失败和部分完成 Job

| 来源 Job | 可生成内容 | 禁止内容 |
|---|---|---|
| 完成且 Review 通过 | 标准工作流 Skill | 无证据的额外能力 |
| 完成但未 Review | 带警告的草稿 | 默认直接安装 |
| 失败 | 诊断 / 恢复 Skill | 把失败输出描述为成功方法 |
| 取消或超时 | 有证据覆盖的局部步骤 | 推断未完成步骤的结果 |
| 运行中 | 截止快照时点的草稿 | 宣称 Job 已完整验收 |

## 7. 生成的 Skill 结构

标准输出：

```text
skill-name/
├── SKILL.md
├── agents/
│   └── openai.yaml
├── scripts/       # 只有重复且确定性的操作值得固化时才生成
├── references/    # 详细合同、领域知识、检查表按需生成
└── assets/        # 只有确有模板、样例或静态资源时才生成
```

生成原则：

- `SKILL.md` 保持精炼，包含名称、描述、触发边界、工作流、输入输出、安全规则和必要资源导航。
- 大段领域资料放进 `references/`，不要让 `SKILL.md` 退化成完整运行日志。
- `scripts/` 只承载可确定、可测试、重复执行价值高的机械步骤；模型推理不伪装成脚本。
- `assets/` 不复制任意来源附件，只复制用户明确选择且授权复用的模板或资源。
- `agents/openai.yaml` 与 `SKILL.md` 保持一致；展示名称、描述和默认提示不得扩大 Skill 能力边界。
- 生成新 Skill 时优先使用 Skill Creator 提供的初始化脚本创建规范骨架，再填充内容；校验使用其快速校验脚本或项目中等价的校验器。

项目当前 `SkillLoader` 第一版只发现 Skill 根目录下一层的 `<name>/SKILL.md`。因此施工时需要明确兼容层：`SKILL.md` 必须始终可被现有 Loader 独立读取；`agents/`、`scripts/`、`references/`、`assets/` 是可选增强目录，Loader 未支持的元数据不能成为执行 Skill 的硬依赖。

## 8. Runtime 服务与 RPC 设计

建议新增以下请求：

```text
skill-draft/create-from-job
skill-draft/get
skill-draft/list
skill-draft/update
skill-draft/re-extract
skill-draft/preview
skill-draft/validate
skill-draft/install
skill-draft/delete
```

职责建议：

| RPC | 作用 | 关键约束 |
|---|---|---|
| `create-from-job` | 创建来源快照并启动提炼 | 校验 threadId/jobId 归属；幂等键防重复提交 |
| `get` | 读取草稿、文件和校验问题 | 只返回 Renderer 可展示的安全数据 |
| `list` | 列出当前 Chat 或全部草稿 | 默认不返回完整文件正文 |
| `update` | 保存用户编辑 | 使用 revision 乐观锁，拒绝覆盖新版本 |
| `re-extract` | 从同一或更新快照重新提炼 | 不覆盖用户编辑版本，生成新 revision |
| `preview` | 返回目录树和选定文件 | 路径必须是相对路径并经过规范化 |
| `validate` | 执行结构、安全、引用和兼容校验 | 不产生安装写入 |
| `install` | 经确认后写入选定 Skill 根目录 | 必须传 expectedRevision、目标路径和冲突策略 |
| `delete` | 删除项目内草稿 | 不删除已安装 Skill |

建议使用事件推送提炼阶段：

```text
skill-draft/extracting
skill-draft/progress
skill-draft/validated
skill-draft/installed
skill-draft/failed
```

提炼任务应独立于当前 Chat 的消息发送状态；用户关闭抽屉、切换 Chat 或页面重载后可以重新获取进度。取消提炼只取消草稿生成任务，不得取消来源 Job。

## 9. 持久化与一致性

### 9.1 草稿持久化

建议把 Skill 草稿加入 Runtime 的版本化持久化快照，或使用独立的版本化草稿存储。若沿用单文件 Runtime 状态：

- 升级 snapshot version，并提供旧版本迁移默认值。
- 大型附件不能直接内嵌主状态文件，只保存受控引用和哈希。
- 写入继续采用临时文件 + 原子替换，防止断电产生半份草稿。

若使用独立草稿目录：

```text
runtime-data/
└── skill-drafts/
    └── <draft-id>/
        ├── draft.json
        └── files/...
```

该目录仅是项目内部草稿区，不是已安装 Skill 根目录，现有 `SkillLoader` 不应扫描这里。

### 9.2 安装事务

安装过程：

1. 再次验证草稿 revision 和全部生成文件。
2. 解析并展示绝对目标目录，但写入算法只接收受控根目录 + 安全相对名称。
3. 在目标根目录内创建同级临时目录。
4. 写入文件并重新读取校验内容与哈希。
5. 运行完整 Skill 校验。
6. 目标不存在时再原子重命名为最终目录。
7. 记录安装路径、revision、哈希和时间。
8. 刷新 SkillLoader 或提示需要重启；具体行为以施工时验证现有 Loader 生命周期为准。

任一步失败都清理临时安装目录，不能留下可被 Loader 当成正式 Skill 的半成品。

## 10. 安全、权限与安装边界

### 10.1 两次安全扫描

第一次在来源快照进入模型前执行，第二次在生成文件安装前执行。至少检测：

- 常见凭据格式、私钥块、认证 Header 和高熵秘密值。
- 环境变量值、浏览器 Cookie、本机用户目录和临时目录。
- 绝对路径、目录穿越、软链接逃逸和保留设备名。
- 引用不存在的文件、超大文件、二进制伪装文本。
- 指令注入内容，例如要求跳过权限、读取全盘或上传秘密。

检测到疑似秘密时默认阻止安装，只允许用户返回编辑或将其参数化；不提供“一键忽略全部”。

### 10.2 权限合同

草稿需要明确：

- 默认只读、允许修改工作区、允许执行命令、需要联网等权限范围。
- 哪一步需要哪种权限，以及不授权时的降级方式。
- 不得因为来源 Job 曾获得一次权限，就把该权限视作永久授权。
- 安装 Skill 不等于授权 Skill 以后自动执行敏感操作。

### 10.3 目标目录

第一版只允许用户从配置好的 Skill 根目录列表中选择，例如项目 `skills/` 或用户明确配置的个人 Skill 根目录。安装时：

- 展示解析后的完整目标目录。
- 校验最终路径仍在所选 Skill 根目录内。
- 不接收任意未验证绝对路径作为 RPC 安装目标。
- 不自动修改认证、环境变量、MCP 配置或全局 Agent 配置。

## 11. 重名、更新、版本与回滚

### 11.1 重名策略

检测到同名目录或同名 Skill 时，安装请求必须失败并返回结构化冲突信息。UI 提供：

- 修改新 Skill 名称。
- 查看已有 Skill。
- 进入“更新已有 Skill”流程。
- 取消。

### 11.2 更新已有 Skill

更新不能复用“新安装”确认框直接覆盖。用户必须显式选定目标 Skill，并看到：

- 文件级新增、修改、删除清单。
- `SKILL.md` 文本差异。
- 触发范围、权限合同和脚本变化的高亮风险提示。
- 原版本备份位置和可回滚说明。

更新时保存 manifest：来源 draft、安装前后哈希、时间和备份路径。失败后恢复原目录；成功后至少保留最近一个可恢复版本，清理策略后续单独配置。

### 11.3 删除规则

- 删除草稿只影响草稿存储，不影响来源 Chat / Job 和已安装 Skill。
- 删除 Chat / Job 不自动卸载 Skill。
- 卸载 Skill 属于独立需求，第一版不通过本向导实现。

## 12. 分阶段施工计划

### 阶段 A：契约与只读快照

目标：先建立稳定的数据边界，不做安装。

- 定义 `SkillDraft`、来源快照、状态机和校验错误类型。
- 为 `AgentRuntimeStore` 增加按 Job 生成安全快照的只读服务。
- 明确成功 Task、Evidence、Review、Board、Return Ack 的筛选规则。
- 实现敏感字段清洗、路径参数化候选和来源引用。
- 增加旧 Runtime snapshot 的兼容迁移测试。

完成标志：对任意 Job 可以生成一份不包含隐藏上下文和秘密值的稳定 JSON 快照。

### 阶段 B：草稿生成与持久化

- 实现草稿存储、revision 乐观锁和状态恢复。
- 实现 `create/get/list/update/re-extract/delete` RPC。
- 构建确定性的提炼输入；让模型输出严格结构化结果，再由程序生成文件。
- 对模型输出做 schema 校验，不接受模型直接指定安装绝对路径。
- 生成 `SKILL.md` 与按需的辅助目录。

完成标志：重启 App 后草稿仍存在，可以查看来源、编辑文件并重新提炼。

### 阶段 C：顶部入口与提炼向导

- 在 `App.tsx` 的工作区标题栏增加按钮，并补齐禁用、loading、tooltip 和窄屏表现。
- 在桌面快照中暴露当前 Job 的可沉淀状态与原因，Renderer 不自行推断。
- 实现来源、设置、预览编辑、校验落地四步向导。
- 打通 IPC、Controller、App Server RPC 和提炼进度事件。
- 切换 Chat 后抽屉内容必须随 Chat 隔离；后台提炼不中断。

完成标志：用户能从截图红框处创建、编辑并保存当前 Job 的 Skill 草稿。

### 阶段 D：校验与安全安装

- 实现结构、Frontmatter、文件引用、名称和敏感信息校验。
- 接入规范 Skill 初始化与快速校验流程，保留适合打包环境的等价实现或清晰错误提示。
- 实现受控目标根目录、临时目录写入、哈希复核和原子安装。
- 检测同名冲突，不允许静默覆盖。
- 安装成功后验证项目现有 `SkillLoader` 能发现并读取新 Skill。

完成标志：一个通过校验的草稿可以安全安装，并在下一次匹配任务中被 Loader 正确列出和读取。

### 阶段 E：显式更新与回滚

- 增加选择已有 Skill、文件 Diff、风险高亮、备份和回滚。
- 验证更新失败不会破坏旧 Skill。
- 补充草稿与安装版本的追溯记录。

完成标志：用户可以看清差异后更新已有 Skill，并能恢复到更新前版本。

## 13. 预计代码落点

以下是施工阶段的候选位置，本轮不修改：

| 层级 | 现有位置 / 建议新增位置 | 职责 |
|---|---|---|
| Renderer | `src/electron/renderer/App.tsx`、`styles.css` | 顶部按钮、向导、预览、校验和确认 UI |
| Desktop 类型 | `src/electron/desktop-types.ts` | 草稿摘要、事件和可沉淀状态的安全类型 |
| Preload / IPC | `src/electron/preload.cjs`、`main.cjs`、`global.d.ts` | 暴露受控方法并校验跨进程数据 |
| Desktop Controller | `src/electron/desktop-controller.ts` | 组合快照、调用 RPC、隔离 Chat 和恢复进度 |
| App Server | `src/app-server/handlers.ts` | SkillDraft RPC、鉴权、幂等和错误映射 |
| Runtime | 建议新增 `src/skills/skill-draft*.ts` | 来源快照、提炼、状态机、持久化和校验 |
| 安装器 | 建议新增 `src/skills/skill-installer.ts` | 路径安全、冲突检测、原子安装和回滚 |
| 现有 Loader | `src/skills/skill-loader.ts` | 安装后发现与兼容验证；只做必要改动 |
| 持久化 | `src/runtime/json-file-runtime-persistence.ts` 或独立草稿存储 | 保存草稿元数据、版本迁移 |
| 测试 | `tests/skill-draft-*`、Electron/App Server 测试 | 单元、契约、恢复、安全和 UI 验收 |

施工前应先复核当前打包环境能否访问 Skill Creator 的初始化 / 校验脚本；若运行时不可依赖外部脚本，则把同一套规则实现成项目内校验器，不能让桌面 App 依赖开发机专属路径。

## 14. 测试与真实页面验收

### 14.1 单元测试

- Job 归属和来源快照不可变。
- 只选择成功且有 Evidence 的 Task；返工后旧结论被排除。
- Review 缺失、失败、取消、超时和运行中状态映射正确。
- Token、Cookie、私钥、绝对临时路径被阻断或参数化。
- Skill 名称、Frontmatter、描述长度、目录名一致性和引用文件校验。
- `../`、绝对路径、软链接、保留设备名和大小写同名不能逃逸目标根目录。
- revision 冲突不会覆盖用户较新编辑。
- 同一幂等键重复创建不会启动两个提炼任务。
- 安装中断后不会留下可被 Loader 发现的半成品。

### 14.2 集成测试

- App Server RPC 从创建草稿到校验的完整闭环。
- Electron IPC 对非法输入进行拒绝和净化。
- App 重启后恢复提炼中、草稿、无效和已安装状态。
- 当前 Chat 切换不串草稿，不串 Job 来源，不取消后台提炼。
- 运行中 Job 的两个快照保留各自时间点和 revision。
- 安装后 `SkillLoader.list()` 能列出，`read()` 能读取完整说明。
- 同名安装返回冲突，旧 Skill 内容不变。
- 显式更新失败时旧版本可以恢复。

### 14.3 真实页面验收用例

1. 打开一个没有 Job 的新 Chat，按钮禁用且原因正确。
2. 运行一个包含多个 Agent、Task DAG、Evidence 和 Review 的成功 Job。
3. Job 完成后按钮正常启用，默认选择当前最新 Job。
4. 进入预览，确认步骤来自成功 Task，证据来源可追踪，未出现 reasoning 或原始日志。
5. 将项目绝对路径改为变量，保存并重开草稿，内容不丢失。
6. 故意加入测试 Token，校验阻止安装并定位到文件。
7. 清理后安装到项目 Skill 根目录，确认目录与 Loader 发现结果正确。
8. 再次安装同名 Skill，确认不能覆盖，并出现改名 / 更新选择。
9. 对一个失败 Job 操作，只能生成排查 / 恢复 Skill，UI 不声称任务成功。
10. 在 Job 运行中创建快照，提示时间点；Job 完成后重新提炼产生新 revision，不覆盖旧编辑。
11. 提炼过程中切换 Chat，再返回时进度和草稿仍属于原 Chat。
12. 缩窄窗口，顶部入口进入图标或溢出菜单，Runtime 状态不被遮挡。

### 14.4 可访问性与可用性

- 按钮、步骤切换、文件树和确认框支持键盘操作。
- loading、成功、警告和失败不能只靠颜色区分。
- 风险提示可被屏幕阅读器朗读，焦点在弹窗打开和关闭后位置正确。
- 生成时间较长时持续展示阶段进度，不用虚假的百分比。

## 15. 完成标准

以下条件全部满足才算此需求完成：

- 截图红框区域存在清晰、响应式、状态正确的“沉淀为 Skill”入口。
- 当前 Chat 的 Job 选择与其他 Chat 完全隔离。
- 草稿只使用允许的结构化事实，所有核心步骤可追溯到 Task / Evidence / Board / Review。
- 隐藏思维链、秘密值、原始日志和机器专属信息不会进入已安装文件。
- 成功 Job、未 Review Job、失败 Job、取消 / 超时 Job 和运行中 Job 的策略符合本方案。
- 用户能预览、编辑、保存、重启恢复和校验草稿。
- 安装前明确显示目标目录与文件，且不会静默覆盖同名 Skill。
- 安装过程具备路径防逃逸、原子写入、失败清理和结果复核。
- 新 Skill 能被现有 Loader 正确发现、读取，并在匹配任务中按需触发。
- 单元、集成和真实页面验收通过，未破坏现有多 Chat、多 Agent、回收站和 Runtime 会话能力。

## 16. 推荐施工顺序与首版范围

推荐先交付 A–D 阶段，首版形成：

```text
当前 Job
→ 安全来源快照
→ Skill 草稿
→ 预览编辑
→ 校验
→ 安装一个全新 Skill
```

“更新已有 Skill + Diff + 回滚”作为紧随其后的 E 阶段单独验收。首版即使暂未开放更新，也必须在遇到同名时安全停止，不能以覆盖来代替更新设计。

进入施工前，建议先确认两项产品选择：

1. 首版默认安装目标是项目内 `D:\练手\agent-learn\skills`，还是允许用户选择已配置的个人 Skill 根目录。
2. 对“已完成但缺少独立 Review”的 Job，安装动作是完全禁止，还是允许用户在明确风险确认后继续。

这两项只影响安装策略，不影响前四个阶段的草稿数据合同和 UI 入口设计。
