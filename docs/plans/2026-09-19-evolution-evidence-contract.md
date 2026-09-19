# 自进化 MVP：证据捕获、试用与成本合同

> 版本：0.1，2026-09-19；D-058～D-060。实施前验收合同，尚未实现或运行验证。
> 上游核查固定在 ddefc45fbc7f8e46dd73185e68295696d1297887。不承诺任意边界或整个环境均可重放。

## 1. 什么是相关边界

边界必须是代码可识别、具有明确输入输出的调用点；不是由分析模型事后选择一段“看起来重要”的叙述。验证计划先登记 boundaryKind、目标调用识别条件、所比较的处理函数及其读取的输入。第一期先实现一条真实需要的捕获路径，不做全事件抓取平台。

| 点位 | 自动捕获内容 | 可支持的结论 |
|---|---|---|
| `llm/stream` waterfall 的 recorder 入口、委托 `next()` 前 | 当前实际 GenerateOptions 的数据字段：有序消息/内容块、工具定义、模型/提供方、采样与输出限制、可序列化扩展；请求关联标识和版本 | 本拦截点的模型输入相同；不是网络最终字节保证，也不是其上游检索/组装过程的输入快照 |
| 同一调用的返回流 | 顺序记录内容块/usage/终止状态或异常，调用开始/结束时间 | 本次输出和已知消耗；模型输出不保证确定性 |
| 持久 `compaction/start`、`compaction/summary`、`compaction/end` | compactionId、事件 seq、源日志代际；summary、shadowedSeqs、模型、usage、错误；通过官方只读 handle 解析引用的原始内容 | 压缩事务及选定材料的对照。必须关联到实际摘要调用才能标为请求已捕获；不能凭时间接近或“最后一次请求”猜关联 |
| 持久 `turn/end` 及已有结果标记 | turn/session/task 关联、终止状态、结果标记来源 | 记账和试用进展；一个 turn 结束不等于实际任务结束 |

`llm/stream` 只能证明 recorder 所在拦截点；后续 middleware 可能变换请求。实施探针必须核对顺序，并与测试 adapter 实收数据比较。不能证明一致时标 `seam_only`，不能称为最终请求快照。不得为抓取擅自重写请求或改变原调用次数。

特别是上下文压缩：请求级对照只支持固定选定材料的摘要策略比较；若候选改变保留范围/触发时机，必须另捕获选取发生前的完整可见 surface、选择配置和外部依赖。当前尚未核实这一前置入口，故不得用摘要请求冒充该类策略的输入。检索、Skill 选择、工具执行亦须各自有真实输入合同和探针后才纳入；未支持的边界标 unsupported，不由模型补写。

源码依据：[LLM seam](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/llm/llm/src/index.ts)、[压缩事件类型](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/compaction/compaction/src/types.ts)。事件存在不代表本项目采集已通过验收。

## 2. 最小存储合同

使用 Git 外的本地 `evolution-private/`：小型 JSON manifest 加每次调用的 JSONL 记录，不另建数据库。文件权限限制为当前用户；沿用任务删除规则，不把敏感材料永久提交 Git。可用原日志稳定引用时复用；已授权的关键输入按需快照，属于最小证据副本，不复制全部对话库。

每次捕获 manifest 的必填字段：

```text
schemaVersion: 1
captureId, taskId, sessionId, runId, callId
boundaryKind, capturedAtUtc, recorderVersion
source: { harnessSha, logGeneration, eventSeqs }
versions: { model, provider, configHash, activeArtifactsHash }
input: { file, sha256, bytes, fidelity }
output: { file, sha256, bytes } | null
status: complete | incomplete | unsupported
missingFields: []
redaction: { policyVersion, removedFields }
```

experimentId、candidateId、trialId、compactionId 在有关时必填；无法关联则显式 null 并记缺口，不猜身份。输入 fidelity 为 `boundary_exact`、`seam_only` 或 `redacted`。只有 `boundary_exact` 且所有依赖已捕获的输入，才可声明相同边界输入对照。明确只比较脱敏问题时，可让两版使用同一脱敏输入，但结论限于该派生问题。

捕获器在委托执行前复制输入的数据值，按固定 JSON 编码规则序列化：UTF-8，对象键排序、数组顺序保留，不改字符串内容；非有限数字、函数等不静默丢弃，按字段规则排除或标不可捕获。凭据、认证头、AbortSignal/运行时句柄不入正文。外部文件/图片只有路径或 URL 不代表内容已保存；须有授权内容副本及摘要，否则记 missing dependency。

