/**
 * Gateway Client Protocol(定稿)的 zod schema。
 * 模式参照 qwen-audio-agent shared/protocol(Apache-2.0,能力协商/信封纪律),
 * 内容自研——参照仓的消息面只覆盖其自身场景,本仓按任务/会话/面板/标注/Rsi 等域自建。
 * 拆分:按域分片到 ./messages/*(core/task/session/surface/ide-fs/board/annotate/rsi/server-events),
 * 本文件保留公共出口;消费方全部走根导入,零改动。
 */
export { PROTOCOL_VERSION } from "./version.js";
export * from "./messages/core.js";
export * from "./messages/task.js";
export * from "./messages/session.js";
export * from "./messages/surface.js";
export * from "./messages/ide-fs.js";
export * from "./messages/board.js";
export * from "./messages/annotate.js";
export * from "./messages/rsi.js";
export * from "./messages/server-events.js";
export * from "./relay.js";
/** :legacy 错误码封闭兼容登记表 + 读侧归一/投影助手(纯逻辑零 IO,不改 ErrorCode 既有值)。 */
export * from "./compat.js";
