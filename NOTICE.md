# lampgenie-harness 第三方声明(NOTICE)

本仓为自研 harness agent 项目。**不包含任何第三方项目的源码拷贝,亦不随包分发
第三方组件**:面板编辑器、图渲染器、token 估算器、插件解压器等此前依赖的标准库
均已替换为本仓自有实现;仓库内不再存在 vendor 目录与第三方库的打包产物。

运行时依赖(通过包管理器安装的 npm 库)以各 package.json 声明为准,不随源码仓
分发;随安装包分发的运行时依赖同样保留其上游许可文本,详见安装包内 NOTICE 副本。

## 参考致谢(仅思路参考,无代码携带)

下列开源项目的设计在相应模块的演进中被参考过;对应模块均为本仓独立实现,
注释与文档中的「设计参考 / 参考思路」字样即指此处:

| 项目 | 许可证 | 参考关系 |
|---|---|---|
| qwen-audio-agent(QwenAudio/qwen-audio-agent) | Apache-2.0 | 任务系统/会话日志/通知等子系统的领域模型与工程思路 |
| ZCode(zai-org/ZCode) | Apache-2.0 | 进程级 AIMD 并发治理(dynamic-workflow)、计划模式与技能机制等产品概念 |
| deepseek-harness(deepseek-ai/deepseek-harness) | MIT | journal 事件词汇与会话导出 v4 行帧格式(数据契约层面的沿用) |
| opencode(anomalyco/opencode) | MIT | 权限规则(permit/deny/ask + 通配符)语义 |
| teamai-cli(Tencent/teamai-cli) | MIT | 出站文本脱敏与 webhook 通知、PID 文件锁思路;团队仓数据格式的兼容读取 |
| EditHere(Inginnng/EditHere) | PolyForm Noncommercial | 截图标注的交互模式(取屏画框→批注→结构化反馈);交互思想参考,几何引擎与检测器为本仓独立实现 |
| OpenClaw | 见上游仓库 LICENSE | 定时任务硬超时看门狗(每轮墙钟预算)的机制思路 |
| open-code-review(alibaba) | Apache-2.0 | 代码评审的过滤保护主题与评论定位思想;TS 实现为本仓独立 |
| gitdiagram | MIT | archmap 管线设计(采样→摘录→索引→LLM 两段式→校验修复环)参考;实现为本仓独立 |
| code2flow / deepwiki-open | MIT / AGPL-3.0 | 代码流程图与代码档案(wiki)的呈现思路;实现为本仓 code-sense 自研 |
| Monaco Editor / mermaid / tiktoken | MIT | 早期版本曾随包分发,现均已替换为本仓自有实现(编辑器/图渲染器/估算器);思路致谢保留 |

若上游项目要求署名而本表有所遗漏,请提 issue,我们会补正。