对实际保存的字节计算 SHA-256、记录长度。哈希只能检出内容变化，不能证明业务正确或抵御同权限恶意修改。模型只能读取脱敏证据副本，不能修改捕获和账本目录；同宿主权限不是安全隔离，仍须承认该限制。

先写 input，再顺序追加输出，完成后原子发布 complete manifest。崩溃、取消、磁盘失败或捕获限额触发，保留 incomplete/失败记录，不截断后称完整。普通工作不因观测失败而阻塞；实验执行缺必需证据则停止比较。重启扫描未完成记录并与持久日志核对；无从恢复的内容标未知。

不要求输出确定。要求确定的是“当时捕获了哪些实际输入、来源和字节”，模型事后总结只能放 analysis 材料，不能回填 input。

## 3. 最小试用规则

默认从明确启用时刻起，**最多纳入 5 个符合条件的实际任务，或经过 7×24 小时，先到为准**。第五个任务纳入后不再接新任务，等待已纳入任务结算；达到 7 天即生成截止复盘，未完成者标 pending，不能为了凑成功推迟结论。已运行任务保持版本绑定并遵守自身时限；技术故障按既定暂停/恢复规则处理。

- 开始前冻结适用条件、任务归并办法、候选版本、期限、目标、负面指标与预算。
- “三个任务”是发现重复机会的证据要求，不是又等三个任务才能开启已批准试用，也不是统计显著性保证。
- 按自然到达次序纳入符合条件的任务；重试不重复计数，失败、中断和候选实际未触发的任务都不能消失。每项记录 eligible、enrolled、exposed、outcome（含 unknown/pending）和原因。
- 到期记录符合条件数、纳入数、实际暴露数、已结算数及缺失项。零暴露或结论矛盾就是证据不足；5 个任务也不自动等于有效。
- 一次只试一个改动，到期停止新纳入，由人保留、恢复或显式续期；默认新任务用旧版，续期另记期限和理由，不静默重新计时。
- 判断依据在候选前固定；任务数和天数是默认复盘节奏，可在启动前有理由地调整并留痕，不在看到结果后改门槛。

## 4. 成本账本

同一 Git 外目录保存 `costs.jsonl`，追加 start/finish/reconcile 记录，用唯一 operationId/callId 去重关联；不可把每次流 usage 都直接相加。具体 provider 的累计/增量用量语义由适配器测试固定，原记录保留，修正追加新记录。

```text
schemaVersion, eventId, operationId, parentOperationId
experimentId, candidateId, trialId, taskId, stage, attempt
provider, model, providerRequestId
startedAtUtc, finishedAtUtc, durationMs, status
usage: { inputTokens, outputTokens, cachedInputTokens, reasoningTokens }
usageSource: provider | estimate | unknown
money: { amount, currency, priceVersion, source } | null
failureReason, supersedesEventId
```

阶段至少区分 discovery、validation-plan、generation、offline-check、trial-observation、review；模型判断和检查模型的调用都计费，失败/取消/重试不能漏掉。非模型步骤 token 不适用，时长仍记录；模型未返回 usage 用 null/unknown，不写 0。缓存和推理 token 可能是输入/输出子集，不重复相加；费用换算明确价格版本、币种和估算/账单来源。

分别统计：进化额外成本（分析、生成、测试、复盘）、真实任务运行成本、已有基线评估成本；共享准备费用归实验，不把每个候选各算一次。并发时各调用时长和不等于实验墙钟时长，两者分开。报告全部尝试总成本及缺失用量，不只报成功版本；任务成本变化也不自动归因于候选。

调用前记录开始与预算预留，结束结算；未知用量时按预先定义的保守上限预留，不释放成零。无法设定可信调用上限时不继续自动调用，等待核对。取消请求不能保证提供方立即停止计费，因此硬闸门保证不再调度/发出取消，报告仍可能到达的账单用量，不承诺精确零超支。

## 5. 实施验收

1. 固定输入穿过捕获器与测试 adapter，字节/结构一致；原对象后续修改不改变快照；捕获不增减调用，不改变输出。
2. 多条交错请求、压缩和重试正确关联；不能关联的明确拒绝当配对证据。摘要策略输入与选取策略输入不能混用。
3. 模拟崩溃、磁盘失败、超限、缺外部依赖和脱敏，均不得生成虚假的完整证据；正文和成本记录可按任务删除。
4. 模拟重复 usage、流中断、取消及费用未知，验证去重、未知标记、重试计入和预算不被重置。
5. 用可控时钟验证第五个任务与第七天截止、跨会话重试去重、pending/零暴露复盘和显式续期。不同任务结果不被挑选丢弃。

这些验证属于首次真实候选对照之前的必要小探针，不要求先建通用捕获框架。
