# God-Agent 复试三分钟演示

> 最新证据快照：`113/113`；主测试 `736`，`735pass`、1 skip、0 fail；源码覆盖 `26146/28672 = 91.19%`，加载 `116/122`。

> 目标：三分钟内展示“产品原型存在、可靠性问题真实、证据边界诚实”。  
> 默认轨道：完全离线、固定 seed、零真实 Provider 调用。  
> 可选轨道：已提前验证且用户明确授权时，才展示真实 Provider 对话。

## 1. 演示前冻结

至少提前一天固定：

- Commit、Node/npm 版本、操作系统和演示工作区；
- 已安装依赖与 Electron 构建，不在现场执行 `npm ci`；
- 离线 seed `20260824` 和空输出目录；
- 一张桌面端截图、一张故障时序图和一份已归档离线报告；
- 真实 Provider 轨道所需预算、模型白名单和终止条件。

先运行安全自检：

```powershell
npx --no-install tsx scripts/demo-preflight.ts
```

`FAIL` 必须在演示前处理；缺 Provider 只会显示 `WARN`，不影响离线轨道。自检只观察环境变量名是否存在，不读取或输出 Key、Base URL、模型值。

## 2. 三分钟主脚本：离线必达

### 0:00–0:30：问题

口述：

> 我最初实现的是 Agent Loop、多 Chat 和多 Agent，后来发现难点不是让模型继续回答，而是模型或工具已经执行、进程却在持久化前崩溃时，系统怎样避免重复调用和伪完成。

展示一张最小时序：

```text
Tool 产生副作用
  -> 确认尚未持久化
  -> 进程崩溃
  -> 不能把“没收到结果”当成“没有执行”
  -> outcome_unknown / 人工裁决，而不是盲目重放
```

### 0:30–1:05：产品壳

展示提前验证的 Electron 窗口或截图，只指出四处：

1. 左侧多 Chat 与任务历史；
2. 中间 Runtime Timeline；
3. 右侧父子 Agent/Activity；
4. `outcome_unknown` 的重试授权、外部结果登记和终止入口。

不要点击尚未接入的 Changes、任意 Terminal 或键位个性化。

### 1:05–1:50：固定离线入口

先展示 dry-run，不写报告：

```powershell
npm run benchmark:offline -- --suite gate30 --seed 20260824 --dry-run
```

解释三个字段：固定 suite、固定 seed、经过校验的 task manifest。随后打开提前生成的 `run-record.json`、`summary.csv` 和一个失败 `repro`，不要在现场滚动完整日志。

若现场允许写入临时目录，可预先清空一个明确目录后运行：

```powershell
npm run benchmark:offline -- --suite gate30 --seed 20260824 --output .tmp/demo-gate30
```

必须说明：GATE-30 是 30 个确定性协议场景，不是 30 个真实软件工程任务；逻辑延迟不是生产 Provider 延迟。

### 1:50–2:30：恢复机制

用一页表解释：

| 风险 | Runtime 机制 | 仍然做不到 |
|---|---|---|
| 重复模型/工具调用 | 稳定 Invocation ID + WAL | 不能确认所有外部系统状态 |
| 双 Owner/迟到提交 | Lease + Fencing | 不等于端到端 exactly-once |
| 父子 Return 丢失/重复 | Outbox + Receipt | 不代表多 Agent 必然优于单 Agent |
| 副作用结果未知 | `outcome_unknown` + 人工裁决 | 不能安全自动重放不可查询副作用 |

### 2:30–2:50：证据

展示当前工作树最终正式摘要：test discovery 113/113；主测试共 736，其中 735 pass、1 个 Windows symlink 权限条件 skip、0 fail；当前 `src` 源码行覆盖 26146/28672 = 91.19%，源文件加载率 116/122 = 95.082%，coverage gate 为 90.25/93；GATE-40 candidate 40、local pilot 40 passed / 0 failed / 0 blocked、formal Verified 0、`complete=false`；Process Chaos 17/17；Provider offline `liveCalls=0`；Release Readiness 为 11/12、`BLOCKED`，官方审计 0 critical / 3 high，production 仍 `blocked`；官方总账评分为 93/90/69/47/68，五项均未到 95。

马上补充：主测试 736 总计不能把条件 skip 算作 pass，准确结果是 735 pass、1 个权限条件 skip、0 fail；它是回归证据而不是可靠性百分比。自动化主要是 Fake Provider；40 个 passed 只是 local pilot，formal Verified 仍为 0、`complete=false`；本地 Release 11/12、BLOCKED，不具备生产发行资格。

