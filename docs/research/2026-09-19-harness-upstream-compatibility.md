# DeepSeek Harness 上游更新核查（2026-09-19）

> 本文记录本次实际 fetch 后的源码事实与迁移要求，不代表新版已安装、构建或通过运行验收。产品与技术方案已据此修订到 1.3。

## 1. 当前版本与冲突结论

| 项目 | 核查结果 |
|---|---|
| 远端 | `https://github.com/deepseek-ai/deepseek-harness.git`，`origin/master` |
| 当前工作目录 HEAD | `47f943859bef60e4160492346772ded9b24f765a`，2026-08-13 |
| 本次 fetch 后远端提交 | `ddefc45fbc7f8e46dd73185e68295696d1297887`，2026-09-17 21:19:19 +0800 |
| 远端包版本 | `0.1.6-alpha.2`；Cordis `4.0.2` |
| 提交关系 | 本地独有 0，远端独有 18,056；本地是远端祖先，可以快进 |
| 工作区改动 | Harness 仓库 `git status --porcelain` 为空，无本地未提交改动 |
| 是否拉下来了 | 远端提交和源码对象已 fetch 到本地；未切换工作目录、安装依赖或改动实际运行环境 |
| 是否存在冲突 | 没有 Git 分叉合并冲突；有插件接口、候选流程和日志格式兼容性问题 |

这里的“最新”指此次 fetch 返回的固定提交，不是长期跟随浮动 `master`。旧版探针仍依赖当前工作目录及旧构建产物，不能直接快进后继续复用旧 `node_modules` / `lib`。

## 2. 对方案有影响的变化

### 2.1 创造模式改为直接编写和安装标准插件

新版 `tool-cordis` 只注册 `cordis_inspect_list`、`cordis_inspect_query` 两个只读工具。模型不再使用 `cordis_define/run/stop/undefine` 创建动态候选；Creator 技能要求先在工作区编写标准 bundle，再通过 `plugin_manager` 安装。动态 runner 仍供程序和已有浏览器消费者使用，并未被删除，但不再是默认模型创作入口。

新版方案采用：冻结测试 → 运行时检查 → 生成标准候选包 → 仅安装到隔离测试 profile → 验证 → 冻结产物并在干净测试实例复验 → 人工批准 → 正式启用。不为了保留旧图额外造一套动态工具。候选包已经是标准形态，取消“动态源码再物化”的转换；最终实际发布产物仍必须完整验证。

依据：[工具注册源码](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/extensions/tool-cordis/src/index.ts)、[Creator 开发技能](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/preset/agent-presets/presets/cordis/skills/cordis-plugin-development/SKILL.md)、[动态 runner 说明](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/extensions/cordis-host-runner/README.zh.md)。

### 2.2 Plugin Manager 会修改整个 profile，不能直接充当正式发布闸门

安装默认启用；配置是否热应用取决于 HMR。修改影响该 profile 的全部会话，管理器也不负责编辑 agent preset。替换已安装包需要重启以加载新模块。包安装失败/取消可恢复 manifest 和 lockfile，但激活失败不会自动撤销安装，卸载失败可能留下部分改动。

因此候选创建器只能接触独立测试 `DSH_HOME`、profile、工作区和允许的凭据。正式发布由控制插件/外部启动器处理，不能让模型向用户当前 Web profile 调用安装。会话级发布仍通过受验证的 preset 组合；只能全局生效的插件采用新实例，不能把 profile HMR 当作“只影响新会话”。

安装后的 Host 代码运行在宿主进程内，不受工作区沙箱限制。安装批准并不证明插件运行安全，也不替代我们已确认的外部操作逐次批准。依赖构建脚本还需单独批准；验证不能静默使用 `danger-full-access` 绕过这些要求。

依据：[Plugin Manager](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/boot/plugin-manager/README.zh.md)、[preset 作用域](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/preset/agent-presets/README.zh.md)。

### 2.3 会话读取已经改成 handle 接口

旧设计依赖服务级 `readFrom`。新版使用 `stat/list` 查看元数据和 revision，`open(id, 'read')` 获取只读句柄，通过 `handle.read(offset, length)` 读取逻辑事件，并在完成后 `close()`。`session/event` 仍可作为轻量唤醒信号；补读和持久化证据以官方读取接口为准。

只有完成 `flush` 才是持久性屏障；已收到事件不等于跨崩溃保存已经完成。不要为了采集取得写句柄，也不要自行从压缩文件名推断最新日志。

依据：[持久化服务](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/session/session-persistence/src/index.ts)、[读取句柄](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/session/session-persistence/src/handle.ts)。

### 2.4 日志格式变为 V3，旧证据序号不能直接套用

新版 `SESSION_FORMAT_VERSION = 3`，官方提供受支持历史版本的相邻迁移链。只读打开可以在内存迁移，写打开会发布新的版本文件并保留源代；旧程序不能被假定能继续使用已产生的新格式。

V2→V3 会插入系统提示事件并改变事件序号和引用；旧版 `sessionId + seq` 不足以唯一解释跨格式证据。派生材料需要同时记录源 Harness 提交、日志格式/代际与事件位置。升级后重新提取经验，保留旧证据引用，不能把旧序号当新版序号继续补读。

