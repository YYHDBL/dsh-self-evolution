# Self-Evolving Harness

让 DeepSeek Harness 从真实使用中自我进化的研究原型：观察日常代码任务，发现重复出现的适配机会，做出**最小的**受管理改动（Memory / Skill / 配置 / 插件），先在隔离环境验证、经人工批准后小范围试用，用真实证据决定保留或恢复——每一步可审计、可撤销、可诚实地说"证据不足"。

> 正式名称：Continually Self-Evolving DeepSeek Harness（自进化 DeepSeek Harness）
> 项目性质：研究原型（第一期为研究型原型优先，成功后再发展为内部系统与产品）

## 当前状态（2026-09-19）

阶段 A（基线与新版适配）已完成并通过审计，停在第 0 个里程碑审计点，未开始阶段 B。

- 目标上游：DeepSeek Harness `ddefc45`（`0.1.6-alpha.2`），独立 checkout 于 `vendor/dsh-0.1.6`（不入库）
- 里程碑零验收：新版构建/启动、附带会话日志上传关闭（配置级+请求级双向验证）、V3 日志只读迁移、探针装载/会话记录/官方 handle 核对、网页常驻状态三态生命周期——全部有实际运行证据
- 真实最小 PTC 会话（DeepSeek-V4-Flash）已通过；成本按[证据合同](docs/plans/2026-09-19-evolution-evidence-contract.md)记账

## 目录结构

```text
docs/plans/       产品/技术设计、实施方案 v1.4、任务拆解 v1.2、决策记录（D-001～D-062）
docs/research/    上游兼容性核查、架构调研、参考实现
packages/
  evolution-probe/  控制插件（薄接入层：turn/end 记录 + composer.dock 状态标记）
scripts/probe/    探针脚本（上传关闭替身、V3 迁移/只读核对）
artifacts/        验收证据（旧基线 47f9438 历史 + 目标基线 ddefc45）
state/            运行时状态（不入库）
evolution-private/ 敏感证据与成本账本（不入库）
vendor/           上游 checkout（不入库）
```

## 快速开始

```bash
corepack pnpm install   # 安装工作区依赖（vendor 需另行 checkout，见 docs）
npm test                # 探针包测试（3 用例，直接测试发布产物）
```

## 核心纪律

不修改上游核心源码；候选只在隔离环境运行；正式发布与试用经人工批准（试用 ≤5 个实际任务或 7 天）；证据分"运行检查通过 / 局部对照支持 / 真实使用支持"三层且永不混报；同一问题最多三个候选版本，每次尝试有时间和消耗上限；敏感证据留在 Git 外。完整约束见[决策记录](docs/plans/2026-08-17-project-decision-log.md)。

## 许可证

待定（研究原型阶段）。
