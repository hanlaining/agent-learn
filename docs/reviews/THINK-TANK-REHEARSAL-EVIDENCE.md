# God-Agent 彩排证据升级协议攻击性智囊复核

> 日期：2026-08-24（Asia/Shanghai）  
> 审阅对象：`scripts/verify-evidence-consistency.ts`、当前 evidence schema/json、`tests/evidence-consistency-test.ts`、考研复试彩排验收表  
> 方法：源码逐项审阅、现有正向测试反向解释、纯内存攻击样本验证  
> 边界：本报告不修改协议实现、测试、Schema、当前证据或既有 advisor。

## 1. 最终结论

**当前协议：可以作为复试 95 门禁的一部分，但不能作为唯一门禁，也尚不能据此把真人彩排判为 Passed。**

当前 `records=[]`、`status=NotRun`，因此现状没有虚构彩排完成，维持 No-Go 是正确的。协议已经具备一些重要的失败关闭能力：

- 完成数必须从 Passed records 派生；
- record ID 必须唯一；
- 3 次 timed 与 1 次 non-author 数量固定；
- timed Passed 被限制在 165–190 秒；
- Passed 要求 facts/privacy 通过且 P0/P1 为 0；
- Artifact 文件必须存在且 SHA-256 匹配；
- 工作区外的词法路径逃逸会被拒绝；
- non-author 必须把 `independent` 填为 true；
- 顶层 status 由记录重新计算。

但是它当前验证的是“JSON 字段自洽 + 某些文件字节匹配”，**不能证明参与者是真人、非作者身份真实、观察者独立、演示实际发生，或四条记录来自四次不同活动**。

### 是否可作为 95 门

| 用法 | 裁决 |
|---|---|
| 作为未来真实彩排材料的结构化索引 | Go |
| 阻止只改 completed 数量的低成本造假 | Go |
| 单独证明 3 次真人彩排 + 1 次非作者试讲 | No-Go |
| 在关闭本报告 P0，并配合外部身份确认/真人观察后作为 95 合取门的一部分 | Conditional Go |
| 当前把复试分数提升到 95 | No-Go |

## 2. 已实际验证的攻击样本

本次用当前 `current-evidence.json` 构造了四条 Passed 记录：

- 三条 timed 均为 165 秒；
- 一条 non-author 仅为 1 秒；
- participant 与 observer 都写成 `project author`；
- `independent=true`；
- `authorInterventions="author performed the entire demo"`；
- `performedAt=2099-01-01`；
- `candidateRef=arbitrary-candidate`；
- 四条记录复用同一个 Artifact 路径和同一个 digest。

结果：**`validateSnapshot` 接受并输出 `ATTACK_ACCEPTED_BY_VALIDATE_SNAPSHOT`。**

此外，现有正向测试 `accepts completed rehearsal counts only from digest-bound Passed records` 本身把同一个 `record.txt` 和同一个 SHA-256 同时用于 3 次 timed 和 1 次 non-author，并期望完整 verifier 通过。这不是理论猜测，而是当前测试明确允许“一份 Artifact 四次计数”。

## 3. 攻击面与优先级

