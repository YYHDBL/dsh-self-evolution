# 第一期 MVP 分阶段任务拆解

> 版本：1.2，2026-09-19。依据[实施方案 v1.4](./2026-09-19-phase-1-mvp-implementation-plan.md)拆解；与设计文档冲突时以决策记录中更晚的决定为准。
> v1.2 修订（负责人评审）：残锁不做并发自动接管——运行中遇残锁停止并告警，清理只在启动前置恢复步骤（确认无存活进程后）执行，普通加锁/释放仍自动；`session/flush` 监听器与持久化排水并行执行，收到通知≠已落盘，补读以"读到本轮目标 seq"为完成判定并保留待补读状态，去重键加入日志代际 `(sessionId, generation, seq)`；任务身份不再支持会话中途切换——一个会话仅归属一个任务，换任务即新建会话（"继续"可选）；健康检查改为**按实例核对自己应加载的产物**（插件查激活，Memory/Skill/配置查版本与加载证据，候选在其运行实例或会话绑定时核对），控制文件损坏时空集合启动**保留既有安全配置（含日志上传关闭）**。
> v1.1 修订（负责人评审）：恢复动作区分**撤销试用**（baseline 不动）与**回退正式发布**（坏版本入隔离清单、重复回退不换回坏版本）；名额检查与占位合并为 `bindForTask` 单次锁内操作，锁实现明确为 O_EXCL 锁文件（本机无 `flock` 命令）；预算补"预占→调用→结算/未知保留占额"与 reconcile 补账，成本记录补实验/候选/试用/任务关联；任务身份前置为会话建立时的"新任务/继续"入口，事后归并只修统计不改执行绑定，跨会话归并改人工认领制（暂不做相似度匹配）；启动健康检查关联 bootId 并核对预期集合激活，控制文件损坏以空受管理集合启动；采集增加事件级去重键、`session/flush` 唤醒、启动补扫与崩溃恢复测试；P1 探针提前到 A2（v3 迁移脚本即其载体），C1 复用结论。
> 本轮只编写任务文档，未修改业务代码、未安装依赖、未开始开发。
> 详细度分级：**阶段 A/B/C 细到可直接编码**；阶段 D 的 D1（Jev）细到可编码；D2/E/F 为合同级（必要接口、状态变化、验收），开工前按同标准补细。
> 任务编号：`<阶段><序号>`；探针任务 `P<n>`（验证尚未核实的上游接口，结论写回本文后再实现，不猜接口）；阶段审计点 `✦<阶段>`——每阶段完成即停，审查通过后才开始下一阶段。

## 0. 仓库现状复核（2026-09-19 本轮实测）

| 项 | 状态 | 对任务的影响 |
|---|---|---|
| 项目仓库 | 零提交，全部未跟踪 | A1 建立基线提交 |
| `vendor/deepseek-harness` | HEAD `47f9438`，干净 | 保留为旧基线历史环境，不再使用 |
| `vendor/dsh-0.1.6` | HEAD `ddefc45`，干净；**依赖已安装且已完整构建**（packages 下 291 个 `lib`，2026-09-19 15:08–15:13，`apps/cli/lib/bin.js` 与 web 前端均在） | A2 的构建步骤变为"幂等复验 + 留痕"，重心移到启动与配置验证 |
| `packages/evolution-probe` | 旧基线代码 + 2 个 vitest 通过 | A3 改造复用，不重写 |
| `scripts/`、`state/` 清单、`evolution-private/` | 不存在 / 仅 `turns.jsonl` | B/C 阶段新建 |
| 里程碑零新版证据 | 无（旧 README 仅覆盖 47f9438 前三项） | 证据写入 `artifacts/milestone-0/ddefc45/` |
| 工具链 | node v24.18.0；corepack 0.35.0（pnpm 经 `corepack pnpm`） | 所有命令用此前缀 |

**可复用清单**：`packages/evolution-probe` 宿主/客户端逻辑（A3 原地适配）；旧 vitest 用例结构（A3 改造）；项目根 `package.json` 的 `npm test`（devDep 的 vitest link 改指新 vendor）；`.pnpm-store`（缓存复用）；旧 `state/turns.jsonl` 仅作历史证据，**不迁移、不删除**。

**本轮静态核实的上游接口**（源码位置均在 `vendor/dsh-0.1.6`，静态核实≠运行验收）：

| 接口 | 事实 | 位置 |
|---|---|---|
| 具体持久化插件 | `@deepseek-ai/dsh-session-persistence-jsonl`，`Config { root: string }` **必填无默认**，按会话目录存不可变代际文件 | `packages/session/session-persistence-jsonl/src/index.ts:87-96` |
| Profile 布局 | `$DSH_HOME/profiles/<name>/`；默认 `web` profile = `['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']` | `packages/boot/app-boot/src/profile.ts:50,125,139` |
| CLI | bin `apps/cli/lib/bin.js`；模式 profile / plugin / dump-config；`dsh plugin <args>` 转发 pnpm 做 profile 包管理 | `apps/cli/src/bin.ts:30-70`、`apps/cli/src/plugin.ts` |
| pluginManager 服务 | `listPlugins() / inspect(spec) / setPluginEnabled(id,enabled) / installBundle(spec) / setBundleEnabled(name,enabled)` | `packages/boot/plugin-manager/src/index.ts:170-355` |
| message-feedback | 服务 `ctx.messageFeedback`，对已定稿 assistant 消息 put/list/delete，类别常量 `FEEDBACK_CATEGORIES`（来自 `dsh-command-feedback`），带版本冲突类型 | `packages/feedback/message-feedback/src/index.ts` |
| llm/stream | Cordis 事件 `'llm/stream'(options, next) => AsyncIterable<StreamChunk>` waterfall | `packages/llm/llm/src/index.ts:72` |

## 1. 任务总览

```text
A1 ─ A2 ─ A3 ─ ✦A            阶段 A：基线与新版适配
✦A ─ B1 ─ B2 ─ B3 ─ B4 ─ B5 ─ ✦B   阶段 B：隔离与恢复底座（里程碑零完成）
✦B ─ C1 ─ C2 ─ C3 ─ ✦C        阶段 C：最小采集
✦C ─ D1 ─ D2 ─ ✦D            阶段 D：Jev 接入 + 真实发现试验
✦D ─ E1 ─ E2 ─ ✦E            阶段 E：证据捕获 + 首个候选闭环
✦E ─ F1 ─ F2 ─ F3 ─ ✦F       阶段 F：试用控制与收尾
```

| 阶段 | 对应方案步骤 | 审计点通过标准（摘要） |
|---|---|---|
| A | 步骤 0–2 | 新版可启动、上传已关并验证、探针新版装载+handle 补读+常驻状态 |
| B | 步骤 3–5 | 里程碑零五项 + 演练全部有新版实际运行证据 |
| C | 步骤 6 | 采集不干扰任务、归并可复核、六态状态真实 |
| D | 步骤 7 | 人工触发产出可审查卡片或如实证据不足；Jev 验证有预登记结论 |
| E | 步骤 8–9 | 捕获探针①–④通过；候选闭环证据分层如实 |
| F | 步骤 10–11 | 探针⑤+错配演练通过；试用与复盘留痕完整 |

**探针任务表**（探针脚本放 `scripts/probe/`，属验证工具；结论回填本文对应任务后方可实现）：

