# G95 统一验收矩阵

更新时间：2026-08-25  
状态：执行中；未满足硬门禁前为 No-Go

| 线 | 95+硬条件 | 当前证据 | 状态 | 下一证据 |
|---|---|---|---|---|
| 工程 | 122 文件、28,736 行分母；连续两次独占 coverage ≥95%；0 fail | 26,808/28,736 = 93.2906%；822/820/2/0 | No-Go | E1 行为切片与两次独占 coverage |
| 复试 | 3 次真人计时彩排、1 次非作者试讲、Demo/PPT 同候选 | 0/3、0/1 | No-Go | 原始彩排记录与非作者反馈 |
| 科研 | formal Verified、正式 Raw、真实 Provider、外部基线、独立复现均非 0 | 当前均为 0 | No-Go | 外部运行与 verifier 证据 |
| 论文 | 核心 Claim 全绑定、引用 100% 核验、结果与 Artifact 一致、非作者审阅 | 47 分；NotVerified/TODO | No-Go | Claim/Citation/Review 闭环 |
| 生产 | audit high 处置、签名包、干净机、升级回滚、长稳；release READY | 3 high；release BLOCKED | No-Go | 外部发布环境证据 |

## 证据状态规则

- `Verified`：只有 verifier 依据正式证据自动或可复验地确认时允许使用。
- `NotVerified`：材料存在但缺少正式验证或外部证据。
- `NotRun`：尚未执行，不得写成失败或通过。
- `NotIncluded`：明确不在本候选范围内。
- `Draft`：计划或预注册草稿，不是正式结果。
- `local pilot`：本机试运行，不是 formal experiment。

## 返工规则

首跑失败、复跑不一致、数字漂移、旧 SHA 残留、Claim 无来源、绝对路径、secret、Mock 冒充 Provider、同作者复跑冒充独立复现，均退回原子任务重新验证。