| ID | 优先级 | 攻击/缺口 | 当前行为 | 影响 |
|---|---|---|---|---|
| R-P0-01 | P0 | 同一 Artifact 重复计数 | 不检查跨记录 canonical path、digest 或内容唯一性；正向测试明确允许四次复用 | 一份观察记录即可伪装四次活动 |
| R-P0-02 | P0 | 作者冒充非作者 | 只检查 `kind=non-author` 与 `independent=true`；participant 可写 project author | 机器状态 Passed 不能证明非作者存在 |
| R-P0-03 | P0 | 参与者/观察者伪自填 | participant/observer 只要求非空，可相同、可均为作者、无外部确认 | 作者可自签整套证据 |
| R-P0-04 | P0 | non-author 1 秒也能 Passed | 165–190 秒只应用于 timed；彩排表的通用用时规则未落实到 non-author | 1 秒“试讲”可计入 1/1 |
| R-P0-05 | P0 | 独立性与作者介入自相矛盾 | `independent=true` 与“作者完成全部演示”可同时通过 | guided/代操作可冒充 independent |
| R-P0-06 | P0 | 符号链接逃逸 | `resolveInside` 只做词法边界；Artifact 用 `readFile`，未 lstat/realpath、未拒绝 symlink | 工作区内链接可读取工作区外文件并通过 digest |
| R-P0-07 | P0 | Artifact 没有证据类型或内容合同 | 任意可读文件、空白文本、README 均可作为唯一 Artifact | digest 只证明字节存在，不证明它记录了彩排 |
| R-P0-08 | P0 | candidateRef 未绑定候选 | 只要求非空，不等于 snapshot baseline、源码/材料 digest 或候选 Manifest | 旧演练可被挂到新候选 |
| R-P1-01 | P1 | performedAt 可在未来或晚于 capturedAt | 只验证可解析 ISO 时间 | 2099 年记录可通过 |
| R-P1-02 | P1 | 同一活动改 ID 重放 | 只要求 ID 字符串唯一；时间、参与者、Artifact、nonce 均可重复 | 一次活动可复制成三次 timed |
| R-P1-03 | P1 | P0/P1 关闭是自报数字 | 不绑定问题清单、关闭记录和复验 Artifact | 把计数改成 0 即可满足 Passed 条件 |
| R-P1-04 | P1 | sensitiveDataCheck 是自报枚举 | 不实际扫描 Artifact，也没有脱敏报告 | Artifact 可能含 Key、声音/人像等敏感数据 |
| R-P1-05 | P1 | Digest TOCTOU / 可变证据 | 校验时读取并 hash，但文件和 snapshot 都可在返回后被替换；无不可变 Manifest/签名/归档 | “刚验证过”不等于后续引用的仍是同一份字节 |
| R-P1-06 | P1 | Schema 与运行时条件不等价 | JSON Schema 不表达时长、Passed、计数派生、独立性等条件 | 只跑 Schema 的外部工具可接受运行时会拒绝的记录 |
| R-P1-07 | P1 | Artifact 路径可使用别名 | 未禁止 `a/../b` 等规范化别名，也没有 canonical path 唯一性 | 重复检测未来容易被路径别名绕过 |
| R-P1-08 | P1 | 验收表要求未机器化 | 随机追问、异常降级、开始/结束、设备、反馈、签名等没有结构字段或 verifier | records Passed 小于彩排表定义的 Passed |

## 4. 对六类重点问题的逐项裁决

### 4.1 路径逃逸与符号链接

普通 `../` 逃出工作区会被 `resolveInside` 拒绝，这是有效防线。但该函数没有对 Artifact 做 `lstat`、`realpath` 和最终真实路径边界检查，`readFile` 会跟随符号链接。因此：

- 词法路径逃逸：已防；
- 工作区内 symlink/junction 指向外部：未防；
- 普通文件类型约束：未证明；
- canonical 路径唯一性：未做。

结论：**P0，当前不能称“仓库内 Artifact 已被物理边界约束”。**

### 4.2 同一 Artifact 重复计数

当前没有以下任何约束：

- 每条 Passed record 至少一个独占 Artifact；
- 不同 record 的 canonical path 不得相同；
- 不同活动必须有不同 challenge nonce；
- Artifact 内容必须包含 record ID、performedAt 和 candidateRef；
- 相同 SHA-256 是否允许跨记录复用。

现有正向测试直接复用同一文件四次，已构成可复现反例。

结论：**P0，必须先关闭才能让 3/3 + 1/1 具备次数含义。**

### 4.3 参与者伪自填边界

机器只能验证字符串与布尔值，不能从：

- `participant="张三"`；
- `observer="李四"`；
- `independent=true`

推导真人张三/李四确实存在、确实在场或确实作出声明。即使增加“签名字符串”也不能证明签名人身份，除非存在外部信任根、受控身份系统或人工复核。

结论：**这是不可由本机纯机器验证彻底关闭的边界。机器验证必须永久附带“身份未由机器证明”的限定。**

### 4.4 记录计数

计数算术本身较好：Passed 数量派生，status 也派生，手改 `timedCompleted=3` 无 records 会失败。但“记录唯一”目前只等于 ID 唯一，不等于活动唯一。攻击者可复制相同活动并修改 ID。

结论：**算术 Go，语义唯一性 No-Go。**

### 4.5 Digest 与 TOCTOU

当前 digest 能证明 verifier 读取到的字节与 snapshot 声明一致，能检测静态篡改。这一点应保留。