| 编号 | 目标 | 方法 | 归属 |
|---|---|---|---|
| P1 | `session-persistence-jsonl` 能否在裸 Cordis `Context` 独立装载、服务访问器名、`open/read/close` 实际用法 | 参考该包自带测试 + 最小 node 脚本对授权副本运行 | **A2**（`v3-migration.mjs` 即其载体，结论记录在案；C1 直接复用，不重复验证） |
| P2 | `message-feedback` 的 `FEEDBACK_CATEGORIES` 实际取值、写入接口形状、网页是否已有反馈入口 | 源码常量 + 隔离实例实查 | C3 |
| P3 | 创造模式（preset `cordis`）无头启动命令、隔离实例内 `pluginManager` 服务调用路径、凭据注入方式 | 隔离 `DSH_HOME` 实跑 | B2 首日 |
| P4 | 插件内注册 `llm/stream` waterfall 的确切写法、`GenerateOptions` 可序列化字段全集、middleware 顺序 | 测试 adapter 实跑 + 源码类型 | E1 首日 |
| P5 | `dsh` 启动 web 的准确命令行、端口/URL、就绪信号 | `bin.js --help` + 实跑 | A2 首步 |
| P6 | `session-log-deepseek.enabled=false` 的配置写入位置（profile patch/config 层）与 `dump-config` 键路径 | `dump-config` 对照 | A2 |

---

## 2. 阶段 A：基线与新版适配（细到可编码）

### A1 仓库基线提交

- **前置**：无。
- **涉及文件**：`.gitignore`（修改）、全部现有文件（提交）。
- **实现步骤**：
  1. `.gitignore` 追加三行：`vendor/`、`evolution-private/`、`state/`（原 `state/turns.jsonl` 行被 `state/` 覆盖，删除冗余行）。
  2. 提交现有 docs、packages、artifacts、根清单文件，提交信息注明基线事实（旧基线 47f9438 证据保留、目标 ddefc45 已装已建）。
  3. 在 `artifacts/milestone-0/ddefc45/README.md` 建索引文件（只登记后续任务的证据条目）。
- **测试**：无（纯仓库操作）。
- **命令**：`git add -A && git commit -m "baseline: docs + old-baseline probe + vendor pins"`。
- **验收**：`git log` 有 1 个提交；`git status` 干净；`git check-ignore vendor evolution-private state` 三者均命中。
- **失败处理**：提交内容含被忽略目录 → 检查 `.gitignore` 生效后重做提交（`git rm --cached` 清理）。

### A2 新版构建复验、启动基线与上传关闭（含 P5/P6）

- **前置**：A1。
- **涉及文件**：`vendor/dsh-0.1.6`（只读使用）；新建 `state/runtime/dsh-baseline/`（一次性验证环境）、`scripts/probe/p5-cli-help.mjs`、`scripts/probe/p6-logupload-stub.mjs`、`scripts/probe/v3-migration.mjs`；证据 `artifacts/milestone-0/ddefc45/A2-*.md`。
- **实现步骤**：
  1. 构建幂等复验：`corepack pnpm install --frozen-lockfile && corepack pnpm build`，记录输出摘要（已构建过，预期成功）。
  2. **P5**：运行 `node vendor/dsh-0.1.6/apps/cli/lib/bin.js --help` 及子命令帮助，确认启动 web 的语法与默认端口（旧版为 `--profile web`、127.0.0.1:3080，以实际输出为准写入探针结论）。
  3. 建独立环境：`DSH_HOME=$PWD/state/runtime/dsh-baseline`，初始化 web profile（`--from-default-profile` 语义以 P5 结论为准）。
  4. **P6**：`dump-config` 查看默认配置树，定位 `session-log-deepseek.enabled` 键路径；在目标 profile 的配置/patch 层显式写 `false`（写入方式以 dump-config 对照为准）；再跑 `dump-config` 确认生效。
  5. 上传关闭验证：本地替身（`p6-logupload-stub.mjs` 起本地 HTTP 服务记录请求体）+ 让最小会话指向替身，断言请求体不含 `dsh_session_log` 字段；不向真实端点发送测试请求。
  6. 完成一次不带自进化插件的最小 PTC 会话（deepseek-official / deepseek-v4-flash），记录会话 id 与日志路径。
  7. **V3 迁移验证（兼 P1）**：复制 8 月授权旧日志到 `state/runtime/migration-check/`；`scripts/probe/v3-migration.mjs` 用 `session-persistence-jsonl` 以 `root` 指向副本只读打开——**本步即 P1 的正式载体**：独立装载可行性、服务访问器名、`open/read/close` 用法的结论在此记录，C1 直接复用；脚本输出旧格式引用（源代际/seq）与新格式（V3 代际/seq）成对映射表；确认源文件未被修改（前后哈希）。
- **必要测试**：`p6-logupload-stub` 断言脚本；`v3-migration.mjs` 的源文件不变断言。
- **命令**：见步骤内；探针均以 `node scripts/probe/<name>.mjs` 运行。
- **验收**：新版独立启动并完成真实会话（证据含 SHA、命令、会话 id）；上传关闭经请求级验证；V3 映射成对记录且副本零修改；旧 8 月 README 未被改写。
- **失败处理**：构建/启动失败 → 只修环境（G1），不建项目插件；上传关不掉 → 查配置层写入方式，仍失败则停止（安全要求，不许跳过）；V3 迁移失败 → 保留旧数据停止切换基线（G6）。

### A3 探针包适配新版

- **前置**：A2。
- **涉及文件**：`packages/evolution-probe/package.json`、`src/index.ts`、`src/client/index.ts`、`tests/host.spec.ts`、`tests/client.spec.ts`、`tsdown.config.ts`、`cordis.patch.yml`；项目根 `package.json`（vitest link 改指 `vendor/dsh-0.1.6`）。
- **具体改动**：
  1. `package.json`：peerDeps 改为 `@deepseek-ai/cordis`（对齐 `vendor/dsh-0.1.6/vendor/cordis` 实际版本 `4.0.2`）、`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-client-ui-conversation`（`0.1.6-alpha.2`）；**删除** `@deepseek-ai/dsh-client-runtime`；`dsh.client.inject` 依赖数组按新版客户端清单机制改为 `["@deepseek-ai/dsh-client-ui-renderer"]`（以 C 阶段前的实机核对为准，先按此写、装载失败即修正）；devDeps link 全部改指 `vendor/dsh-0.1.6` 对应目录。
  2. `src/index.ts`（宿主）：逻辑不变（`turn/end` → 追加 JSONL），类型导入按新版 `@deepseek-ai/dsh-session` 校验 `SessionEvent` 形状；`turn/end` 载荷为 `{ turn, reason }`（`packages/core/session/src/types.ts:285`）。
  3. `src/client/index.ts`：`ClientContext` 旧来源已删除；改为从 `@deepseek-ai/dsh-client-ui-renderer/client` 导入 `SlotRegistry` 类型，插槽注册按新版 `SlotRegistry` 签名重写（保持 `conversation.composer.dock` + `<strong role="status">自进化：记录中</strong>` 渲染不变）。**精确签名以 `vendor/dsh-0.1.6/packages/client/ui-conversation/src/client/` 现存客户端插件写法为模板对照**（本轮已确认该模式存在：`export { apply, Config, inject }`），不凭记忆猜。
  4. 测试：host 用例改用新版 Cordis 测试上下文与 `SessionStore`（保持"单条 turn/end 追加一行"断言）；client 用例改导入路径，断言插槽注册与组件渲染。
  5. 构建脚本 `build` 指向 `vendor/dsh-0.1.6/node_modules/.bin/tsdown`；`clientBundle` 构建输入按新版重新核对。
