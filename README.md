<div align="center">
  <img src="assets/logo/logo-mark-only.svg" width="140" alt="LampGenie">
  <h1>LampGenie</h1>
  <p><b>神灯 · 本地优先的开源 AI Agent 运行时与工作台</b></p>
  <p>把一句自然语言愿望,跑成「代码感知 → 白板规划 → 子代理执行 → 证据验收」的可观测、可回放、可审计的交付流水线。</p>
  <p><i>The genie in your lamp — a local-first, open-source agent runtime that turns one wish into a shipped, verified task.</i></p>
  <p>
    <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
    <img src="https://img.shields.io/badge/node-%E2%89%A520-green" alt="node >= 20">
    <img src="https://img.shields.io/badge/pnpm-monorepo-orange" alt="pnpm monorepo">
    <img src="https://img.shields.io/badge/TypeScript-89.7%25-blue" alt="TypeScript">
  </p>
</div>

---

## 这是什么

LampGenie 不是聊天壳,而是围绕**「任务」**组织的一等公民运行时。核心主张:

- **先感知再动手**:改代码前,`code-sense` 先给出静态调用图、改动影响面、分支决策点与项目画像——不做局部盲修;
- **先规划再执行**:白板把任务画成「变更契约图」(现状层+变更层),节点带目标、验收条件与证据,P0 节点未验收不算完成;
- **分派子代理**:主 agent 负责理解、拆解、调度与验收;worker / explore / planner / judge 等子代理在各自领地内执行,互不踩文件,重活可进独立 git worktree;
- **证据收口**:测试、typecheck、代码评审、截图冒烟等证据回填白板,`done` 状态必须带证据;
- **全过程可观测**:任务、工具调用、LLM 请求响应、子代理轨迹全部落 journal / llm-trace,面板里可回放、可导出、可复盘。

## 功能亮点

| 域 | 能力 |
|---|---|
| **任务运行时** | 双调度器(user/system)+ 每 owner 串行 + 幂等去重;定时任务与硬超时看门狗;进程级 AIMD 并发治理(429 自适应退避);重试/冷却/恢复 |
| **代码感知** | 调用图与影响面、决策点扫描、HTTP/状态机/算法画像、整仓 code flow、函数级 CFG 控制流图、语义级代码档案(wiki)与功能拆解 |
| **白板** | 十三种任务板型(代码/测试/重构/UI/数据/契约/部署/评审…)、变更契约校验、P0 验收与证据回填、画布/经典双视图 |
| **子代理** | 角色白名单(含 planner/explore/judge)、能力继承、审批链(重活回询主 agent)、worktree 隔离、deadline 收割 |
| **面板** | 浏览器单页 + Electron 桌面壳;任务流/会话/画布/轨迹回看/模型热切换/截图标注(取屏画框→批注→结构化反馈) |
| **多模型** | OpenAI 兼容端点、按角色配模型(主对话/任务书/评审/语音)、热切换、失败降级与恢复态 |
| **语音与多模态** | 聊天窗录音→任务书、语音任务书模型可配、图片附件识别 |
| **交付物** | 会话导出(journal 全量+轨迹)、评审 PPT(源稿质量门+溢出/重叠 QA+视觉验收)、代码档案站点 |
| **安全** | 出站文本脱敏、权限规则(allow/deny/ask + 通配符)、工具结果审计、journal 幂等与崩溃恢复 |

## 快速开始

要求:Node.js ≥ 20、pnpm。

```bash
git clone https://github.com/Z-yq/lampgenie-harness.git
cd lampgenie-harness
pnpm install
pnpm -r build
pnpm --filter @lampgenie/gateway start   # 打开 http://localhost:7700
```

首次打开面板 → 「设置」页接入模型:任一 OpenAI 兼容端点(填 BaseURL + API Key)。密钥只落本地 `.genie/secrets.json`,不入库、不回显。

> **桌面版**:`apps/desktop` 为 Electron 壳(内置网关托管、无边框标题栏、系统托盘)。构建安装包见 `apps/desktop/README.md`。

### 日常入口

- 面板聊天窗直接提任务(支持 `@文件` 引用、图片附件、✂ 截图标注);
- 定时任务在任务面板配置(支持超时预算);
- 会话回放与导出:会话详情 → 轨迹/导出。

## 配置速查

| 文件/环境变量 | 作用 | 入库? |
|---|---|---|
| `genie.config.json` | 并发上限、权限、面板、任务等非密配置 | 模板 `genie.config.example.json` 入库 |
| `.genie/secrets.json` | 模型 API Key 等凭证 | ❌ 永不入库 |
| `.genie/permissions.json` | 工具/路径权限规则(allow/deny/ask) | 按需 |
| `GENIE_PANEL_READONLY=1` | 面板只读模式 | — |

完整配置项见 `genie.config.example.json` 内注释。

## 架构

| 模块 | 职责 |
|---|---|
| `apps/gateway` | 本地网关:HTTP/WS 面板、任务调度、子代理编排、LLM 热切换、语音/标注通道 |
| `packages/harness-runtime` | agent 主循环、工具调用、上下文压缩、子代理运行时、任务系统 |
| `packages/code-sense` | 静态代码感知:调用图/影响面/画像/评审/代码档案;`code-sense-cli` 是其 CLI |
| `packages/core` | 任务模型、配置分层、journal、权限与审计 |
| `packages/protocol` | 面板与网关的 WS 协议与类型 |
| `packages/harness-*` | 终端、LSP、记忆、经验、执行器、工作流等能力包 |
| `apps/desktop` | Electron 桌面壳(内置网关托管) |
| `packages/test-support` | 测试用脚本化 mock LLM 服务 |

依赖链:`core → harness-runtime → protocol → 其余包 → gateway`。
## 开发者指南

```bash
pnpm -r build        # 按依赖链全量构建
pnpm -r typecheck    # 全仓类型检查
pnpm -r test         # 全仓测试(vitest)
pnpm gate:creds      # 凭证红线扫描(提交前建议跑一次)
```

- 测试约定:`packages/*/test` 与 `apps/*/test`;端到端用例不依赖真实模型(`packages/test-support` 提供 mock LLM);
- 提交建议按主题分批,凭证/运行时产物不入库;详见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 安全与隐私

- **本地优先**:网关、面板、journal、密钥都在本机;产品本体不外联(模型端点由你自己配置);
- **凭证隔离**:`.env` / secrets 均被 gitignore;面板错误信息对密钥做脱敏显示,LLM 轨迹落盘前过出站脱敏器;
- **权限闸**:工具与路径按 `allow/deny/ask` 规则求值,重操作走审批链;
- **可审计**:journal 追加式、崩溃可重放,谁在什么时候用了哪个工具、发了什么请求全程留痕。

## 兼容性

Windows(实机)与 Linux/WSL 上开发与实测;macOS 理论可运行但未验证,欢迎反馈。

## 致谢

本项目的设计在演进中参考过若干开源项目的思路(qwen-audio-agent、ZCode、deepseek-harness、opencode、teamai-cli、EditHere、open-code-review、gitdiagram、code2flow、deepwiki-open 等)——**均只作思路致谢,仓库不含任何第三方项目源码拷贝**,对应模块为本仓独立实现。完整致谢与随包第三方组件(Monaco Editor、mermaid,MIT)许可见 [NOTICE.md](./NOTICE.md)。

> 名称说明:LampGenie(神灯里的灯神)与 Cisco pyATS「Genie harness」、Databricks「Genie」等均无关联。

## 许可证

[MIT](./LICENSE) © 2026 LampGenie contributors
