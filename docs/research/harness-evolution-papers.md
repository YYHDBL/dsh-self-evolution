# Harness Evolution 一手文献研究笔记

> 研究时点：2026-08-17（Asia/Shanghai）。本文只依据 arXiv 原文及论文指向的官方代码项目；未用新闻稿、搜索摘要或二手解读填补细节。用户列出的 8 个 arXiv 编号均可取得且与标题匹配；但 arXiv 页面均未列出已接收会议/期刊，应视为新近预印本而非已经充分独立复现的定论。

## 1. 版本与可获得性核对

| 工作 | arXiv 状态（截至 2026-08-17） | 异常/证据边界 |
|---|---|---|
| Self-Harness | [2606.09498](https://arxiv.org/abs/2606.09498)；v1 2026-06-08，v2 2026-08-12 | 可获得；本文按 v2。距研究日仅 5 天的新修订。 |
| Agentic Harness Engineering (AHE) | [2604.25850](https://arxiv.org/abs/2604.25850)；v1 2026-04-28，v4 2026-05-18 | 可获得；本文按 v4。 |
| MOSS | [2605.22794](https://arxiv.org/abs/2605.22794)；v1 2026-05-21，v2 2026-05-23 | 可获得；本文按 v2。论文只报告 4 个任务的单周期 case study。 |
| HarnessCompass | [2608.01918](https://arxiv.org/abs/2608.01918)；v1 2026-08-03 | 可获得；距研究日仅 14 天，仅 v1。 |
| TTHE | [2607.08124](https://arxiv.org/abs/2607.08124)；v1 2026-07-09 | 可获得；仅 v1。 |
| Adaptive Auto-Harness | [2606.01770](https://arxiv.org/abs/2606.01770)；v1 2026-06-01，v2 2026-06-03 | 可获得；本文按 v2。 |
| Continual Harness | [2605.09998](https://arxiv.org/abs/2605.09998)；v1 2026-05-11 | 可获得；仅 v1。实验域是 Pokémon 长程部分可观测环境。 |
| Meta-Harness | [2603.28052](https://arxiv.org/abs/2603.28052)；v1 2026-03-30 | 可获得；仅 v1。 |

链接中的 `utm_source=chatgpt.com` 只是跟踪参数，不影响 arXiv/GitHub 原文。未发现编号被占用、标题不匹配或论文尚未发布的情况。

## 2. 逐篇研读

### 2.1 Self-Harness: Harnesses That Improve Themselves

一手来源：[arXiv v2 HTML](https://arxiv.org/html/2606.09498v2)，重点见 §3.1–§3.4 与 §4.1。

- **目标/假设**：在模型权重和 evaluator 固定的前提下，让同一个目标模型改进自己的 harness，不依赖更强外部 agent；harness 改进需要是有边界、模型特定的编辑（§3.1）。
- **闭环**：`Evaluate → Weakness Mining → Parallel Harness Proposal → held-in/held-out regression → accept/reject → merge accepted edits`（Algorithm 1，§3.1）。
- **experience/signal**：每条记录包含 task、完整 trace、输出和 verifier pass/fail；仅 held-in 失败轨迹用于构造 evidence bundle，另保留成功行为作为不应被破坏的正例（§3.2–§3.3）。
- **credit assignment / localization**：失败签名 `φ(r)=(terminal verifier cause, agent behavior causal status, abstract mechanism)`，按签名精确分组，再过滤为“有证据支持且可由已宣告 editable surface 解决”的 pattern；明确允许将任务困难、随机波动和模型能力上限判为不可修（§3.2，§3.3）。
- **mutation**：同一固定模型在 proposer 角色中生成 `K` 个彼此不同、但每个尽量小的 edit bundle；每个 bundle 绑定目标 pattern、变更 surface、预期行为及回归风险，不允许无关架构重写（§3.3）。
- **validation/selection**：候选在 held-in 和 proposer 不可见的 held-out 分区上都不得退化，且至少一个分区必须改善；随机设置可重复运行后按聚合 pass count 判定。多个兼容编辑通过后合并（§3.4）。
- **memory/persistence**：harness 以 `h0, h1, ...` 形成 lineage，记录已尝试编辑、拒绝分支和审计数据；但不是从无限生产流中长期检索的 experience store。
- **在线/离线**：离线 benchmark/development-time evolution，每个任务从新鲜环境启动；不是 live deployment 内自修改（§4.1）。
- **成本/安全**：每个候选都完整重跑两个分区且默认两次尝试，成本高；但固定模型、预算、工具、环境和 evaluator，且仅允许改 harness definition file，对归因是良好控制。论文没有提供生产自修改的权限、审批和快速回滚栈。
- **对本项目最有用**：“失败签名 → 可解决性过滤 → 最小变更 → 双分区无退化门”是第一阶段 prototype 最完整且最可控的核心。
- **不能直接迁移**：固定 benchmark verifier 给了干净的 pass/fail 和 held-out gate；真实使用没有这种廉价 oracle，也不能每个 candidate 全量重放长期任务。

### 2.2 Agentic Harness Engineering: Observability-Driven Automatic Evolution of Coding-Agent Harnesses

一手来源：[arXiv v4 HTML](https://arxiv.org/html/2604.25850v4)，重点见 §3.1–§3.3、Algorithm 1、§4.4 和 Limitations。

- **目标/假设**：自动 harness engineering 的瓶颈主要是“可观测性”，而非 evolution agent 不够强；因此同时建立 component、experience 和 decision 三层 observability（§3）。
- **闭环**：`rollout → clean traces → 核验上轮 manifest/回滚 → Agent Debugger 分层蒸馏 → Evolve Agent 编辑+新 manifest → git commit/tag → best-so-far`（Algorithm 1）。
- **experience/signal**：每任务 `k≥2` 条轨迹，包括 pass/fail；原始消息按文件存储，Agent Debugger 产生 per-task 成败根因报告和 benchmark overview，同时保留 raw/clean trace 供 drill-down（§3.2）。
- **credit assignment / localization**：NexAU 把 harness 拆成 7 类文件：system prompt、tool description、tool implementation、middleware、skill、sub-agent config、long-term memory；根因先映射到单一 component class，每个编辑再由 manifest 声明“预期修复任务/可能回归任务”（§3.1，§3.3）。
- **mutation**：Evolve Agent 可增、改、删上述文件；一个 logical edit 一次 git commit。它不只修 prompt，实验中实际生成了 tool、middleware 和 long-term memory（§3.3，§4.4）。
- **validation/selection**：下一轮把 manifest 的 predicted-fix/predicted-regression 集合与任务级 delta 相交得出 verdict，无效编辑按文件回滚，最终返回 pass@1 最高的历史版本。预测修复的平均 precision/recall 为 33.7%/51.4%，但预测回归只有 11.8%/11.1%（§4.4.2）。
- **memory/persistence**：文件化轨迹库、分析报告、change manifest、git history/tag 和 best harness 共同构成可审计记忆。
- **在线/离线**：在 Terminal-Bench 2 全 89 任务上进行 10 轮离线 evolution，再冻结 harness 转移到 SWE-bench Verified/其他模型；不是生产持续流。
- **成本/安全**：每轮全基准多 rollout+分析，成本大；但 Evolve Agent 只能写 harness workspace，runs、tracer、verifier、LLM config 只读，seed prompt 不得删除，可防止关闭 verifier、换模型或偷加预算（§3.3）。作者明确说这不是完整 guardrail stack，长期清理与 misuse prevention 仍缺失（Limitations）。
- **对本项目最有用**：三层可观测性、文件级 component registry、逐级 evidence drill-down、可证伪 manifest 及 git 回滚几乎直接对应 DeepSeek Harness Plugin/Cordis 的可编辑 surface。
- **不能直接迁移**：AHE 以“一个失败 pattern 映射一个 component class”来简化归因，但其消融实验显示 component 非加性且会重复验证；真实插件/hook 因果经常跨组件。

### 2.3 MOSS: Self-Evolution through Source-Level Rewriting in Autonomous Agent Systems

一手来源：[arXiv v2 HTML](https://arxiv.org/html/2605.22794v2)，重点见 §3.1–§3.5 和 §4。官方代码：[HKGAI MOSS](https://github.com/hkgai-official/Moss)。

- **目标/假设**：prompt/skill/memory 文本修改无法到达 routing、hook order、state invariant、dispatch 等结构问题；生产 agent 需要 source-level rewrite，且必须以具体用户失败为定向目标（§1，§3.1）。
- **闭环**：`session auto-scan/用户 flag → sealed failure batch → baseline keypoint matrix → Locate → Plan ⇄ Plan-Review → Implement ⇄ Code-Review → Build → isolated Trial → Task-Evaluate → Verdict → user apply → container swap → health probe/rollback`（§3）。
- **experience/signal**：定时扫描 session JSONL，Task-Evaluate 只把 weak/missing chunk 放入 batch；用户可在对话中显式 flag。每个 batch 默认积累 8 chunks 封存，内部以每任务 4–7 个固定 keypoint 的 strong/adequate/weak/missing 矩阵跟踪改善（§3.1–§3.3）。
- **credit assignment / localization**：Locate 只做诊断不提修复，Plan 再指定 root cause、影响文件、新逻辑及不应动的部分，两道 review gate 减少错定位和过窄修复；没有形式化 component-credit estimator（§3.2–§3.3）。
- **mutation**：外部可替换 coding-agent CLI 直接修改完整 substrate source，每次 implement 一个 git commit；MOSS 自身保留确定性 stage ordering 和 verdict 权限（§2.3，§3.3）。
- **validation/selection**：用 candidate image 创建 `N` 个短命、无网络/无用户 volume mount 的 trial container，对原失败 batch 多次重放以暴露 flakiness；Verdict 可为 CONVERGED、NEED_MORE_WORK、MODEL_LIMIT 或 ARCHITECTURE_LIMIT，平台无改善时 plateau guard 停止（§3.2–§3.4）。
- **memory/persistence**：batch、计划、diff、build log、评分矩阵、git commit、candidate image 和 last-known-good image 都持久化；对话、memory、credential、agent config 在独立 user-state volume 中跨镜像保留（§2.4，§3.5）。
- **在线/离线**：线上被动积累真实使用信号；编辑和验证在 host daemon 和隔离 trial workers 中离线执行；用户同意后才上线，是最清晰的“线上经验/离线变异/受控提升”边界。
- **成本/安全**：light/standard/deep 统一调节轮数、stage round、trial/task 和 plateau；候选隔离，上线需用户同意，90 秒探测窗口每 5 秒做 4 项健康检查，连续 3 次通过才 commit，否则回滚独立 last-known-good（§3.5）。
- **对本项目最有用**：生产 evidence ingress、相同失败场景重放、候选隔离、人工提升门、健康检查和 last-known-good 回滚，是其他论文普遍缺失的 deployment mechanics。
- **不能直接迁移**：论文只在同一 4-task batch 上进化和重评，无 disjoint regression set，且单一 case study 不能证明长期无回归。全容器 swap 也比 DeepSeek Harness 的 Plugin/Cordis 热加载粗重。

### 2.4 HarnessCompass: Guiding Automatic Harness Evolution toward Generalizable and Effective Agent Harnesses

一手来源：[arXiv v1 HTML](https://arxiv.org/html/2608.01918v1)，重点见 HarnessCompass 一节中 Constrained Evolution、Proactive Feedback、Component-wise Optimization 及 Experiments/Ablation。

- **目标/假设**：现有方法的三个核心缺陷是 search-task overfitting、仅有第三人轨迹而导致误归因、以及多组件同时修改的相互干扰；进化要靠 discipline，不是单纯增大 search。
- **闭环**：`rollout → trace distillation + grounded self-feedback → structure/guidance 两条 GatedEvolve 轨道 → 分别 rollout → 选 winner → R³ 合并 loser 中的独立正增益编辑 → 只在 winner 比 baseline 好时接受`（Algorithm 1）。
- **experience/signal**：完整 trace+verifier pass/fail；对失败任务由同一 solver 做 blind report（不给 verdict）和 hindsight report（给 verdict），后者在 harness/自身 reasoning/task ambiguity/environment 四类中归因，然后对两份报告调和（Proactive Feedback）。
- **credit assignment / localization**：自评不是真值；只保留 trace 能直接支持的组件摩擦，或 trace 能显示具体 capability gap 的新能力请求。报告按 implicate 的 component 聚合，confidence 由报告一致性、跨任务支持数、blind/hindsight 一致性决定（Proactive Feedback）。
- **mutation**：先经 generalization gate：拒绝任务实例、test function、private symbol 或只在某任务中出现 token 的条件分支；capability edit 必须落在 middleware/tool/sub-agent 的可执行代码，guidance edit 必须落在 system prompt/memory。然后分 structure（middleware/tool/sub-agent）和 guidance（prompt/skill/tool description/memory）两轨修改（Constrained Evolution，Component-wise Optimization）。
- **validation/selection**：两轨分别评估，Pass@1 更高者为 winner；R³ 的 Revision 丢弃 loser 中的回归、task-specific、重复/冲突/不确定编辑，Recombination 合入 winner，Refinement 再删除功能重叠。论文用 50 任务 evolution set 和 450 任务 held-out 评估 generalization（Component-wise Optimization，Experiments）。
- **memory/persistence**：延续 AHE 风格的机器可读 change manifest，记录每个 edit 和触发它的 first-person evidence，下轮归因/回滚；论文没有定义长期生产 experience retention policy。
- **在线/离线**：SWE-bench Verified 离线 evolution，后续冻结 harness 在其他模型上转移测试；不是持续生产流。
- **成本/安全**：每个失败需多次 first-person/checker 调用，每轮两条轨道评估；但只用 5 轮达到峰值，比 AHE 的 20 轮少。generalization gate 是防过拟合约束，不等于代码权限/供应链/危险工具安全审查。
- **对本项目最有用**：用户明确要纳入 agent self-reflection；该文给出最稳健的做法：自评仅是 candidate evidence，必须双盲/事后对照，并由 trace 证据落地。“capability vs guidance”的落点规则也是简洁的 component localization policy。
- **不能直接迁移**：其 R³ 合并依然用 agent 判断“独立有益/不冲突”，并未对 merge 后的 harness 在 Algorithm 1 中再次独立 rollout 才提升；在真实 runtime 中不能把合并判断当作已验证。

### 2.5 TTHE: Test-Time Harness Evolution

一手来源：[arXiv v1 HTML](https://arxiv.org/html/2607.08124v1)，重点见 §4.1–§4.5、§5.7–§5.8 和 §6。官方代码：[TTHE](https://github.com/junnie00/TTHE)。

- **目标/假设**：在没有 gold label、hidden test、人类修复信号或额外 repair model 的测试流中，仅凭模型自身的 execution evidence 持久修改 executable harness（§4.1）。
- **闭环**：对每个 unlabeled batch，从当前 committed harness 复制 `G` 条分支，运行 `R` 轮 `Observe → parallel Propose → execute children`，然后 Judge 从最后一代选一个带到下一 batch（Algorithm 1，§4.4）。
- **experience/signal**：prompt/completion、tool calls/outputs、stdout/stderr、artifacts、runtime state、errors、probes；另有任务相关但非 oracle 的 execution health、round-trip semantic consistency 和可用时的 public-test pass rate，原轨迹和 proxy 同时暴露而不压成一个 scalar（§4.3）。
- **credit assignment / localization**：没有显式 component classifier/causal manifest；每个 proposer 自由查看其他分支的 code/trace，自行诊断失败并编辑自己的 Python harness class。论文将误差后验分为 candidate coverage gap 和 judge selection regret（§5.8）。
- **mutation**：任意 Python 程序代码，可改 context construction、tool grounding、decomposition、multi-sampling、contract checks 和 recovery branch；分支被分别引导为 conservative-repair、exploratory、adversarial 以维持多样性（§4.2，§4.4）。
- **validation/selection**：invalid/unloadable child 自动回退到 parent；Judge 查 code/trace/proxy，可追加 probe 或 re-execute，但永远不见 gold。结果显示 judge 曾在可选 4/10 时选 3/10、可选 7/10 时选 6/10；候选池 oracle 64% 对实际 50%，证明 selection regret（§5.8）。
- **memory/persistence**：每条 branch lineage 累积程序变化，每 batch 提交一个 harness 跨 batch 延续；累积设置对 BIRD 为 50% vs 每 batch reset 44%（§5.7）。未提出独立长期经验整理/遗忘策略。
- **在线/离线**：测试时、transductive 自适应：当前 batch 用于选 harness，然后仍在同 batch 上打分；gold 仅在 commit 后报告。论文自身明确说这不证明 forward generalization，应用 prequential `Ht on batch t+1 before adaptation` 补测（§6）。
- **成本/安全**：每 batch 需要 `G×R×|batch|` 级别的运行，且更大 search 非单调改善；作者用固定 resource/wall-clock budget、排除 malformed/non-terminating candidate、re-execution judge 和 restricted sandbox 降风险（§4.5）。开放世界/安全关键场景需额外 guardrails（§6）。
- **对本项目最有用**：真实 outcome 很稀疏时，可将多种 execution proxy 和 raw trace 并置，不过早合成虚假精确的总分；并应单独记录“没有生成好解”和“生成了但没选中”。
- **不能直接迁移**：用不完美 proxy 就在线提交任意代码过于激进；且 transductive 结果会高估持续改进。第一阶段应只把 proxy 用于候选排序，不作为单独提升门。

### 2.6 Adaptive Auto-Harness: Sustained Self-Improvement for Agentic System Deployment on Open-Ended Task Streams

一手来源：[arXiv v2 HTML](https://arxiv.org/html/2606.01770v2)，重点见 §3.2–§3.5、§4.4–§4.6 和 §6。官方代码：[AdaptiveHarness](https://github.com/A-EVO-Lab/AdaptiveHarness)。

- **目标/假设**：开放任务流无终点、异质且分布漂移，不断密集修改单一 harness 会早期达峰后下降。作者将对 oracle 的 gap 拆为 evolution loss（从历史构造不出所需能力）和 adaptation loss（不知当前任务却提前承诺单一 harness）（§3.2）。
- **闭环**：周期性 `Analyze → parallel Research → Build → Verify`，把 delayed outcome 按时间门暴露给 evolver，持久工作区跨周期累积；构建阶段生成 harness tree，solve time 路由到最适分支，信号缺失时触发人工指导（§3.3–§3.5）。
- **experience/signal**：按时序到达的 task trajectory 与延迟 label/outcome；temporal-reveal gate 只在事件真实解析后发放评价，防止未来泄漏。人工只补充历史不可能包含的 credential、新 source 或 proprietary endpoint，不提供答案（§3.3，§3.5）。
- **credit assignment / localization**：Analyst 把 failure analysis 排入 task board，Researchers 记录假设和 pass/fail verdict；不是细粒度 component causality，而是识别“缺失能力”与“任务路由不匹配”，再按任务 regime 分支隔离（§3.2–§3.4）。
- **mutation**：多角色 evolver 可改 prompt、skill、tool 和基础设施；在 git repo 中创建专门分支，每个分支拥有自己的 prompt/skills/tool registry（§3.3–§3.4）。
- **validation/selection**：Verify 角色与验证 tests 记录结果；solve-time router 读各分支 workspace 选路由。论文以 branch replay 构造 post-hoc Oracle/Adapt/Naive/Worst 边界，结果显示 router 只捕捉部分 specialization headroom，FutureX 上甚至 main 优于 Adapt（§4.5）。
- **memory/persistence**：跨周期 workspace 显式存 task board、已测假设及 verdict 的 research logs、README 架构文档和 verification tests；git tree 提供分支隔离、lineage 与 versioning（§3.3–§3.4）。
- **在线/离线**：按真实时序流周期性离线进化，solve time 只做轻量路由；是长期 deployment 取向，但实验仍是公开 benchmark stream。
- **成本/安全**：四角色+并行 research+branch tree+router 费用明显高于单候选闭环；作者只报告公开任务和隔离 CTF container，人工不提供答案。论文没有展示生产 plugin permission 审计、上线 canary 或自动回滚。
- **对本项目最有用**：temporal reveal、跨周期 research ledger 和“历史缺信号时才找人”极适合长期真实使用；其 evolution-loss/adaptation-loss 区分能防止把所有异质失败都堆到一个全局 plugin 里。
- **不能直接迁移**：第一阶段需要先证明“经验能变成一个安全改进”；马上引入多 agent 四阶段、树、router 和 HITL 会同时引入太多无法归因的变量。

### 2.7 Continual Harness: Online Adaptation for Self-Improving Foundation Agents

一手来源：[arXiv v1 HTML](https://arxiv.org/html/2605.09998v1)，重点见 §2.2、§3.1–§3.3、§4.4–§4.6 和 §6。

- **目标/假设**：部分可观测的超长 embodied episode 无法廉价 reset，所以 harness 应在同一运行内从局部 trajectory window 原地改进 prompt、sub-agent、skill 和 memory（§3.1）。
- **闭环**：inner loop 连续 act；外层每 `F` 步（预热 `W` 步后）由同模型 Refiner 读取最近 window，对 `Δp, Δsubagents, Δskills, Δmemory` 做四遍编辑，立即进入下一步（§3.1–§3.2）。论文另有 PRM+frontier teacher+soft-SFT 的模型训练环，与用户明确排除 RL/重训的范围不同。
- **experience/signal**：最近轨迹窗口中的 navigation loop、tool-call failure、stalled objective、missed exploration；成功序列被编译为 skill，异常触发可执行 skill repair，事实/策略进 persistent memory（§3.2）。
- **credit assignment / localization**：固定做 4 个 component pass：prompt 改写；repeated multi-step pattern 创建/修改 sub-agent，无效者删除；success sequence 生成 skill，exception 修代码；memory 填 gap/更新过期项/降低已过阶段的重要性（§3.2）。它是 heuristic localization，无反事实验证。
- **mutation**：通过固定 meta-tool API 原地 CRUD 四类 harness state，prompt 整体替换，其他组件 create/read/update/delete（§2.2，§3.1）。
- **validation/selection**：对 harness-only loop，论文未描述 candidate shadow run、held-out regression gate、版本提升或回滚；变更直接进入 live context。导航 skill 的 Dijkstra oracle 消融是后验分析，不是通用上线门（§4.6）。
- **memory/persistence**：harness memory 是持久知识库，早期 failure signature 对后续 refiner 可见；refined harness 可作为 bootstrap 继承，环境 emulator state 跨训练轮保存（§3.2，§4.6）。
- **在线/离线**：真正 mid-episode/reset-free 在线 harness 自修改；训练环亦在线但不属于本项目第一阶段。
- **成本/安全**：频繁 refiner 调用会增加 inference 成本；论文显示 capability floor：Flash-Lite 上所有 Continual Harness 变体比 minimal baseline 更差，说明弱模型不一定能利用或安全维护复杂 harness（§4.4，§6）。无隔离验证/回滚是生产应用的主要空缺。
- **对本项目最有用**：它提醒我们经验不只有 failure；重复成功序列可升格为 skill，过期 memory 要降权，深层运行后才出现的失败需要长期保留。
- **不能直接迁移**：“发现后立即原地修改”与用户所需的可验证、可回滚 Runtime 改进相冲突；Pokémon 里容错的可逆行为不能代表文件、网络、credential 和生产工具。

### 2.8 Meta-Harness: End-to-End Optimization of Model Harnesses

一手来源：[arXiv v1 HTML](https://arxiv.org/html/2603.28052v1)，重点见 §3、Algorithm 1、Appendix A 和 Appendix D。

- **目标/假设**：harness 是有状态可执行程序，一个决策可跨多任务产生延迟效应；标量分数和压缩摘要不足以做完整 harness search，应让 coding-agent proposer 按需读取所有旧 code/score/trace（§3）。
- **闭环**：`filesystem 中初始 population → Evaluate → 存 code/score/trace → proposer 自由检索全历史并提 k 个程序 → interface validation → Evaluate → 追加目录`，固定 `N` 轮后返回 Pareto frontier（Algorithm 1）。
- **experience/signal**：每个候选单独目录存 source、task-specific reward/score 及 prompts、tool calls、outputs、state updates 等 execution trace。在最大设置中，一次评估可产生 10M tokens 证据，proposer 每轮中位读 82 个文件、参考 20+ 个旧 candidate（§1，Appendix A.1）。
- **credit assignment / localization**：不设固定规则；proposer 通过跨候选 trace 对照自由构造因果假设。TerminalBench 案例中，它发现两个不同 structural fix 的共同回归因素是 shared prompt rewrite，然后隔离该 confound（Appendix A.2）；这是质性案例，不是稳定定位算法。
- **mutation**：从 retrieval/memory/prompt construction 的局部改动到 full program rewrite，无固定 parent selection；候选是单文件 Python harness，proposer 有一个最小 domain skill 说明可写/不可写文件（§3）。
- **validation/selection**：先做 interface smoke validation，再在 search set 完整评估；多目标用 Pareto dominance，例如 accuracy vs context cost；test set 只在搜索结束后评估 frontier，proposer 不见 test result（§3，Appendix D）。
- **memory/persistence**：filesystem 是全历史、非 Markov 的 experience store，保留失败与成功的候选、分数和原始轨迹；论文建议加一个小 CLI 列 frontier/top-k/diff，但不提供自动遗忘、去重或数据保留政策（§3，Appendix D）。
- **在线/离线**：搜索是离线 development-time，用 search set 生成 feedback，结束后冻结 frontier 进 test；文本分类用例虽是 online classification，但“harness evolution”本身不是线上自修改。
- **成本/安全**：典型运行约 20 轮、60 harnesses，全轨迹保留的存储/检索/模型 token 成本很高；但候选冒烟验证后才跑贵评测，且 eval 在 proposer 外执行。论文未展示用于生产 source self-modification 的 sandbox、权限 manifest、人工审批或回滚。
- **对本项目最有用**：不要只留“经验摘要”；应同时留 raw evidence、结构化索引和候选 diff/score，让 evolver 逐级 drill-down，并保留被拒绝编辑以避免重蹈失败。
- **不能直接迁移**：无限期保留所有生产 trace 会带来私密、凭证、存储和检索成本；无结构的全历史在长期运行时会退化成数据沦潭，必须先做最小事件模式、脱敏和 retention policy。

## 3. 统一比较

| 工作 | 时间边界 | 主信号 | 定位 | 变异面 | 选择/提升 | 持久化 | 最突出限制 |
|---|---|---|---|---|---|---|---|
| Self-Harness | 离线多轮 | verifier-grounded fail/pass traces | `(cause, causal status, mechanism)` + addressability | 有边界 harness definition | held-in 与 held-out 均不退化 | lineage+尝试日志 | 依赖干净 verifier/全量 regression |
| AHE | 离线多轮 | 多 rollout + debugger 分层报告 | 7 组件+自声明 fix/risk | 文件级 tool/middleware/memory 等 | 下轮验证 manifest，文件回滚 | git+manifest+raw/summary traces | 回归预测弱，不是完整安全栈 |
| MOSS | 线上收集/离线编辑/受控上线 | session scan+用户 flag+keypoints | Locate/Plan/review 定位 source | 整个 substrate source | 隔离重放+人工 apply+健康回滚 | batch/git/image/user volume | 仅 4-task 同集 case study，无 disjoint regression |
| HarnessCompass | 离线多轮 | trace+grounded first-person feedback | 四类原因+组件置信 | gated structure/guidance 两轨 | 分轨评估+R³+分数提升 | manifest+当前 lineage | R³ merge 后缺独立再验证；gate 非 security gate |
| TTHE | 测试时 transductive | raw execution+health/round-trip/public tests | 无显式 component localization | 任意 Python harness | label-free Judge 从末代分支选一 | committed code 跨 batch | proxy/judge 失配，未证 forward generalization |
| Adaptive | 时序流上周期进化 | delayed outcome+trajectory+targeted human signal | evolution loss vs adaptation loss; regime | prompt/skill/tool/infra + git branches | Verify+solve-time routing | task board/research log/tests/git tree | 系统太重，router 只捕捉部分 headroom |
| Continual | live mid-episode | 最近 window 失败+成功序列 | 4 组件 heuristic pass | prompt/sub-agent/skill/memory 原地 CRUD | harness-only loop 无隔离 gate | live harness/memory/bootstrap state | 无上线验证/回滚；弱模型反而退化 |
| Meta-Harness | 离线 search | 全历史 code+score+raw trace | proposer 自由跨候选因果假设 | 单文件完整程序 | interface check+search score+Pareto+final test | 全量 filesystem archive | 昂贵、无 retention/privacy 与 deployment governance |

## 4. 跨论文综合结论

1. **最小可信闭环不是“reflect 后改 prompt”，而是 `evidence → hypothesis → localized change → counterfactual/regression evidence → promotion`**。Self-Harness、AHE 和 HarnessCompass 都用不同方式强调这条链。
2. **原始轨迹、结构化索引和高层 pattern 要同时保留**。只留 raw trace 会淹没 evolver，只留摘要会无法审查误归因；AHE 的 progressive disclosure 与 Meta-Harness 的 full-history filesystem 在这一点上互补。
3. **Agent self-reflection 必须是待验证的信号，不是真值**。HarnessCompass 的 blind/hindsight 对照+轨迹 grounding 是当前最可直接复用的防自我合理化设计。
4. **首先要判断“这是否真的是 harness 问题”**。任务本身困难、模型能力上限、环境不稳、数据模糊和缺失凭证都不应被强制生成 plugin patch。Self-Harness 的 addressability filter、MOSS 的 MODEL/ARCHITECTURE LIMIT verdict 和 Adaptive 的“缺外部信号才找人”可合并成一个 abstain 机制。
5. **Component localization 应是显式合同，但不应假设组件效果可加**。AHE 的 7 类 component registry 便于审计；它自己的消融却显示 memory/tool/middleware/prompt 会重叠或冲突。因此候选 manifest 应声明 primary owner 和 interacting components，合并后必须再评估。
6. **评估要分层**：便宜的 interface/static/smoke check 先挡掉坏候选，原失败 replay 验证定向修复，disjoint regression 防过拟合，shadow/canary health 验证生产可用。MOSS 完成后两层，Self-Harness 完成中间两层；两者组合才完整。
7. **Outcome proxy 不得作为唯一提升标准**。TTHE 量化了 judge selection regret 和 candidate coverage gap，且搜索越多并不越好。对无 verifier 真实任务，proxy 更适合触发/排序 hypothesis，不适合直接 auto-promote。
8. **长期持久化至少包含两条 lineage**：experience lineage（轨迹、feedback、pattern、置信和 retention）与 change lineage（hypothesis、diff、评估、决策、上线版本和 last-known-good）。只存最终 plugin 无法避免重蹈失败，只存轨迹又无法闭环归因。
9. **第一阶段应采用“线上收集、离线候选、人工或严格门提升”**。这同时保留 MOSS 的生产真实性和 Self-Harness/AHE 的可归因性，避免 Continual Harness/TTHE 在 live state 上直接试错的风险。
10. **Prototype 不需要 harness tree、多角色 evolver 或全 source rewrite**。先限制到一种高频 failure family、一个明确 Plugin/Cordis surface、一个 candidate 和一套 replay+regression gate，就能检验用户的核心问题：长期经验能否变成可验证、可保留的 Runtime 改进。只当证据显示单一全局 harness 因任务异质而冲突时，再引入 Adaptive 的 branch/routing。
11. **成功 pattern 与过期经验同样重要**。Continual Harness 表明成功的重复序列可升格为 skill，memory 需降权过期内容；因此 experience miner 不应只查 failure，也要找“成功但高成本/高方差”和可复用的成功序列。
12. **安全治理与泛化约束是两件事**。HarnessCompass 的 task-agnostic gate 防硬编码，AHE 的 read-only evaluator/model config 防作弊，MOSS 的隔离/同意/健康回滚防上线事故。一个实用系统需要三者，不能用“修改看起来通用”代替权限和部署审查。

## 5. 对 DeepSeek Harness prototype 的直接启示（只作研究输入）

若只从这 8 篇文献抽取第一阶段的最小组合，应是：

1. MOSS 的线上 experience ingress（自动 outcome/tool failure+用户显式 flag）；
2. AHE/Meta-Harness 的 raw trace + 分层索引 + change manifest；
3. Self-Harness/HarnessCompass 的 addressability、grounded reflection、最小编辑和无退化门；
4. MOSS 的隔离验证、人工提升和 last-known-good 回滚；
5. TTHE 的 proxy-as-evidence 而非 proxy-as-oracle；
6. Adaptive/Continual 的 temporal reveal、success pattern 与 stale-memory demotion，先放到经验层，不在第一版引入 harness tree 或 live in-place mutation。

这一组合足以验证“真实长期经验能否变成 harness-level 改进”，且没有把第一阶段扩张成多 agent 研究组织、线上程序搜索或模型训练项目。