- **实现步骤**：改清单 → 跑测试（红→绿）→ 构建 → 安装到 `state/runtime/dsh-baseline` 的 web profile（`dsh plugin --profile web add link:./packages/evolution-probe`，语法以 P5 结论为准）→ 真实网页会话核对记录 → `open(id,'read')`+`handle.read` 补读核对（对照 turns.jsonl 新行）→ 状态标记生命周期检查（装载出现/刷新仍在/卸载消失/重装恢复）。
- **必要测试**：`packages/evolution-probe/tests/*.spec.ts` 全绿。
- **命令**：`npm test`；`cd packages/evolution-probe && ../../vendor/dsh-0.1.6/node_modules/.bin/tsdown`；安装与启动命令按 P5。
- **验收**：测试通过；真实记录与 handle 补读一致；插件异常（人为 throw 一次）不阻止会话完成；状态文字+强调样式同在。
- **失败处理**：标准插件承载不了监听 → 停止重评"不改核心"边界（G2）；插槽不稳 → 退最小官方位置（G3）；客户端清单机制不符 → 以实机核对修正 `dsh.client` 字段，不改渲染需求。

### ✦A 阶段审计点

停审清单：① A2 五项证据齐全（构建复验/启动会话/上传关闭/V3 映射/旧证据未动）；② A3 测试绿 + 实机核对记录；③ 未引入对 vendor 的任何修改（`git -C vendor/dsh-0.1.6 status` 干净）；④ 探针结论 P5/P6 已回填本文。审查人确认后进入阶段 B。

---

## 3. 阶段 B：隔离与恢复底座（细到可编码）

### B1 `packages/evolution`：控制状态 + 成本账本 + 预算登记

- **前置**：✦A。
- **涉及文件**：新建 `packages/evolution/{package.json,tsconfig.json,src/index.ts,src/control.ts,src/costs.ts,src/budgets.ts,tests/control.spec.ts,tests/costs.spec.ts,tests/budgets.spec.ts}`。包名 `@self-evolving/evolution`，type module，零运行时依赖（仅 node 内建），devDeps：vitest（link 新 vendor）。
- **接口与数据格式**：

```ts
// src/control.ts —— 控制状态单文件（state/control.json）
export interface ControlFile {
  schemaVersion: 1
  seq: number                              // 发布编号，每次发布动作 +1
  baseline: ArtifactSet                    // 正式基线
  previous: ArtifactSet | null
  quarantine: { hash: string; reason: string; atUtc: string }[]   // 坏版本隔离清单：回退目标永不从中选取
  activeTrial: Trial | null
  records: ControlRecord[]                 // 每次发布/绑定/恢复动作的脱敏摘要（上限 200 条，FIFO）
}
export interface ArtifactSet { entries: ArtifactRef[]; hash: string }   // hash = 全部 entries 的 sha256
export interface ArtifactRef { kind: 'plugin'|'memory'|'skill'|'config'; id: string; digest: string; path: string }
export interface Trial {
  trialId: string; candidateId: string
  releaseSeq: number                       // 不变式：=== 当前 seq 才有效
  candidateDigest: string                  // 不变式：=== 实际加载产物摘要才有效
  condition: { preset?: string; workspacePrefix?: string }   // 预先批准的适用条件，由控制插件解释
  startedAtUtc: string; deadlineUtc: string
  status: 'active' | 'expired' | 'invalidated'
  enrolled: EnrollEntry[]
}
export interface EnrollEntry { taskId: string; sessionId: string; boundVersion: 'baseline'|'candidate'; enrolledAtUtc: string; reason?: string }
export type ControlAction =
  | { type: 'publish'; baseline: ArtifactSet; approvalRef: string }
  | { type: 'enable-trial'; trial: Omit<Trial, 'status' | 'enrolled'> }
  | { type: 'revoke-trial'; reason: string }      // 试用候选技术故障：停候选，baseline 不动
  | { type: 'recover-baseline'; reason: string }  // 正式基线故障：回退上一基线（坏版本入隔离）
  | { type: 'mark-trial'; status: 'expired' | 'invalidated'; reason: string }
// 注意：enroll 不是独立动作——名额检查与占位合并进 bindForTask（同一次锁内），杜绝"先查后写"竞态
export async function writeControl(stateDir: string, action: ControlAction): Promise<ControlFile>
export function readControl(stateDir: string): Promise<ControlFile>          // 损坏 → 抛 ControlCorruptError
export function trialEffective(c: ControlFile, actualCandidateDigest: string | null): Trial | null
// 绑定入口唯一 API：查既有绑定 → 校验有效试用（seq/摘要/status）→ 期限/名额 → 占位写入，全部在同一次锁内完成
export interface BindInput { taskId: string; sessionId: string; candidateDigestOnDisk: string | null
  conditionCtx: { preset?: string; workspacePrefix?: string } }
export type BindResult =
  | { bound: 'candidate'; trialId: string }
  | { bound: 'baseline'; reused: boolean
      reason: 'no-trial' | 'trial-invalid' | 'digest-mismatch' | 'expired' | 'quota-full'
            | 'condition-mismatch' | 'lock-timeout' | 'control-corrupt' }
export async function bindForTask(stateDir: string, input: BindInput): Promise<BindResult>
```

```ts
// src/costs.ts —— evolution-private/costs.jsonl（合同第 4 节）
export type Stage = 'discovery'|'validation-plan'|'generation'|'offline-check'|'trial-observation'|'review'|'milestone-0-probe'
export interface CostStart { kind:'start'; eventId:string; operationId:string
  experimentId?:string; candidateId?:string; trialId?:string; taskId?:string; attempt?:string   // 合同要求的关联字段
  stage:Stage; provider:string; model:string; startedAtUtc:string; reservationId?:string }
export interface CostFinish { kind:'finish'; eventId:string; operationId:string; status:'completed'|'failed'|'cancelled'|'unknown';
  finishedAtUtc:string; durationMs:number|null;
  usage:{inputTokens:number;outputTokens:number;cachedInputTokens:number|null;reasoningTokens:number|null}|null;
  usageSource:'provider'|'estimate'|'unknown'; money:{amount:number;currency:string;priceVersion:string;source:string}|null;
  failureReason?:string }
export interface CostReconcile { kind:'reconcile'; eventId:string; operationId?:string; supersedesEventId?:string
  note:string; usage:{inputTokens:number;outputTokens:number;cachedInputTokens:number|null;reasoningTokens:number|null}|null
  usageSource:'provider'|'estimate'|'unknown'; atUtc:string }
// 补账：账单到达/修正时追加 reconcile，不改动已写入的原记录
export async function appendCost(dir: string, rec: CostStart | CostFinish | CostReconcile): Promise<void>
export function readCosts(dir: string): CostRecord[]    // 按 operationId 配对；重复 eventId 丢弃并计数；reconcile 挂到对应 operation
```

```ts
// src/budgets.ts —— 预算：预占 → 调用 → 结算 / 未知保留占额（合同第 4 节）
export interface Budget { attemptId:string; stage:Stage; wallClockLimitMs:number; callLimit:number; tokenLimit:number|null
  scope:string; startedAtUtc:string; reservedTokens:number; openReservations:string[]
  status:'open'|'stopped'; stopReason?:'timeout'|'budget_exhausted' }
export interface Reservation { reservationId:string; attemptId:string; estTokens:number }   // estTokens=用量未知时的保守上限估计
export async function openBudget(dir:string, b: Omit<Budget,'reservedTokens'|'openReservations'|'status'>): Promise<void>  // 同名已存在 → 拒绝
export function reserve(dir:string, attemptId:string, estTokens:number): Reservation
  // 调用前预占：reservedTokens += est；wall-clock/call/token 任一超限 → 记 stop 并抛 BudgetExceeded（最后一次请求不得远超剩余预算）
export function settleReservation(dir:string, r:Reservation, actual:{tokens:number|null; calls:number}): void
  // 已知用量 → reservedTokens -= (est - actual)（释放多余）；未知(null) → 占额保留，不释放成零
export function settleBudget(dir:string, attemptId:string): BudgetSummary   // 尝试收尾；未决占额（未知/已取消未结算）如实列出
// 取消语义：cancelled 调用不释放占额（提供方可能仍计费）；账单到达后经 costs.reconcile 补账
```

