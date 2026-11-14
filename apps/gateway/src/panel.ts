/**
 * 桌面 Web 面板。左侧栏复刻 ZCode WorkspaceSidebar 逻辑(ZCode packages/ui/src/WorkspaceSidebar.tsx):
 * 顶部功能按钮栈(新建=草稿态/搜索=命令中心 Ctrl+K/自动化/经验库=workspaceMainView 切换)、
 * 项目任务列表(状态点: error红>running转圈>queued黄>idle灰;相对时间;每页5条显示更多+5)、
 * 264px 可拖拽侧栏 + Ctrl+B 收起 + localStorage 持久化。零构建链:单 HTML 文件,WS 直连 gateway。
 * 交互语义对齐 ZCode: 点已在位的导航按钮=停留不弹回(workspaceMainView);项目头点击=草稿导航;
 * composer 只属于 chat 视图(非 chat 视图隐藏 footer)。
 */
import { createServer, type Server } from "node:http";
import { join, dirname, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import * as nodeFsPromises from "node:fs/promises";
import * as nodeFsAll from "node:fs";
import { repoRoot as repoRootDir } from "./repo-root.js";
import { isPathInside } from "./path-safety.js"; // :Windows 分隔符无关越界判定(/ide/asset 等)
import { parseRemoteProject } from "./remote-project.js"; // :/ide/asset 远程项目(SSH/WSL)分流
import { parseOffice, readOfficePart, OFFICE_DOC_EXT, OFFICE_MAX_BYTES } from "./office-ooxml.js"; // Office(pptx/docx)只读预览服务端解析(板 ide-o1)
import { PROVIDER_PRESETS as PROVIDER_PRESET_CATALOG } from "./provider-presets.js";
import { PANEL_BUILD } from "./build-stamp.js";
import { ERR_TEXT as ERR_TEXT_SRC, ERR_UNKNOWN_PREFIX, errorText as errorTextSrc, errorDiagnostic as errorDiagnosticSrc } from "./error-text.js";
/** 轨迹看板数据层:纯函数源码注入浏览器侧,见 panel-traj-model.ts 尾部 TRAJ_MODEL_JS。 */
import { TRAJ_MODEL_JS } from "./panel-traj-model.js";
/** PAGE 分片(拆分):样式表与 body 骨架,逐字搬移,拼装产物字节不变。 */
import { PANEL_CSS } from "./panel/page-css.js";
import { PANEL_SHELL } from "./panel/page-shell.js";
import { PANEL_JS_CORE } from "./panel/script-core.js";
import { PANEL_JS_TRAJ } from "./panel/script-traj.js";
import { PANEL_JS_ICONS_SIDEBAR } from "./panel/script-icons-sidebar.js";
import { PANEL_JS_MARKDOWN } from "./panel/script-markdown.js";
import { PANEL_JS_TOOL_RENDER } from "./panel/script-tool-render.js";
import { PANEL_JS_HISTORY } from "./panel/script-history.js";
import { PANEL_JS_VIEWS } from "./panel/script-views.js";
import { PANEL_JS_PROVIDERS } from "./panel/script-providers.js";
import { PANEL_JS_WS_ROUTER } from "./panel/script-ws-router.js";
import { PANEL_JS_SUBMIT } from "./panel/script-submit.js";
import { PANEL_JS_ADMIN } from "./panel/script-admin.js";
import { PANEL_JS_BOARD_RENDER } from "./panel/script-board-render.js";
import { PANEL_JS_CANVAS } from "./panel/script-canvas.js";
import { PANEL_JS_CANVAS_OPS } from "./panel/script-canvas-ops.js";
import { PANEL_JS_DIALOGS } from "./panel/script-dialogs.js";
import { PANEL_JS_MODEL_MENU } from "./panel/script-model-menu.js";
import { PANEL_JS_COMMANDS } from "./panel/script-commands.js";
import { PANEL_JS_VOICE_CITE } from "./panel/script-voice-cite.js";
import { PANEL_JS_IDE_1 } from "./panel/script-ide-1.js";
import { PANEL_JS_IDE_2 } from "./panel/script-ide-2.js";
import { PANEL_JS_ANNOTATE } from "./panel/script-annotate.js";
import { PANEL_PROFILE_PAGE } from "./panel/page-profile.js";

/** 预设目录单一出处(TS 模块)注入面板浏览器侧;JSON 只含公开 URL/模型 ID。 */
const PRESETS_JSON = JSON.stringify(PROVIDER_PRESET_CATALOG);
/**
 * 错误文案表单一出处(apps/gateway/src/error-text.ts):ERR_TEXT 映射表 + errorText/errorDiagnostic
 * 以 JSON/源码形式注入浏览器侧。所以「服务端契约测试断言的表」与「面板真正渲染用的表」是同一份,
 * 不存在第二份手抄表(反方向:panel 侧不允许出现硬编码 code 文案)。
 */
const ERROR_TEXT_JS =
  "const ERR_TEXT=" + JSON.stringify(ERR_TEXT_SRC) + ";" +
  "const ERR_UNKNOWN_PREFIX=" + JSON.stringify(ERR_UNKNOWN_PREFIX) + ";" +
  "const errorText=" + errorTextSrc.toString() + ";" +
  "const errorDiagnostic=" + errorDiagnosticSrc.toString() + ";";

export const PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<script>window.__PANEL_BUILD=${JSON.stringify(PANEL_BUILD)};</script>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>lampgenie-harness · 控制台</title>
<style>${PANEL_CSS}${PANEL_SHELL}
<script>
${PANEL_JS_CORE}${PANEL_JS_TRAJ}${PANEL_JS_ICONS_SIDEBAR}${PANEL_JS_MARKDOWN}${PANEL_JS_TOOL_RENDER}${PANEL_JS_HISTORY}${PANEL_JS_VIEWS}${PANEL_JS_PROVIDERS}${PANEL_JS_WS_ROUTER}${PANEL_JS_SUBMIT}
// ---- 服务商预设目录(单一出处=provider-presets.ts;浏览器侧只读 JSON) ----
const PROVIDER_PRESETS = ${PRESETS_JSON};
// ---- 错误码 -> 人话文案表(单一出处=error-text.ts;ERR_TEXT/errorText/errorDiagnostic 由构建期注入)----
${ERROR_TEXT_JS}
// ---- 轨迹看板数据层(单一出处=panel-traj-model.ts;buildTrajRows/summarizeTraj/fmtTokens 等由构建期注入)----
${TRAJ_MODEL_JS}
${PANEL_JS_ADMIN}
${PANEL_JS_BOARD_RENDER}${PANEL_JS_CANVAS}
${PANEL_JS_CANVAS_OPS}${PANEL_JS_DIALOGS}${PANEL_JS_MODEL_MENU}
${PANEL_JS_COMMANDS}${PANEL_JS_VOICE_CITE}
${PANEL_JS_IDE_1}${PANEL_JS_IDE_2}${PANEL_JS_ANNOTATE}
</body></html>`;

/** 在同一端口同时挂 WS 与 HTTP(静态面板)。 */
// 自有图渲染器本地资产(禁 CDN)——由调用方注入内容,防路径读取。
/** 项目档案独立窗口页:只读视图,复用 /assets/diagram-renderer 与 WS 档案消息。 */
const PROFILE_PAGE = PANEL_PROFILE_PAGE;

// ---- 附件回看读盘(E 路由)服务端辅助:上限 / 视频后缀判定 / 后缀→content-type ----
// 上传硬上限:视频 50MB,文档(pdf/office/压缩包)64MB,其余 8MB(客户端预检同口径;服务端为准,防绕过前端直发)。
const VIDEO_UPLOAD_LIMIT = 50 * 1024 * 1024;
const DOC_UPLOAD_LIMIT = 64 * 1024 * 1024; // 与前端 ATT_MAX_DOC / doc-text.ts 的 DOC_MAX_BYTES 同值
const UPLOAD_LIMIT = 8 * 1024 * 1024;
const VIDEO_EXT = [".mp4", ".webm", ".mov", ".m4v", ".ogv", ".avi", ".mkv"];
function isVideoName(lower: string): boolean {
  for (const e of VIDEO_EXT) if (lower.endsWith(e)) return true;
  return false;
}
// 文档后缀(与前端 ATT_DOC_EXT 同源,改动须同步两处;服务端只放宽限额,解析可行性由 doc-text 层判)
const DOC_EXT = [".docx", ".pptx", ".xlsx", ".pdf", ".zip", ".rtf", ".odt", ".odp", ".ods", ".epub",
  ".tar", ".gz", ".tgz", ".7z", ".rar", ".doc", ".ppt", ".xls", ".pages", ".numbers", ".key"];
function isDocName(lower: string): boolean {
  for (const e of DOC_EXT) if (lower.endsWith(e)) return true;
  return false;
}
const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".bmp": "image/bmp", ".svg": "image/svg+xml", ".avif": "image/avif", ".ico": "image/x-icon",
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".ogv": "video/ogg", ".avi": "video/x-msvideo", ".mkv": "video/x-matroska", ".mpeg": "video/mpeg", ".mpg": "video/mpeg",
  ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".log": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".csv": "text/csv; charset=utf-8",
};
/** content-type 真源=落盘文件名后缀(不信任 query 里的 mime;未知后缀回 application/octet-stream)。 */
function attMimeByName(p: string): string {
  const s = String(p || "").toLowerCase();
  const i = s.lastIndexOf(".");
  const e = i < 0 ? "" : s.slice(i);
  return MIME_BY_EXT[e] || "application/octet-stream";
}
// ---- IDE 图片/媒体预览路由(G /ide/asset):扩展名白名单(无点小写,与浏览器侧 IMG_EXT/MEDIA_*_EXT 同源口径) + 大小上限 ----
const IDE_ASSET_IMG_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico"]);
// 媒体地基:视频/音频同走 /ide/asset(<video>/<audio> 直连,支持 Range 拖进度条);
// 值=content-type(浏览器可解的容器/编码;mkv/hevc 等不在表内→403,不静默塞文本层)。
const IDE_ASSET_VIDEO_EXT: Record<string, string> = {
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", m4v: "video/x-m4v", ogv: "video/ogg",
};
const IDE_ASSET_AUDIO_EXT: Record<string, string> = {
  mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac",
  ogg: "audio/ogg", oga: "audio/ogg", flac: "audio/flac", opus: "audio/opus",
};
// 体积上限分级:图片远小于音视频,统一 16MB 会直接卡死正常视频预览。
// 图片 32MB / 音频 128MB / 视频 512MB——<video> 走 Range 分段读,不必整段进内存,上限可以放宽。
const IDE_ASSET_IMG_MAX_BYTES = 32 * 1024 * 1024;
const IDE_ASSET_AUDIO_MAX_BYTES = 128 * 1024 * 1024;
const IDE_ASSET_VIDEO_MAX_BYTES = 512 * 1024 * 1024;
/** 按层类型取体积上限;未知类型回落到图片档(白名单外本来就会先 403,这里只是防御)。 */
function ideAssetMaxBytes(kind: "image" | "video" | "audio" | null): number {
  if (kind === "video") return IDE_ASSET_VIDEO_MAX_BYTES;
  if (kind === "audio") return IDE_ASSET_AUDIO_MAX_BYTES;
  return IDE_ASSET_IMG_MAX_BYTES;
}
/** 上限的兆字节展示(错误文案用,避免硬编码数字与常量漂移)。 */
function ideAssetMaxMB(kind: "image" | "video" | "audio" | null): number {
  return Math.round(ideAssetMaxBytes(kind) / (1024 * 1024));
}
function ideAssetExt(p: string): string {
  const s = String(p || "").toLowerCase();
  const i = s.lastIndexOf(".");
  return i >= 0 ? s.slice(i + 1) : "";
}
/** 后缀 → 层类型:image|video|audio;null=不在白名单(图片判定与旧 ideAssetIsImg 逐字一致)。 */
function ideAssetKind(p: string): "image" | "video" | "audio" | null {
  const ext = ideAssetExt(p);
  if (!ext) return null;
  if (IDE_ASSET_IMG_EXT.has(ext)) return "image";
  if (IDE_ASSET_VIDEO_EXT[ext]) return "video";
  if (IDE_ASSET_AUDIO_EXT[ext]) return "audio";
  return null;
}
/** 媒体 content-type:图片沿用 attMimeByName(旧口径不变);视频/音频查上面的表(m4v 走 video/x-m4v)。 */
function ideAssetMime(p: string): string {
  const ext = ideAssetExt(p);
  return IDE_ASSET_VIDEO_EXT[ext] || IDE_ASSET_AUDIO_EXT[ext] || attMimeByName(p);
}
/** Windows 盘符形态归一( md 内嵌图):`E:/x/y.png`、`E:\x\y.png` → `/mnt/e/x/y.png`(WSL);
 *  非盘符形态原样返回(在 Windows 本机 realpath 能直接吃 `E:\…`)。 */
export function ideAssetWinPath(p: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(String(p || ""));
  if (!m) return p;
  return "/mnt/" + (m[1] || "c").toLowerCase() + "/" + (m[2] || "").split("\\").join("/");
}
/** /ide/asset 本地候选链解析( from=<md 相对路径>):md 里的相对图既能按 md 同目录找,
 *  也能按项目根找,还能给绝对路径。候选顺序:
 *    ①from 所在目录 + path ②项目根 + path(原样相对) ③path 本身是绝对路径(仅根内)。
 *  每个候选先 realpath 再 isPathInside(root, real);越界候选**跳过**并记账(第一个候选越界不得
 *  否掉后续合法候选)。全失败时:有越界且无其它失败原因 → 403,否则 404。
 *  返回 {abs} = 通过沙箱且是个真实文件。 */
export function ideAssetResolveLocal(root: string, rel: string, from: string): { abs: string } | { code: number; msg: string } {
  let absRoot = "";
  try { absRoot = nodeFsAll.realpathSync(root); } catch (e) { return { code: 404, msg: "项目根不存在" }; }
  const src = String(rel || "").split("\\").join("/");
  const fromRel = String(from || "").split("\\").join("/");
  const fromDir = fromRel.split("/").slice(0, -1).filter((x) => x && x !== ".").join("/");
  const cands: string[] = [];
  if (fromDir) cands.push(join(root, fromDir, src));
  cands.push(join(root, src));
  if (src.charAt(0) === "/" || /^[A-Za-z]:[\\/]/.test(src)) {
    const absCand = ideAssetWinPath(src);
    if (isAbsolute(absCand)) cands.push(absCand);
  }
  let outside = 0, other = 0;
  for (const c of cands) {
    let real = "";
    try { real = nodeFsAll.realpathSync(c); } catch (e) { other++; continue; } // 不存在
    if (!isPathInside(absRoot, real)) { outside++; continue; } // 根外/软链逃逸:跳过,继续试后面的候选
    let st: ReturnType<typeof nodeFsAll.statSync> | null = null;
    try { st = nodeFsAll.statSync(real); } catch (e) { st = null; }
    if (!st || !st.isFile()) { other++; continue; }
    return { abs: real };
  }
  if (outside > 0 && other === 0) return { code: 403, msg: "拒绝:路径在项目根之外" };
  return { code: 404, msg: "图片不存在" };
}
// ---- IDE Office 只读预览路由(板 ide-o1/o2):/ide/office(AST JSON)+ /ide/office/media(zip 内媒体 part) ----
/** Office 媒体 part 白名单前缀(防路径穿越):只放 zip 里这两棵媒体树,且不许多级/隐藏段。 */
const IDE_OFFICE_PART_RE = /^(?:ppt|word)\/media\/[A-Za-z0-9._-]+$/;
/** part 后缀 → content-type(未知回 application/octet-stream,不猜)。 */
function ideOfficePartMime(part: string): string {
  const ext = ideAssetExt(part);
  const m: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp",
    webp: "image/webp", svg: "image/svg+xml", tiff: "image/tiff", tif: "image/tiff",
    emf: "image/emf", wmf: "image/wmf", mp4: "video/mp4", m4a: "audio/mp4", m4v: "video/x-m4v",
    mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", avi: "video/x-msvideo", wmv: "video/x-ms-wmv",
  };
  return m[ext] || "application/octet-stream";
}
// ---- IDE HTML 预览静态路由(板 5a7bb5d2):/ide/preview/<项目内相对路径>?pid=<项目> ----
/** 预览白名单:后缀 → content-type(html/css/js/图片/字体/数据;板节点 01 口径,未知后缀 → 415)。 */
const IDE_PREVIEW_MIME: Record<string, string> = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", ico: "image/x-icon", json: "application/json; charset=utf-8", map: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8", md: "text/markdown; charset=utf-8",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf",
};
/** 预览单文件上限(与 file.read 同限 2MB;超出 413)。 */
const IDE_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
/** LLM 轨迹全文单文件上限(经验证最大 2.6MB;8MB 留余量,超出 413)。 */
const LLM_TRACE_MAX_BYTES = 8 * 1024 * 1024;
/** 沙箱共用的路径规范形:统一成 "/" 分隔后按段判定(拒 .. 段/整段与拒 .git 段;Windows 下也生效)。 */
function ideOfficeRelSegs(rel: string): string[] {
  return String(rel || "").split("\\").join("/").split("/");
}

export function servePanel(port: number, attachWs: (server: Server) => void, opts?: {
 /** 会话完整导出钩子:由 main 注入
   * journal+轨迹文件读取;GET /api/session-export?sid=<会话> 触发浏览器原生下载。 */
  sessionExport?: (sid: string) => { filename: string; body: string };
 /** IDE 图片预览取数:/ide/asset 路由按 pid 解析项目根(main 注入闭包延迟取,
   *  同 sessionExport 模式——servePanel 先于 app 创建)。返回 '' = 项目不存在/无活动项目。 */
  ideProjectRoot?: (pid?: string) => string | undefined;
}): { close: () => Promise<void> } {
 /** Office 预览共用沙箱:与 /ide/asset 同口径 —— pid 显式优先、缺省活动项目;
   *  拒 ".." 段、拒 ".git" 段(导出类文件没必要从版本库里取,也不许拿它当读取后门);
   *  项目根 realpath + isPathInside(防软链逃逸)。返回 {abs} 或 {code,msg}(由路由落状态码)。
   *  远程项目(SSH/WSL)不走本地 realpath → 明确 501(V1 不做远端 Office 解析)。 */
  type IdeOfficeResolved = { abs: string; size: number } | { code: number; msg: string };
  const ideOfficeResolve = (rel: string, pid?: string): IdeOfficeResolved => {
    const segs = ideOfficeRelSegs(rel);
    if (segs.indexOf("..") >= 0) return { code: 403, msg: "越界路径" };
    if (segs.indexOf(".git") >= 0) return { code: 403, msg: "拒绝:.git 受保护" };
    const root = opts?.ideProjectRoot ? opts.ideProjectRoot(pid) : repoRootDir();
    if (!root) return { code: 400, msg: "项目不存在或无活动项目" };
    if (parseRemoteProject(root)) return { code: 501, msg: "远程项目暂不支持 Office 预览" };
    let absRoot = "", abs = "";
    try { absRoot = nodeFsAll.realpathSync(root); abs = nodeFsAll.realpathSync(join(root, rel)); } catch (e) { return { code: 404, msg: "文件不存在" }; }
    if (!isPathInside(absRoot, abs)) return { code: 403, msg: "拒绝:路径在项目根之外" };
    let st: ReturnType<typeof nodeFsAll.statSync> | null = null;
    try { st = nodeFsAll.statSync(abs); } catch (e) { st = null; }
    if (!st || !st.isFile()) return { code: 404, msg: "文件不存在" };
    return { abs, size: st.size };
  };
  const server = createServer((req, res) => {
    // fixD3:团队 P2P 直连路由(ping/presence/message/inbox;复用 gateway HTTP,签名头验真;
    // 优先于静态资源与 404 兜底;实例未装配 P2P 时 teamP2pRoute 返回 false 走原路径)。
    if (req.url !== undefined && req.url.startsWith("/team/p2p/")) {
      const p2p = (globalThis as { __teamP2p?: { handleRequest(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<boolean> } }).__teamP2p;
      if (p2p) { void p2p.handleRequest(req, res); return; }
      res.writeHead(503, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, reason: "P2P 通道未装配" }));
      return;
    }
    if (req.url !== undefined && (req.url === "/" || req.url.indexOf("/?b=") === 0 || req.url === "/index.html")) {
 // no-store:面板页面必须每次取最新——曾因浏览器/桌面壳缓存旧页,
      // gateway 重建重启后窗口仍跑旧 JS(IDE 点文件空白)。带 ?b=<戳> 的自愈重载也走这里。
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store, must-revalidate" });
      res.end(PAGE);
      return;
    }
    const { readFile } = nodeFsPromises;
    const here = dirname(fileURLToPath(import.meta.url));
    if (req.url === "/assets/diagram-renderer.js") { // 自有图渲染器(纯 JS 资产,零第三方依赖)
      readFile(join(here, "assets/diagram-renderer.js"))
        .then((buf) => { res.writeHead(200, { "content-type": "application/javascript" }); res.end(buf); })
        .catch(() => { res.writeHead(404); res.end(); });
      return;
    }
    if (req.url === "/assets/annotate-layout.js") { // 截图标注组件拆移引擎(资产同源)
      readFile(join(here, "assets", "annotate-layout.js"))
        .then((buf) => { res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" }); res.end(buf); })
        .catch(() => { res.writeHead(404); res.end(); });
      return;
    }
    if (req.url === "/assets/annotate-coords.js") { // 截图标注坐标换算层(资产同源;缺失→404,面板内联兜底)
      readFile(join(here, "assets", "annotate-coords.js"))
        .then((buf) => { res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" }); res.end(buf); })
        .catch(() => { res.writeHead(404); res.end(); });
      return;
    }
    if (req.url === "/assets/ide-spectrum.js") { // 音频频谱分析件(资产同源;未创建/未构建→404,媒体层降级仅播放)
      readFile(join(here, "assets", "ide-spectrum.js"))
        .then((buf) => { res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" }); res.end(buf); })
        .catch(() => { res.writeHead(404); res.end(); });
      return;
    }
    if (req.url === "/assets/ide-office.js") { // Office 文档渲染件(pptx 幻灯片/DOCX 文档流;缺失→404,IDE 落降级文案)
      readFile(join(here, "assets", "ide-office.js"))
        .then((buf) => { res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" }); res.end(buf); })
        .catch(() => { res.writeHead(404); res.end(); });
      return;
    }
    if (req.url === "/assets/board-page-layout.js") { // 页面结构板语义布局引擎(资产同源)
      readFile(join(here, "assets", "board-page-layout.js"))
        .then((buf) => { res.writeHead(200, { "content-type": "application/javascript" }); res.end(buf); })
        .catch(() => { res.writeHead(404); res.end(); });
      return;
    }
    if (req.url === "/assets/board-ui-flow-layout.js") { // UI 交互流程布局引擎(资产同源)
      readFile(join(here, "assets", "board-ui-flow-layout.js"))
        .then((buf) => { res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" }); res.end(buf); })
        .catch(() => { res.writeHead(404); res.end(); });
      return;
    }
    if (req.url === "/assets/board-flow-layout.js") { // fixH2 设计板流动 LR 布局引擎(资产同源)
      readFile(join(here, "assets", "board-flow-layout.js"))
        .then((buf) => { res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" }); res.end(buf); })
        .catch(() => { res.writeHead(404); res.end(); });
      return;
    }
    if (req.url === "/assets/board-type-profile.js") { // 13 类板型画像(资产同源)
      readFile(join(here, "assets", "board-type-profile.js"))
        .then((buf) => { res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" }); res.end(buf); })
        .catch(() => { res.writeHead(404); res.end(); });
      return;
    }
    if (req.url === "/assets/input-policy.js") { // 网页版输入交互策略(分区接管;文本区例外)
      readFile(join(here, "assets", "input-policy.js"))
        .then((buf) => { res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" }); res.end(buf); })
        .catch(() => { res.writeHead(404); res.end(); });
      return;
    }
    if (req.url === "/assets/canvas-shell.js") { // 无限画布外壳(视图=卡片/定位栏/平移缩放/布局持久化)
      readFile(join(here, "assets", "canvas-shell.js"))
        .then((buf) => { res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" }); res.end(buf); })
        .catch(() => { res.writeHead(404); res.end(); });
      return;
    }
    if (req.url === "/assets/diagram-viewport.js") { // 图视口引擎(锚点缩放/捏合/紧凑 fit)
      readFile(join(here, "assets", "diagram-viewport.js"))
        .then((buf) => { res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" }); res.end(buf); })
        .catch(() => { res.writeHead(404); res.end(); });
      return;
    }
    if (req.url === "/assets/browser-view.js") { // 内置浏览器视图(截图流画布+工具栏+视口拖拽;零构建资产)
      readFile(join(here, "assets", "browser-view.js"))
        .then((buf) => { res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" }); res.end(buf); })
        .catch(() => { res.writeHead(404); res.end(); });
      return;
    }
    if (req.url === "/assets/super-console.js") { // Super Agent 指挥台(自包含资产)
      readFile(join(here, "assets", "super-console.js"))
        .then((buf) => { res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" }); res.end(buf); })
        .catch(() => { res.writeHead(404); res.end(); });
      return;
    }
    if (req.url === "/assets/code-editor.js") { // 自有代码编辑器(Monaco 同形适配层;零第三方依赖,零 worker)
      readFile(join(here, "assets/code-editor.js"))
        .then((buf) => { res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" }); res.end(buf); })
        .catch(() => { res.writeHead(404); res.end(); });
      return;
    }
    if (req.url === "/assets/sw.js") {
      readFile(join(here, "assets", "sw.js"))
        .then((buf) => { res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" }); res.end(buf); })
        .catch(() => { res.writeHead(404); res.end(); });
      return;
    }
    if (req.url === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
 // 项目档案独立窗口页:/profile?p=<projectId>。
    if (req.url !== undefined && req.url.split("?")[0] === "/profile") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PROFILE_PAGE);
      return;
    }
 // 会话完整导出:journal 全事件 + 每次 LLM 调用全量轨迹 + 子代理轨迹,单文件 jsonl。
    // 浏览器原生下载(Content-Disposition),不受 WS 单帧体积约束;未装配导出钩子=503 显式(不静默降级)。
    if (req.method === "GET" && req.url !== undefined && req.url.split("?")[0] === "/api/session-export") {
      const u = new URL(req.url, "http://local");
      const sid = (u.searchParams.get("sid") || "").trim();
      if (!sid) { res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }); res.end("缺少 sid"); return; }
      if (!opts?.sessionExport) { res.writeHead(503, { "content-type": "text/plain; charset=utf-8" }); res.end("导出未装配"); return; }
      try {
        const out = opts.sessionExport(sid);
        res.writeHead(200, {
          "content-type": "application/x-ndjson; charset=utf-8",
          "content-disposition": 'attachment; filename="' + out.filename.replace(/[^a-zA-Z0-9._-]/g, "_") + '"',
        });
        res.end(out.body);
      } catch (err) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end("导出失败:" + String(err).slice(0, 160));
      }
      return;
    }
 // LLM 轨迹全文:GET /api/llm-trace?path=<绝对路径> —— 轨迹看板「逐次决策」卡体的
    // 懒加载数据源。安全口径:realpath 后必须落在 <repo>/.genie/llm-trace 内(realpath 先于归属判定,
    // 否则软链可跳出);只允许 .json;单文件 >8MB → 413;不存在 404。不做任意文件读。
    if (req.method === "GET" && req.url !== undefined && req.url.split("?")[0] === "/api/llm-trace") {
      const u = new URL(req.url, "http://local");
      const raw = (u.searchParams.get("path") || "").trim();
      const deny = (code: number, msg: string) => {
        res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, reason: msg }));
      };
      if (!raw) { deny(400, "缺少 path"); return; }
      if (!isAbsolute(raw)) { deny(400, "path 必须是绝对路径"); return; }
      const traceRoot = join(repoRootDir(), ".genie", "llm-trace");
      let absRoot = "", abs = "";
      try { absRoot = nodeFsAll.realpathSync(traceRoot); } catch (e) { deny(404, "轨迹目录不存在"); return; }
      try { abs = nodeFsAll.realpathSync(raw); } catch (e) { deny(404, "轨迹文件不存在"); return; }
      if (!isPathInside(absRoot, abs)) { deny(403, "拒绝:路径在轨迹目录之外"); return; }
      if (abs.slice(-5).toLowerCase() !== ".json") { deny(403, "拒绝:仅允许 .json 轨迹文件"); return; }
      let st: ReturnType<typeof nodeFsAll.statSync> | null = null;
      try { st = nodeFsAll.statSync(abs); } catch (e) { st = null; }
      if (!st || !st.isFile()) { deny(404, "轨迹文件不存在"); return; }
      if (st.size > LLM_TRACE_MAX_BYTES) { deny(413, "轨迹文件超 " + Math.round(LLM_TRACE_MAX_BYTES / 1048576) + "MB 上限"); return; }
      try {
        const body = nodeFsAll.readFileSync(abs, "utf-8");
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "private, max-age=60" });
        res.end(body);
      } catch (err) {
        deny(500, "读取失败:" + String(err).slice(0, 120));
      }
      return;
    }
    // 轨迹看板自愈(2026-11):GET /api/llm-trace/list?sid=<sessionId> —— 列该会话已落盘的 call-*.json 元数据,
    // 前端拿它跟 journal 已入账的 traceFile 对账:文件在、journal 没记的调用 → 合成行(synth)显示,不丢事件。
    // 安全:sid 仅允许 [A-Za-z0-9._:-](挡 ../、/ 与绝对路径),目录固定 <repo>/.genie/llm-trace/<sid>;
    // 目录不存在 → {ok:true,files:[]}(不 500);单文件解析失败跳过;只读。
    if (req.method === "GET" && req.url !== undefined && req.url.split("?")[0] === "/api/llm-trace/list") {
      const u = new URL(req.url, "http://local");
      const sidRaw = (u.searchParams.get("sid") || "").trim();
      const limitNum = Number(u.searchParams.get("limit") || 200);
      const limit = Number.isFinite(limitNum) && limitNum > 0 ? Math.min(2000, Math.floor(limitNum)) : 200;
      const sendJson = (code: number, body: unknown) => {
        res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(body));
      };
      if (!sidRaw || !/^[A-Za-z0-9._:-]+$/.test(sidRaw) || sidRaw.indexOf("..") >= 0) {
        sendJson(400, { ok: false, reason: "sid 非法(仅允许字母数字与 . _ : -)" });
        return;
      }
      const dir = join(repoRootDir(), ".genie", "llm-trace", sidRaw);
      let names: string[] = [];
      try { names = nodeFsAll.readdirSync(dir); } catch (e) { sendJson(200, { ok: true, sid: sidRaw, files: [] }); return; }
      const files: Record<string, unknown>[] = [];
      for (const name of names) {
        if (files.length >= limit) break;
        if (!/^call-.+\.json$/.test(name)) continue;
        const abs = join(dir, name);
        let raw = "", j: Record<string, any> | null = null;
        try { raw = nodeFsAll.readFileSync(abs, "utf-8"); j = JSON.parse(raw); } catch (e) { continue; } // 单文件坏 → 跳过
        if (!j || typeof j !== "object") continue;
        const resp = j.response && typeof j.response === "object" ? j.response : {};
        const usage = j.usage && typeof j.usage === "object" ? j.usage
          : (resp.usage && typeof resp.usage === "object" ? resp.usage : {});
        const head = typeof resp.content === "string" ? resp.content
          : (typeof resp.text === "string" ? resp.text : (typeof j.response === "string" ? j.response : ""));
        const tcSrc = Array.isArray(resp.toolCalls) ? resp.toolCalls : (Array.isArray(j.toolCalls) ? j.toolCalls : []);
        const toolCalls: string[] = [];
        for (const t of tcSrc) {
          const n = typeof t === "string" ? t : String((t && t.name) || "");
          if (n) toolCalls.push(n);
        }
        files.push({
          file: abs,
          turn: Number(j.turn || 0),
          step: Number(j.step || 0),
          model: String(j.model || ""),
          durationMs: Number(j.durationMs || 0),
          usage: {
            inputTokens: Number(usage.inputTokens || 0),
            cachedTokens: Number(usage.cachedTokens || 0),
            outputTokens: Number(usage.outputTokens || 0),
          },
          responseHead: String(head || "").slice(0, 80),
          toolCalls: toolCalls,
        });
      }
      sendJson(200, { ok: true, sid: sidRaw, count: files.length, files: files });
      return;
    }
 // 附件上传:POST /upload?sid=<会话>&name=<文件名>;落 .genie/uploads/<sid>/。
 // 限额(放宽,按类型判):视频 ≤50MB,其余(图片/文本/代码/未知) ≤8MB —— 仍留硬上限防滥用。
    // 注意:此处是 POST /upload;GET /uploads(读盘回看)是另一条路由,靠 method + 精确路径区分,前缀重叠不打歪。
    if (req.method === "POST" && (req.url === "/upload" || (req.url !== undefined && req.url.indexOf("/upload?") === 0))) {
      const u = new URL(req.url, "http://local");
      const sid = (u.searchParams.get("sid") || "common").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "common";
      const rawName = u.searchParams.get("name") || "file";
      const name = rawName.replace(/[^a-zA-Z0-9._\u4e00-\u9fa5-]/g, "_").slice(-80) || "file";
      const nameLower = name.toLowerCase();
      const isVideo = isVideoName(nameLower);
      const isDoc = !isVideo && isDocName(nameLower);
      const limit = isVideo ? VIDEO_UPLOAD_LIMIT : isDoc ? DOC_UPLOAD_LIMIT : UPLOAD_LIMIT;
      const chunks: Buffer[] = [];
      let size = 0;
      let aborted = false;
      req.on("data", (d: Buffer) => {
        if (aborted) return; // 已超限:后续数据直接丢弃(drain),不 buffer 也不断连
        size += d.length;
        // 413 必须让客户端读得到:早断 socket(req.pause + destroy)会让仍在写 body 的客户端先吃
 // "write ECONNRESET",拿不到 413 正文(经验证间歇性失败)。故超限只置位 + 丢数据,等 req "end"
        // (客户端写完)再回 413 —— 内存有界(chunks 已清空),状态码可读。
        // 仅防御真滥用:远超上限(>8×)时硬断,不陪着把数据收完。
        if (size > limit) {
          aborted = true;
          chunks.length = 0;
          if (size > limit * 8) { try { req.destroy(); } catch (e) { /* 已断开 */ } }
          return;
        }
        chunks.push(d);
      });
      req.on("end", () => {
        if (aborted) {
          if (!res.headersSent) {
            res.writeHead(413, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "文件超 " + Math.round(limit / 1048576) + "MB(" + (isVideo ? "视频" : isDoc ? "文档" : "其它类型") + "上限)" }));
          }
          return;
        }
        try {
          const { mkdirSync, writeFileSync } = nodeFsAll;
          const dir = join(repoRootDir(), ".genie", "uploads", sid);
          mkdirSync(dir, { recursive: true });
          const f = join(dir, Date.now().toString(36) + "-" + name);
          writeFileSync(f, Buffer.concat(chunks));
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ path: f, name, size }));
        } catch (err) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: String(err).slice(0, 120) }));
        }
      });
      return;
    }
 // 附件回看读盘:GET /uploads?path=<绝对路径> —— journal 只存绝对路径,浏览器读不到,
    // 聊天流/旧会话回看必须由服务端按需回读。安全红线:规范化后必须落在白名单根之内
    // (拒 .. 穿越 / 拒符号链接逃逸 / 拒目录外一切路径 → 403);类型按后缀判,不信任 query 里的 mime。
 // 白名单根(截图预览):.genie/uploads(附件)+ .genie/browser-shots(browser 工具截图,
    // mdToHtml 的 ![...](/uploads?path=…) 内嵌预览数据源)。
    if (req.method === "GET" && req.url !== undefined && (req.url === "/uploads" || req.url.indexOf("/uploads?") === 0)) {
      const allowRoots = [join(repoRootDir(), ".genie", "uploads"), join(repoRootDir(), ".genie", "browser-shots")];
      const realRoots = allowRoots.map((r) => { try { return nodeFsAll.realpathSync(r); } catch (e) { return r; } });
      // 归一化(去掉 . / 冗余分隔符;不解析符号链接)后按「相对根」判在场:任一白名单根 lexical 在场才继续,否则一律 403。
      const normAbs = (p: string): string => {
        if (!p || !isAbsolute(p)) return "";
        for (const rr of realRoots) {
          const rel = relative(rr, p).split("\\").join("/");
          if (rel && rel !== "." && rel !== ".." && rel.indexOf("../") !== 0 && rel.indexOf("/") !== 0) return join(rr, rel);
        }
        return ""; // 全部白名单根之外
      };
      const u = new URL(req.url, "http://local");
      const qPath = u.searchParams.get("path") || "";
      const qName = u.searchParams.get("name") || "";
      if (qPath.indexOf("..") >= 0 || qName.indexOf("..") >= 0) { res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }); res.end("越界路径"); return; }
      const lex = normAbs(qPath);
      if (!lex) { res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }); res.end("拒绝:路径不在白名单目录(.genie/uploads、.genie/browser-shots)之内"); return; }
      // 符号链接逃逸:realpath 后仍须落在 uploads 根内(软链指到根外 → 403)
      let real = "";
      try { real = nodeFsAll.realpathSync(lex); } catch (e) { real = ""; }
      if (real && !normAbs(real)) { res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }); res.end("拒绝:符号链接指向白名单目录之外"); return; }
      let st: ReturnType<typeof nodeFsAll.statSync> | null = null;
      try { st = nodeFsAll.statSync(real || lex); } catch (e) { st = null; }
      if (!st || !st.isFile()) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("附件不存在"); return; }
      if (!real) real = lex;
      const total = st.size;
      const mime = attMimeByName(real);
      const range = typeof req.headers.range === "string" ? req.headers.range : "";
      // HTTP Range(视频拖动进度条必需):单段 bytes=a-b / bytes=a- / bytes=-n
      if (range && range.indexOf("bytes=") === 0 && range.indexOf(",") < 0) {
        const spec = range.slice(6).trim();
        const dash = spec.indexOf("-");
        const aRaw = dash >= 0 ? spec.slice(0, dash).trim() : "";
        const bRaw = dash >= 0 ? spec.slice(dash + 1).trim() : "";
        let start = aRaw ? Number(aRaw) : NaN;
        let end = bRaw ? Number(bRaw) : NaN;
        if (isNaN(start)) { start = isNaN(end) ? 0 : Math.max(0, total - end); end = total - 1; }
        if (isNaN(end) || end >= total) end = total - 1;
        if (start > end || start >= total || start < 0) {
          res.writeHead(416, { "content-type": "text/plain; charset=utf-8", "content-range": "bytes */" + total });
          res.end("");
          return;
        }
        res.writeHead(206, {
          "content-type": mime,
          "content-length": String(end - start + 1),
          "content-range": "bytes " + start + "-" + end + "/" + total,
          "accept-ranges": "bytes",
          "cache-control": "private, max-age=60",
        });
        const rs = nodeFsAll.createReadStream(real, { start: start, end: end });
        rs.on("error", () => { try { res.end(); } catch (e) { /* 已断开 */ } });
        rs.pipe(res);
        return;
      }
      res.writeHead(200, { "content-type": mime, "content-length": String(total), "accept-ranges": "bytes", "cache-control": "private, max-age=60" });
      const rs = nodeFsAll.createReadStream(real);
      rs.on("error", () => { try { res.end(); } catch (e) { /* 已断开 */ } });
      rs.pipe(res);
      return;
    }
 // IDE 图片预览取数:GET /ide/asset?pid=<项目>&path=<项目内相对路径>。
    // 守卫口径同 file.read(项目根 realpath+startsWith 沙箱,pid 显式优先、缺省 active、都无→400)
    // + /uploads 同款拒 .. /防软链逃逸;扩展名白名单只放行图片类(IDE_ASSET_IMG_EXT);>16MB→413。
    // svg 经 <img> 展示本身不执行脚本,CSP default-src 'none' + nosniff 兜住直接导航打开面。
    if (req.method === "GET" && req.url !== undefined && (req.url === "/ide/asset" || req.url.indexOf("/ide/asset?") === 0)) {
      const u = new URL(req.url, "http://local");
      const pid = u.searchParams.get("pid") || undefined;
      const rel = u.searchParams.get("path") || "";
      const from = u.searchParams.get("from") || ""; // md 相对路径:图片按 md 同目录优先解析
      if (rel.indexOf("..") >= 0) { res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }); res.end("越界路径"); return; }
      if (!rel) { res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }); res.end("缺 path"); return; }
      const kind = ideAssetKind(rel);
      if (!kind) { res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }); res.end("仅图片/媒体类型可取"); return; }
      const maxBytes = ideAssetMaxBytes(kind);
      const root = opts?.ideProjectRoot ? opts.ideProjectRoot(pid) : repoRootDir();
      if (!root) { res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }); res.end("项目不存在或无活动项目"); return; }
 // 远程项目(SSH/WSL:图片经远端工作区服务读(通道 base64 / 远端 base64 回退),
      // 不再走本地 realpath(远程 identity 不是本地路径,旧实现恒 404)。
      {
        const remoteRoot = parseRemoteProject(root);
        if (remoteRoot) {
          void (async () => {
            const { remoteReadBinary } = await import("./ssh-ops.js");
            const r = await remoteReadBinary(remoteRoot, rel, maxBytes + 1);
            if ("error" in r) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("图片不存在"); return; }
            if (r.buf.length > maxBytes) { res.writeHead(413, { "content-type": "text/plain; charset=utf-8" }); res.end("文件过大(>" + ideAssetMaxMB(kind) + "MB)"); return; }
            res.writeHead(200, {
              "content-type": ideAssetMime(rel), "content-length": String(r.buf.length),
              "content-security-policy": "default-src 'none'", "x-content-type-options": "nosniff",
              "cache-control": "private, max-age=60",
            });
            res.end(r.buf);
          })().catch(() => { try { res.writeHead(500, { "content-type": "text/plain; charset=utf-8" }); res.end("读取失败"); } catch { /* 已断开 */ } });
          return;
        }
      }
 // 候选链解析( `from=`):①from 目录+path ②项目根+path ③绝对(仅根内,含 E:/ 盘符
      // WSL 映射);每个候选先 realpath 再 isPathInside,越界/不存在的候选跳过,全失败才落 403/404。
      const hit = ideAssetResolveLocal(root, rel, from);
      if ("code" in hit) { res.writeHead(hit.code, { "content-type": "text/plain; charset=utf-8" }); res.end(hit.msg); return; }
      const abs = hit.abs;
      let st: ReturnType<typeof nodeFsAll.statSync> | null = null;
      try { st = nodeFsAll.statSync(abs); } catch (e) { st = null; }
      if (!st || !st.isFile()) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("图片不存在"); return; }
      if (st.size > maxBytes) { res.writeHead(413, { "content-type": "text/plain; charset=utf-8" }); res.end("文件过大(>" + ideAssetMaxMB(kind) + "MB)"); return; }
      const mime = ideAssetMime(abs);
      const total = st.size;
 // HTTP Range(媒体地基,逻辑同 GET /uploads):<video>/<audio> 拖进度条必须 206+content-range。
      // 单段 bytes=a-b / bytes=a- / bytes=-n;多段(逗号)不解析 → 落下面 200 全量(浏览器自行退让)。
      const range = typeof req.headers.range === "string" ? req.headers.range : "";
      if (range && range.indexOf("bytes=") === 0 && range.indexOf(",") < 0) {
        const spec = range.slice(6).trim();
        const dash = spec.indexOf("-");
        const aRaw = dash >= 0 ? spec.slice(0, dash).trim() : "";
        const bRaw = dash >= 0 ? spec.slice(dash + 1).trim() : "";
        let start = aRaw ? Number(aRaw) : NaN;
        let end = bRaw ? Number(bRaw) : NaN;
        if (isNaN(start)) { start = isNaN(end) ? 0 : Math.max(0, total - end); end = total - 1; }
        if (isNaN(end) || end >= total) end = total - 1;
        if (start > end || start >= total || start < 0) { // 起点越界:416 + 供客户端自算总量的 content-range
          res.writeHead(416, { "content-type": "text/plain; charset=utf-8", "content-range": "bytes */" + total });
          res.end("");
          return;
        }
        res.writeHead(206, {
          "content-type": mime, "content-length": String(end - start + 1),
          "content-range": "bytes " + start + "-" + end + "/" + total,
          "accept-ranges": "bytes",
          "content-security-policy": "default-src 'none'", "x-content-type-options": "nosniff",
          "cache-control": "private, max-age=60",
        });
        const rs3 = nodeFsAll.createReadStream(abs, { start: start, end: end });
        rs3.on("error", () => { try { res.end(); } catch (e) { /* 已断开 */ } });
        rs3.pipe(res);
        return;
      }
      res.writeHead(200, {
        "content-type": mime, "content-length": String(total), "accept-ranges": "bytes",
        "content-security-policy": "default-src 'none'", "x-content-type-options": "nosniff",
        "cache-control": "private, max-age=60",
      });
      const rs2 = nodeFsAll.createReadStream(abs);
      rs2.on("error", () => { try { res.end(); } catch (e) { /* 已断开 */ } });
      rs2.pipe(res);
      return;
    }
 // IDE Office 预览(板 ide-o1/o2):GET /ide/office?path=<项目内相对路径>&pid=<项目>
    // → 解析后的 AST JSON(pptx: slides / docx: blocks),前端 assets/ide-office.js 负责渲染。
    // 守卫口径同 /ide/asset(ideOfficeResolve:项目根 realpath + isPathInside)+ 扩展名白名单 + >OFFICE_MAX_BYTES→413(文案由常量推导)。
    if (req.method === "GET" && req.url !== undefined && (req.url === "/ide/office" || req.url.indexOf("/ide/office?") === 0)) {
      const u = new URL(req.url, "http://local");
      const rel = u.searchParams.get("path") || "";
      const pid = u.searchParams.get("pid") || undefined;
      const extLow = String(rel).toLowerCase();
      const dotI = extLow.lastIndexOf(".");
      const ext = dotI >= 0 ? extLow.slice(dotI) : "";
      if (!rel) { res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }); res.end("缺 path"); return; }
      if (!OFFICE_DOC_EXT.has(ext)) { res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }); res.end("不支持的文档类型:仅 .pptx/.docx 可预览"); return; }
      const rr = ideOfficeResolve(rel, pid);
      if ("code" in rr) { res.writeHead(rr.code, { "content-type": "text/plain; charset=utf-8" }); res.end(rr.msg); return; }
      if (rr.size > OFFICE_MAX_BYTES) { res.writeHead(413, { "content-type": "text/plain; charset=utf-8" }); res.end("文件过大(>" + Math.round(OFFICE_MAX_BYTES / (1024 * 1024)) + "MB),不支持预览"); return; }
      void nodeFsPromises.readFile(rr.abs)
        .then((buf) => parseOffice(buf, ext as ".pptx" | ".docx", { docPath: rel, pid: pid || "" }))
        .then((ast) => {
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff", "cache-control": "no-store" });
          res.end(JSON.stringify(ast));
        })
        .catch((e) => { try { res.writeHead(500, { "content-type": "text/plain; charset=utf-8" }); res.end("解析失败:" + String((e as Error)?.message ?? e)); } catch (e2) { /* 已断开 */ } });
      return;
    }
 // IDE Office 媒体(板 ide-o1):GET /ide/office/media?path=<源文件>&part=<zip 内 part>&pid=<项目>
    // → zip 内媒体 part 原始字节(图片/音视频)。part 白名单 IDE_OFFICE_PART_RE(防包内穿越),
    // 源文件沙箱与 /ide/office 同口径;源文件扩展名不是 .pptx/.docx → 403。
    if (req.method === "GET" && req.url !== undefined && (req.url === "/ide/office/media" || req.url.indexOf("/ide/office/media?") === 0)) {
      const u = new URL(req.url, "http://local");
      const rel = u.searchParams.get("path") || "";
      const part = u.searchParams.get("part") || "";
      const pid = u.searchParams.get("pid") || undefined;
      const extLow = String(rel).toLowerCase();
      const dotI = extLow.lastIndexOf(".");
      const ext = dotI >= 0 ? extLow.slice(dotI) : "";
      if (!rel) { res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }); res.end("缺 path"); return; }
      if (!IDE_OFFICE_PART_RE.test(part)) { res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }); res.end("part 越界或不在白名单(仅 ppt/media、word/media 下的单层文件)"); return; }
      if (!OFFICE_DOC_EXT.has(ext)) { res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }); res.end("不支持的文档类型:仅 .pptx/.docx 可预览"); return; }
      const rr = ideOfficeResolve(rel, pid);
      if ("code" in rr) { res.writeHead(rr.code, { "content-type": "text/plain; charset=utf-8" }); res.end(rr.msg); return; }
      if (rr.size > OFFICE_MAX_BYTES) { res.writeHead(413, { "content-type": "text/plain; charset=utf-8" }); res.end("文件过大(>" + Math.round(OFFICE_MAX_BYTES / (1024 * 1024)) + "MB),不支持预览"); return; }
      void nodeFsPromises.readFile(rr.abs)
        .then(async (buf) => {
          const got = await readOfficePart(buf, part);
          if (!got) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("包内无此 part"); return; }
          res.writeHead(200, {
            "content-type": ideOfficePartMime(part), "content-length": String(got.length),
            "x-content-type-options": "nosniff", "cache-control": "private, max-age=60",
          });
          res.end(got);
        })
        .catch((e) => { try { res.writeHead(500, { "content-type": "text/plain; charset=utf-8" }); res.end("解析失败:" + String((e as Error)?.message ?? e)); } catch (e2) { /* 已断开 */ } });
      return;
    }
 // IDE HTML 预览静态路由(板 5a7bb5d2 节点 01):GET /ide/preview/<pid>/<项目内相对路径>
    // pid 放路径段是刻意的(板风险 4 闭环):iframe 文档内 style.css/app.js 相对引用按文档 URL 解析时
    // **不继承 query**,query 形 pid 会在子资源请求里丢失;路径前缀 /ide/preview/<pid>/ 则天然保留。
    // 守卫:仅 GET(其余落 404 空体)+ 沙箱口径同 /ide/office(realpath + isPathInside;越界/.git/不存在统一 404 不泄漏细节)
    // + 后缀白名单 IDE_PREVIEW_MIME(外 415)+ >IDE_PREVIEW_MAX_BYTES 413;200 回磁盘字节原样,不注入任何脚本。
    if (req.method === "GET" && req.url !== undefined && (req.url.indexOf("/ide/preview/") === 0 || req.url === "/ide/preview" || req.url.indexOf("/ide/preview?") === 0)) {
      const u = new URL(req.url, "http://local");
      // 路径形(iframe/相对解析主通道):/ide/preview/<pid>/<rel>;query 形(手动直连兼容):?pid=&path=
      const pathSegs = u.pathname.slice("/ide/preview/".length).split("/").map((s) => decodeURIComponent(s));
      const qp = u.searchParams.get("path") || "";
      const rel = qp ? qp : pathSegs.slice(1).join("/");
      const pid = (pathSegs[0] && pathSegs[0] !== "" ? pathSegs[0] : undefined) || u.searchParams.get("pid") || undefined;
 // 沙箱先行(板节点 01 验径:越界 → 404,与后缀无关;不泄漏判定细节)
      const rr = ideOfficeResolve(rel, pid); // 沙箱与 /ide/office 同口径(403/404/400/501 统一落 404)
      if ("code" in rr) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("文件不存在或不可预览"); return; }
      const extLow = ideAssetExt(rel);
      if (!rel || !IDE_PREVIEW_MIME[extLow]) {
        res.writeHead(415, { "content-type": "text/plain; charset=utf-8" });
        res.end("不支持的预览文件类型(白名单:html/css/js/图片/字体/数据)");
        return;
      }
      if (rr.size > IDE_PREVIEW_MAX_BYTES) { res.writeHead(413, { "content-type": "text/plain; charset=utf-8" }); res.end("文件过大(>2MB),不支持预览"); return; }
      void readFile(rr.abs)
        .then((buf) => {
          res.writeHead(200, { "content-type": IDE_PREVIEW_MIME[extLow], "content-length": String(buf.length), "cache-control": "no-store", "x-content-type-options": "nosniff" });
          res.end(buf);
        })
        .catch(() => { try { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("文件不存在或不可预览"); } catch (e) { /* 已断开 */ } });
      return;
    }
 // node-agent 单文件分发(远程向导):dist/downloads/node-agent.mjs(构建期 bundle)。
    if (req.url === "/downloads/node-agent.mjs") {
      readFile(join(here, "downloads", "node-agent.mjs"))
        .then((buf) => { res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }); res.end(buf); })
        .catch(() => { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("// node-agent bundle 未构建(pnpm -F gateway build)"); });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  attachWs(server);
 // 端口占用/监听失败不许静默( K3):日志给人话处置建议 + 非零退出码,桌面壳据此显示错误页。
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") console.error("[gateway] 端口 " + port + " 已被占用——换端口:GENIE_GATEWAY_PORT=7701 或改 genie.config.json gateway.port");
    else console.error("[gateway] 面板监听失败(" + port + "):" + String(err?.message ?? err));
    process.exit(1);
  });
  server.listen(port);
  return {
    close: () => new Promise((r) => server.close(() => r())),
  };
}
