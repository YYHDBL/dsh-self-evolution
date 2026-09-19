# Hermes Agent 随使用增长的 Skill / Memory 机制核查

更新时间：2026-09-19  
上游仓库：`NousResearch/hermes-agent`  
核查提交：[`7c6f21a5e12ba9b1c674ec9b410fa6b8c45de4f8`](https://github.com/NousResearch/hermes-agent/tree/7c6f21a5e12ba9b1c674ec9b410fa6b8c45de4f8)  
本地副本：`vendor/hermes-agent`

本文只关注一个问题：Hermes Agent 怎样把用户实际使用中的信息、纠正、成功路径和重复使用，沉淀成下一次会话可用的能力。

## 一页结论

Hermes 的“自进化”不是训练模型权重，也不是自动跑 benchmark 后把代码合入主分支。它是一个由持久化状态组成的增长回路：

```text
用户对话/工具执行
        ↓
会话历史 + 反馈信号 + 技能使用遥测
        ↓  回合结束后的异步 review，或显式 /learn
USER.md / MEMORY.md + curator-managed SKILL.md
        ↓  新会话加载；需要时检索历史或外部记忆
下一次任务表现更稳定
```

最值得借鉴的设计是把“增长”拆成不同容量和不同用途的层：

| 层 | 保存什么 | 何时参与推理 | 增长方式 |
|---|---|---|---|
| `USER.md` | 用户偏好、身份、表达风格、长期纠正 | 每个新会话的 system prompt | agent 写入，受大小上限和审批控制 |
| `MEMORY.md` | 环境事实、项目约定、工具坑、稳定经验 | 每个新会话的 system prompt | agent 写入，受大小上限和审批控制 |
| `SKILL.md` | 可复用的流程、工具调用、判断点、排错路径 | 按需加载，或由 slash command 调用 | `/learn`、foreground `skill_manage`、后台 review |
| Session Search | 完整历史消息 | 按需检索 | 所有 CLI / messaging session 自动进入 SQLite FTS5 |
| External Memory Provider | 用户模型、知识图谱、向量/层级知识库等 | provider 自己决定注入和检索 | 每回合同步、session end 提取、provider 工具 |
| `.usage.json` / curator | skill 的查看、使用、修补和生命周期 | 主要用于维护 | 使用后计数；定期 stale/archive/consolidate |

因此，Hermes 的核心闭环是“从使用轨迹提炼持久状态”，而不是“让模型本身越来越聪明”。README 对此称为 self-improving / closed learning loop，但源码中真正落地的是上述状态变更和加载机制。[README](https://github.com/NousResearch/hermes-agent/blob/7c6f21a5e12ba9b1c674ec9b410fa6b8c45de4f8/README.md)

## 1. 两个小而常驻的内置记忆文件

Hermes 把长期信息分成两个有硬上限的文件：

- `MEMORY.md`：约 2,200 字符，保存环境、项目、工具和稳定经验。
- `USER.md`：约 1,375 字符，保存用户身份、偏好、风格和长期要求。

它们位于 `~/.hermes/memories/`，在会话启动时注入 system prompt。当前会话中的 prompt 视图是冻结快照，避免每轮写盘导致前缀缓存失效；工具返回的则是最新持久化状态。因此，写入成功后通常要到下一次会话才会自然地进入 system prompt，当前会话要查旧信息应使用 `session_search`。[Memory 用户文档](https://github.com/NousResearch/hermes-agent/blob/7c6f21a5e12ba9b1c674ec9b410fa6b8c45de4f8/website/docs/user-guide/features/memory.md)

写入约束很明确：

- 存长期稳定、可迁移、下次还会有用的内容；跳过一次性日志、原始 dump、可从代码重新得到的信息。
- 用户偏好进入 `USER.md`；项目/环境经验进入 `MEMORY.md`。
- 不足以放下新内容时返回超限，让 agent 先合并、删减或替换，不静默截断。
- 内置 memory 只做小型 always-on context；完整对话交给 FTS5 历史检索。

实现上，`MemoryStore` 会在并发写入时重新读取磁盘、检测外部漂移、用临时文件加 rename 原子替换，并提供备份；批量操作要么全部通过预算，要么全部失败。这些约束使“增长”不会轻易变成 prompt 无限膨胀或半写入状态。[`memory_tool_store.py`](https://github.com/NousResearch/hermes-agent/blob/7c6f21a5e12ba9b1c674ec9b410fa6b8c45de4f8) · [`memory_tool.py`](https://github.com/NousResearch/hermes-agent/blob/7c6f21a5e12ba9b1c674ec9b410fa6b8c45de4f8/tools/memory_tool.py)

## 2. Skill 是“程序性记忆”，不是聊天日志

Hermes 的 skill 是目录中的 `SKILL.md`，用于保存可复用的方法：操作步骤、工具命令、决策点、验证方式和已知坑。它明确不鼓励保存某一次事故的完整时间线、PR 编号、日期或“某个工具偶尔坏了”的一次性结论。

技能通过渐进式披露加载：先列出名称和摘要，再按需读取完整 `SKILL.md`，最后按需读取 `references/`。大资料通常被拆成一个精简入口加多个参考文件，而不是把整份资料每次塞入上下文。[Skills 文档](https://github.com/NousResearch/hermes-agent/blob/7c6f21a5e12ba9b1c674ec9b410fa6b8c45de4f8/website/docs/user-guide/features/skills.md)

技能的增长入口有三类：

1. 用户显式 `/learn`：给本地目录、URL、最近工作流、粘贴笔记或书籍/论文/文档；agent 先盘点已有技能，再 patch 旧技能或创建新技能。
2. 前台 `skill_manage`：当前任务中 agent 或用户明确要求创建、修补、删除、写参考文件。
3. 回合结束后的 background review：根据刚才的纠正、非平凡修复、工具模式或新流程，自动提议 patch 现有 skill，必要时创建 curator-managed skill。

`/learn` 不是独立的训练管线，而是一个约束较强的 prompt：要求 agent 使用已有工具读源、读旧 skill、优先合并，写入仍受 `skills.write_approval` 控制。这种实现很轻，但好处是技能内容直接沿用普通 agent 的判断和工具权限。[`learn_prompt.py`](https://github.com/NousResearch/hermes-agent/blob/7c6f21a5e12ba9b1c674ec9b410fa6b8c45de4f8/agent/learn_prompt.py) · [Skills `/learn` 文档](https://github.com/NousResearch/hermes-agent/blob/7c6f21a5e12ba9b1c674ec9b410fa6b8c45de4f8/website/docs/user-guide/features/skills.md)

## 3. 真正的自动增长点：回合结束后的 background review

每个用户回合结束后，Hermes 可以在后台 fork 一个 review agent。它拿到刚结束的对话和必要上下文，判断是否应：

- 把稳定的用户偏好写入 `USER.md`；
- 把环境事实或项目经验写入 `MEMORY.md`；
- 修补当前已加载、由 agent 管理的 skill；
- 把新方法追加到已有 umbrella skill 或参考文件；
- 在确实没有合适归属时创建新 skill。

触发并不是每一轮都同步阻塞主回答：默认 memory / skill nudge interval 为 10，回合结束后才启动后台 review，主回答优先返回。review 可以使用同一个主模型，也可以配置更便宜的辅助模型；本地 GPU 忙时可以延后。它只被授予受限工具白名单，不能任意改仓库或执行任意终端命令。[`turn_finalizer.py`](https://github.com/NousResearch/hermes-agent/blob/7c6f21a5e12ba9b1c674ec9b410fa6b8c45de4f8/agent/turn_finalizer.py) · [`run_agent.py`](https://github.com/NousResearch/hermes-agent/blob/7c6f21a5e12ba9b1c674ec9b410fa6b8c45de4f8/run_agent.py) · [`background_review.py`](https://github.com/NousResearch/hermes-agent/blob/7c6f21a5e12ba9b1c674ec9b410fa6b8c45de4f8/agent/background_review.py)

### review 识别什么信号

源码 prompt 明确把以下内容视为增长信号：

- 用户纠正表达风格、格式、详细程度或输出结构；
- 用户纠正工作流；
- 解决了非平凡 bug，找到可复用的 workaround 或调试路径；
- 当前加载的 skill 过时或缺步骤；
- 一次成功流程里出现了可重复的工具组合和验证方式。

它优先 patch 当前加载的 curator-managed skill，其次 patch 已有 umbrella skill，再考虑 reference 文件，最后才创建新 skill。写之前必须重新读取目标 skill；bundled、hub、external、pinned 和用户拥有的 skill 不允许被后台 review 直接改动。删除也不是物理删除，而是带 `absorbed_into` 依据的可恢复 archive。[`background_review.py`](https://github.com/NousResearch/hermes-agent/blob/7c6f21a5e12ba9b1c674ec9b410fa6b8c45de4f8/agent/background_review.py) · [`skill_manager_guards.py`](https://github.com/NousResearch/hermes-agent/blob/7c6f21a5e12ba9b1c674ec9b410fa6b8c45de4f8/tools/skill_manager_guards.py)

### 它刻意不保存什么

后台 prompt 要求跳过：

- 单次任务的 incident log、日期、PR 号和具体报错原文；
- 没有稳定修复路径的失败；
- 环境依赖、一次性网络/服务抖动；
- 无法迁移到同类任务的细节；
- 同一条偏好同时写入 `USER.md` 和 skill。

这点很关键：Hermes 的 review 更像“把对话压缩为可复用规则”，不是把所有经历都写成记忆。

### review 的安全边界

`write_approval` 可以让前台和后台写入都先进入 pending；后台 memory 的 replace/remove 还有专门的无人值守保护。skill 侧有 provenance 和所有权检查，后台只操作它自己创建的 curator-managed skill。这样可以把自动增长切换成“自动提出、人工确认”的模式，而不是一开始就完全放开。[Memory 配置文档](https://github.com/NousResearch/hermes-agent/blob/7c6f21a5e12ba9b1c674ec9b410fa6b8c45de4f8/website/docs/user-guide/features/memory.md) · [`skill_manager_guards.py`](https://github.com/NousResearch/hermes-agent/blob/7c6f21a5e12ba9b1c674ec9b410fa6b8c45de4f8/tools/skill_manager_guards.py)

## 4. 使用遥测如何影响 skill 的后续命运

Hermes 单独记录 skill 的生命周期，而不是把“被使用过”直接当成“内容正确”。`.usage.json` 里有：

- `view_count`、`use_count`、`patch_count`；
- 创建来源：`agent`、`learn` 等；
- 最近查看、使用和修补时间；
- `patch_generation`、`reuse_after_patch`；
- `active`、`stale`、`archived` 和 `pinned` 状态。

查看、加载和实际使用都会计数，修补后再次使用还会形成复用信号。curator 默认按时间做确定性维护：长期没有真实活动的 skill 先变 stale，再可能 archive；归档可恢复，pinned 和受保护技能跳过。可选的 LLM consolidation 只负责语义合并，默认关闭，且会先做快照。[`skill_usage.py`](https://github.com/NousResearch/hermes-agent/blob/7c6f21a5e12ba9b1c674ec9b410fa6b8c45de4f8/tools/skill_usage.py) · [`curator.py`](https://github.com/NousResearch/hermes-agent/blob/7c6f21a5e12ba9b1c674ec9b410fa6b8c45de4f8/agent/curator.py)

所以 usage telemetry 的作用主要是维护和筛选，不是内容质量证明。Hermes 没有在这里看到“skill 经过回放测试后自动晋升”的完整验证门。

`/journey` 把非基础 skill、memory chunk 和它们之间的关系画出来，属于可视化和编辑入口；它本身不负责学习。[`learning_graph.py`](https://github.com/NousResearch/hermes-agent/blob/7c6f21a5e12ba9b1c674ec9b410fa6b8c45de4f8/agent/learning_graph.py) · [Learning Journey 文档](https://github.com/NousResearch/hermes-agent/blob/7c6f21a5e12ba9b1c674ec9b410fa6b8c45de4f8/website/docs/user-guide/features/memory.md)

## 5. Session Search：不压缩的长期经历层

内置 `session_search` 把 CLI 和 messaging session 的真实消息写入 SQLite FTS5。它不依赖 LLM 摘要，也不把内容截断成短记忆，适合查找“之前是怎么做的”。这与小容量的 `USER.md` / `MEMORY.md` 形成互补：

```text
always-on memory：小、稳定、每次都加载
session history：大、原始、需要时搜索
skill：中等、程序化、按需加载
```

代价是历史检索本身不是自动抽象。若没有 background review、`/learn` 或外部 provider，重复使用只会增加可搜索记录，不会自动形成新的 skill。[Memory 文档](https://github.com/NousResearch/hermes-agent/blob/7c6f21a5e12ba9b1c674ec9b410fa6b8c45de4f8/website/docs/user-guide/features/memory.md)

## 6. 外部 Memory Provider：把增长交给专门的记忆后端

Hermes 支持在内置 memory 之外启用一个外部 provider。统一接口包含初始化、system prompt 注入、prefetch、回合同步、session end、压缩前处理和 provider 工具；外部 provider 只能同时启用一个。典型生命周期是：当前问题开始前检索，回合完成后写入，session 结束时提取或提交。[Memory Provider 插件指南](https://github.com/NousResearch/hermes-agent/blob/7c6f21a5e12ba9b1c674ec9b410fa6b8c45de4f8/website/docs/developer-guide/memory-provider-plugin.md) · [`memory_provider.py`](https://github.com/NousResearch/hermes-agent/blob/7c6f21a5e12ba9b1c674ec9b410fa6b8c45de4f8/agent/memory_provider.py)

| Provider | 随使用增长的对象 | Hermes 侧观察到的写入时机 |
|---|---|---|
| Honcho | 用户 representation / user card、session summary、dialectic 结论 | 每回合保存消息，按 cadence 做用户建模和方言推理 |
| Hindsight | 实体、事实、时间信息和知识图谱；`reflect` 生成综合结论 | 每 N 回合 retain，prefetch recall / reflect |
| Mem0 | 后端抽取出的稳定事实 | 每回合把 user/assistant turn 发送给后端 `infer` |
| Holographic | 带 trust score 的本地事实和反馈 | 可在 session end 自动抽取；显式 feedback 调整信任度 |
| ByteRover / OpenViking | 层级知识树、session 知识和提取后的 profile/preferences/entities | 回合后台 curate，或 session end commit/extract |
| Supermemory / RetainDB | session graph、profile/context 和异步记忆记录 | 分桶或队列写入，session end flush |

这些 provider 的“变聪明”是各自后端的抽取、合并、检索和用户建模策略，不应和 Hermes 内置的 `MEMORY.md` / `SKILL.md` 机制混为一谈。Hermes 只定义生命周期和工具接入契约；云端服务是否保留数据、如何做模型抽取，还取决于具体 provider 配置。[Provider 配置与对比](https://github.com/NousResearch/hermes-agent/blob/7c6f21a5e12ba9b1c674ec9b410fa6b8c45de4f8/website/docs/user-guide/features/memory-providers.md)

## 7. 什么会增长，什么不会

### 会随使用增长

- `USER.md` / `MEMORY.md` 中经过筛选的稳定事实、偏好和经验；
- curator-managed skill 的流程和参考资料；
- skill 的查看、使用、修补、修补后复用计数；
- 所有 session 的原始消息索引；
- 外部 provider 的用户模型、知识图谱、session 摘要或向量/层级知识；
- `/journey` 中可见的学习节点和关系。

### 不会自动增长

- 模型权重和基础能力；
- bundled / hub / external / pinned / user-owned skill 的后台自动修改；
- 当前已运行会话的 memory prompt 快照；
- 没有 review、`/learn` 或 provider 的语义抽象；
- “使用次数多”到“内容已被回放验证”的自动证明。

这意味着 Hermes 的自进化强项是“低成本持续积累”，弱项是“内容正确性验证”。把它当作自适应知识层很合适；把它当作自动演化的软件发布管线则不够。

## 8. 对当前自进化 harness 的最小可迁移方案

建议优先复用 Hermes 的分层，而不是照搬所有 provider：

1. **先做三层存储**：小型 always-on `USER/MEMORY`、按需加载的 procedure skill、可搜索的原始 session history。
2. **在回合边界做异步 review**：主回答完成后再提取；触发信号用用户纠正、非平凡修复、稳定工具流程和重复失败后的有效路径。
3. **写“类级规则”，不写事故日志**：patch 现有 skill 优先；大材料放 `references/`；只在没有归属时新建 skill。
4. **把使用遥测和内容质量分开**：记录 view/use/patch/reuse-after-patch，用于 stale/archive 和复用分析，不把次数当正确性。
5. **默认可审批、可回滚**：写入前 pending；限制后台可改的 provenance；删除采用 archive；原子写、漂移检测和快照保留。
6. **如果要实现真正的“能力进化”**：在 Hermes 这套语义提炼之上，增加候选 skill 隔离、代表性任务回放和回归门；只有回放结果改善时才晋升到 active。

最后一项是 Hermes 当前实现中最明显的空位，也是本 harness 可以形成差异化的地方：Hermes 负责把使用经验提炼成可复用状态，但没有把“提炼后的 skill 是否真的让任务更好”做成强制的实验闭环。

## 9. 关键源码索引

- 后台 review：[`agent/background_review.py`](https://github.com/NousResearch/hermes-agent/blob/7c6f21a5e12ba9b1c674ec9b410fa6b8c45de4f8/agent/background_review.py)
- review 调度：[`agent/turn_finalizer.py`](https://github.com/NousResearch/hermes-agent/blob/7c6f21a5e12ba9b1c674ec9b410fa6b8c45de4f8/agent/turn_finalizer.py)、[`run_agent.py`](https://github.com/NousResearch/hermes-agent/blob/7c6f21a5e12ba9b1c674ec9b410fa6b8c45de4f8/run_agent.py)
- 内置 memory：[`tools/memory_tool.py`](https://github.com/NousResearch/hermes-agent/blob/7c6f21a5e12ba9b1c674ec9b410fa6b8c45de4f8/tools/memory_tool.py)、[`tools/memory_tool_store.py`](https://github.com/NousResearch/hermes-agent/blob/7c6f21a5e12ba9b1c674ec9b410fa6b8c45de4f8/tools/memory_tool_store.py)
- `/learn`：[`agent/learn_prompt.py`](https://github.com/NousResearch/hermes-agent/blob/7c6f21a5e12ba9b1c674ec9b410fa6b8c45de4f8/agent/learn_prompt.py)
- skill 写入边界：[`tools/skill_manager_guards.py`](https://github.com/NousResearch/hermes-agent/blob/7c6f21a5e12ba9b1c674ec9b410fa6b8c45de4f8/tools/skill_manager_guards.py)、[`tools/skill_manager_tool.py`](https://github.com/NousResearch/hermes-agent/blob/7c6f21a5e12ba9b1c674ec9b410fa6b8c45de4f8/tools/skill_manager_tool.py)
- skill 遥测与维护：[`tools/skill_usage.py`](https://github.com/NousResearch/hermes-agent/blob/7c6f21a5e12ba9b1c674ec9b410fa6b8c45de4f8/tools/skill_usage.py)、[`agent/curator.py`](https://github.com/NousResearch/hermes-agent/blob/7c6f21a5e12ba9b1c674ec9b410fa6b8c45de4f8/agent/curator.py)
- 学习图：[`agent/learning_graph.py`](https://github.com/NousResearch/hermes-agent/blob/7c6f21a5e12ba9b1c674ec9b410fa6b8c45de4f8/agent/learning_graph.py)
- 外部 memory 契约：[`agent/memory_provider.py`](https://github.com/NousResearch/hermes-agent/blob/7c6f21a5e12ba9b1c674ec9b410fa6b8c45de4f8/agent/memory_provider.py)