- **实现步骤**：`writeControl` / `bindForTask` 共用同一锁实现。**锁（本机无 `flock` 命令，用 O_EXCL 锁文件；自动获取/释放，不做并发自动接管）**：`fs.openSync(control.lock, 'wx')` 独占创建并写入 `{pid, createdAtUtc}`；失败按 50ms 间隔重试至 5s 超时；正常路径 finally 删锁。超时后读锁诊断：pid 存活 → 抛 `ControlLockTimeout`（调用方可稍后重试）；pid 已死或锁文件损坏 → 抛 `StaleLockError`，**该操作停止并告警，不自动删锁**——两个进程同时处理残锁时，自动删除可能误删对方刚取得的新锁。**残锁清理只由启动前置恢复步骤执行**（见 B4）：`start.mjs` 在拉起任何子进程之前（此时不存在本环境写者）核对各锁文件 pid，全部已死才删除残锁；发现存活 pid → 中止启动并报告，交人工处理。`writeControl` 顺序：取锁 → 校验（publish 需 approvalRef；enable-trial 需 candidateDigest 非空；recover-baseline 见下）→ 组装新文件（seq 规则见下表）→ 写 `control.json.tmp` + fsync + rename → 释放锁。所有路径无中间态。
- **关键状态变化（发布与试用）**——试用候选故障与正式基线故障是两种不同恢复，**不得混用**：

| 动作 | seq | baseline | previous | activeTrial | quarantine |
|---|---|---|---|---|---|
| publish（正式发布） | +1 | ←新集合 | ←旧 baseline | null | 不变 |
| enable-trial（试用启用） | +1 | 不变 | 不变 | ←新 Trial（绑定新 seq+摘要） | 不变 |
| **revoke-trial（撤销试用）** | +1 | **不变** | 不变 | invalidated+原因 | 不变 |
| **recover-baseline（回退正式发布）** | +1 | ←previous；previous 为空或其 hash ∈ quarantine → 抛 `NoSafeBaseline`（调用方停机交人工） | **←null**（坏版本不得再成为回退目标） | null（若有活动试用一并失效） | ←追加旧 baseline 的 `{hash, reason}` |
| bindForTask（绑定+占位） | 不变 | 不变 | 不变 | 有效则 enrolled 追加一条 | 不变 |
| mark-trial | 不变 | 不变 | 不变 | status → expired/invalidated | 不变 |

撤销/回退的判定规则：故障源是**试用候选**（仅候选会话受影响）→ revoke-trial，baseline 继续服务，下一任务回基线；故障源是**正式基线产物** → recover-baseline。连续第二次 recover-baseline 时 previous 已为 null → `NoSafeBaseline` → 启动器退出（与"仅重试一次"一致），被隔离的坏版本在任何路径下都不会被换回。

- **异常处理**：锁超时（pid 存活）→ 调用方放弃本次动作并稍后重试，**不得降级为无锁写**；`StaleLockError`（残锁）→ 操作停止、状态置 paused 并告警，等启动前置恢复步骤或人工清理，**不自动删锁**；rename 前崩溃 → 旧文件完好、动作未发生；rename 后崩溃 → 新文件生效（无撕裂，单文件）；`ControlCorruptError` → 绑定一律回基线（reason=control-corrupt）、启动器以空受管理集合（保留安全配置）启动并置 paused（见 B4），等待人工恢复；bindForTask 时 activeTrial 已失效 → 返回 baseline+原因，不写占位。
- **必要测试**：`control.spec.ts`——原子性（注入 rename 失败断言旧文件不变）、seq 单调、动作表逐一断言（含 revoke-trial 不动 baseline、recover-baseline 后 previous=null、二次 recover 抛 `NoSafeBaseline`、quarantine 中的 hash 永不被选为回退目标）、trialEffective 在 seq 不匹配/摘要不匹配/status≠active 时返回 null、锁互斥（并发 20 写全部串行成功）、残锁 → 抛 `StaleLockError` 且锁文件不被删除、**bindForTask 并发**（名额=5、20 个不同 taskId 并发绑定 → 恰好 5 个 candidate 无超额）、同 taskId 重复绑定复用不占新名额；`costs.spec.ts`——operationId 配对、重复 eventId 丢弃、usage=null 不写 0、reconcile 挂接不改原记录、关联字段（experiment/candidate/trial/task）写入；`budgets.spec.ts`——reserve 预占与超限抛出、未知用量占额保留不释放、已知用量释放多余、cancelled 不释放、settle 后不重置、wall-clock 超时停止。
- **命令**：`npm test`（根 test script 扩为 `vitest run packages`）。
- **验收**：三组测试全绿；手工演练一次"注入崩溃后文件完整"。
- **失败处理**：原子性测试不过 → 先修写入实现，不进入 B2。

### B2 创造模式候选探针（含 P3）

- **前置**：B1。
- **涉及文件**：新建 `scripts/run-candidate-probe.mjs`、`scripts/probe/p3-creator-boot.mjs`、`state/runtime/dsh-test/`（隔离环境，可随时删除）。
- **实现步骤**：
  1. **P3 首日**：隔离 `DSH_HOME=state/runtime/dsh-test`，确认创造模式（preset `cordis`）无头启动命令、`pluginManager` 服务在实例内的调用方式、deepseek-official 凭据注入方式（实例自有配置，运行时由操作者提供，不落 Git、不继承主环境）。结论回填本文。
  2. 主脚本：创建独立 `DSH_HOME`、临时 profile/数据目录/工作区 → 子进程环境变量允许清单（仅 `PATH/HOME/DSH_HOME` + 凭据变量）→ 启动创造模式 → 驱动 Flash 用 `cordis_inspect_list/query` 检查接口 → 在工作区编写仅记录生命周期的标准 bundle（package.json + 入口 + 配置层）→ 经 `pluginManager.installBundle` 装到测试 profile（遵循操作批准与构建脚本批准，不静默 `danger-full-access`）→ `setPluginEnabled` 验证激活/停用/再激活 → 保存候选源码、工具调用记录、诊断 → 清理。
  3. 接入 B1：脚本开头 `openBudget`（限额由操作者此时填入，首个必须登记的尝试），每次模型调用 `assertBudget` + `appendCost` start/finish；演练超时与达限两种停止（取消在途、清理进程、保留记录、不自动重试）。
- **必要测试**：无单测（端到端探针）；预算停止以真实触发留痕为准。
- **命令**：`node scripts/run-candidate-probe.mjs`。
- **验收**：主网页进程（baseline 环境）全程未装载候选；候选激活失败不改主进程状态；两种超限真实停止。
- **失败处理**：创造模式无法在独立进程完成生命周期 → 停止，不建候选管理（G4）。

### B3 工作进程骨架与按需拉起

