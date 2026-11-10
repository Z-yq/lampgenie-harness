/**
 * genie:// 深链解析(提取语义设计参考 ZCode 项目,致谢;本仓独立实现)。
 * 覆盖三条到达路径:
 *   ① Windows/Linux 冷启动:协议 URL 在 process.argv;
 *   ② Windows/Linux 二次启动:second-instance 的 argv / additionalData.deepLinkUrl;
 *   ③ macOS:open-url 事件。
 * 支持的路由:
 *   genie://settings            → 打开配置台
 *   genie://new-task            → 新建任务草稿
 *   genie://task/<id>           → 打开任务所在会话
 *   genie://session/<id>        → 同上
 *   genie://project?path=...    → 添加/激活项目
 *   其它/未知                    → open(仅唤起窗口)
 * 纯函数,不依赖 electron,可 node --test 单测。
 */
const DEEP_LINK_SCHEME = "genie";
// 容忍 genie://x、genie:/x、genie:x;终止于空白/引号/尖括号(Windows 命令行可能带引号)
const DEEP_LINK_RE = /\bgenie:(?:\/\/|\/)?[^\s"'<>]+/i;
const MAX_URL_LENGTH = 2048;

/** 从 argv/additionalData 里提取深链 URL(第一个匹配)。 */
function extractDeepLinkUrlFromArgs(args = []) {
  if (!Array.isArray(args)) return null;
  for (const arg of args) {
    const text = String(arg == null ? "" : arg);
    if (!text || text.length > MAX_URL_LENGTH * 2) continue;
    // Windows 会把 URL 包在引号里;空闲时也可能带尾随引号
    const match = text.match(DEEP_LINK_RE);
    if (match && match[0]) {
      const url = match[0].replace(/[),.;]+$/, "");
      if (url.length <= MAX_URL_LENGTH) return url;
    }
  }
  return null;
}

/** second-instance 的 additionalData(我们通过 requestSingleInstanceLock 传入)。 */
function extractDeepLinkUrlFromSingleInstanceData(data) {
  if (!data || typeof data !== "object") return null;
  const value = data.deepLinkUrl;
  if (typeof value !== "string" || !value) return null;
  return extractDeepLinkUrlFromArgs([value]);
}

/** 解析成 { raw, action, ... } —— 非法 scheme/超长返回 null。 */
function parseDeepLink(raw) {
  const text = String(raw == null ? "" : raw).trim();
  if (!text || text.length > MAX_URL_LENGTH) return null;
  let url;
  try {
    url = new URL(text);
  } catch (e) {
    return null;
  }
  if (url.protocol !== `${DEEP_LINK_SCHEME}:`) return null;
  const host = String(url.hostname || "").toLowerCase();
  const pathParts = url.pathname.split("/").filter(Boolean);
  const segs = [host, ...pathParts].filter(Boolean);
  const action = (segs[0] || "open").toLowerCase();
  const params = {};
  try {
    for (const [k, v] of url.searchParams.entries()) params[k] = v;
  } catch (e) { /* 非法 query 忽略 */ }

  if (action === "settings" || action === "config") {
    return { raw: text, action: "settings", params };
  }
  if (action === "new-task" || action === "newtask" || action === "new") {
    return { raw: text, action: "new-task", params };
  }
  if ((action === "task" || action === "session") && segs[1]) {
    return { raw: text, action: "session", sessionId: segs[1], params };
  }
  if (action === "project" && params.path) {
    return { raw: text, action: "project", path: params.path, label: params.label || "", params };
  }
  return { raw: text, action: "open", path: segs.join("/"), params };
}

module.exports = {
  DEEP_LINK_SCHEME,
  MAX_URL_LENGTH,
  extractDeepLinkUrlFromArgs,
  extractDeepLinkUrlFromSingleInstanceData,
  parseDeepLink,
};