但它不能证明：

- 文件在验证后没有改变；
- snapshot 在验证后没有改变；
- 后续 PPT/评分读取的是刚验证的同一 bundle；
- Artifact 来自声明的候选或时间；
- Artifact 作者/参与者身份。

结论：**digest 是必要条件，不是充分条件。当前适合作为完整性检查，不适合作为真实性证明。**

### 4.6 Passed 条件与作者冒充非作者

当前非作者 Passed 只额外要求 `independent=true`。它不要求：

- participant 与项目作者不同；
- participant 与 observer 不同；
- authorInterventions 为 none；
- authorInterventions 与 independent 不矛盾；
- 非作者主讲达到 165–190 秒；
- 非作者仅凭冻结材料完成；
- 至少形成一条具体反馈；
- 外部确认参与者声明。

结论：**作者可以在字段层面冒充非作者，当前 nonAuthorCompleted 不能作为真实身份完成数。**

## 5. P0 修复要求

以下全部关闭前，协议不得单独放行复试 95：

1. Artifact 使用 `lstat + realpath`，拒绝 symlink/junction/非普通文件，并要求真实路径位于固定的 `docs/evidence/rehearsals/<record-id>/` 下；
2. 对所有 Passed records 建立 canonical path 与 digest 使用账本，拒绝跨记录复用；现有“一文件四记录”正向测试必须改成四组独立 Artifact；
3. 每次彩排在执行前生成唯一 challenge nonce，Artifact 内容必须绑定 record ID、nonce、candidateRef、performedAt；
4. `candidateRef` 必须机器绑定冻结候选 Manifest，而不是任意非空字符串；
5. non-author Passed 同样满足 165–190 秒，且 participant 不能声明为作者；participant 与 observer 不得相同；
6. `independent=true` 时 authorInterventions 必须为空或明确为 none；任何实质提示/代操作都降级为 Run-Conditional 或 guided；
7. Passed 至少绑定两类独立 Artifact：计时/录制证据 + 观察者确认；单个任意文本文件不够；
8. P0/P1 数量必须从绑定的问题清单和复验记录派生，不能由 record 自填；
9. 在最终 95 判定中把机器结论命名为“结构与摘要通过”，另设真人身份/独立性人工门。

## 6. P1 加固要求

1. 拒绝 performedAt 晚于 capturedAt、明显未来时间和不合理重复时间；
2. 在 Artifact 打开前后核对文件身份、大小和 mtime；验证后生成包含全部 digest 的冻结 Manifest；
3. 最终评分、PPT 和总账只消费刚验证的 Manifest digest，避免验证后替换；
4. 为 Artifact 定义机器可解析内容 Schema，至少含记录 ID、候选、nonce、开始/结束、净用时、问题与复验；
5. 对 Artifact 执行 Secret/PII 检查并记录真实扫描报告，而不是只相信 `sensitiveDataCheck`；
6. 让 JSON Schema 与 TypeScript verifier 的 Passed 条件尽量等价，避免外部仅 Schema 验证产生假绿；
7. 增加攻击性测试：symlink、路径别名、重复 digest、重复活动改 ID、未来时间、作者=非作者、观察者=参与者、1 秒 non-author、independent/介入矛盾、空白 Artifact；
8. 保存失败与条件通过记录，采用追加式审计历史，避免用覆盖文件抹去早期问题。

## 7. 推荐的 95 合取门

建议最终判定为：

1. 机器结构门通过：计数、状态、时长、候选绑定、问题关闭和 Artifact digest 均有效；
2. Artifact 唯一性门通过：4 次活动有 4 组不同 nonce 和独占证据；
3. 真人身份门通过：至少一名可核验观察者确认 3 次 timed，另一名真实非作者确认 non-author；
4. 非作者独立性门通过：参与者非作者、无实质介入、仅使用冻结材料；
5. 隐私门通过：Artifact 经实际 Secret/PII 复核；
6. 总控在评分时重新验证冻结 Manifest，不能只读取 JSON 中的 `status=Passed`。

其中第 3、4 项必须包含人工或外部信任来源。**本机 verifier 永远只能证明“声明与字节自洽”，不能证明声明者的真人身份。**

## 8. 当前裁决