- **前置**：B2。
- **涉及文件**：新建 `scripts/evolution-worker.mjs`；`packages/evolution-probe/src/index.ts` 增加 spawn 逻辑（约 +40 行）。
- **接口与数据格式**：
  - `state/worker.lock`：`{ pid:number; startedAtUtc:string; reason:string }`。
  - `state/worker-status.json`：`{ state:'starting'|'running'|'idle'|'interrupted'; pid:number; lastError?:string; updatedAtUtc:string }`（工作进程心跳覆写，>120s 未更新视为陈旧）。
  - `state/worker-request.json`：`{ requestId; kind:'analysis'; requestedAtUtc }`（控制插件写，工作进程取走后删除）。
- **实现步骤**：控制插件注册最小触发命令（现有界面命令通道）→ `spawnWorker()`：lock 文件存在且 pid 存活 → 拒绝（单实例）；pid 已死 → 标 `interrupted` 后允许操作者确认重开（不自动重试）→ spawn `node scripts/evolution-worker.mjs`（env 允许清单 + `EVO_SESSIONS_ROOT` 传入，见 C1）→ worker 写 status 状态机 `starting→running→idle`，异常退出前 best-effort 写 `interrupted`。演练：网页触发 → kill 工作进程 → 网页仍可用、状态标中断、无自动重启；停止请求清理 worker 及其子进程。
- **必要测试**：`packages/evolution/tests/worker-lock.spec.ts`（锁判定与中断标记的纯函数部分）。
- **命令**：网页触发；`node scripts/evolution-worker.mjs --selftest`。
- **验收**：单实例强制；中断可见；清理无残留（`pgrep` 验证）。
- **失败处理**：spawn/清理不可靠 → 修生命周期，不带病进入 B4。

### B4 外部启动器、冻结复验与恢复演练

- **前置**：B3。
- **涉及文件**：新建 `scripts/start.mjs`、`scripts/test-startup-recovery.mjs`。
- **实现步骤**：
  1. 冻结 B2 候选：源码+配置+依赖记录+sha256 存入 `evolution-private/candidates/<candidateId>/`；静态核对包清单/入口/配置层可被官方加载器解析；干净测试实例（新 `DSH_HOME`）安装并跑生命周期；按冻结验证计划复验适用离线检查；经 `writeControl({type:'publish'})` 写入测试用控制状态，重启确认插件仍在。
  2. `start.mjs`：**启动前置恢复步骤**（拉起任何子进程之前执行，此时不存在本环境写者）：核对各锁文件（control/worker）中的 pid——全部已死 → 清理残锁后继续；发现存活 pid → 中止启动并报告（孤儿进程交人工，不强行清理）。随后读 `control.json`；若 `ControlCorruptError` → **不以猜测基线启动**：以"空受管理集合"启动——仅官方默认 bundles，**保留既有安全配置（含 `session-log-deepseek.enabled=false`；空集合指进化产物，不回退安全配置）**，状态置 paused 并告警等待人工修复——此时不存在可信基线可回退，不得声称"已回落基线"。正常路径：生成 `bootId`（uuid）随 env 传入 → 以受管 env 启动官方 web → 健康检查 = ①子进程存活 ②端口就绪 ③**健康记录**：控制插件按 `bootId` 写 `state/launcher-health.json` `{ bootId, atUtc, artifacts: [{id, kind, expected, evidence}] }`——**按实例核对各自应加载的产物，不要求全部产物都在主实例激活**：插件类查实际激活状态（activated）；Memory/Skill/配置类无"激活"概念，核对**版本与加载证据**（生效 configHash / 材料摘要与控制文件预期一致）；试用候选经独立实例运行 → 在**该实例**的健康检查中核对，按会话挂载 → 在**绑定会话建立时**记录激活证据，均不强求主实例启动时激活。主实例启动健康只覆盖主实例应加载项，全部通过才算成功；心跳周期刷新但 **bootId 必须匹配本次启动**（旧启动残留记录 bootId 不符，直接忽略，杜绝陈旧心跳冒充健康）。控制插件自身列入主实例预期集合：它失败则无人写健康记录 → 超时判败（覆盖"网页起了但另一受管插件没激活"与"控制插件死亡"两类场景）。失败时按故障对象选动作：试用候选故障 → `writeControl({type:'revoke-trial'})`（baseline 不动）；正式基线故障 → `writeControl({type:'recover-baseline'})`；之后**仅重试一次**，二次失败退出码非 0。启动器同时负责按 `worker.lock` 的 PID 清理残留工作进程。
  3. `test-startup-recovery.mjs` 演练矩阵：a) 人为坏插件+进程非零退出；b) 坏插件+仅告警网页仍起（健康检查必须判败）；b2) 控制插件正常但集合内另一插件激活失败（健康记录须判败，不得因心跳存在而放行）；b3) Memory/Skill/配置类产物版本或加载证据与控制文件不符（判败）；c) 启动成功后注入运行故障（控制插件死亡）→ 启动器恢复；c2) 试用候选故障 → 撤销试用后 baseline 不变、下一任务绑基线；d) 进程仍活着但插件故障 → 受影响任务先暂停、坏插件停止作用后提示（不只切清单）；e) 中断 `writeControl` 写入过程 → 控制文件无撕裂；e2) 控制文件损坏 → 空受管理集合启动 + paused + 安全配置保留，不声称回退；f) 未知原因退出 → 保留诊断交人工，不自动定性插件故障；g) 伪造旧 bootId 心跳文件 → 被忽略；h) 残锁 → 前置恢复步骤清理后启动；锁内有存活 pid → 中止启动并报告。
- **必要测试**：恢复演练即测试，全部留痕（输出+日志入 `artifacts/milestone-0/ddefc45/B4/`）。
- **命令**：`node scripts/start.mjs`；`node scripts/test-startup-recovery.mjs`。
- **验收**：演练矩阵各项（含 b2/c2/e2/g）各自有通过记录；恢复后受影响任务保持暂停并提示；撤销试用后 baseline 不变、回退发布后坏版本入隔离且不换回；两次失败退出不循环。
- **失败处理**：启动器无法在坏配置下恢复 → 不进入真实候选发布（G8）；冻结产物复验失败 → 不允许发布（G5）。

### B5 文件撤销与预算边界演练（里程碑零收尾）

- **前置**：B4。
- **涉及文件**：新建 `packages/evolution/src/undo.ts` + `tests/undo.spec.ts`；`evolution-private/undo/`（日志目录）。
- **接口与数据格式**：撤销日志 `evolution-private/undo/<sourceId>.jsonl`，每条 `{ file; beforeHash; beforeRef; afterHash; source; ts }`（`beforeRef` 指向最小恢复材料副本，仅授权范围）。
- **实现步骤**：纯函数库 `planUndo(journal, now)` → `{revert:[], skipped:[{file,reason:'later-modified'|'unclear-owner'|'missing-material'}], failed:[]}`；执行器逐文件：复核当前哈希===afterHash（防并发）→ 恢复 beforeRef → 再验哈希。演练（可丢弃工作区）：正常撤销、后续被用户再改（整文件跳过）、归属不明（保留现场+人工清单）、并发写入嫌疑（跳过）、不整仓恢复、不向真实外部系统写。
- **必要测试**：`undo.spec.ts` 覆盖上述五情形 + "撤销后报告明细完整"。
- **命令**：`npm test`；演练脚本输出留痕 `artifacts/milestone-0/ddefc45/B5/`。
- **验收**：撤销确认的故障修改且保住后续正常改动；明细三类齐全；至此**里程碑零五项+全部演练**有新版证据，出具总结记录（G9/G10 通过）。
- **失败处理**：撤销会覆盖后续修改或缺证据仍撤销 → 修边界，不允许正式插件发布。

