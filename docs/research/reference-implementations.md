# Harness Evolution 公开实现源码核查

更新时间：2026-08-17

## 研究范围与方法

本文只核查三个公开实现，不复述论文综述：

- Self-Harness：`qzzqzzb/Self-Harness`，固定提交 [`2720dbb3f52283684f4b85a1065d642df1779dd8`](https://github.com/qzzqzzb/Self-Harness/tree/2720dbb3f52283684f4b85a1065d642df1779dd8)。
- AdaptiveHarness：`A-EVO-Lab/AdaptiveHarness`，固定提交 [`c1ea7d60c009519f5c037f7db9d47e97063bb353`](https://github.com/A-EVO-Lab/AdaptiveHarness/tree/c1ea7d60c009519f5c037f7db9d47e97063bb353)。
- Prime Agent：`PrimeIntellect-ai/prime-agent`，固定提交 [`2c34b82f86dd6e4110607eb83a210ab13dff2aa3`](https://github.com/PrimeIntellect-ai/prime-agent/tree/2c34b82f86dd6e4110607eb83a210ab13dff2aa3)。

论文只用来界定作者宣称的系统范围；实现判断以固定提交的源码、配置和调用关系为准。三篇论文分别宣称：Self-Harness 是 weakness mining → proposal → regression validation 的三段闭环；Adaptive Auto-Harness 用有状态多 Agent evolver、harness tree 和 solve-time routing 处理开放任务流；Continual Harness 在单次不重置的运行中交替 acting/refining prompt、sub-agent、skill、memory（[Self-Harness abstract](https://arxiv.org/abs/2606.09498)，[Adaptive Auto-Harness abstract](https://arxiv.org/abs/2606.01770)，[Continual Harness abstract](https://arxiv.org/abs/2605.09998)）。

## 一页结论

| 实现 | 真正闭环对象 | 经验输入 | 修改方式 | 验证强度 | 持久化/回滚 | 对 prototype 的价值 |
|---|---|---|---|---|---|---|
| Self-Harness | 一组明确的 harness surface / virtual hook | 失败 trace、verifier evidence、通过案例 | 每个候选只改一个 hook，物化到独立目录 | 三者中最强：baseline/candidate、train/heldout、重复运行、明确 promotion rule | JSON branch state + candidate artifacts；不覆盖父版本，但无通用 Git rollback API | 直接借它的候选合同、独立物化、promotion gate |
| AdaptiveHarness | prompt、skill、memory、tool、infra，另可演化 Git strategy branch | observation JSONL、trajectory、feedback、历史版本 | Evolver LLM 在 Docker bind mount 中直接编辑 workspace | 默认路径弱；structured 模式有 LLM verifier + rollback，但不是 benchmark regression gate | Git commit/tag/worktree/branch + JSONL；rollback primitive 完整 | 借 FS contract、append-only experience、受限写层、Git checkpoint；别照搬大编排器 |
| Prime Agent | session/global supplemental prompt、memory、skill reference、subagent spec | 当前会话尾部、已有 harness overview、refinement history、显式/自动触发 | LLM 输出结构化 CRUD edits；原子写 JSON | schema/冲突校验强，但没有任务回放或 outcome acceptance gate | local/global JSON + session/global history；逐 edit before/after rollback | 借最小 entry schema、scope、原子写、乐观并发、可逆 edit event |

最值得组合的不是任何一个完整框架，而是：**Prime Agent 式小而可逆的经验条目与 mutation event + Self-Harness 式候选隔离和回归 promotion + AdaptiveHarness 式 append-only observation 与 Git checkpoint**。

---

## 1. Self-Harness

### 1.1 真实数据流

公开 workflow 的真实主链是：

1. 第一次运行注册一组 `name=path` editable surfaces，创建 baseline branch state，并跑 baseline eval；后续从 `branch_state.json` 恢复 active branch。[`load_or_init_branch_state`](https://github.com/qzzqzzb/Self-Harness/blob/2720dbb3f52283684f4b85a1065d642df1779dd8/workflow/scripts/run_self_harness_loop.py#L184-L214)
2. diagnosis 不是 workflow 内部自动完成：它要么接收现成 diagnosis 文件，要么执行用户传入的 `--diagnosis-command`；proposer response 同样要么现成、要么由 `--proposer-command` 外部生成。[workflow `main`](https://github.com/qzzqzzb/Self-Harness/blob/2720dbb3f52283684f4b85a1065d642df1779dd8/workflow/scripts/run_self_harness_loop.py#L96-L137) [`resolve_diagnosis`](https://github.com/qzzqzzb/Self-Harness/blob/2720dbb3f52283684f4b85a1065d642df1779dd8/workflow/scripts/run_self_harness_loop.py#L277-L355)
3. 源码库提供了 diagnosis primitive：只对失败 trace 工作，把 message/tool call 归一化为 steps/stages，再将 task、failure、terminal verifier evidence 一起交给显式传入的 LLM，输出 `terminal_cause / criticality / agent_mechanism` 等字段。[`build_causal_trace_diagnosis`](https://github.com/qzzqzzb/Self-Harness/blob/2720dbb3f52283684f4b85a1065d642df1779dd8/diagnosis/src/self_harness_diagnosis/trace.py#L100-L163) [`_run_llm_analysis`](https://github.com/qzzqzzb/Self-Harness/blob/2720dbb3f52283684f4b85a1065d642df1779dd8/diagnosis/src/self_harness_diagnosis/trace.py#L278-L355)
4. 跨案例聚类不是 embedding/向量聚类，而是对三个离散 LLM 字段做精确分组，再按 criticality 和 cluster size 排序；通过案例被保留为回归保护集。[`build_verifier_causal_clusters`](https://github.com/qzzqzzb/Self-Harness/blob/2720dbb3f52283684f4b85a1065d642df1779dd8/diagnosis/src/self_harness_diagnosis/integrated.py#L41-L62) [`render_verifier_causal_brief`](https://github.com/qzzqzzb/Self-Harness/blob/2720dbb3f52283684f4b85a1065d642df1779dd8/diagnosis/src/self_harness_diagnosis/integrated.py#L65-L104)
5. proposer 每个 slot 产一个严格 JSON proposal；候选必须选择一个 failure cluster、一个 mechanism family、一个 exact hook，并且只允许一个 `candidate_values` key。没有可靠改进时可以 `decline`。[`build_multi_proposer_prompt`](https://github.com/qzzqzzb/Self-Harness/blob/2720dbb3f52283684f4b85a1065d642df1779dd8/proposer/src/self_harness_proposer/multi_proposer.py#L65-L164) [`_validate_mechanism_contract`](https://github.com/qzzqzzb/Self-Harness/blob/2720dbb3f52283684f4b85a1065d642df1779dd8/proposer/src/self_harness_proposer/multi_proposer.py#L298-L315)
6. virtual hook 被受控翻译为现有 Python surface 的函数体/返回值变化。公开 hook family 包括 prompt instruction、subagent、skill procedure、tool configuration、middleware、runtime control、permission/interrupt。[hook registry](https://github.com/qzzqzzb/Self-Harness/blob/2720dbb3f52283684f4b85a1065d642df1779dd8/proposer/src/self_harness_proposer/hooks.py#L9-L68) [`apply_candidate_values`](https://github.com/qzzqzzb/Self-Harness/blob/2720dbb3f52283684f4b85a1065d642df1779dd8/proposer/src/self_harness_proposer/hooks.py#L81-L105)
7. 每个 proposal 物化到独立 candidate directory，包含 `current/` surface 文件、`proposal.json/md`、`candidate_variant.json`、`proposal_bundle.json`、`manifest.json`；路径禁止绝对路径和 `..`。[`materialize_candidate`](https://github.com/qzzqzzb/Self-Harness/blob/2720dbb3f52283684f4b85a1065d642df1779dd8/proposer/src/self_harness_proposer/materialize.py#L84-L154)
8. candidate directory 通过环境变量注入 eval；wrapper 临时把 candidate surface 放到 `sys.path` 首位，构建 candidate agent，任务内工具执行由 Harbor environment backend 承担。[`run_candidate_eval`](https://github.com/qzzqzzb/Self-Harness/blob/2720dbb3f52283684f4b85a1065d642df1779dd8/workflow/scripts/run_self_harness_loop.py#L1075-L1095) [`_candidate_import_context`](https://github.com/qzzqzzb/Self-Harness/blob/2720dbb3f52283684f4b85a1065d642df1779dd8/eval/harness_workspace/self_harness_harbor/harbor_wrapper.py#L32-L63) [`FixedHarnessWrapper.run`](https://github.com/qzzqzzb/Self-Harness/blob/2720dbb3f52283684f4b85a1065d642df1779dd8/eval/harness_workspace/self_harness_harbor/harbor_wrapper.py#L283-L297)
9. eval 对每个 split/repeat/case 跑 Harbor pytest，保存 command、stdout、stderr、JUnit 和 trace metadata，再汇总 pass rate。[`run_repeat`](https://github.com/qzzqzzb/Self-Harness/blob/2720dbb3f52283684f4b85a1065d642df1779dd8/eval/scripts/run_harbor_eval.py#L181-L221) [`run_case`](https://github.com/qzzqzzb/Self-Harness/blob/2720dbb3f52283684f4b85a1065d642df1779dd8/eval/scripts/run_harbor_eval.py#L224-L304)
10. acceptance gate 默认要求 train/heldout 各恰好两次 repeat；candidate 与 parent baseline 分母必须相同；只有“无 split 下降且至少一 split 上升”才接受。[`run_acceptance_gate`](https://github.com/qzzqzzb/Self-Harness/blob/2720dbb3f52283684f4b85a1065d642df1779dd8/acceptance/scripts/run_acceptance_gate.py#L77-L115) [`compare_split`](https://github.com/qzzqzzb/Self-Harness/blob/2720dbb3f52283684f4b85a1065d642df1779dd8/acceptance/scripts/run_acceptance_gate.py#L118-L145)
11. accepted candidate 不原地覆盖 parent：它生成 child branch entry，并把 active pointer 切到 child；parent 标为 superseded。多候选同时通过时还会按顶层 Python function 合并，再对合并结果重新 eval/gate。[`process_pending_candidates`](https://github.com/qzzqzzb/Self-Harness/blob/2720dbb3f52283684f4b85a1065d642df1779dd8/workflow/scripts/run_self_harness_loop.py#L437-L497) [`finalize_merge_groups`](https://github.com/qzzqzzb/Self-Harness/blob/2720dbb3f52283684f4b85a1065d642df1779dd8/workflow/scripts/run_self_harness_loop.py#L500-L593) [`create_branch_from_surfaces`](https://github.com/qzzqzzb/Self-Harness/blob/2720dbb3f52283684f4b85a1065d642df1779dd8/workflow/scripts/run_self_harness_loop.py#L980-L1016)

### 1.2 核心数据对象

- `DiagnosisOutcome` + per-trace diagnosis JSON：task outcome、归一化 steps/stages、verifier evidence、LLM causal fields。
- `ProposalBundle`：proposal rationale、chosen cluster/surface/mechanism、完整 candidate surface values。[`ProposalBundle`](https://github.com/qzzqzzb/Self-Harness/blob/2720dbb3f52283684f4b85a1065d642df1779dd8/proposer/src/self_harness_proposer/multi_proposer.py#L32-L49)
- `CandidateManifest`：candidate id、changed surfaces、surface file map。[`CandidateManifest`](https://github.com/qzzqzzb/Self-Harness/blob/2720dbb3f52283684f4b85a1065d642df1779dd8/proposer/src/self_harness_proposer/materialize.py#L22-L39)
- `candidate_queue.json`：`pending_eval → accepted_pending_merge/rejected → accepted/...` 状态机，并记录 parent baseline/surfaces、eval/acceptance artifact path。[`enqueue_candidates`](https://github.com/qzzqzzb/Self-Harness/blob/2720dbb3f52283684f4b85a1065d642df1779dd8/workflow/scripts/run_self_harness_loop.py#L387-L434)
- `branch_state.json`：active branch、parent、depth、eval/proposer surfaces、baseline result、accepted candidate。

### 1.3 验证、持久化、沙箱与回滚

**验证。** 这是三个实现中唯一把 baseline/candidate、held-in/held-out、重复运行、promotion rule 真正串进默认公开 workflow 的实现。gate 很小，但性质正确：相对 parent regression，而非绝对阈值；通过案例显式作为 regression tests。

**持久化。** 所有诊断、proposal、candidate、eval、acceptance、queue、branch state 都是普通文件，天然可检查和重放。没有数据库、向量库或服务依赖。

**版本/回滚。** 版本是逻辑 branch DAG，不是 Git。父 surface 从不被 candidate 覆盖，所以“拒绝”只是保留 artifact、不移动 active pointer；这是隔离，不是完整 rollback API。源码未提供 active pointer 回切命令、垃圾回收、跨进程锁或原子 rename。

**沙箱。** Agent 的任务命令在 Harbor environment 中执行，backend 有命令 timeout；但 proposer/diagnoser/workflow 本身运行在宿主 Python 进程。candidate 是 Python import-path 隔离，不是对恶意 candidate code 的进程级安全隔离。[`HarborSandbox.aexecute`](https://github.com/qzzqzzb/Self-Harness/blob/2720dbb3f52283684f4b85a1065d642df1779dd8/eval/harness_workspace/self_harness_harbor/backend_bridge.py#L45-L92)

### 1.4 依赖与可复用思想

主要运行依赖是 Python、Deep Agents/LangGraph 风格 agent、Harbor、pytest/uv，以及调用方注入的 LLM client。值得直接复用：

- `experience cluster → one mechanism family → one exact hook → one candidate` 的窄 mutation contract。
- candidate 全量物化而不是直接改 active runtime。
- parent-relative evaluation，promotion 后才移动 active pointer。
- passing cases 进入 regression pool；失败原因以 terminal evidence 为最高优先级。
- merge 后必须重新验证，不把“各自通过”误当作“组合通过”。

### 1.5 论文宣称与公开代码边界

论文宣称在 Terminal-Bench 2.0、SWE-bench Verified、AppWorld、三个模型的九个组合上均提升。当前公开仓库的 eval adapter、diagnosis evidence 和最终 harness 明显围绕 TB2/Harbor；没有 SWE-bench/AppWorld adapter 或九组实验配置。更重要的是，public workflow 没有内置从 baseline eval artifacts 自动调用 trace diagnosis，也没有内置 proposer provider：必须传现成文件或外部 command。也就是说，**关键算法 primitive 和 promotion loop 已公开，但论文实验的一键端到端复现链没有公开完整**。

---

## 2. AdaptiveHarness

### 2.1 真实数据流：核心 loop

通用 `EvolutionLoop` 的实际链条是：

1. 从 train split 取 batch，逐任务 `agent.solve → benchmark.evaluate`，组装 `Observation(task, trajectory, feedback)`；异常只记日志并跳过。
2. `Observer.collect` 把 observation 写入 JSONL 和 per-task trajectory/patch artifact。
3. Git 记录 pre-evo checkpoint。
4. `engine.step(workspace, observations, history, trial)` 可以任意修改 filesystem workspace。
5. 不论是否 mutation 都做 post-evo commit/tag，记录 cycle，reload agent。
6. score curve 只用于 convergence check；`step_result.mutated` 被当作 `accepted` 回调参数，不代表通过性能 gate。[`EvolutionLoop.run`](https://github.com/A-EVO-Lab/AdaptiveHarness/blob/c1ea7d60c009519f5c037f7db9d47e97063bb353/agent_evolve/engine/loop.py#L68-L183)

默认 `Evolver` 使用 `AEvolveEngine`，而不是 navigation/structured 多 Agent模式。[`Evolver._default_engine`](https://github.com/A-EVO-Lab/AdaptiveHarness/blob/c1ea7d60c009519f5c037f7db9d47e97063bb353/agent_evolve/api.py#L74-L112)

默认 `AEvolveEngine.step` 只读取最近两批 observation，快照 prompt/skills/memory/tools/infra，构造 evolver prompt，让 LLM 通过 bash 直接编辑 workspace，然后按文件差异报告 `mutated`；它收到 `TrialRunner` 但完全没有调用它，也没有比较 mutation 前后 score。[`AEvolveEngine.step`](https://github.com/A-EVO-Lab/AdaptiveHarness/blob/c1ea7d60c009519f5c037f7db9d47e97063bb353/agent_evolve/algorithms/navigation/_evolver_engine.py#L47-L132)

### 2.2 Workspace contract 与经验持久化

`AgentWorkspace` 把可修改面规范为：

- `prompts/system.md` 与 prompt fragments；
- `skills/<name>/SKILL.md`；
- `tools/registry.yaml` + `tools/<name>.py`；
- `memory/*.jsonl`；
- `infra/`；
- 可选 `harness.py`。[`AgentWorkspace`](https://github.com/A-EVO-Lab/AdaptiveHarness/blob/c1ea7d60c009519f5c037f7db9d47e97063bb353/agent_evolve/contract/workspace.py#L37-L181)

manifest 进一步声明 `evolvable_layers` 和 hot/cold reload，但真正阻止 disabled layer 被修改的是 `workspace.protect()`：调用前复制目录，调用后恢复。它是事后恢复，不是 filesystem permission boundary。[`Manifest`](https://github.com/A-EVO-Lab/AdaptiveHarness/blob/c1ea7d60c009519f5c037f7db9d47e97063bb353/agent_evolve/contract/manifest.py#L14-L55) [`AgentWorkspace.protect`](https://github.com/A-EVO-Lab/AdaptiveHarness/blob/c1ea7d60c009519f5c037f7db9d47e97063bb353/agent_evolve/contract/workspace.py#L188-L221)

Observer 的记录同时保留 flat 与 nested schema：task input/metadata、agent output、steps、conversation、feedback/claims。它还能用 `trajectory_only` 隐藏 ground truth，或用 resolution timestamp 延迟 reveal；未 reveal 时只删 label fields，behavior trace 仍可见。[`Observer.collect`](https://github.com/A-EVO-Lab/AdaptiveHarness/blob/c1ea7d60c009519f5c037f7db9d47e97063bb353/agent_evolve/engine/observer.py#L193-L320) [`filter_batch_for_evolver`](https://github.com/A-EVO-Lab/AdaptiveHarness/blob/c1ea7d60c009519f5c037f7db9d47e97063bb353/agent_evolve/engine/observer.py#L322-L367)

经验是 append-only JSONL，而 `EvolutionHistory` 只是 observation 与 Git version 的查询 facade。注意 cycle records 本身只在进程内 list 中；另一个 `evolution/history.jsonl` 只写 cycle/score/mutated/timestamp 等简表，不足以完整恢复 core `EvolutionHistory` 对象。[`EvolutionHistory`](https://github.com/A-EVO-Lab/AdaptiveHarness/blob/c1ea7d60c009519f5c037f7db9d47e97063bb353/agent_evolve/engine/history.py#L20-L89) [`EvolutionLoop._append_history`](https://github.com/A-EVO-Lab/AdaptiveHarness/blob/c1ea7d60c009519f5c037f7db9d47e97063bb353/agent_evolve/engine/loop.py#L187-L208)

### 2.3 修改、routing 与 structured evolver

**默认 mutation。** LLM 获得 `workspace_bash`，直接读写 bind-mounted workspace。变更对象可以是 prompt、skill、memory、tool、infra；检测粒度主要是内容/hash/entry count，不是结构化 edit contract。[`_run_llm`](https://github.com/A-EVO-Lab/AdaptiveHarness/blob/c1ea7d60c009519f5c037f7db9d47e97063bb353/agent_evolve/algorithms/navigation/_evolver_engine.py#L244-L321)

**Navigation。** Git branch 代表 specialized harness。solve-time router 读取 branch README，LLM 返回 `{branch, confidence}`，低于阈值或 branch 不存在就回退 main。[`NavigationEngine.navigate`](https://github.com/A-EVO-Lab/AdaptiveHarness/blob/c1ea7d60c009519f5c037f7db9d47e97063bb353/agent_evolve/algorithms/navigation/engine.py#L138-L201) [`_read_branch_leaves`](https://github.com/A-EVO-Lab/AdaptiveHarness/blob/c1ea7d60c009519f5c037f7db9d47e97063bb353/agent_evolve/algorithms/navigation/engine.py#L301-L344)

inline navigation template 给 evolver 完整 Git/bash 能力，让它自行改 main、创建 branch、提交；框架事后发现新增 branch 并注册到 strategy tree。它不会为每个 branch 做 benchmark gate。[`InlineTemplate.execute`](https://github.com/A-EVO-Lab/AdaptiveHarness/blob/c1ea7d60c009519f5c037f7db9d47e97063bb353/agent_evolve/algorithms/navigation/templates/inline.py#L194-L276)

**Structured mode。** 更复杂的 template 将流程拆为 analyst/research/builder/verifier，并保存 task board、research log、architecture、insight 等 evolver workspace artifact。build 前打 Git tag，失败后 rollback，最多重试数次。[structured build/verify loop](https://github.com/A-EVO-Lab/AdaptiveHarness/blob/c1ea7d60c009519f5c037f7db9d47e97063bb353/agent_evolve/algorithms/navigation/templates/structured_evolution.py#L743-L859)

### 2.4 验证、版本、回滚与沙箱

**验证边界。** 仓库有 `GatingStrategy`，可以跑 holdout task 并以绝对平均分阈值接受，但全仓库没有调用它；空 holdout 会自动接受。[`GatingStrategy`](https://github.com/A-EVO-Lab/AdaptiveHarness/blob/c1ea7d60c009519f5c037f7db9d47e97063bb353/agent_evolve/algorithms/aevolve/gating.py#L20-L68)

structured verifier 也不跑 benchmark delta：它再调用一个 LLM agent，根据输出首行或是否包含 `VERDICT: PASS` 判定；因此更接近 tool smoke test/self-critique，不是独立 regression evaluation。[`structured_evolution._verify`](https://github.com/A-EVO-Lab/AdaptiveHarness/blob/c1ea7d60c009519f5c037f7db9d47e97063bb353/agent_evolve/algorithms/navigation/templates/structured_evolution.py#L861-L891) navigation 版本甚至把 `VERDICT: PARTIAL` 也视为 passed。[`structured_navigation._verify`](https://github.com/A-EVO-Lab/AdaptiveHarness/blob/c1ea7d60c009519f5c037f7db9d47e97063bb353/agent_evolve/algorithms/navigation/templates/structured_navigation.py#L801-L857)

**版本/回滚。** `VersionControl` 提供 init、commit/tag、rollback-as-new-commit、worktree、branch、merge/rebase/sync 等完整 primitive。rollback 会恢复目标 ref 的 tracked files、删除目标 ref 不存在的新增 tracked files，再产生一个 rollback commit，因此 rejected state 仍留在历史中。[`VersionControl.rollback`](https://github.com/A-EVO-Lab/AdaptiveHarness/blob/c1ea7d60c009519f5c037f7db9d47e97063bb353/agent_evolve/engine/versioning.py#L89-L125) [`checkout_copy`](https://github.com/A-EVO-Lab/AdaptiveHarness/blob/c1ea7d60c009519f5c037f7db9d47e97063bb353/agent_evolve/engine/versioning.py#L157-L175)

**沙箱。** evolver bash 必须经 Docker；没有 Docker 就报错，没有 insecure fallback。默认 `--network none`，只 bind mount solver/evolver workspace，trajectory 只读；ground-truth archive 被 `/dev/null` 遮蔽。命令有 60 秒 timeout、100 KB output cap。[`EvolverSandbox.start`](https://github.com/A-EVO-Lab/AdaptiveHarness/blob/c1ea7d60c009519f5c037f7db9d47e97063bb353/agent_evolve/algorithms/navigation/_evolver_tools.py#L132-L236) [`EvolverSandbox.exec`](https://github.com/A-EVO-Lab/AdaptiveHarness/blob/c1ea7d60c009519f5c037f7db9d47e97063bb353/agent_evolve/algorithms/navigation/_evolver_tools.py#L238-L257) [`make_workspace_bash`](https://github.com/A-EVO-Lab/AdaptiveHarness/blob/c1ea7d60c009519f5c037f7db9d47e97063bb353/agent_evolve/algorithms/navigation/_evolver_tools.py#L281-L319)

但 bind mount 对 solver workspace 是可写的；网络隔离和目录边界不能阻止 evolver 破坏该 workspace 内的数据。因此必须配 Git checkpoint 或 candidate worktree，不能把 Docker 本身当 rollback。

### 2.5 依赖与可复用思想

核心包只声明 Python 3.11+、PyYAML、matplotlib；LLM、benchmark 和 agent adapter 通过 optional extras 引入 OpenAI、Bedrock、datasets、Strands、MCP、SWE-bench、GEPA 等。Docker 是 evolution execution 的实际外部依赖。[`pyproject.toml`](https://github.com/A-EVO-Lab/AdaptiveHarness/blob/c1ea7d60c009519f5c037f7db9d47e97063bb353/pyproject.toml#L1-L51)

值得复用：

- filesystem contract：把 evolution surface 变成可审查 artifact，而不是藏在对象图里。
- observation JSONL 与 per-task artifact 分离；label reveal policy 独立于 trajectory retention。
- evolver 只能写声明开启的 layer；pre/post Git checkpoint；rollback 保留历史。
- `TrialRunner` 是合适的验证接口形状，虽然默认实现没真正使用。
- 需要多 regime 时，Git branch + conservative router 是一种可实验的二阶段扩展，但不该进入第一版。

### 2.6 论文宣称与代码实际边界

论文的“stateful multi-agent evolver + harness tree + solve-time routing”在代码中确实存在，且 FutureX、CTF、PolyBench adapter/实验配置也公开。边界有四点：

1. pip/API 默认入口不是论文最复杂系统，而是单 LLM、最近两批历史、无 gate 的 `AEvolveEngine`。
2. 最强 structured mode 的 verification 是 LLM verdict，不是 baseline/heldout 回归；PolyBench structured 配置还明确 `holdout_ratio: 0.0`。[example config](https://github.com/A-EVO-Lab/AdaptiveHarness/blob/c1ea7d60c009519f5c037f7db9d47e97063bb353/experiments/polybench/configs/structured_evolution_evo.yaml#L1-L21)
3. `GatingStrategy` 和 `TrialRunner` 是未接入默认 evolution path 的 building blocks；“有验证模块”不能等同“mutation 已受 gate 保护”。
4. task board、research agents、architecture log、strategy tree、branch heuristics 形成近万行 navigation/template 代码；这些服务论文全系统，不是证明长期经验能否产生有效 runtime improvement 的最小必要条件。

---

## 3. Prime Agent

### 3.1 真实实现不是“改 Runtime”，而是 continual harness supplemental state

Prime Agent 的 mutable object 只有四类：`prompt | memory | skill | subagent`。每条 entry 有 stable id、title/content/path、scope、reference/arguments/metadata、source、timestamps、单调 version；refinement event 记录 trigger、changes、evidence、expected outcome。[TS state schema](https://github.com/PrimeIntellect-ai/prime-agent/blob/2c34b82f86dd6e4110607eb83a210ab13dff2aa3/packages/coding-agent/src/core/refinement/refinement.ts#L30-L102) Python RLM kernel 共享同一概念模型。[Python `HarnessEntry`](https://github.com/PrimeIntellect-ai/prime-agent/blob/2c34b82f86dd6e4110607eb83a210ab13dff2aa3/prime-agent-runtime/src/rlm/harness.py#L94-L123)

它明确禁止改 base system prompt，只允许 supplemental prompt note。`skill` 也不是现场生成代码：entry 必须引用已存在的 Python import/callable/call pattern 和 arguments contract；subagent entry 是可复用 delegation spec。[refiner system prompt](https://github.com/PrimeIntellect-ai/prime-agent/blob/2c34b82f86dd6e4110607eb83a210ab13dff2aa3/packages/coding-agent/src/core/refinement/refinement.ts#L123-L173) [`validateEdit`](https://github.com/PrimeIntellect-ai/prime-agent/blob/2c34b82f86dd6e4110607eb83a210ab13dff2aa3/packages/coding-agent/src/core/refinement/refinement.ts#L664-L704)

### 3.2 真实 refinement 数据流

1. 触发源可以是用户 `/refine`、Agent 调 `refine.run()`、turn interval 或 compact checkpoint。自动路径先由单独 review LLM 判断 `shouldRefine`，拒绝 one-off noise、unsupported hypothesis、transient output。[auto-review prompt](https://github.com/PrimeIntellect-ai/prime-agent/blob/2c34b82f86dd6e4110607eb83a210ab13dff2aa3/packages/coding-agent/src/core/refinement/refinement.ts#L175-L185) [`_runApprovedRefine`](https://github.com/PrimeIntellect-ai/prime-agent/blob/2c34b82f86dd6e4110607eb83a210ab13dff2aa3/packages/coding-agent/src/core/agent-session.ts#L7601-L7644)
2. host 合并 global state 与当前 session local state，合并 global JSONL history 与 session custom-entry history。[`_loadMergedHarnessState`](https://github.com/PrimeIntellect-ai/prime-agent/blob/2c34b82f86dd6e4110607eb83a210ab13dff2aa3/packages/coding-agent/src/core/agent-session.ts#L7647-L7660)
3. planner 输入当前 harness overview、最近 refinement history、当前 conversation 尾部（最多 80k chars）、scope policy 和可选显式 instruction；输出结构化 CRUD proposal。rollback 不走 LLM，而是从历史 before/after snapshot 生成 inverse edits。[`planRefinement`](https://github.com/PrimeIntellect-ai/prime-agent/blob/2c34b82f86dd6e4110607eb83a210ab13dff2aa3/packages/coding-agent/src/core/refinement/refinement.ts#L856-L934) [`rollbackProposal`](https://github.com/PrimeIntellect-ai/prime-agent/blob/2c34b82f86dd6e4110607eb83a210ab13dff2aa3/packages/coding-agent/src/core/refinement/refinement.ts#L804-L836)
4. planning 可以与 active work 重叠，但 apply 必须等 Agent idle、event queue/compaction/branch summary 静止；并发 refine 串行化。[`AgentSession.refine`](https://github.com/PrimeIntellect-ai/prime-agent/blob/2c34b82f86dd6e4110607eb83a210ab13dff2aa3/packages/coding-agent/src/core/agent-session.ts#L7663-L7778)
5. apply 前重新读取目标 state。每个 edit 用 planning 时的 baseline entry 做乐观并发检查；若该 entry 在 planning 期间已变化，就只拒绝该 edit，避免覆盖 kernel/另一 session 的更新。[`applyRefinementProposal`](https://github.com/PrimeIntellect-ai/prime-agent/blob/2c34b82f86dd6e4110607eb83a210ab13dff2aa3/packages/coding-agent/src/core/refinement/refinement.ts#L707-L780) [`_applyRefine`](https://github.com/PrimeIntellect-ai/prime-agent/blob/2c34b82f86dd6e4110607eb83a210ab13dff2aa3/packages/coding-agent/src/core/agent-session.ts#L7862-L7934)
6. state 写入后重建 system prompt，下一 turn 立刻看到 compact continual harness menu。[`_applyRefine`](https://github.com/PrimeIntellect-ai/prime-agent/blob/2c34b82f86dd6e4110607eb83a210ab13dff2aa3/packages/coding-agent/src/core/agent-session.ts#L7924-L7955) [`buildSystemPrompt`](https://github.com/PrimeIntellect-ai/prime-agent/blob/2c34b82f86dd6e4110607eb83a210ab13dff2aa3/packages/coding-agent/src/core/system-prompt.ts#L38-L107)

### 3.3 持久化、版本与回滚

**scope。** local state 位于 session artifact directory；global state 位于 agent directory。默认 local，只有明确请求才 global。合并时 local 与 global 同 id 会用 display prefix 区分，不静默覆盖。[state paths and merge](https://github.com/PrimeIntellect-ai/prime-agent/blob/2c34b82f86dd6e4110607eb83a210ab13dff2aa3/packages/coding-agent/src/core/refinement/refinement.ts#L269-L343)

**原子写。** host 将 JSON 写到 PID/UUID temp file 后 rename 覆盖正式文件，并保留原权限；global refinements 另 append 到 `refinements.jsonl`，local result 则记录在 session JSONL custom entry。[`saveHarnessState`](https://github.com/PrimeIntellect-ai/prime-agent/blob/2c34b82f86dd6e4110607eb83a210ab13dff2aa3/packages/coding-agent/src/core/refinement/refinement.ts#L345-L378)

**版本。** 每条 entry update 后 version +1；每次 result 保存每个 edit 的 `before`/`after`。它不是 Git 或全量 state snapshot，但足够生成精确 inverse transaction。[entry apply](https://github.com/PrimeIntellect-ai/prime-agent/blob/2c34b82f86dd6e4110607eb83a210ab13dff2aa3/packages/coding-agent/src/core/refinement/refinement.ts#L760-L801)

**跨进程保护。** Python kernel 的长寿命 `HarnessState` 记录文件 mtime，host `/refine` 重写后，kernel 下一次读写前自动 reload，降低 stale snapshot 覆盖风险。[`HarnessState._sync_from_disk`](https://github.com/PrimeIntellect-ai/prime-agent/blob/2c34b82f86dd6e4110607eb83a210ab13dff2aa3/prime-agent-runtime/src/rlm/harness.py#L142-L198)

### 3.4 验证与沙箱的实际边界

Prime 的“review gate”回答的是“当前轨迹是否值得形成经验”，不是“候选是否提高任务 outcome”。真正的 apply validation 包括 JSON parsing、kind/action schema、skill reference contract、base prompt immutability、entry existence、optimistic concurrency。`expectedOutcome` 只是文本，系统不会自动回放任务或在下一个 action 后比较指标；Python helper 也只是建议“run next action then record outcome”。[`plan_refinement`](https://github.com/PrimeIntellect-ai/prime-agent/blob/2c34b82f86dd6e4110607eb83a210ab13dff2aa3/prime-agent-runtime/src/rlm/harness.py#L705-L720)

因此它具备**可审查、可撤销的在线记忆更新闭环**，但还不是**可验证并自动 promotion 的 Runtime 改进闭环**。

Prime Agent 也明确说明 worker/kernel lifecycle isolation 不是 security sandbox，model-generated Python 和 project command 以用户权限运行。[README security boundary](https://github.com/PrimeIntellect-ai/prime-agent/blob/2c34b82f86dd6e4110607eb83a210ab13dff2aa3/README.md#L63-L66)

### 3.5 依赖与可复用思想

Prime 是 Node 22/TypeScript monorepo，核心 coding-agent 依赖自己的 pi agent/ai/tui packages、ZeroMQ、TypeBox、YAML、proper-lockfile 等；RLM kernel 侧是 Python package。对 DeepSeek Harness 不应移植整套 daemon/IPython/runtime，只应偷以下局部机制：[package dependencies](https://github.com/PrimeIntellect-ai/prime-agent/blob/2c34b82f86dd6e4110607eb83a210ab13dff2aa3/packages/coding-agent/package.json#L49-L92)

- local-first / explicit-global scope，避免一个 session 的错误经验污染所有任务。
- 四类小 entry + metadata，而不是让 LLM随意改一大份总 prompt。
- refinement event 保存 trigger、evidence、expected outcome、before/after 和 applied/error。
- plan/apply 分离、apply 前重新读、per-entry optimistic concurrency。
- temp + rename 原子写，rollback 生成新 inverse event，不删除坏历史。
- system prompt 只注入 compact menu，完整 entry 按需读取，避免长期状态吞噬 context。

### 3.6 论文/产品叙事与代码边界

README 称 Prime Agent 为 self-improving RLM agent，并称 `/refine` 能基于轨迹做 evidence-backed updates、snapshot rollback。对应机制在源码中真实存在。边界是：

- Prime 实现的 Continual Harness 只覆盖 supplemental state，不修改 immutable base prompt、tool runtime、middleware、permission 或 scheduling code。
- skill refinement 只创建/更新“已安装 Python skill 的引用与调用合同”，不负责生成、打包、测试 executable skill；README 也明确说它不能替代 executable skill 的 packaging/review。[README continual harness boundary](https://github.com/PrimeIntellect-ai/prime-agent/blob/2c34b82f86dd6e4110607eb83a210ab13dff2aa3/README.md#L80-L88)
- 代码没有论文式 environment milestone evaluator、process reward 或 reset-free benchmark loop；当前 `/refine` 是产品内在线状态更新机制，而不是论文实验系统的完整复刻。

---

## 4. 对 DeepSeek Harness prototype 的最小可偷方案

### 4.1 第一版只需要五个机制

1. **Experience ledger（AdaptiveHarness 的最小子集）**
   - 每个真实 task 追加一个 JSONL record：`task_id, timestamp, trajectory_ref, component_events, tool_failures, self_reflection, user_feedback, outcome, runtime_version`。
   - 大 trajectory 单独存文件，ledger 只保留引用与摘要。
   - 不上向量数据库；第一版按 component/failure signature/filter 扫描即可。

2. **Weakness candidate（Self-Harness 的窄合同）**
   - `evidence_refs[]`
   - `failure_signature = terminal_cause / affected_component / agent_mechanism`
   - `support_count`
   - `counterexamples[]`（已有成功案例）
   - `confidence`
   - `proposed_hook`
   - 只有重复出现、能落到一个现有 Plugin/Cordis hook、且有可构造回归检查时才进入 mutation。

3. **Mutation event（Prime Agent 的可逆 transaction）**
   - `id, parent_runtime_version, component, hook, action, rationale, evidence_refs, expected_outcome`
   - `before_snapshot, after_snapshot, generated_files, validation_plan`
   - 一个候选默认只改一个 plugin/hook；多处修改等第一阶段证明不足时再开。

4. **Candidate sandbox + promotion（Self-Harness）**
   - candidate plugin 物化到独立目录/临时 Cordis scope，不直接热改 active runtime。
   - 三层 gate：静态 load/schema → targeted replay/regression → 小流量 shadow/canary。
   - promotion rule 至少是：目标 failure slice 改善、核心 regression pool 不下降、无新的 runtime/tool fatal error。
   - promotion 只移动 active manifest pointer；旧版本和 rejected artifacts 全保留。

5. **原子持久化与回滚（Prime + Adaptive）**
   - manifest/state 用 temp + rename。
   - plugin source 用 Git commit/tag。
   - rollback 创建新的 rollback event 并将 active pointer 指回已知好版本，不删历史。
   - plan/apply 分离；apply 前确认 parent version 未变化，否则 candidate stale，重新生成或重基线。

### 4.2 第一阶段刻意不做

- 不做 AdaptiveHarness 的多 Agent analyst/research/builder/verifier 编排；一个 diagnosis call + 一个 proposal call 足够验证核心假设。
- 不做 harness tree 和 per-task LLM router；先证明一个 global active runtime 能安全积累一两个 improvement。
- 不做候选 merge；每轮只 promotion 一个，避免组合效应和 merge gate。
- 不做向量库、知识图谱、自动 taxonomy；JSONL + 稳定 signature 足够。
- 不让 evolver 任意 bash 改整个仓库；只允许生成一个声明边界清晰的 plugin candidate。
- 不把 Agent self-reflection 当 ground truth；它只是 evidence channel，最终 promotion 由 replay/outcome gate 决定。
- 不照搬 Prime 的 daemon/IPython/session machinery；只移植 entry/event/scope/atomicity/rollback 语义。
- 不使用 AdaptiveHarness 的 LLM `VERDICT: PASS` 作为最终 acceptance；它最多做静态/smoke verifier，benchmark/outcome delta 才能 promotion。

### 4.3 最小实验判据

prototype 成功不等于“系统会持续自我改进”，只需证明一条可审计链：

1. 至少一个 weakness 由多次真实 trajectory/outcome 自动聚合发现，而非人工预先写死；
2. weakness 被正确路由到一个 DeepSeek Harness component/hook；
3. 生成一个隔离 candidate plugin；
4. candidate 在目标 replay slice 上改善，并通过独立 regression pool；
5. promotion 后新任务真实命中该能力；
6. 人为注入 regression 时能自动拒绝或回滚；
7. 重启后 experience、candidate、active version 和 rollback history 均可恢复。

这七项成立，就已经证明“长期经验 → Harness-level weakness → 可验证 Runtime 改进 → 持久保留”的最小闭环；branch routing、多 Agent evolver、复杂长期记忆检索都可以留到第二阶段。
