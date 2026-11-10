# lampgenie-harness 第三方声明(NOTICE)

本仓为自研 harness agent 项目。**不包含任何第三方项目的源码拷贝**:历史版本曾在
`vendor/` 目录存放参考件,现已全部移除,相关功能均以本仓自有实现交付(出处见下表
「参考关系」列,仅作思路致谢)。

仓库内随包分发的标准前端库(均为 MIT 许可的常规依赖做法,保留其许可文本):

| 库 | 版本 | 许可证 | 位置 | 许可文本 |
|---|---|---|---|---|
| Monaco Editor | 0.52.2 | MIT | apps/gateway/src/assets/vendor/monaco/ | 同目录 LICENSE.txt |
| mermaid(esbuild 打包产物) | 11.17.2 | MIT | apps/gateway/src/assets/mermaid.min.js | https://github.com/mermaid-js/mermaid (MIT) |

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

若上游项目要求署名而本表有所遗漏,请提 issue,我们会补正。