### ✦B 阶段审计点

停审清单：① 里程碑零五项对照[完成定义](./2026-08-20-milestone-zero-implementation-plan.md)逐项有 ddefc45 实证；② 预算与成本从首次模型调用起有账（B2 起抽查 costs.jsonl）；③ 控制文件演练（错配/撕裂/锁）记录齐全；④ 未修改 vendor、未影响 baseline 主环境。通过后进入阶段 C。

---

## 4. 阶段 C：最小采集（细到可编码）

### C1 SessionSource 端口与官方适配器（含 P1）

- **前置**：✦B。
- **涉及文件**：新建 `packages/evolution/src/session-source.ts`、`tests/session-source.spec.ts`；`scripts/evolution-worker.mjs` 内适配器（P1 结论复用自 A2）。
- **接口与数据格式**：

```ts
// 端口（纯库只依赖此接口）
export interface SessionSource {
  list(): Promise<SessionMeta[]>                       // { id, revision }
  open(id: string): Promise<ReadHandle>                // 只读
}
export interface ReadHandle { read(offset:number, length:number):Promise<SessionEvent[]>; close():Promise<void> }
```

- **实现步骤**：
  1. **P1 结论复用（A2 已定案）**：独立装载可行性、服务访问器名、`open/read/close` 用法以 A2 的 `v3-migration.mjs` 记录为准，本步不再重复验证；仅当 A2 结论为不可行时，启用备选（控制插件主进程内 IPC 提供同端口）并于当日留痕定案。
  2. 适配器：`new Context()` → `ctx.plugin(SessionPersistenceJsonl, { root: process.env.EVO_SESSIONS_ROOT })`（启动器传入，缺失即启动失败，不猜默认路径）→ 包一层仅暴露五类调用的端口实现；模块内禁止出现 `create`/写打开（评审硬项，lint 规则可选）。
  3. 游标：`evolution-private/progress.json`，`{ [sessionId]: { revision, seq } }`；**推进规则**：仅成功补读后推进；立即补读允许较短前缀，以 flush 后补读的完整结果为准。
- **必要测试**：`session-source.spec.ts`——授权副本完整补读一轮，副本目录前后清单+哈希零变化；旧格式只读打开仅内存迁移。
- **命令**：`npm test`。
- **验收**：P1 复用记录在案；只读探针通过；真实并发场景不以"目录未变"为验收（正确实现不被误判）。
- **失败处理**：主选/备选均不可行 → 停止重评架构（G11 前置）。

### C2 任务归并与来源隔离

- **前置**：C1。
- **涉及文件**：新建 `packages/evolution/src/merge.ts`、`tests/merge.spec.ts`；数据 `evolution-private/derived/tasks.json`。
- **接口与数据格式**：

```ts
export interface TaskRecord {
  taskId: string                                   // t-<uuid>
  purpose: 'real' | 'exercise' | 'internal' | 'unassigned'
  assignment: 'auto' | 'confirmed' | 'rejected'    // 归并结果是否经确认
  sessions: { sessionId: string; firstSeq: number; lastSeq: number }[]
  retryCount: number
  createdAtUtc: string
  outcome?: 'success' | 'partial' | 'fail' | 'unknown'
  outcomeNote?: string; outcomeSource?: 'user' | 'derived'
}
```

- **关键状态变化（任务身份与归并）**——身份在绑定前确定，归并在事后修正统计，两者分离：

```text
会话建立（首条消息前）：控制插件最小入口确定身份（C3 实装）——
  默认"新任务" → 新建 taskId 并写入 session→task 映射；
  用户选"继续 <最近任务>" → 复用该 taskId（用于跨会话重试）。
  MVP 不支持会话中途切换任务：一个会话从建立起归属且仅归属一个任务；
  要开始新工作 → 新建会话（默认新任务）；要继续旧工作 → 新建会话并选"继续"。
  （消除会话内区间归属与版本中途切换两套问题。）
绑定与名额计数都以 binding-time 身份为准（bindForTask 的 taskId 即来自此处）。
同 sessionId 续轮次 → sessions[].lastSeq 延长（同一任务，不新建）。
跨会话重试未经"继续"入口 → 按新任务绑定与计数，如实记录 binding-identity；
操作者事后在报告中"认领合并"（人工认领制；MVP 不做相似度匹配）
  → 仅修统计与计数（retryCount+1，留合并痕迹与认领人/时间），
    不改已发生的执行绑定、不追改会话实际使用的版本；
  认领可撤销 → 计数恢复，同样留痕。
无法归属（映射缺失/损坏）→ purpose='unassigned'，不计入三任务与三十任务计数。
```

- **异常处理**：`tasks.json` 损坏 → 从派生经验的源引用（sessionId+seq 区间仍在）重建骨架，outcome 丢失标 `unknown` 并告警；同一 sessionId 出现在两个 TaskRecord → 冲突标记，人工裁决前双方都不计数；`turn/end` 数量任何时候不得当作任务数；认领合并与执行绑定不一致（重试会话占了两个名额）→ 复盘报告如实列出，不伪装成当时执行一致。
- **必要测试**：`merge.spec.ts`——续轮次不新建、认领合并修统计不改绑定、撤销认领恢复计数、unassigned 不计数、损坏重建。
- **命令**：`npm test`。
- **验收**：binding-identity 与事后认领结果各自留痕可审计；计数口径仅 `purpose='real' && assignment='confirmed'`。
- **失败处理**：认领负担过重 → 维持现状如实记录，不引入自动匹配（保守方向）。

### C3 增量采集流程、结果标记与六态状态

- **前置**：C2。
- **涉及文件**：`scripts/evolution-worker.mjs`（采集主流程）；`packages/evolution-probe/src/index.ts`（唤醒标记精简 + 结果标记入口 + 状态写读）；`scripts/probe/p2-feedback-categories.mjs`。
- **实现步骤**：
  1. 控制插件监听 `session/event`（只置脏标记，内存 + `state/dirty.json`，不读内容；同时记下本轮**目标 seq** = 已见最新 `turn/end` 的 seq）与 `session/flush`（作为补读唤醒信号之一）。**注意：flush 的各监听器并行执行**——采集监听器收到通知时，持久化排水监听器可能尚未完成，**收到 flush 通知 ≠ 已落盘**；不得据此认定"最终读完成"。
  2. 工作进程采集循环（含两个兜底触发）：①事件唤醒（event/flush）；②**启动补扫**——worker 每次启动时对所有"游标落后于当前 revision"的会话全量补扫，覆盖崩溃期间 missed 的唤醒。循环体：取待读会话 → `SessionSource` `stat/list` 比对 revision → `open('read')` 补读至游标 → 派生经验写入 `evolution-private/derived/experience.jsonl` → 推进游标 → 关句柄。**完成判定（防 flush 并行窗口漏尾）**：某轮补读只有读到 ≥ 该轮目标 seq 的事件才判完成；暂读不到 → 保留**待补读状态**，等下一次唤醒或启动补扫再查，不因"收到过 flush 通知"而提前结轮。**幂等写入（崩溃恢复的关键）**：经验记录以事件为原子，每条携带稳定去重键 `(sessionId, generation, seq)`——**必须含日志代际**，V3 迁移会重排 seq，不含代际则迁移后新序号可能与旧记录混淆；追加前查该会话该代际已写末位 seq，只追加其后增量；读取端再按 `(sessionId, generation, seq)` 兜底去重——"写完经验、未推进游标就崩溃"后重启补扫，重放增量靠去重保证不重不漏，游标随后追平。字段：taskId、purpose、源代际+seq 区间、harnessSha、preset/model、规范化现象、脱敏摘要、结果引用。
  3. **任务身份入口实装**：控制插件提供最小入口（默认新任务；"继续 <最近任务>"选择；**不支持会话中途切换**，换任务即新建会话）——写入 `session→task` 映射，供采集计数与 F1 绑定使用；首条消息前无身份 → 阻塞绑定并提示（不猜身份）。
  4. **P2**：读 `FEEDBACK_CATEGORIES` 实际取值与网页暴露方式 → 能映射 成功/部分/失败 则接 `messageFeedback` 写入并同步 TaskRecord.outcome；不能映射则退最小命令/卡片（决策留痕）。结果标记关联 taskId+版本+seq。
  5. 六态状态机：控制插件读写 `state/machine-state.json` `{ state:'recording'|'analyzing'|'testing-candidate'|'awaiting-confirmation'|'observing'|'paused'; since; reason? }`，来源=worker-status + 控制文件 + 采集健康度的真实组合；客户端标记渲染六态文字+强调样式。