- 当前彩排事实：`records=[]`、timed 0/3、non-author 0/1、`NotRun`；
- 当前复试彩排放行：**No-Go**；
- 当前协议作为证据结构：**Conditional Go**；
- 当前协议作为独立的 95 完成证明：**No-Go**；
- P0 全关 + 外部真人确认后作为 95 合取门的一部分：**Go**。

最重要的对外限定：

> SHA-256 可以证明 verifier 读取的文件字节没有偏离声明摘要，不能证明文件记录的活动真实发生，也不能证明 participant、observer 或 non-author 的真人身份。任何把机器结构通过直接翻译成“真人彩排已完成”的表述都属于证据升级过度。

## 9. 加固后快速复验（2026-08-24）

本节复核加固后的 `scripts/verify-evidence-consistency.ts`、`tests/evidence-consistency-test.ts` 与 evidence JSON Schema。上文第 2–8 节保留为攻击前基线，不能再直接描述加固后的当前代码。

定向复验结果：`npm run test:evidence` **7/7 通过**，`npm run check` **通过**。新增攻击测试已覆盖重复 Artifact、作者冒充非作者、non-author 1 秒、候选漂移与未来时间。

| 原 P0 | 加固后状态 | 复验证据与剩余边界 |
|---|---|---|
| R-P0-01 Artifact 重复计数 | **代码层已关闭** | Passed 记录建立 path/digest 账本，四条记录改为四个独立目录、独立 nonce 与独立摘要；复用会被拒绝。 |
| R-P0-02 作者冒充非作者 | **声明结构层已关闭；真人身份门仍开放** | non-author 必须声明 `participantRole=non-author`，参与者文本不能是 project author；但机器不能认证填表者真人身份。 |
| R-P0-03 参与者/观察者伪自填 | **结构层已关闭；真人身份门仍开放** | 所有 Passed 记录均强制 participant 与 observer 不同，observer attestation 绑定记录；但任意字符串仍可能由作者自填，真人身份必须外部确认。 |
| R-P0-04 non-author 1 秒 Passed | **已关闭** | 所有 Passed 记录统一要求 165–190 秒；攻击测试覆盖 1 秒拒绝。 |
| R-P0-05 独立性与作者介入矛盾 | **non-author 路径已关闭** | non-author 要求 `independent=true` 且 `authorInterventions=none`；仍需真人观察确认不是代操作。 |
| R-P0-06 symlink/junction 逃逸 | **主要代码路径已关闭，攻击测试仍不足** | verifier 使用 `lstat + realpath`、只接受普通文件并拒绝真实路径逃出工作区，同时检查校验期间 size/mtime；当前定向测试未单列 symlink/junction 反例。 |
| R-P0-07 任意单文件 Artifact | **大部分关闭** | 每条记录至少含 recording 与 observer-attestation 两类 Artifact，attestation JSON 绑定 id/nonce/candidate/time/participant/observer；recording 目前只校验非空与 digest，尚未验证媒体时长或内容真实性。 |
| R-P0-08 candidateRef 任意 | **当前候选绑定已关闭** | `candidateRef` 必须等于 snapshot 的 candidate baseline，attestation 再次绑定；攻击测试覆盖旧候选拒绝。 |

问题清单已经由 `issues[]` 派生 P0/P1 开放状态，Closed issue 必须给出复验摘要；但“没有漏报问题”仍无法由本机证明。JSON Schema 已加入新字段，不过仍弱于 TypeScript 运行时：例如 Artifact `minItems` 还是 1，无法单靠 Schema 表达两类 Artifact、Passed 时长和身份条件。

### 加固后裁决

- 协议作为“声明结构 + 文件摘要一致性”门：**Go**；
- 原八项 P0 的本地结构关闭：**7 项关闭，1 项部分关闭**；剩余项是 recording 内容真实性/真人身份不能由本机摘要验证；
- 协议单独证明 3 次真人彩排和 1 次真实非作者试讲：**No-Go**；
- 当前实际彩排：仍为 `records=[]`、3 次 timed `0/3`、non-author `0/1`、`NotRun`；
- 当前复试 95 放行：**No-Go**。

最终仍需独立人工门：可核验观察者确认三次 timed，真实非作者确认试讲且无实质介入，并由总控对冻结证据包重新验摘要。机器通过不能替代真人发生性与身份真实性。