新版通过 `system/message` 记录系统提示，`assistant/message` 内嵌已结算的流记录，失败等尝试使用 `assistant/attempt`；不能继续假定逐个旧式 `assistant/chunk` 都是持久日志事件。进程在结算前退出可能没有完整尝试流，缺失记录应标为证据不足。

依据：[V3 常量与类型](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/core/session/src/types.ts)、[V2→V3 迁移规范](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/session/session-format-v2-to-v3/README.zh.md)、[架构说明](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/docs/architecture.md)。

### 2.5 现有网页探针不能原样迁移

新版删除了 `packages/client/runtime` / `@deepseek-ai/dsh-client-runtime`。当前探针的类型导入、manifest 注入依赖、开发依赖路径及客户端测试都引用它，直接升级会失效。新版使用 Cordis `Context`，SlotRegistry 从 `dsh-client-ui-renderer/client` 导出，纯 slot 核心在 `dsh-client-ui-slots`。

`conversation.composer.dock` 插槽仍在，可继续作为状态标记位置；但仍需新版真实页面验证。`clientBundle` 仍存在，构建输入和依赖须按新版重新核对。探针当前固定 Cordis `4.0.1` 和 DSH `0.1.0-rc.5`，也不能当作新版依赖锁定。

依据：[SlotRegistry 导出](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/client/ui-renderer/src/client/index.ts)、[插槽声明](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/client/ui-conversation/src/client/contract/slots.ts)、[当前探针包清单](../../packages/evolution-probe/package.json)、[客户端实现](../../packages/evolution-probe/src/client/index.ts)、[客户端测试](../../packages/evolution-probe/tests/client.spec.ts)。

### 2.6 PTC 仍存在，但基线必须重新建立

新版随附 `standard`、`ptc`、`cordis`、`minimal`。历史 `code` 预设在官方日志迁移中映射到 `ptc`；正式运行与测试应记录实际预设 ID，不能仅比较显示名。新版 PTC 的工具组合和系统提示可能与旧版不同，不能把上游升级效果归因于自进化。

Flash 模型选择不因本次升级改变。所有新版事故测试和基础考试缓存重新建立；旧结果仍是旧版证据。

依据：[PTC 元数据](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/preset/agent-presets/presets/ptc/preset.yml)、[preset 说明](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/preset/agent-presets/README.zh.md)。

### 2.7 网页能启动，不代表正式插件已加载成功

新版启动保留可激活插件，对非 required 条目失败只发警告；required 条目失败才拆卸应用并非零退出。因此自进化插件坏了，网页仍可能打开。外部启动器必须把受管理正式插件集合的实际激活状态纳入健康检查，不能只等待端口可用或进程不退出。

官方 `sanitizeProfile` 提供文件级恢复辅助，但它是清理 profile 配置与 bundle 选择，不等于精确恢复我们批准的上一集合，也不撤销工作区文件修改。不因已有该 helper 删除项目的版本清单和恢复边界。

依据：[启动与失败策略](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/boot/app-boot/README.zh.md)。

### 2.8 附带会话日志上传默认开启（本轮补充）

上游 `session-log-deepseek` 的 `enabled` 默认 true，随附 profile 会挂载该插件。满足官方 API 与有效 sessionId 等条件时，请求会通过 `dsh_session_log` 附带会话日志。这不同于正常推理必需的 messages。

按 D-053，项目目标 profile 显式关闭该功能，切换前检查生效配置，并用本地替身或请求构造验证不再附带该字段；本次仅修订文档，尚未完成运行验证。

依据：[官方说明](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/session/session-log-deepseek/README.zh.md)。

## 3. 新版切换前必须完成的工作

第 1 项启动任何真实模型请求前，先完成上述日志上传关闭与本地验证；这是第 6 项切换的前置条件。

1. 使用独立 checkout、独立安装与构建产物、独立 `DSH_HOME` / profile，不先覆盖旧版运行目录或用户会话数据。
2. 适配探针依赖、客户端 Context/SlotRegistry 和测试，在目标提交上重新构建并测试；旧版通过结果不得冒充新版通过。
3. 在授权的日志副本上验证 V0→V3 只读迁移、经验重建与来源引用，不把新旧格式放在同一套恢复流程中混用。
4. 用 Flash Creator 生成标准候选 bundle，只安装到测试 profile，检查 Host 生命周期；有 Client 时连接隔离页面并验证渲染、停止和重启。
5. 验证正式发布只影响新会话，以及配置/加载/运行故障的外部恢复、单次预算停止和文件撤销边界；包含“页面已启动但受管理插件激活失败”的情况。
6. 完成以上验证再切换实际运行基线；旧版目录与旧数据保留作历史环境，不能仅切回可执行文件就宣称新版数据已回滚。

这些是上游兼容性接入工作，不新增独立控制平台、更多模型或自动正式批准。

## 4. 本次验证范围

- `git fetch origin` 成功；远端与当前 HEAD 的提交关系及干净工作区已核对。
- 新版工具、插件管理器、持久化、日志迁移、preset 与客户端接口已进行静态源码核查。
- 当前旧基线执行 `pnpm test`：2 个测试通过。
- 未在新版安装依赖、构建、启动真实页面或调用模型；新版端到端兼容性尚未通过验收。
- 旧版 [里程碑零证据](../../artifacts/milestone-0/README.md) 保持原样，不能当作新版验收证据。