- **必要测试**：采集循环单测——前缀接受、游标不提前、故障注入不阻塞标记脏会话、**崩溃恢复**（写完经验、未推游标即中断 → 重启补扫后不重不漏）、**flush 并行窗口**（收到 flush 通知但目标 seq 暂不可见 → 保持待补读，下一轮唤醒补齐后才判完成）、**代际去重**（模拟迁移重排 seq 后，新旧代际记录不混淆）、启动补扫覆盖无唤醒窗口；状态机转换表单测。
- **命令**：`npm test`；实机跑一轮真实会话采集。
- **验收**：立即补读与 flush 后补读呈前缀关系、最终不重不漏；**崩溃恢复测试通过**（写经验未推游标 → 重启补扫 → 不重不漏）；采集故障注入不影响会话完成；练习/内部记录不进真实统计；身份入口可用且绑定前必有 taskId；六态随真实状态切换。
- **失败处理**：采集干扰任务 → 修隔离与补读（G11）；反馈通道不可用 → 用命令通道，不阻塞。

### ✦C 阶段审计点

停审清单：① 只读探针+前缀关系验收记录；② 归并演练记录（含合并/拒绝/unassigned）；③ 真实会话全链路一次（事件→经验→结果标记→状态）；④ costs.jsonl 覆盖 discovery 前的所有模型调用为空（本阶段如无模型调用则记录"零调用"）。通过后进入阶段 D。

---

## 5. 阶段 D：Jev 接入与真实发现试验

### D1 Jev 接入验证与审计客户端（细到可编码）

- **前置**：✦C。
- **涉及文件**：新建 `packages/evolution/src/jev.ts`、`tests/jev.spec.ts`；`evolution-private/derived/jev-validation/`。
- **接口与数据格式**：

```ts
export interface JevQuestion { kind:'choice'|'score'|'noul'; /* 按 P4 前置的官方 API 字段补全 */ }
export interface JevAuditor {
  ask(state: string, questions: JevQuestion[]): Promise<Array<{ kind:string; value:unknown; confidence:number }>>
}
export function makeJevAuditor(config:{ endpoint:string; apiKeyEnv:string }): JevAuditor   // 密钥只从环境读
```

（SDK vs 裸 HTTP、npm 包名与请求字段以接入时官方文档为准，先写探针脚本 `scripts/probe/jev-smoke.mjs` 对一条脱敏样本实调确认，再固化 `jev.ts`——不猜字段。）

- **验证登记文件** `evolution-private/derived/jev-validation/registry-<n>.json`：

```ts
{
  round: number; createdAtUtc: string
  sampleSet: { file: string; count: number; sampling: string; goldStandard: '人工核对' ; annotator: string }
  passConditions: {
    screening: { accuracyMin: number; missMax: number; uncertainMax: number; costMaxPerCall: number; latencyP95MaxMs: number }   // 初筛用途
    audit:     { accuracyMin: number; missMax: number; uncertainMax: number; costMaxPerCall: number; latencyP95MaxMs: number }   // 卡片审计用途
  }
  uncertainRule: { confidenceThreshold: number; fallback: 'flash-or-human' }
  status: 'registered' | 'testing' | 'passed' | 'failed' | 'fallback'
}
```

- **关键状态变化（Jev 接入）**：

```text
registered（登记冻结，时间早于一切测试结果）
→ testing（跑样本，逐条记 raw 输出）
→ passed（各项指标满足预登记条件）→ 允许在 D2/F2 使用
→ failed（任一条件不满足）→ 回退 Flash-only；改条件=登记新一轮 registry-<n+1>，旧轮结果不得复用
→ fallback（发送范围未获负责人确认 / 提供方不可用）→ 不外发，主线继续
```

- **异常处理**：API 错误/超时 → 该样本标 `errored`（区别于 `uncertain`），重试一次；`errored` 超过样本 10% → 本轮 `testing` 判不完整，不得判 passed；confidence < 阈值 → `uncertain`，不算对错，走 fallback 路径；数据发送范围未确认 → 一律不外发（G13）。
- **必要测试**：`jev.spec.ts` 用本地 stub 模拟三种返回（正常/低置信/错误）断言状态机与分类；真实调用仅发生在验证脚本。
- **命令**：`node scripts/probe/jev-smoke.mjs`；验证执行脚本读取 registry 跑批。
- **验收**：registry 有预登记且时间戳早于结果；两个用途分别判定；回退路径真实演练一次。
- **失败处理**：验证失败 → Flash-only，不影响 D2 其余验收（G13）。

### D2 人工触发分析编排与问题卡片（合同级）

- **前置**：D1（或 D1 判 fallback）。
- **合同要点**：触发命令 → 工作进程检查（新修订/无并发任务/未超本轮调用上限）→ 事实整理覆盖三类样本 → Flash 隔离上下文分析（每调用 assertBudget + appendCost）→ Jev（若 passed）初筛与卡片审计 → 卡片落 `evolution-private/derived/cards/<cardId>.json`（字段：现象、支持任务列表（taskId+证据 seq 引用）、反例、归因假设、不确定性、可测性、发现来源 `self|human-hinted`、确认记录链）→ ≥3 个 `real+confirmed` 任务支持才可进确认，否则记 `insufficient-evidence`；人工确认/修改留痕（前后版本+修改人+时间）。
- **验收**：一次真实触发生成可审查卡片或如实证据不足报告；人工干预全留痕；"跑过分析"不等于发现成功。
- **失败处理**：无合格问题 → 继续收集或调整发现方法（留痕），不建外围。

### ✦D 阶段审计点

停审清单：① Jev registry 结论与回退演练记录；② 卡片/证据不足报告的可回查性（证据 seq 引用抽查）；③ 分析阶段成本账完整。通过后进入阶段 E。

---

## 6. 阶段 E：证据捕获与首个候选闭环（合同级）

### E1 捕获器与探针①–④（含 P4）

- **前置**：✦D + 已确认问题卡片。
- **合同要点**：新建 `packages/evolution-capture`（Cordis 插件）；**P4 首日**：测试 adapter 实跑确认插件内 `ctx.on('llm/stream', ...)` 注册语义、middleware 顺序（recorder 须在被测策略之前/之后的结论写实）、`GenerateOptions` 可序列化字段全集。捕获落盘 `evolution-private/captures/<captureId>/{input.json, output.jsonl, manifest.json}`，manifest 字段=合同第 2 节全项。
- **关键状态变化（证据捕获）**：