### 2:50–3:00：主动收口

> 当前是具备较强故障语义的单机研究原型，主要证据为 E2，另有窄范围 E3。下一步是完整 Process 矩阵、真实任务公平对照、统计分析和外部无指导复现。

## 3. 可选真实 Provider 轨道

只有以下条件全部满足才启用：

- 离线主轨已准备完成；
- Key 只存在于当前进程环境，不写入命令历史、文件、截图或日志；
- 模型、请求数、单次预算、总预算和超时已经冻结；
- 自检只显示 Provider `CONFIGURED`，不显示任何配置值；
- 已在同一机器、同一网络和同一模型上预演成功；
- 随时可以切回离线 Artifact。

启动桌面端：

```powershell
npm run electron:dev
```

真实轨道只演示一个低风险、无外部副作用的短任务。不要现场启用写文件、执行命令、外部账户操作或不可撤销工具。真实对话失败时不反复重试，立即说明网络/Provider 不属于离线可靠性证据，切回固定报告。

## 4. 三层失败兜底

### A：现场运行成功

展示命令、seed、退出码和产物，不展示环境变量或本机敏感路径。

### B：命令失败但 Artifact 完整

保留失败输出，打开预先冻结的 JSON/CSV/repro 和 SHA-256。明确区分“当前现场失败”和“此前固定基线结果”，不能说现场通过。

### C：桌面端无法启动

使用标注 Commit 和录制日期的 30 秒短录屏或截图；继续完成离线 Benchmark 与机制讲解。录像不能冒充现场运行。

## 4.1 三类现场异常的明确降级

### 断网

1. 不排查校园网、不切热点、不反复刷新真实 Provider；
2. 明确口述“默认轨道本来就是离线，断网不影响固定 seed 与冻结 Artifact”；
3. 运行已安装依赖下的离线 dry-run；若命令也失败，直接打开冻结的 `run-record.json`、`summary.csv`、失败 `repro` 和截图；
4. 不把此前联网结果说成现场联网验证。

### 无 Key / Key 不可用

1. 不现场粘贴 Key，不打开环境变量详情；
2. `demo-preflight` 出现 Provider `WARN` 时说明它不阻断离线主轨；
3. 跳过真实 Provider 可选轨道，展示 `liveCalls=0` 的离线报告；
4. 明确说明真实 Provider 的幂等、状态查询、取消和费用仍未验证。

### 依赖异常

1. 不在答辩现场运行 `npm ci`、升级 Electron 或修改 lockfile；
2. 保留错误页面或退出码，口述“当前机器现场运行失败”；
3. 切换到带版本/日期标识的桌面截图、30 秒短录屏和冻结离线 Artifact；
4. 继续讲故障窗口、机制和证据边界，不把录屏冒充现场成功；
5. 答辩后在固定环境复现，现场不做无证据的根因判断。

## 5. 现场禁止事项

- 不执行 `npm ci`、升级依赖或临时修代码；
- 不输出、粘贴或截图任何 Key、Token、Bearer、私有 Base URL；
- 不使用真实账户做有副作用操作；
- 不把逻辑模拟延迟说成生产 p50/p95；
- 不说“完整复刻 Codex”“生产级”“exactly-once”或“论文已完成”；
- 不用后续成功复跑覆盖当场失败；
- 不把桌面壳启动说成真实 Provider 已验证。

## 6. 演示后可供追问的材料

- `research/CLAIMS-EVIDENCE.zh-CN.md`：Claim 与证据等级；
- `research/artifacts/v0.1/README.md`：三层冻结 Artifact；
- `research/REPRODUCIBILITY.zh-CN.md`：复现 SOP；
- `docs/process-chaos-harness.md`：真进程检查及限制；
- `原创借鉴与引用说明.md`：原创、借鉴和 AI 辅助边界。
- `docs/God-Agent-考研复试高频追问与回答.md`：30 秒/90 秒追问口径；
- `docs/God-Agent-考研复试彩排验收表.md`：三次计时彩排与一次非作者试讲证据；
- `docs/God-Agent-AI辅助与原创边界声明.md`：AI 参与、个人责任和引用边界。
> 2026-08-24 统一证据快照：113/113，736（735pass，1 skip，0fail），26146/28672（91.19%），116/122，17/17，40passed，0blocked，formalverified0，livecalls=0，11/12，3high。
