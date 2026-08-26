# God-Agent 安全扫描与发布门禁

## 当前安全边界

God-Agent 是单机研究原型。仓库内的安全门禁用于减少“把凭据或本地状态误纳入发布候选”的风险，不等同于专业代码审计、依赖漏洞数据库、恶意代码分析或生产环境渗透测试。

安全扫描入口：

```powershell
npx --no-install tsx scripts/security-scan.ts
```

发布就绪入口：

```powershell
npx --no-install tsx scripts/release-readiness.ts
```

两个入口均不会调用真实 Provider，也不会读取环境变量中的秘密值。

## Secret 扫描器做什么

扫描器通过 Git 的 tracked/untracked-but-not-ignored 候选清单选择文件，不递归扫描整台机器。随后只读取工作区内的普通 UTF-8 文本，并检测下列高置信模式：

- 私钥材料头；
- 长 Bearer credential；
- OpenAI、GitHub、Slack、AWS 和 Google 常见 Token 形态；
- 分配给 credential 字段、并满足长度和字符复杂度条件的通用秘密。

报告只包含：

- 相对文件路径；
- 规则 ID；
- 行号。

报告和机器结果不保存命中字符串、上下文行或秘密全文。即使调用方把报告序列化为 JSON，也不应得到命中的秘密内容。

## 默认排除与拒绝

默认排除 `.git`、`node_modules`、`dist`、`.tmp`、coverage、容量报告和本地 Agent 状态目录。二进制文件和超过 2 MiB 的文本不进入正则扫描，并在内部结果中标记为 skipped。

候选路径必须满足以下条件：

- 是工作区内相对路径；
- 不包含父目录跳转；
- 是普通文件；
- 解析后的真实路径仍位于工作区内；
- 不是符号链接。

违反路径边界时扫描器 fail closed，不读取目标内容。

## 发布就绪分级

发布门禁输出三个总状态：

| 状态 | 含义 |
|---|---|
| `READY` | 所有 blocking 与 warning 检查均清零 |
| `CONDITIONAL` | 没有 blocking，但仍有需人工确认的 warning |
| `BLOCKED` | 至少一个发布阻断项存在 |

当前检查包括：

- package 名称、版本、说明、license 元数据、入口与 provenance；
- README 的当前能力与 Claim 边界；
- LICENSE 与 NOTICE 文件；
- Windows CI 中的锁定安装、类型、测试发现、主测试、Benchmark、Runtime-E2E、Process Chaos 和 Electron 构建；
- 正式测试文件是否被 package scripts 明确覆盖；
- Electron 主进程与 Renderer 构建产物；
- 敏感文件名和本地状态文件黑名单；
- Provider Smoke 是否保持 offline-by-default；
- Secret 扫描结果。

LICENSE 缺失是 blocking。NOTICE 缺失目前为 warning，因为具体归属义务需要结合项目和依赖许可证人工确认。门禁不会自动创建或猜测法律文本。

## 明确限制

该扫描器刻意偏向高置信规则，因此：

- 可能漏掉短 Token、加密/编码后的秘密、自定义凭据格式和分片秘密；
- 不扫描 Git 历史，已经删除但仍在历史中的秘密需要专门历史扫描与立即轮换；
- 不查询依赖漏洞、许可证数据库或供应链信誉；
- 跳过的二进制与超大文件仍需要发布前人工审查；
- 通过扫描不代表凭据从未泄漏，也不代表应用生产安全；
- 真实秘密一旦进入文件或日志，应先撤销/轮换，再清理仓库和历史，不能只删除当前文本。

正式公开发布前仍应增加独立 LICENSE/NOTICE、依赖许可证清单、依赖漏洞扫描、Git 历史 Secret 扫描、签名发布和外部安全复核。