```text
每次模型调用：writing-input（委托 next() 前复制数据值并序列化落盘）
→ streaming-output（顺序追加块/usage/终止或异常）
→ complete（原子发布 manifest）
→ incomplete{reason: crash|disk|limit|cancelled}（保留已写内容，绝不截断称完整）
辅助状态：seam_only（顺序无法证明一致时降级标记）/ unsupported（该边界未实现）
```

- **异常处理**：捕获写盘失败 → 业务调用不受影响继续，但标记 capture-failed，**实验对照缺证据即停止比较**（观测失败不阻塞普通工作，实验缺证据不硬比）；非有限数字/函数等 → 按字段规则排除并记 missingFields，不静默丢弃；凭据/句柄不入正文（redaction v1 字段表）。
- **探针①–④**：按合同第 5 节 1–4 项各写一个 vitest/脚本，通过记录入 `artifacts/milestone-0/ddefc45/E1/`。⑤ 不在本步（随 F1）。
- **验收**：①–④ 全过；未支持边界显式标 unsupported。
- **失败处理**：任一不过 → 不进入真实对照（G7）。

### E2 首个候选闭环（合同级，含选择节点）

- **前置**：E1。
- **合同要点**：
  1. **选择节点（硬门）**：在候选生成开始前，由操作者确认《改动类型选择记录》`{ chosen:'memory'|'skill'|'config'|'plugin'; rejected:[{kind,reason}]; decidedAtUtc; cardRef }` 落 `evolution-private/derived/`。**只实现被选中类型的修改器路径**，不预建其余三类（方案 8.1）。
  2. 验证计划冻结文件 `{hypothesis, scope, metrics, nonRegression, materials+缺失项, repeats, budgetRef, trialTerms, exitConditions, frozenAtUtc}`——`frozenAtUtc` 必须早于任何候选产物时间戳（审计核对项）。
  3. 三版状态：`candidates[1..3]`，每版 `{parentRef, failureDiagnosis, budgetRef, outcome}`；v(n) 只能引用 v(n-1) 的明确失败诊断；三版耗尽 → 停止等人。
  4. 判定分支：运行/安全检查缺失 → 拦截；缺可信对照 → 记录缺口，低风险+可观察+可撤回+运行检查已过 → 出审查报告申请试用（标"尚无独立证据"）。
  5. 冻结产物（sha256）→ 干净实例复验 → 审查报告（字段清单见方案步骤 9）→ 人工批准/拒绝。
- **验收**：选择记录、冻结时间、三版约束、证据分级四项均可审计。
- **失败处理**：超限/三版尽 → 停止留痕等人；捕获不足 → 走判定分支不造快照。

### ✦E 阶段审计点

停审清单：① P4 结论与探针①–④记录；② 选择节点记录存在且只实现了一种修改器；③ 冻结时序核对；④ 判定分支演练记录。通过后进入阶段 F。

---

## 7. 阶段 F：试用控制与收尾（合同级）

### F1 试用控制实现与探针⑤ + 错配/重绑演练

- **前置**：✦E + 人工批准。
- **合同要点**：控制插件在会话身份确定后调用 B1 的 **`bindForTask`**——查既有绑定 → 校验 trialEffective（seq/摘要/status）→ 期限/名额 → 占位写入，**全部在同一次锁内完成**，不存在"先查后写"两段式；taskId 来自会话建立时的"新任务/继续"入口（C3 实装），绑定前必已存在；eligible/enrolled/exposed/outcome 记账。试用候选技术故障 → `revoke-trial`（baseline 不动）；正式基线故障 → `recover-baseline`（坏版本入隔离）。
- **关键状态变化与异常**（实现以此为准）：

| 情形 | 行为 |
|---|---|
| 试用候选技术故障 | **撤销试用**（revoke-trial）：baseline 不动，下一任务绑基线；不得误退 previous |
| 正式基线产物故障 | **回退发布**（recover-baseline）：坏版本入隔离清单，previous 置空，二次回退即停机交人工 |
| 绑定时锁超时 | 绑基线 + 告警，不无锁写 |
| control.json 损坏 | 绑基线 + 状态 paused，冻结试用至人工恢复 |
| seq/摘要不匹配 | 视为无活动试用，回落基线并记录原因 |
| 崩溃于占位写前/后 | 写前=无记录重新判定；写后=同任务复用（bindForTask 单次原子写，无中间态） |
| 同任务跨会话重试（经"继续"入口） | 命中既有绑定复用，不占新名额、不换版本；未经入口 → 按新任务绑定，事后认领只修统计 |
| 试用中 kill 工作进程/重启应用 | 限制照常生效（持久文件，不依赖进程） |
| 到期 | 绑定入口停止纳入，status→expired，待复盘 |

- **探针⑤与演练**（先于任何真实试用）：可控时钟验第五任务/第七天/跨会话重试去重/pending/零暴露/显式续期；两模拟并发新会话仅一个占位成功（bindForTask 并发已在 B1 单测，此处端到端复验）；发布/撤销/恢复后活动试用状态正确（撤销后 baseline 不变）；摘要篡改拒绑。
- **验收**：全部演练通过（G12）。
- **失败处理**：任一可绕过 → 修闸门，不开始 10b。

### F2 限定试用执行与复盘（合同级）

- **合同要点**：按批准条件只影响新会话（preset 会话挂载优先；全局插件走新实例，实机验证作用域）；技术故障走 B4/B5 路径；到期复盘报告 `evolution-private/derived/trials/<trialId>/report.json`（符合条件数/纳入/暴露/结算/缺失/全成本，Jev 一致性审计附后，数字一致性由代码核对）；人决定保留/续期/修改/恢复，全部留痕；30 个真实任务触发正式复盘检查。
- **验收**：作用域实机验证；复盘含负面与缺失；不可撤销操作逐次批准记录在案。

### F3 闭环演示与第一期收尾（合同级）

- **合同要点**：产品第 18 节链条演示一次（含恢复演练）；无证据环节展示"待观察"；汇总成本三分类 + Jev 单列 + 人工参与程度 + 样本限制。
- **验收**：演示与留痕一一对应。

### ✦F 阶段审计点

停审清单：① 探针⑤+错配演练记录；② 试用期间控制文件与账本抽查；③ 复盘报告与决定留痕；④ 第一期演示记录。至此 MVP 闭环完成，后续按路线图第二期另行规划。

---

## 8. 全局执行纪律

- **命令速查**：项目测试 `npm test`；上游构建 `cd vendor/dsh-0.1.6 && corepack pnpm build`；探针 `node scripts/probe/<name>.mjs`；启动 `node scripts/start.mjs`。
- **禁止**：修改 `vendor/` 任何内容；绕过 `SessionSource` 自解析日志；在主 profile 安装候选；未登记预算、未预占就发起模型调用；为通过验收改测试门槛（改门槛=按 D-044/合同规则重新登记）。
- **锁与互斥**：所有状态文件（control/worker/trial 相关）统一用 B1 的 O_EXCL 锁文件实现（独占创建、自动获取/释放，不依赖 `flock` 或其他外部命令）；**残锁不做并发自动接管**——运行中遇残锁停止并告警，清理只在 B4 的启动前置恢复步骤（确认全部 pid 已死）执行。
- **每阶段收尾**：证据入 `artifacts/milestone-0/ddefc45/`（或对应目录）→ 对照审计清单停审 → 需要时在决策记录追加条目 → 批准后才开下一阶段。
- **范围守则**：本拆解未新增任何方案外能力；Memory/Skill/配置/插件四类修改器只按 E2 选择节点实现被选中的一种；Jev 仅按 D-062 的审计角色接入。
