/**
 * 面板主脚本分片:script-icons-sidebar(逐字自 panel.ts PAGE 模板搬移, 拆分)。
 * 模板约束沿袭:不得出现反引号与 ${;行内换行不得写裸转义。
 */
export const PANEL_JS_ICONS_SIDEBAR = `// ===================== 主题图标体系(线性 sprite)+ emoji 素描化 =====================
// chrome 符号字符形态(✓ ✕ ▶ ▼ ↖ ⇒ ↳ ▦ …)全部改为 path 描绘:stroke=currentColor 跟文字色,
// 描边粗细走 --ic-sw;主题质感(ink 加粗/glass 半透)见样式区尾部 .icn/.emj 主题层。
const ICONS = {
  "check": '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  "x": '<path d="M6.5 6.5l11 11"/><path d="M17.5 6.5l-11 11"/>',
  "arrow-right": '<path d="M4.5 12h14"/><path d="M13 6.5l5.5 5.5-5.5 5.5"/>',
  "chev-right": '<path d="M9.5 5.5l6.5 6.5-6.5 6.5"/>',
  "chev-down": '<path d="M5.5 9.5l6.5 6.5 6.5-6.5"/>',
  "chev-up": '<path d="M5.5 14.5l6.5-6.5 6.5 6.5"/>',
  "chev-left": '<path d="M14.5 5.5L8 12l6.5 6.5"/>',
  "play": '<path d="M8.5 5.5v13l9.5-6.5z"/>',
  "home": '<path d="M4.5 11.5L12 4.5l7.5 7"/><path d="M6.5 10v9.5h11V10"/>',
  "folder": '<path d="M4 7.5A1.5 1.5 0 0 1 5.5 6h4l2 2.5h7A1.5 1.5 0 0 1 20 10v7a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17z"/>',
  "file": '<path d="M6.5 3.5h7l4 4v13h-11z"/><path d="M13.5 3.5v4h4"/>',
  "sub": '<path d="M7 4.5V12a3 3 0 0 0 3 3h9"/><path d="M15.5 11l4 4-4 4"/>',
  "inject": '<path d="M5 7l5 5-5 5"/><path d="M12.5 7l5 5-5 5"/>',
  "grid": '<rect x="4.5" y="4.5" width="15" height="15" rx="1.5"/><path d="M4.5 12h15"/><path d="M12 4.5v15"/>',
  "dot": '<circle cx="12" cy="12" r="2.6"/>',
  "run": '<path d="M19 12a7 7 0 1 1-4.3-6.5"/><circle cx="12" cy="12" r="1.6"/>',
  "warn": '<path d="M12 4.5L21 19.5H3z"/><path d="M12 10v4.3"/><path d="M12 16.9h.01"/>',
  "fail": '<circle cx="12" cy="12" r="8.5"/><path d="M9.2 9.2l5.6 5.6"/><path d="M14.8 9.2l-5.6 5.6"/>',
  "plus": '<path d="M12 5.5v13"/><path d="M5.5 12h13"/>',
  "minus": '<path d="M5.5 12h13"/>',
  "inbox": '<path d="M4.5 13.5l2-7h11l2 7v5a1.5 1.5 0 0 1-1.5 1.5h-12a1.5 1.5 0 0 1-1.5-1.5z"/><path d="M4.5 13.5H9a3 3 0 0 0 6 0h4.5"/>',
  "dots": '<path d="M5.5 12h.01"/><path d="M12 12h.01"/><path d="M18.5 12h.01"/>',
  "clock": '<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2.5"/>',
  "search": '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.5-4.5"/>',
  "package": '<path d="M12 3.5l8 4.3v8.4l-8 4.3-8-4.3V7.8z"/><path d="M4 7.8l8 4.3 8-4.3"/><path d="M12 12.1v8.4"/>',
  "alert-circle": '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.6v5.2"/><path d="M12 16.2h.01"/>'
};
// ic(name, cls):sprite 引用内联展开(PAGE 无 <use> 跨文档问题,体量 24 形可接受);aria-hidden=装饰语义。
function ic(name, cls) { return '<svg class="icn' + (cls ? " " + cls : "") + '" viewBox="0 0 24 24" aria-hidden="true">' + (ICONS[name] || ICONS.dot) + "</svg>"; }
/** 文件类型图标形(24×24 viewBox,与 ICONS 同线条风格:细描边无 fill)。key=组名。 */
const FILE_ICONS = {
  ts: '<path d="M7 5.5L4 12l3 6.5"/><path d="M17 5.5l3 6.5-3 6.5"/><path d="M14.5 5l-5 14"/>',
  js: '<path d="M7 5.5L4.5 12l2.5 6.5"/><path d="M17 5.5l-2.5 6.5 2.5 6.5"/><path d="M12.5 9.8c-1.9 0-1.9 2.4 0 2.4s1.9 2.4 0 2.4"/>',
  py: '<path d="M8.5 4.5c-2.6 2 2.6 4.2 0 6.2s2.6 4.2 0 6.2"/><path d="M15.5 4.5c2.6 2-2.6 4.2 0 6.2s-2.6 4.2 0 6.2"/><path d="M6.5 18.5h4"/>',
  json: '<path d="M9.5 4.5c-2 0-2.5 1-2.5 2.5v3c0 1.5-.6 2-1.5 2 .9 0 1.5.5 1.5 2v3c0 1.5.5 2.5 2.5 2.5"/><path d="M14.5 4.5c2 0 2.5 1 2.5 2.5v3c0 1.5.6 2 1.5 2-.9 0-1.5.5-1.5 2v3c0 1.5-.5 2.5-2.5 2.5"/>',
  md: '<path d="M4.5 8.5v7"/><path d="M4.5 8.5l4 4.5 4-4.5v7"/><path d="M16 8.5v6"/><path d="M13.5 12l2.5 2.5 2.5-2.5"/><path d="M4.5 19h15"/>',
  img: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="8.5" cy="9.8" r="1.4"/><path d="M4.5 16.5l4.5-4.5 3.5 3.5 3-2.5 4 3.5"/>',
  data: '<path d="M9 5.5L4.5 12 9 18.5"/><path d="M15 5.5L19.5 12 15 18.5"/><path d="M12 7.5v9"/>',
  bin: '<path d="M6 4.5h12v15H6z"/><path d="M9.5 8.5h5"/><path d="M12 4.5v3"/><path d="M9 17h6"/><path d="M6 13.5h12"/>',
  sh: '<path d="M5.5 7.5l4 4.5-4 4.5"/><path d="M12 16.5h6.5"/><rect x="3.5" y="4.5" width="17" height="15" rx="2"/>',
  git: '<circle cx="8" cy="6.5" r="2.2"/><circle cx="8" cy="17.5" r="2.2"/><circle cx="16.5" cy="11" r="2.2"/><path d="M8 8.7v6.6"/><path d="M10 7c2.3.5 3.9 1.9 4.3 4.1"/>',
  lock: '<rect x="5.5" y="10.5" width="13" height="9" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
  txt: '<path d="M5 7h14"/><path d="M5 12h14"/><path d="M5 17h9"/>'
};
/** 扩展名 → 组名。至少覆盖 ts/js/py/json/md/img/data/bin/sh/git/lock/txt。 */
const FILE_EXT_GROUP = {
  ts: "ts", tsx: "ts", mts: "ts", cts: "ts",
  js: "js", jsx: "js", mjs: "js", cjs: "js",
  py: "py", pyi: "py",
  json: "json", jsonc: "json",
  md: "md", mdx: "md", markdown: "md",
  png: "img", jpg: "img", jpeg: "img", gif: "img", webp: "img", svg: "img", ico: "img", bmp: "img", avif: "img",
  html: "data", htm: "data", css: "data", scss: "data", less: "data", vue: "data", svelte: "data",
  yml: "data", yaml: "data", toml: "data", xml: "data", csv: "data", tsv: "data", sql: "data",
  zip: "bin", gz: "bin", tgz: "bin", tar: "bin", pdf: "bin", docx: "bin", pptx: "bin", xlsx: "bin",
  exe: "bin", so: "bin", wasm: "bin", bin: "bin", "7z": "bin", rar: "bin",
  sh: "sh", bash: "sh", zsh: "sh", ps1: "sh", bat: "sh", cmd: "sh",
  gitignore: "git", gitattributes: "git", gitmodules: "git", git: "git",
  lock: "lock", lockb: "lock", pin: "lock",
  txt: "txt", log: "txt", env: "txt", ini: "txt", conf: "txt", cfg: "txt", license: "txt", readme: "txt",
};
/** 文件名 → 组名(剥前导点、取末段扩展名、小写;查不到 → "txt")。纯函数,不碰 DOM。 */
function fileGroupOf(name) {
  const raw = String(name || "").split("/").pop() || "";
  const low = raw.toLowerCase();
  if (!low) return "txt";
  if (low.charAt(0) === ".") { const k = low.slice(1); return FILE_EXT_GROUP[k] || FILE_EXT_GROUP[low] || "txt"; }
  const dot = low.lastIndexOf(".");
  if (dot > 0) { const ext = low.slice(dot + 1); if (FILE_EXT_GROUP[ext]) return FILE_EXT_GROUP[ext]; }
  if (FILE_EXT_GROUP[low]) return FILE_EXT_GROUP[low];
  return "txt";
}
/** 文件类型图标 html(class=icn fic-<组>)。树 / 页签 / 文件 chip 共用此唯一取形口。 */
function fileIcon(name, cls) { return '<svg class="icn fic-' + fileGroupOf(name) + (cls ? " " + cls : "") + '" viewBox="0 0 24 24" aria-hidden="true">' + (FILE_ICONS[fileGroupOf(name)] || FILE_ICONS.txt) + "</svg>"; }
// ---- 内容侧素描形(sketch-only;与 chrome 图标共享视觉语言:同网格/同描边)----
const SKETCH = {
  "face": '<circle cx="12" cy="12" r="8"/><path d="M8.8 14a4.2 4.2 0 0 0 6.4 0"/><path d="M9.2 9.7h.01"/><path d="M14.8 9.7h.01"/>',
  "joy": '<circle cx="12" cy="12" r="8"/><path d="M8.6 13.2h6.8a3.4 3.4 0 0 1-6.8 0z"/><path d="M7.6 9.6c.8-.9 2-.9 2.8 0"/><path d="M13.6 9.6c.8-.9 2-.9 2.8 0"/>',
  "sweat": '<circle cx="12" cy="12" r="8"/><path d="M9 14.5a3.6 3.6 0 0 0 6 0"/><path d="M9.2 9.7h.01"/><path d="M14.8 9.7h.01"/><path d="M18.6 4.5s1.6 2 1.6 3.1a1.6 1.6 0 0 1-3.2 0c0-1.1 1.6-3.1 1.6-3.1z"/>',
  "cry": '<circle cx="12" cy="12" r="8"/><path d="M8.8 15.5a4.4 4.4 0 0 0 6.4 0"/><path d="M8.8 9.9h.01"/><path d="M15.2 9.9h.01"/><path d="M16.9 14.2s1.2 1.5 1.2 2.3a1.2 1.2 0 0 1-2.4 0c0-.8 1.2-2.3 1.2-2.3z"/>',
  "sleep": '<circle cx="12" cy="12" r="8"/><path d="M9 13.8c.9.9 2.1.9 3 0"/><path d="M13.5 13.8c.9.9 2.1.9 3 0"/><path d="M9.3 9.6l1.8-1v1l-1.8 1v-1z"/><path d="M13.6 8.2l1.8-1v1l-1.8 1v-1z"/>',
  "think": '<circle cx="12" cy="12" r="8"/><path d="M8.6 9.8l2.2-.8"/><path d="M14.6 9.4h.01"/><path d="M9.2 15.3c1.4-.9 3.2-.9 4.6.1"/><path d="M15.5 16.8l2.3-1.6 1.9.8"/>',
  "thumbs-up": '<path d="M7 11l3.6-6.6c1.6 0 2.5 1 2.2 2.5l-.5 2.6h4.6a1.8 1.8 0 0 1 1.8 2.2l-1.1 4.9A2.4 2.4 0 0 1 15.2 18H7z"/><path d="M7 11H4.5v7H7z"/>',
  "thumbs-down": '<g transform="rotate(180 12 12)"><path d="M7 11l3.6-6.6c1.6 0 2.5 1 2.2 2.5l-.5 2.6h4.6a1.8 1.8 0 0 1 1.8 2.2l-1.1 4.9A2.4 2.4 0 0 1 15.2 18H7z"/><path d="M7 11H4.5v7H7z"/></g>',
  "clap": '<path d="M9.2 11.2l2.6-2.6 5.4 5.4-2.4 2.4a3.8 3.8 0 0 1-5.6-5.2z"/><path d="M9.2 11.2L6.6 8.6"/><path d="M5.2 12.5h.01"/><path d="M6.8 5.5h.01"/><path d="M11.5 3.8h.01"/><path d="M15.8 4.8h.01"/>',
  "pray": '<path d="M8.6 4.5v5.6a3.4 3.4 0 0 0 3.4 3.4v6"/><path d="M15.4 4.5v5.6a3.4 3.4 0 0 1-3.4 3.4"/><path d="M12 19.5v-6"/>',
  "muscle": '<path d="M5 18.5V13a8 8 0 0 1 4.2-7c1.9.9 2.5 2.9 1.5 4.9l2.2 1.6c3-1.1 6.1.4 6.1 3.4a2.6 2.6 0 0 1-2.6 2.6z"/><path d="M5 18.5h11.4"/>',
  "heart": '<path d="M12 19.5l-6.6-6.4a4.2 4.2 0 0 1 6.6-5.2 4.2 4.2 0 0 1 6.6 5.2z"/>',
  "broken": '<path d="M12 19.5l-6.6-6.4a4.2 4.2 0 0 1 6.6-5.2 4.2 4.2 0 0 1 6.6 5.2z"/><path d="M12 7.9l-1.2 2.6 2.4 2.4-1.2 3"/>',
  "sparkles": '<path d="M11 4.5l1.3 3.7 3.7 1.3-3.7 1.3L11 14.5l-1.3-3.7L6 9.5l3.7-1.3z"/><path d="M18 14l.8 2.2 2.2.8-2.2.8L18 20l-.8-2.2-2.2-.8 2.2-.8z"/>',
  "star": '<path d="M12 4.5l2.3 4.8 5.2.7-3.8 3.7.9 5.2-4.6-2.5-4.6 2.5.9-5.2-3.8-3.7 5.2-.7z"/>',
  "flame": '<path d="M12 20c-3.5 0-5.8-2.2-5.8-5.4 0-2.7 1.9-4.4 3.3-6.3.8 1 1.1 1.7 1.2 2.9 1.5-1.5 2.2-3.5 1.5-5.8 3.3 1.9 5.6 5.4 5.6 9.2 0 3.2-2.3 5.4-5.8 5.4z"/>',
  "party": '<path d="M9.7 14.3L4.5 19.5l6.2-1.4z"/><path d="M9.7 14.3c0-4.4 2.6-7 7-7 0 4.4-2.6 7-7 7z"/><path d="M6.2 8.6h.01"/><path d="M16.2 4.4h.01"/><path d="M19.6 11.6h.01"/>',
  "rocket": '<path d="M12 3.5c2.9 2 4.4 4.9 4.4 8.3l-2.4 2.9h-4l-2.4-2.9c0-3.4 1.5-6.3 4.4-8.3z"/><circle cx="12" cy="9.8" r="1.6"/><path d="M9.9 14.7l-1.8 3.6 2.9-1.3"/><path d="M14.1 14.7l1.8 3.6-2.9-1.3"/><path d="M12 15.5v3"/>',
  "bulb": '<path d="M12 3.5a5.5 5.5 0 0 1 3.1 10c-.7.5-1.1 1.4-1.1 2.5h-4c0-1.1-.4-2-1.1-2.5A5.5 5.5 0 0 1 12 3.5z"/><path d="M9.8 18.5h4.4"/><path d="M10.6 20.9h2.8"/>',
  "bug": '<circle cx="12" cy="13.5" r="4.6"/><path d="M12 8.9V6.8"/><path d="M8.9 10.2L7 8.6"/><path d="M15.1 10.2l1.9-1.6"/><path d="M7.4 13.5H4.8"/><path d="M16.6 13.5h2.6"/><path d="M8.9 16.8l-1.9 1.6"/><path d="M15.1 16.8l1.9 1.6"/><path d="M9.6 9L8.2 7.2"/><path d="M14.4 9l1.4-1.8"/>',
  "box": '<rect x="4.5" y="6.8" width="15" height="12.4" rx="1.2"/><path d="M12 6.8v12.4"/><path d="M4.5 11.2h15"/>',
  "note": '<rect x="5" y="4" width="14" height="16" rx="1.5"/><path d="M8.5 9h7"/><path d="M8.5 12.5h7"/><path d="M8.5 16h4.2"/>',
  "pin": '<path d="M12 20.5S6.5 14.3 6.5 10.5a5.5 5.5 0 0 1 11 0c0 3.8-5.5 10-5.5 10z"/><circle cx="12" cy="10.5" r="1.8"/>',
  "target": '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4.4"/><path d="M12 12h.01"/>',
  "wrench": '<path d="M14.8 6.3a4.2 4.2 0 0 0-5.6 5L4 16.5V20h3.5l5.2-5.2a4.2 4.2 0 0 0 5-5.6l-2.9 2.9-2.9-2.9z"/>',
  "bot": '<rect x="5" y="8" width="14" height="10" rx="2.2"/><circle cx="9.4" cy="13" r="1"/><circle cx="14.6" cy="13" r="1"/><path d="M12 8V4.8"/><path d="M12 4.8h.01"/><path d="M9 18v1.8"/><path d="M15 18v1.8"/>',
  "brain": '<path d="M9.6 4.5A3 3 0 0 0 6.7 8 3.1 3.1 0 0 0 5.1 10.8c0 1.2.6 2.2 1.5 2.8-.3 1.9 1.2 3.6 3.1 3.6.9 0 1.7-.3 2.3-.9V5.5a3 3 0 0 0-2.4-1z"/><path d="M14.4 4.5A3 3 0 0 1 17.3 8a3.1 3.1 0 0 1 1.6 2.8c0 1.2-.6 2.2-1.5 2.8.3 1.9-1.2 3.6-3.1 3.6-.9 0-1.7-.3-2.3-.9V5.5a3 3 0 0 1 2.4-1z"/>',
  "bolt": '<path d="M13.2 3.5L6.4 13.4h4.7l-1 7.1 6.9-9.9h-4.7z"/>',
  "cup": '<path d="M5 9.5h10.5V15a4.5 4.5 0 0 1-4.5 4.5h-1.5A4.5 4.5 0 0 1 5 15z"/><path d="M15.5 10.8H17a2.4 2.4 0 0 1 0 4.8h-1.5"/><path d="M8 5.5V7"/><path d="M12 4.5V7"/>',
  "palette": '<path d="M12 20a8 8 0 1 1 8-8c0 2.4-1.9 3-3.4 3H14a2 2 0 0 0-1.5 3.3c.4.6 0 1.7-.5 1.7z"/><path d="M7.8 10.2h.01"/><path d="M11.8 7.4h.01"/><path d="M15.9 9.8h.01"/>',
  "flask": '<path d="M10 3.5h4"/><path d="M10.8 3.5v5.2L5.6 18a1.8 1.8 0 0 0 1.6 2.6h9.6a1.8 1.8 0 0 0 1.6-2.6L13.2 8.7V3.5"/><path d="M7.6 14.5h8.8"/>',
  "chart": '<path d="M4.5 4.5v15h15"/><path d="M8.5 16v-4.6"/><path d="M12.5 16V8"/><path d="M16.5 16v-6.4"/>',
  "eyes": '<circle cx="7.6" cy="12" r="3.1"/><circle cx="16.4" cy="12" r="3.1"/><path d="M7.6 12h.01"/><path d="M16.4 12h.01"/>',
  "checks": '<path d="M4.5 13l3.8 3.8 7.7-8.6"/><path d="M11.4 14.4l1.9 2 6.2-6.9"/>',
  "ban": '<circle cx="12" cy="12" r="8.5"/><path d="M6.2 6.2l11.6 11.6"/>',
  "q-circle": '<circle cx="12" cy="12" r="8.5"/><path d="M9.4 9.6a2.6 2.6 0 1 1 3.8 2.3c-.8.4-1.2 1-1.2 1.8v.2"/><path d="M12 17h.01"/>',
  "bang-circle": '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.2v5.6"/><path d="M12 16.6h.01"/>',
  "moon": '<path d="M19.5 14.3A8 8 0 0 1 9.7 4.5a8 8 0 1 0 9.8 9.8z"/>',
  "sun": '<circle cx="12" cy="12" r="4.3"/><path d="M12 3.6V5.8"/><path d="M12 18.2v2.2"/><path d="M3.6 12h2.2"/><path d="M18.2 12h2.2"/><path d="M6.1 6.1l1.6 1.6"/><path d="M16.3 16.3l1.6 1.6"/><path d="M17.9 6.1l-1.6 1.6"/><path d="M7.7 16.3l-1.6 1.6"/>',
  "car": '<path d="M5.2 13.6l1.5-4.3A2 2 0 0 1 8.6 8h6.8a2 2 0 0 1 1.9 1.3l1.5 4.3"/><rect x="3.8" y="13.6" width="16.4" height="3.6" rx="1.1"/><path d="M7.3 17.2v1.6"/><path d="M16.7 17.2v1.6"/>',
  "flag": '<path d="M6 21V4"/><path d="M6 5c2.2-1.4 4.3-1.4 6.5 0s4.3 1.4 6.5 0v8c-2.2 1.4-4.3 1.4-6.5 0s-4.3-1.4-6.5 0"/>'
};
// 常用 emoji→素描形映射表(语义归组共享形;title/aria-label 保留原字符=语义零丢失)。
const EMOJI_SKETCH = (() => {
 // 键由码点构造(源文件零原始 emoji 字形——panel.test emoji 门对源 HTML 的扫描与 097 一致)
  const cp = (...codes) => codes.map((c) => String.fromCodePoint(c)).join("");
  const m = new Map();
  m.set(cp(128512), "face");
  m.set(cp(128515), "face");
  m.set(cp(128516), "face");
  m.set(cp(128513), "face");
  m.set(cp(128578), "face");
  m.set(cp(128522), "face");
  m.set(cp(129392), "face");
  m.set(cp(128525), "face");
  m.set(cp(129321), "face");
  m.set(cp(128526), "face");
  m.set(cp(128519), "face");
  m.set(cp(128514), "joy");
  m.set(cp(129315), "joy");
  m.set(cp(128540), "joy");
  m.set(cp(128541), "joy");
  m.set(cp(129322), "joy");
  m.set(cp(128521), "joy");
  m.set(cp(128517), "sweat");
  m.set(cp(128546), "cry");
  m.set(cp(128557), "cry");
  m.set(cp(129402), "cry");
  m.set(cp(128532), "cry");
  m.set(cp(128564), "sleep");
  m.set(cp(129300), "think");
  m.set(cp(128077), "thumbs-up");
  m.set(cp(128078), "thumbs-down");
  m.set(cp(128079), "clap");
  m.set(cp(128588), "clap");
  m.set(cp(128591), "pray");
  m.set(cp(129309), "pray");
  m.set(cp(128170), "muscle");
  m.set(cp(10084, 65039), "heart");
  m.set(cp(10084), "heart");
  m.set(cp(129655), "heart");
  m.set(cp(128148), "broken");
  m.set(cp(10024), "sparkles");
  m.set(cp(11088), "star");
  m.set(cp(127775), "star");
  m.set(cp(128293), "flame");
  m.set(cp(127881), "party");
  m.set(cp(127882), "party");
  m.set(cp(127880), "party");
  m.set(cp(128640), "rocket");
  m.set(cp(128161), "bulb");
  m.set(cp(128027), "bug");
  m.set(cp(128230), "box");
  m.set(cp(128221), "note");
  m.set(cp(128204), "pin");
  m.set(cp(127919), "target");
  m.set(cp(128295), "wrench");
  m.set(cp(128736, 65039), "wrench");
  m.set(cp(128736), "wrench");
  m.set(cp(129302), "bot");
  m.set(cp(129504), "brain");
  m.set(cp(9889), "bolt");
  m.set(cp(9749), "cup");
  m.set(cp(127912), "palette");
  m.set(cp(129514), "flask");
  m.set(cp(128202), "chart");
  m.set(cp(128200), "chart");
  m.set(cp(128064), "eyes");
  m.set(cp(128175), "checks");
  m.set(cp(9745, 65039), "checks");
  m.set(cp(9745), "checks");
  m.set(cp(9989), "checks");
  m.set(cp(127769), "moon");
  m.set(cp(9728, 65039), "sun");
  m.set(cp(9728), "sun");
  m.set(cp(127968), "home");
  m.set(cp(128663), "car");
  m.set(cp(10060), "fail");
  m.set(cp(11093), "fail");
  m.set(cp(9888, 65039), "warn");
  m.set(cp(9888), "warn");
  m.set(cp(128683), "ban");
  m.set(cp(9940), "ban");
  m.set(cp(10067), "q-circle");
  m.set(cp(10071), "bang-circle");
  m.set(cp(8252, 65039), "bang-circle");
  m.set(cp(8252), "bang-circle");
  m.set(cp(10133), "plus");
  m.set(cp(10134), "minus");
  m.set(cp(9200), "clock");
  m.set(cp(9201, 65039), "clock");
  m.set(cp(9201), "clock");
  m.set(cp(8987), "clock");
  m.set(cp(9203), "clock");
  m.set(cp(128193), "folder");
  m.set(cp(128194), "folder");
  m.set(cp(128450, 65039), "folder");
  m.set(cp(128450), "folder");
  m.set(cp(128269), "search");
  m.set(cp(128270), "search");
  m.set(cp(127464, 127475), "flag");
  m.set(cp(127482, 127480), "flag");
  m.set(cp(127471, 127477), "flag");
  m.set(cp(127468, 127463), "flag");
  m.set(cp(127466, 127482), "flag");
  return m;
})();
function emojiShapeOf(key) { return SKETCH[key] || ICONS[key] || ""; }
// emoji/变体选择符/ZWJ 序列/区域指示对判定(纯 codePointAt 扫描,PAGE 零反斜杠正则纪律)。
function isEmojiCp(cp) {
  if (cp >= 0x1F300 && cp <= 0x1FAFF) return true;
  if (cp >= 0x1F1E6 && cp <= 0x1F1FF) return true; // 区域指示(旗帜)
 // 27xx 丁贝符只收 emoji 呈现形(2705/2714/2716/2728/274C/274E/2753/2754/2755/2757/2764/2795/2796/2797);✓(2713)/✗(2717)等纯文本形不入内容治理
  if (cp === 0x2705 || cp === 0x2714 || cp === 0x2716 || cp === 0x2728 || cp === 0x274C || cp === 0x274E || cp === 0x2753 || cp === 0x2754 || cp === 0x2755 || cp === 0x2757 || cp === 0x2764 || cp === 0x2795 || cp === 0x2796 || cp === 0x2797) return true;
  if (cp >= 0x2600 && cp <= 0x26FF) return true;  // 杂项符号(26xx 段,FE0F 时彩色呈现)
  if (cp >= 0x2B50 && cp <= 0x2B55) return true;  // 2B50-2B55 星/圈
  if (cp === 0x2139 || cp === 0x203C || cp === 0x2049) return true;
  if (cp === 0x231A || cp === 0x231B || cp === 0x23F0 || cp === 0x23F1 || cp === 0x23F2 || cp === 0x23F3 || cp === 0x23E9 || cp === 0x23EA) return true;
  return false;
}
// sketchifyHtml(html):内容层 emoji 主题化总入口(确定性 string→string,mfPatch 新旧对比稳定)。
// 映射命中→内联素描 svg(title/aria-label 保留原字符);未命中→emj-rw 包裹(主题滤镜去彩色);
// <pre>/<code> 上下文强制 emj-rw(字符留在 textContent,复制/搜索保真)。
function sketchifyHtml(html) {
  const s = String(html || "");
  let has = false;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if ((c >= 0xd800 && c <= 0xdfff) || (c >= 0x203c && c <= 0x2bff)) { has = true; break; } }
  if (!has) return s;
  let out = "", inTag = false, codeDepth = 0, i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s.charAt(i);
    if (ch === "<") {
      if (!inTag) {
        if (s.startsWith("<pre", i) || s.startsWith("<code", i)) codeDepth++;
        else if (s.startsWith("</pre", i) || s.startsWith("</code", i)) codeDepth = Math.max(0, codeDepth - 1);
      }
      inTag = true; out += ch; i++; continue;
    }
    if (ch === ">") { inTag = false; out += ch; i++; continue; }
    if (inTag) { out += ch; i++; continue; }
    const cp = s.codePointAt(i);
    if (!isEmojiCp(cp) || (cp >= 0xFE00 && cp <= 0xFE0F)) { out += ch; i += ch.length; continue; } // 孤立变体选择符原样输出(注意:astral 码点数值大于 0xFE00,不可只写上界)
 // 收敛完整 token:基字符(+FE0F)+(ZWJ 级联);区域指示对=双码点旗帜。
    let j = i + (cp > 0xFFFF ? 2 : 1);
    let cp2 = j < n ? s.codePointAt(j) : 0;
    while (cp2 >= 0xFE00 && cp2 <= 0xFE0F) { j += 1; cp2 = j < n ? s.codePointAt(j) : 0; }
    if (cp >= 0x1F1E6 && cp <= 0x1F1FF) { // 旗帜:成对区域指示
      if (cp2 >= 0x1F1E6 && cp2 <= 0x1F1FF) j += 2;
    } else {
      while (cp2 === 0x200D) { // ZWJ 级联:吃掉 ZWJ+下一 emoji(+尾随 FE0F)
        let k = j + 1;
        let cpk = k < n ? s.codePointAt(k) : 0;
        if (!isEmojiCp(cpk)) break;
        k += cpk > 0xFFFF ? 2 : 1;
        let cpk2 = k < n ? s.codePointAt(k) : 0;
        while (cpk2 >= 0xFE00 && cpk2 <= 0xFE0F) { k += 1; cpk2 = k < n ? s.codePointAt(k) : 0; }
        j = k; cp2 = cpk2;
      }
    }
    const raw = s.slice(i, j);
    const baseKey = EMOJI_SKETCH.has(raw) ? raw : (EMOJI_SKETCH.has(String.fromCodePoint(cp)) ? String.fromCodePoint(cp) : "");
    const name = baseKey ? EMOJI_SKETCH.get(baseKey) : "";
    if (name && !codeDepth) {
      out += '<svg class="emj emj-sk" viewBox="0 0 24 24" role="img" aria-label="' + raw + '"><title>' + raw + "</title>" + emojiShapeOf(name) + "</svg>";
    } else {
      out += '<span class="emj emj-rw" title="' + raw + '">' + raw + "</span>";
    }
    i = j;
  }
  return out;
}
// 复刻 ZCode formatTaskRelativeTime(taskListItemPresentation.ts)
function ago(ts) {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return m + "分钟前";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "小时前";
  return Math.floor(h / 24) + "天前";
}
function timeBucket(ts) { // 时间线桶(taskTimelineGroups 全桶对齐:今天/昨天/N天前/本周/上周/本月/上月/更早,周起周一)
  const d = new Date(ts), now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff <= 0) return "今天";
  if (diff === 1) return "昨天";
  if (diff <= 3) return diff + " 天前";
  const dow = (x) => (x.getDay() + 6) % 7; // 0=周一(zh 周)
  if (d.getTime() >= day(now) - dow(now) * 86400000) return "本周";
  if (d.getTime() >= day(now) - (dow(now) + 7) * 86400000) return "上周";
  if (d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()) return "本月";
  const pm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  if (d.getMonth() === pm.getMonth() && d.getFullYear() === pm.getFullYear()) return "上月";
  return "更早";
}
// 复刻 deriveTaskLeadingIndicator 优先级: error红 > running转圈 > queued黄 > idle灰
// interrupted(状态机恢复):外因中断非取消——用 warn 色(可恢复的暂停,不是失败红)。
// ---- 任务进度段(后端可选 task.progress = {phase?,step?,note?,at?}) ----
// 任务对象来自 task.index(前端 tasks Map 无类型),一律防御式读取:任一段非法即跳过,全缺 → 空串零变化。
const TP_STALL_MS = 3 * 60000; // 停滞判定阈值:3 分钟无进展
function taskStallMin(t, now) { // 停滞整分钟数;非 running / at 非法 / at>now(未来戳) / 未满 3 分 → 0
  if (!t || t.state !== "running") return 0;
  const p = t.progress;
  if (!p || typeof p !== "object") return 0;
  const at = p.at;
  if (typeof at !== "number" || !isFinite(at) || at <= 0) return 0;
  const n = typeof now === "number" && isFinite(now) ? now : Date.now();
  const d = n - at;
  if (!(d > TP_STALL_MS)) return 0; // NaN/未来时间戳落到这里 → 0
  return Math.floor(d / 60000);
}
function taskStallCn(min) { // 停滞文案:≥60 分转小时(一位小数)
  return min >= 60 ? "停滞 " + Math.round(min / 6) / 10 + " 小时" : "停滞 " + min + " 分";
}
function taskStallLevel(t, now) { // 色阶:"" 无 / "tp-warn" 3≤分<10 / "tp-stall" ≥10 分
  const m = taskStallMin(t, now);
  if (!m) return "";
  return m >= 10 ? "tp-stall" : "tp-warn";
}
function taskProgressHtml(t, now) { // 阶段 / 第 N 步 / 停滞 三段 · 拼接;非 running/queued/blocked 或全缺 → ""
  if (!t || (t.state !== "running" && t.state !== "queued" && t.state !== "blocked")) return "";
  const p = t.progress && typeof t.progress === "object" ? t.progress : null;
  const segs = [];
  if (p) {
    const ph = typeof p.phase === "string" ? p.phase.trim() : "";
    if (ph) segs.push("阶段 " + ph);
    const st = typeof p.step === "number" && isFinite(p.step) && p.step > 0 ? Math.floor(p.step) : 0;
    if (st) segs.push("第 " + st + " 步");
  }
  const min = taskStallMin(t, now);
  if (min) segs.push(taskStallCn(min));
  if (!segs.length) return "";
 // note 不上正文,只作 hover title
  const note = p && typeof p.note === "string" ? p.note.trim() : "";
  const lvl = taskStallLevel(t, now);
  return '<span class="t-progress' + (lvl ? " " + lvl : "") + '"' + (note ? ' title="' + esc(note) + '"' : "") + ">" + esc(segs.join(" · ")) + "</span>";
}
// 三态兜底文案(queued/running/blocked 无 progress 时不留白);其它状态返回 "" —— 与旧行逐字一致。
function taskMetaHtml(t, now) {
  const h = taskProgressHtml(t, now);
  if (h) return h;
  const word = !t ? "" : t.state === "running" ? "运行中" : t.state === "queued" ? "排队中" : t.state === "blocked" ? "阻塞中" : "";
  return word ? '<span class="t-progress">' + word + "</span>" : "";
}
// running 停滞 ≥10 分:只在属性上加提示(配色与 DOM 结构不动)
function stallAttr(t, now) {
  const m = taskStallMin(t, now);
  if (m < 10) return "";
  const txt = taskStallCn(m) + "无进展";
  return ' title="' + txt + '" aria-label="' + txt + '"';
}
function indicator(t, now) {
 // now 缺省取当前时刻:旧调用点(7517/25673)只传 t,不得因缺参丢停滞提示或抛错
  if (now === undefined || !isFinite(Number(now))) now = Date.now();
  if (t.state === "failed" || t.state === "cancelled") return '<span class="t-dot failed"></span>';
  if (t.state === "running") return '<span class="t-dot running"' + stallAttr(t, now) + "></span>";
  if (t.state === "queued") return '<span class="t-dot queued"></span>';
  if (t.state === "interrupted") return '<span class="t-dot interrupted"></span>';
  return '<span class="t-dot done"></span>';
}
// ---- 项目区(ZCode workspace 移植):状态+渲染+交互 ----
let projects = [];            // [{id,path,label,availability}]
let srvPlatform = "";         // 服务端平台(hello.platform;WSL 连接向导按它区分 Windows 桌面壳/Linux 网关)
// WSL UNC → 服务端 remote:wsl identity(服务端 project.add 自动转换;此处只用于「添加成功了吗」判定)。
// 不用正则:面板脚本在大模板串里,反斜杠要层层转义;用 String.fromCharCode(92) 更稳。
var PATH_BS = String.fromCharCode(92);
function wslUncIdentity(p) {
  var t = String(p || "");
  var low = t.toLowerCase();
  var pre = PATH_BS + PATH_BS;
  var rest = null;
  if (low.indexOf(pre + "wsl.localhost" + PATH_BS) === 0) rest = t.slice((pre + "wsl.localhost" + PATH_BS).length);
  else if (low.indexOf(pre + "wsl$" + PATH_BS) === 0) rest = t.slice((pre + "wsl$" + PATH_BS).length);
  if (rest === null) return null;
  var i = rest.indexOf(PATH_BS), j = rest.indexOf("/");
  var cut = i < 0 ? j : (j < 0 ? i : Math.min(i, j));
  if (cut <= 0) return null;
  var distro = rest.slice(0, cut);
  var tail = rest.slice(cut).split(PATH_BS).join("/");
  while (tail.charAt(0) === "/") tail = tail.slice(1);
  while (tail.length && tail.charAt(tail.length - 1) === "/") tail = tail.slice(0, -1);
  return "remote:wsl:" + distro + ":/" + tail;
}
function projPathMatches(target) {
  if (projects.some(function (p) { return p.path === target; })) return true;
  var id = wslUncIdentity(target);
  return !!id && projects.some(function (p) { return p.path === id; });
}
let activeProjectId = null;
function projectById(id) { return projects.find((p) => p.id === id) || null; }
/** 当前页面缩放系数(body.style.zoom 唯一写入口=settings.zoom 应用处;未设/非法回退 computed). */
function menuZoom() {
  const raw = String(document.body.style.zoom || "");
  const v = parseFloat(raw);
  if (v > 0) return v;
  const c = parseFloat(getComputedStyle(document.body).zoom || "");
  return c > 0 ? c : 1;
}
// ---- 通用右键/操作菜单:任务行/项目行/文件树共用 #taskMenu 载体 ----
function openMenuAt(items, x, y) {
  const menu = $("taskMenu");
 // 菜单项支持 hint(悬停 title)/dim(说明行不可点)——harness 根项目「不可移除」说明走此通道(ref 各 workspace 等权可移除是本仓有意分歧,补说明防误报 bug)。
  menu.innerHTML = items.map((it, i) => '<div class="tm-item" data-i="' + i + '"' + (it.hint ? ' title="' + esc(it.hint) + '"' : "") + (it.dim ? ' style="opacity:.55;cursor:default"' : "") + ">" + esc(it.label) + "</div>").join("");
  for (const el of menu.querySelectorAll(".tm-item")) {
    const it = items[Number(el.dataset.i)];
    if (it && it.dim) { el.onclick = (e) => e.stopPropagation(); continue; } // 说明行:点击不收菜单不执行
    el.onclick = () => { menu.style.display = "none"; items[Number(el.dataset.i)].act(); };
  }
  menu.style.left = "0px";
  menu.style.top = "0px";
  menu.style.display = "block";
 // 经验证尺寸后定位:默认锚在光标(左上对齐);越出视口才翻转(右→左对齐光标,下→底对齐光标),不再按项数估算高度
 // body 有 CSS zoom 时 position:fixed 的 left/top 是「布局 px」,屏幕位置 = left*zoom,而 e.clientX/Y 是视口 px
 // (不经 zoom)。经验证(Chromium, zoom=1.25):left=100 → rect.left=125、rect.width=offsetWidth*1.25。
 // 故光标与视口边界必须先除 zoom 换进菜单的布局坐标系,left/top 才与鼠标重合;否则菜单按 zoom 倍数朝右下漂移、
 // 且 125% 下靠近右下角照样出屏(越界判据与菜单宽高不在同一空间)。zoom=1 时下面 4 个变量与原式逐像素相同。
  const z = menuZoom();
  const cx = x / z, cy = y / z, vw = window.innerWidth / z, vh = window.innerHeight / z;
  const w = menu.offsetWidth, h = menu.offsetHeight;
  let left = cx, top = cy;
  if (left + w > vw - 8) left = vw - w - 8;
  if (top + h > vh - 8) top = cy - h;
  menu.style.left = Math.max(8, left) + "px";
  menu.style.top = Math.max(8, top) + "px";
}
function copyText(s) { if (navigator.clipboard) navigator.clipboard.writeText(s); toast("已复制"); }

function renderProjects() {
  const box = $("projList");
 // (ZCode onboarding):新用户列表为空(仅内部 conversation workspace)时给引导入口
  if (!projects.length) {
    box.innerHTML = '<div style="padding:8px 10px;color:var(--faint);font-size:11px;line-height:1.7">尚未打开项目。<br>点击下方「+ 添加项目」,或' +
      '<a href="javascript:void(0)" id="emptyBrowse" style="color:var(--bronze)">打开文件夹</a> / ' +
      '<a href="javascript:void(0)" id="emptyRemote" style="color:var(--bronze)">远程连接</a>。</div>';
    const eb = document.getElementById("emptyBrowse");
    if (eb) eb.onclick = () => { $("projAddBtn").click(); $("projBrowseBtn").click(); };
    const er = document.getElementById("emptyRemote");
    if (er) er.onclick = () => { $("projAddBtn").click(); prOpen(); };
    return;
  }
  box.innerHTML = projects.map((p) =>
    '<div class="proj-row' + (p.id === activeProjectId ? " on" : "") + '" data-pid="' + esc(p.id) + '" title="' + esc(p.path) + '">' +
    '<span class="p-lab">' + esc(p.label) + '</span>' +
    ((p.path || "").indexOf("remote:") === 0 ? '<span class="p-un" style="color:var(--bronze);border-color:var(--bronze)" title="SSH 远程项目">远程</span>' : '') +
    (p.availability !== "available" ? '<span class="p-un" title="目录暂不可访问(相关任务将使用默认工作区)">不可用</span>' : '') +
    '<span class="p-prof" data-prof="' + esc(p.id) + '" title="项目档案:架构图/模块/演进(异步构建)">档案</span>' +
    '<span class="p-more" data-more="' + esc(p.id) + '" title="更多操作">…</span>' +
    '</div>').join("");
  const act = projectById(activeProjectId);
  $("projName").textContent = act ? act.label : "尚未打开项目"; // act 恒有(harness 默认工作区在列)
  if (!projects.length) $("projCnt").textContent = "";
  for (const row of box.querySelectorAll(".proj-row")) {
    row.onclick = (e) => {
      const prof = e.target.dataset && e.target.dataset.prof;
      if (prof) { openProfile(prof); return; }
      const more = e.target.dataset && e.target.dataset.more;
      if (more) {
        e.stopPropagation(); // 冒泡到 document 的全局点击监听会把刚开的菜单立刻关掉
        const r = row.getBoundingClientRect();
        openProjectMenu(more, r.left + 8, r.bottom + 4);
        return;
      }
      wsSafeSend(JSON.stringify({ v: 1, type: "project.activate", projectId: row.dataset.pid }));
    };
 // 右键行任意处 = 更多操作菜单(ZCode 项目行右键语义)
    row.oncontextmenu = (e) => { e.preventDefault(); openProjectMenu(row.dataset.pid, e.clientX, e.clientY); };
  }
}
function projectRemoveConfirmed(id) {
  const running = [...tasks.values()].filter((t) => t.projectId === id && t.state === "running").length;
  const p = projectById(id);
 // 运行中项目专用确认(ref WorkspaceSidebarItem.tsx:349-368 removeRunningWorkspace +
 // zh-CN.ts:1523-1527):独立标题/描述/危险色确认钮,如实传达「历史任务不会被删除」。
  if (running > 0) {
    uiConfirm("该项目有 " + running + " 个运行中任务。移除项目会停止并释放相关运行状态,历史任务不会被删除;其会话转入「任 务」栏,运行中的任务将自动切回默认工作区。", {
      title: "移除运行中的项目?", tone: "danger", okClass: "danger", ok: "移除并停止运行",
    }).then((ok) => { if (ok) wsSafeSend(JSON.stringify({ v: 1, type: "project.remove", projectId: id })); });
    return;
  }
  uiConfirm("移除项目 “" + (p ? p.label : "") + "” ?(不删除任何文件;其会话转入「任 务」栏,运行中的任务将自动切回默认工作区)", { tone: "warning" }).then((ok) => {
    if (ok) wsSafeSend(JSON.stringify({ v: 1, type: "project.remove", projectId: id }));
  });
}
function openProjectMenu(id, x, y) {
  const p = projectById(id);
  if (!p) return;
  openMenuAt([
    { label: "新建任务(此项目)", act: () => { wsSafeSend(JSON.stringify({ v: 1, type: "project.activate", projectId: id })); newDraft(); } },
    { label: "查看文件", act: () => { wsSafeSend(JSON.stringify({ v: 1, type: "project.activate", projectId: id })); switchView("files"); } },
    { label: "项目档案", act: () => openProfile(id) },
    { label: "重命名", act: () => { uiPrompt("项目显示名:", p.label).then((v) => { if (v !== null && v.trim()) wsSafeSend(JSON.stringify({ v: 1, type: "project.rename", projectId: id, label: v.trim() })); }); } },
    { label: "在文件管理器中显示", act: () => wsSafeSend(JSON.stringify({ v: 1, type: "fs.open", path: p.path, reveal: true })) },
    { label: "复制路径", act: () => copyText(p.path) },
 // 根工作区不可移除说明(ref 各 workspace 等权 vs 本仓 __harness__ 保护=有意分歧;dim 行只说明不可点)
    ...((p.path || "").indexOf("remote:") === 0 ? [
      { label: "优化远程连接", hint: "在远端安装轻量辅助组件,文件浏览与编辑更快更稳", act: () => { toast("正在配置远端环境…(自动上传并检测)"); wsSafeSend(JSON.stringify({ v: 1, type: "remote.deploy", projectId: id })); } },
      { label: "检查连接", hint: "重新测试这台服务器能否连通", act: () => { wsSafeSend(JSON.stringify({ v: 1, type: "project.add", path: p.path })); toast("正在检查连接…"); } },
    ] : []),
    ...(id === "__harness__" ? [{ label: "根工作区不可移除", dim: true, hint: "harness 本体项目是默认工作区,不提供移除(有意保护,非缺陷)" }] : [{ label: "移除项目", hint: "移除入口;不删文件,历史任务保留", act: () => projectRemoveConfirmed(id) }]),
  ], x, y);
}
function setupProjectAdd() {
  $("projAddBtn").onclick = () => {
    const box = $("projAdd");
    const opening = box.style.display === "none";
    box.style.display = opening ? "" : "none";
 // 桌面壳默认 Windows 工作区:占位符按平台给例子(远程项目走连接向导)
    $("projPathInput").placeholder = srvPlatform === "win32"
      ? "或粘贴 Windows 绝对路径,如 C:" + String.fromCharCode(92) + "Users" + String.fromCharCode(92) + "…(WSL/SSH 请用「远程连接」)"
      : "或粘贴绝对路径,如 /home/u/myapp(WSL/SSH 请用「远程连接」)";
    if (opening) { $("projPathInput").value = ""; $("projPathInput").focus(); }
  };
  $("projAddCancel").onclick = () => { $("projAdd").style.display = "none"; };
 // 打开文件夹 = 服务端目录浏览器(gateway 在 WSL,浏览真实 /home 路径);
 // 旧 webkitdirectory 选择器只能拿 Windows 侧相对路径,已删(视频问题 #2/#3 根治)。
  $("projBrowseBtn").onclick = () => { dbOpen(""); };
  $("projRemoteBtn").onclick = () => { prOpen(); };
  const submit = () => {
    const path = $("projPathInput").value.trim();
    if (!path) return;
    pendingAddPath = path;
    wsSafeSend(JSON.stringify({ v: 1, type: "project.add", path }));
    $("projAdd").style.display = "none";
 // 注意修复:harness 本体/已在列表/校验失败时服务端幂等返回,面板无感知=「添加没反应」;
 // 3s 后若列表仍无此 path 则明确告知(harness 本体按设计不进列表)
    setTimeout(() => {
      if (pendingAddPath !== path) return;
      pendingAddPath = null;
      const hit = projPathMatches(path);
      if (!hit) toast("该目录未加入列表:若它是 harness 默认工作区则无需添加(已在当前工作区);否则检查路径是否存在/是否已在列表", true);
    }, 3000);
  };
  $("projAddGo").onclick = submit;
  $("projPathInput").onkeydown = (e) => { if (e.key === "Enter") submit(); };
}
setupProjectAdd();

// ---- 目录浏览器(T2/T3):服务端 fs.list 驱动,「选择此目录」直接 project.add ----
let dbSelPath = null;
let pendingAddPath = null; // 添加项目待验证(3s 未入列 → 明确提示,防「添加没反应」)
let dbParent = null; // 服务端回的上级目录(根为 null)
function dbOpen(path) {
  $("dirBrowser").classList.add("on");
  $("dbErr").textContent = "";
  dbList(path || "__home__");
}
$("dbClose").onclick = () => $("dirBrowser").classList.remove("on");
$("dirBrowser").onclick = (e) => { if (e.target === $("dirBrowser")) $("dirBrowser").classList.remove("on"); };
function dbList(path, showHidden) {
 // "__home__" 是 UI 哨兵;服务端契约:path="" → 锚点应答
  wsSafeSend(JSON.stringify({ v: 1, type: "fs.list", path: path === "__home__" ? "" : path, showHidden: showHidden === undefined ? $("dbHidden").checked : showHidden }));
}
$("dbUp").onclick = () => { if (dbParent) dbList(dbParent); };
$("dbGo").onclick = () => dbList($("dbPath").value.trim());
$("dbPath").onkeydown = (e) => { if (e.key === "Enter") dbList($("dbPath").value.trim()); };
for (const a of document.querySelectorAll(".db-anchor")) a.onclick = () => dbList(a.dataset.p === "__home__" ? "__home__" : a.dataset.p);
$("dbHidden").onchange = () => dbList($("dbPath").value.trim() || "__home__");
$("dbPick").onclick = () => {
  const cur = $("dbPath").value.trim();
  const target = dbSelPath || (cur && cur !== "__home__" ? cur : null);
  if (!target) { toast("先在列表中选中一个目录", true); return; }
  pendingAddPath = target;
  wsSafeSend(JSON.stringify({ v: 1, type: "project.add", path: target }));
  $("dirBrowser").classList.remove("on");
  $("projAdd").style.display = "none";
  setTimeout(() => {
    if (pendingAddPath !== target) return;
    pendingAddPath = null;
    const hit = projPathMatches(target);
    if (!hit) toast("该目录未加入列表:若它是 harness 默认工作区则无需添加;否则检查路径是否存在", true);
  }, 3000);
};
function dbRender(m) {
  if (m.error) { $("dbErr").textContent = m.error; return; }
  const anchors = m.anchors;
  const cur = m.path === "" ? (anchors ? anchors.home : "/") : m.path;
  $("dbPath").value = cur;
  $("dbErr").textContent = "";
  dbSelPath = null;
  dbParent = m.path === "" ? null : (m.parent !== undefined ? m.parent : null);
  $("dbSel").textContent = "";
  const rows = [];
  if (m.path === "") {
    rows.push('<div class="db-row" data-p="' + esc(anchors.home) + '"><span class="ic">' + ic("home") + '</span><span class="nm">主目录(' + esc(anchors.home) + ")</span></div>");
 // 连接向导口径:WSL/SSH 项目不再从本地目录选择器添加(避免绕过「先连接→装服务→
 // 服务返回目录」流程),这里只给指路提示;本地选择器保持纯 Windows 路径语义。
    if ((anchors.wsl || []).length) {
      rows.push('<div class="db-row" style="opacity:.75;cursor:default" data-p=""><span class="ic">i</span><span class="nm">WSL 项目请用「远程连接 → WSL」:先连接并装好工作区服务,再由服务返回目录</span></div>');
    }
    rows.push('<div class="db-row" data-p="' + esc(anchors.root || "/") + '"><span class="ic">/</span><span class="nm">' + esc(anchors.rootLabel || "根目录") + '</span></div>');
  } else {
    const base = cur.replace(/[/\\\\]+$/, "");
 // 子项拼接:按当前路径方言选分隔符(Windows UNC/盘符用 \,POSIX 用 /)。
    const child = (name) => (base.indexOf("\\\\") >= 0 ? base + "\\\\" + name : (base || "") + "/" + name);
    for (const en of m.entries) {
      if (en.kind !== "dir") continue; // 选目录:只列目录
      rows.push('<div class="db-row" data-p="' + esc(child(en.name)) + '"><span class="ic">' + ic("folder") + '</span><span class="nm">' + esc(en.name) + '</span><span class="mt">' + new Date(en.mtime).toLocaleDateString() + "</span></div>");
    }
    if (!rows.length) rows.push('<div class="cc-empty">没有子目录(可点「选择此目录」选当前)</div>');
  }
  $("dbList").innerHTML = rows.join("");
  for (const el of $("dbList").querySelectorAll(".db-row")) {
    el.onclick = () => {
      for (const s of $("dbList").querySelectorAll(".db-row.sel")) s.classList.remove("sel");
      el.classList.add("sel");
      dbSelPath = el.dataset.p;
      $("dbSel").textContent = dbSelPath;
    };
    el.ondblclick = () => dbList(el.dataset.p);
  }
}

// ---- 远程连接向导(T4):SSH/WSL/Docker 三形态;命令复用 wizard.gen(节点注册) ----
let wizOutTarget = "wizOut"; // wizard.gen.result 写入目标(节点页/添加项目向导二选一)
function prOpen() { $("projRemote").classList.add("on"); prRenderBody(null); }
$("prClose").onclick = () => $("projRemote").classList.remove("on");
$("projRemote").onclick = (e) => { if (e.target === $("projRemote")) $("projRemote").classList.remove("on"); };
function prRenderBody(kind) {
  prConn = null;   // 切换/重开向导:清空上一轮连接与浏览态(防回包串台)
  prBrowse = null;
  const tabs = document.querySelectorAll(".pr-tab2");
  for (const t of tabs) t.classList.toggle("on", t.dataset.kind === kind);
  const imp = $("prConfigImport");
  const go = $("prGo");
  $("prSub").textContent = "";
  const inp = 'width:100%;background:var(--input-bg);border:1px solid var(--input-border);border-radius:7px;color:var(--text);font-size:11px;padding:6px 8px;outline:none';
  const lbl = 'font-size:10px;color:var(--faint);margin:8px 0 3px';
  if (kind === "wsl") {
    imp.style.display = "none"; go.style.display = "none";
 // 连接向导:先连接发行版 → 连接过程中安装工作区服务 → 验证可用 →
 // 由服务返回目录(不是 UNC 浏览) → 选一个项目目录添加。SSH 同一套。
    const winShell = srvPlatform === "win32";
    if (!winShell) {
      $("prBody").innerHTML = '<div class="note" style="font-size:11px;color:var(--faint);line-height:1.8">gateway 运行在 Linux/WSL 中——WSL 内的项目目录直接用<b> 打开文件夹 </b>浏览即可(能看到 /home 真实路径),无需连接。</div>';
      return;
    }
    $("prBody").innerHTML = '<div style="font-size:11px;color:var(--faint);line-height:1.8;margin-bottom:6px">先连接发行版:连接过程中安装<b>工作区服务</b>(<span style="color:var(--text)">~/.genie</span>,首次要求发行版内已装 node),确认可用后由服务返回目录,再选一个项目目录添加。</div>' +
      '<div id="prWslList" style="margin-top:4px"><div class="cc-empty loading">正在枚举发行版…</div></div>' +
      '<div id="prWslOut" style="margin-top:8px;font-size:11px;color:var(--faint);line-height:1.7"></div>';
    wsSafeSend(JSON.stringify({ v: 1, type: "wsl.list" }));
    return;
  }
  if (kind === "docker") {
    imp.style.display = "none"; go.style.display = "none";
    $("prBody").innerHTML = '<div class="note" style="font-size:11px;color:var(--faint);line-height:1.8">本地容器作为执行节点接入(任务委派执行;远程工作区直连见 SSH)。生成接入命令后在容器内执行,节点会出现在「节点」页。</div>' +
      '<div style="display:flex;gap:6px;margin-top:8px"><input id="prDockerImage" placeholder="镜像,如 node:20-alpine" style="' + inp + ';flex:1"><button id="prDockerGen" style="background:transparent;border:1px solid var(--border-soft);color:var(--bronze);border-radius:7px;font-size:11px;padding:5px 12px;cursor:pointer">生成接入命令</button></div><div id="prDockerOut" style="margin-top:6px;font-size:10px;color:var(--faint)"></div>';
    $("prDockerGen").onclick = () => { wizOutTarget = "prDockerOut"; wsSafeSend(JSON.stringify({ v: 1, type: "wizard.gen", kind: "docker", host: $("prDockerImage").value.trim() || "node:20-alpine", user: "root", port: 22, nodeId: "docker-node" })); };
    return;
  }
 // ── SSH:完整表单(ZCode 新建连接形态)──
  imp.style.display = ""; go.style.display = "";
  $("prBody").innerHTML =
    '<div style="' + lbl + '">主机</div><input id="prHost" placeholder="输入主机地址或 IP,例如 192.168.1.100" style="' + inp + '">' +
    '<div style="display:flex;gap:8px;margin-top:6px"><div style="flex:1"><div style="' + lbl + '">用户名</div><input id="prUser2" placeholder="输入用户名,例如 root" style="' + inp + '"></div>' +
    '<div style="width:90px"><div style="' + lbl + '">端口</div><input id="prPort2" value="22" style="' + inp + '"></div></div>' +
    '<div style="' + lbl + '">认证方式</div><div class="seg" id="prAuth"><button data-v="password" class="on">密码</button><button data-v="key">私钥</button></div>' +
    '<div id="prAuthBody"></div>' +
    '<div id="prConnOut" style="margin-top:8px;font-size:11px;color:var(--faint);line-height:1.7"></div>';
  let authKind = "password";
  const authBody = () => {
    $("prAuthBody").innerHTML = authKind === "password"
      ? '<div style="' + lbl + '">SSH 密码</div><input id="prPass" type="password" placeholder="输入 SSH 密码" style="' + inp + '">'
      : '<div style="' + lbl + '">私钥(粘贴 PEM 全文;或从 SSH config 导入自动读取)</div><textarea id="prKey" rows="4" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" style="' + inp + ';resize:vertical;font-family:var(--mono,monospace)"></textarea>' +
        '<div style="' + lbl + '">私钥口令(可选)</div><input id="prKeyPass" type="password" placeholder="无口令留空" style="' + inp + '">';
  };
  authBody();
  for (const b of document.querySelectorAll("#prAuth button")) b.onclick = () => {
    for (const x of document.querySelectorAll("#prAuth button")) x.classList.remove("on");
    b.classList.add("on"); authKind = b.dataset.v; authBody();
  };
  imp.innerHTML = '<option value="">从 SSH config 导入</option>';
  wsSafeSend(JSON.stringify({ v: 1, type: "ssh.config.list" }));
  imp.onchange = () => {
    const e = prConfigEntries.find((x) => x.alias === imp.value);
    if (!e) return;
    $("prHost").value = e.host; $("prUser2").value = e.user || "root"; $("prPort2").value = String(e.port || 22);
    if (e.identityFile) { for (const b of document.querySelectorAll("#prAuth button")) if (b.dataset.v === "key") b.click(); const k = $("prKey"); if (k) { k.value = "(保存时将自动读取密钥文件)"; k.dataset.file = e.identityFile; } }
    toast("已导入 " + e.alias);
  };
  go.onclick = () => {
    const host = $("prHost").value.trim(), user = $("prUser2").value.trim() || "root", port = Number($("prPort2").value) || 22;
    if (!host) { toast("先填主机地址", true); return; }
    prConn = { host, user, port };
    const H = host.toUpperCase().replace(/[^A-Z0-9]/g, "_"), U = user.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    if (authKind === "password") {
      const pass = ($("prPass") || {}).value || "";
      if (!pass) { toast("输入 SSH 密码", true); return; }
      $("prConnOut").textContent = "① 保存凭证 → ② 测试连接 → ③ 添加项目 → ④ 准备远端环境…";
      wsSafeSend(JSON.stringify({ v: 1, type: "cfg.secret.set", name: "GENIE_SSH_" + H + "_" + U, value: pass, rid: "prconn-pw" }));
    } else {
      const k = $("prKey") || {};
      const keyText = k.value || "";
      const keyFile = k.dataset ? k.dataset.file : "";
      if (keyFile) {
        $("prConnOut").textContent = "① 读取密钥 → ② 测试连接 → ③ 添加项目 → ④ 准备远端环境…";
        wsSafeSend(JSON.stringify({ v: 1, type: "ssh.key.import", path: keyFile, host, user }));
      } else {
        if (!keyText.trim()) { toast("粘贴私钥内容,或切换密码认证", true); return; }
        $("prConnOut").textContent = "① 保存密钥 → ② 测试连接 → ③ 添加项目 → ④ 准备远端环境…";
        wsSafeSend(JSON.stringify({ v: 1, type: "cfg.secret.set", name: "GENIE_SSHKEY_" + H + "_" + U, value: keyText, rid: "prconn-key" }));
      }
    }
  };
}
let prConn = null;           // 新建连接会话态({kind:"ssh",host,user,port}|{kind:"wsl",distro})
let prConfigEntries = [];    // SSH config 导入条目
let prBrowse = null;         // 连接向导目录浏览态({kind,distro|host/port/user,path,parent});目录由服务返回

/** WSL:连接发行版(连接过程中装服务;wsl.test 回 ok 才进入目录浏览)。 */
function prWslConnect(distro) {
  prConn = { kind: "wsl", distro };
  prBrowse = null;
  const out = $("prWslOut");
  if (out) out.textContent = "① 连接发行版 → ② 安装工作区服务 → ③ 验证服务…";
  wsSafeSend(JSON.stringify({ v: 1, type: "wsl.test", distro }));
}
/** 连接成功后的服务目录浏览器(SSH/WSL 共用;挂到当前向导 body 里)。 */
function prShowBrowser() {
  let box = $("prBrowseBox");
  if (!box) {
    box = document.createElement("div");
    box.id = "prBrowseBox";
    box.style.cssText = "margin-top:10px;border-top:1px solid var(--border-soft);padding-top:8px";
    $("prBody").appendChild(box);
  }
  box.innerHTML = '<div style="display:flex;align-items:center;gap:6px"><button id="prBrUp" title="上级目录" style="background:transparent;border:1px solid var(--border-soft);color:var(--text);border-radius:6px;font-size:11px;padding:2px 8px;cursor:pointer">↑</button><span id="prBrPath" style="flex:1;font-size:11px;color:var(--text);word-break:break-all"></span></div>' +
    '<div id="prBrList" style="margin-top:6px;max-height:220px;overflow:auto;border:1px solid var(--border-soft);border-radius:8px"><div class="cc-empty loading">读取中…</div></div>' +
    '<div style="display:flex;justify-content:flex-end;margin-top:8px"><button id="prBrPick" style="background:var(--bronze);border:none;color:#111;border-radius:7px;font-size:11px;padding:5px 14px;cursor:pointer;font-weight:600">选择此目录 →</button></div>';
  $("prBrUp").onclick = () => { if (prBrowse && prBrowse.parent) prBrowseGo(prBrowse.parent); };
  $("prBrPick").onclick = () => prPickProject();
}
/** 经工作区服务列目录(不是 UNC 直读)。 */
function prBrowseGo(path) {
  if (!prBrowse) return;
  prBrowse.path = path;
  const p = $("prBrPath"); if (p) p.textContent = path;
  const list = $("prBrList"); if (list) list.innerHTML = '<div class="cc-empty loading">读取中…</div>';
  if (prBrowse.kind === "wsl") wsSafeSend(JSON.stringify({ v: 1, type: "wsl.browse", distro: prBrowse.distro, path: path }));
  else wsSafeSend(JSON.stringify({ v: 1, type: "ssh.browse", host: prBrowse.host, port: prBrowse.port, username: prBrowse.user, path: path }));
}
function prRenderBrowse(m) {
  if (!prBrowse) return;
  const list = $("prBrList"); if (!list) return;
  if (m.error) { list.innerHTML = '<div class="cc-empty">读取失败:' + esc(m.error) + '</div>'; return; }
  prBrowse.parent = m.parent || null;
  if (m.path) { prBrowse.path = m.path; const p = $("prBrPath"); if (p) p.textContent = m.path; }
  const dirs = (m.entries || []).filter(function (e) { return e.kind === "dir"; });
  list.innerHTML = dirs.length ? dirs.map(function (e) {
    return '<div class="pr-br-row" data-n="' + esc(e.name) + '" style="padding:5px 10px;font-size:11px;cursor:pointer;border-bottom:1px solid var(--border-soft)">' + esc(e.name) + '</div>';
  }).join("") : '<div class="cc-empty">无子目录(可选当前目录)</div>';
  for (const el of list.querySelectorAll(".pr-br-row")) el.onclick = function () {
    const base = prBrowse.path === "/" ? "" : prBrowse.path;
    prBrowseGo(base + "/" + el.dataset.n);
  };
}
function prPickProject() {
  const f = prBrowse; if (!f) return;
  const id = f.kind === "wsl"
    ? "remote:wsl:" + f.distro + ":" + f.path
    : "remote:ssh:" + f.host + ":" + f.port + ":" + f.user + ":" + f.path;
  $("projRemote").classList.remove("on");
  toast("已添加项目:" + f.path);
  wsSafeSend(JSON.stringify({ v: 1, type: "project.add", path: id }));
  prConn = null; prBrowse = null;
}
for (const t of document.querySelectorAll(".pr-tab2")) t.onclick = () => prRenderBody(t.dataset.kind);
$("prCancel").onclick = () => $("projRemote").classList.remove("on");
// SSH config 列表回包 → 填充导入下拉
// (新建连接:prconn 全链 = 凭证→测试→加项目→部署;每步回包驱动下一)

for (const c of document.querySelectorAll(".pr-card")) c.onclick = () => prRenderBody(c.dataset.kind);

// ---- 项目文件树(T6/T1):fs.list 懒展开;右键 = 打开/复制路径/添加到聊天 ----
const dirCache = new Map();     // absPath -> entries[](fs.list.result 统一落这里;目录浏览器/文件树共用)
const filesPending = new Set(); // 在飞 fs.list(防渲染循环重发)
/** 目录缓存键失效集:rootAbs 自身 + 全部后代键(纯字符串前缀匹配;remote://<pid>[/rel] 伪根同样成立)。
 * 空 root 返空集(不做全清:全清是目录浏览器 #filesRefresh 的语义,树刷新只该清子树)。 */
function treeCacheKeysUnder(keys, rootAbs) {
  const root = String(rootAbs || "");
  if (!root) return [];
  const pre = root + "/";
  const out = [];
  for (const k of keys) { const s = String(k); if (s === root || s.indexOf(pre) === 0) out.push(s); }
  return out;
}
/** 树刷新统一入口:失效 root 及其全部子孙的目录缓存与在飞标记(展开态不动)。
 * 渲染时缺缓存的目录会重新发 fs.list,不会留永久「加载中」。 */
function invalidateTreeCache(rootAbs) {
  for (const k of treeCacheKeysUnder(dirCache.keys(), rootAbs)) dirCache.delete(k);
  for (const k of treeCacheKeysUnder(filesPending.values(), rootAbs)) filesPending.delete(k);
}
let filesRootPath = null;
const filesExpanded = new Set(JSON.parse(localStorage.getItem("zh:files-expand") || "[]"));
function filesRootProject() { return projectById(activeProjectId); }
// 远程项目文件树(ZCode remote workspace UI 切片):remote:ssh 项目走 remote.ls/read;
// 伪根键 remote://<projectId> 进 dirCache 同一缓存通道,walk/展开/渲染零分叉
let remoteLsSink = null;
let remoteReadSink = null;
function filesRemoteProject() {
  const p = filesRootProject();
  return p && p.path && p.path.indexOf("remote:") === 0 ? p : null;
}
function filesRootKey() {
  const rp = filesRemoteProject();
  return rp ? "remote://" + rp.id : filesRootPath;
}
// 远程文件预览弹层(简单只读;二进制/错误如实)
function remotePreview(name, m) {
  let host = document.getElementById("remotePv");
  if (!host) {
    host = document.createElement("div");
    host.id = "remotePv";
    host.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center";
    host.onclick = (e) => { if (e.target === host) host.remove(); };
    document.body.appendChild(host);
  }
  const NL = String.fromCharCode(10); // 仓规:模板内联脚本禁用转义序列
  const body = m.binary ? "<i>(二进制文件 " + (m.bytes ?? "?") + "B,不预览)</i>"
    : m.error ? "<i>读取失败:" + esc(m.error) + "</i>"
    : '<pre style="margin:0;white-space:pre-wrap;max-height:60vh;overflow:auto">' + esc(m.content || "(空)") + (m.truncated ? NL + "…(截断)" : "") + "</pre>";
  host.innerHTML = '<div style="background:var(--bg-soft,#1e1e1e);color:var(--text,#ddd);border:1px solid var(--border-soft,#333);border-radius:10px;padding:14px;max-width:72vw;width:640px;box-shadow:0 8px 40px rgba(0,0,0,.4)">' +
    '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><b style="font-size:12px">' + esc(name) + '</b><span style="font-size:10px;color:var(--faint,#888)">远程 · 只读</span><button onclick="this.parentElement.parentElement.remove()" style="margin-left:auto;cursor:pointer;background:transparent;border:1px solid var(--border-soft,#333);color:inherit;border-radius:6px;font-size:11px;padding:2px 10px">关闭</button></div>' +
    body + "</div>";
}
function filesLoad() {
  const p = filesRootProject();
  if (p && p.availability !== "available") {
    filesRootPath = null;
    $("filesRoot").textContent = p.label + "(目录不可用)";
    $("filesTree").innerHTML = '<div class="cc-empty">项目目录暂不可访问;恢复目录或重新添加项目后即可浏览</div>';
    return;
  }
  filesRootPath = p ? p.path : null;
  $("filesRoot").textContent = p ? (p.label + " · " + p.path) : "无项目(harness)";
  if (filesRemoteProject()) $("filesRoot").textContent = p.label + " · 远程(SSH 文件树)";
  filesRender();
}
function filesRender() {
  const tree = $("filesTree");
  if (!filesRootPath) { tree.innerHTML = '<div class="cc-empty">无可用项目根(先添加项目)</div>'; return; }
  const rows = [];
  const walk = (abs, rel, depth) => {
    const entries = dirCache.get(abs);
    if (!entries) {
      rows.push('<div class="ft-row" style="padding-left:' + (10 + depth * 14) + 'px"><span class="ic">…</span><span class="nm">加载中</span></div>');
      if (!filesPending.has(abs)) {
        filesPending.add(abs);
        const rp = filesRemoteProject();
        if (rp) wsSafeSend(JSON.stringify({ v: 1, type: "remote.ls", projectId: rp.id, path: rel }));
        else wsSafeSend(JSON.stringify({ v: 1, type: "fs.list", path: abs, showHidden: true }));
      }
      return;
    }
    const indent = "padding-left:" + (10 + depth * 14) + "px";
    for (const en of entries) {
      const childRel = rel ? rel + "/" + en.name : en.name;
      const childAbs = abs + "/" + en.name;
      if (en.kind === "dir") {
        const open = filesExpanded.has(childRel);
        rows.push('<div class="ft-row dir" data-abs="' + esc(childAbs) + '" data-rel="' + esc(childRel) + '" style="' + indent + '"><span class="chev">' + (open ? ic("chev-down") : ic("chev-right")) + '</span><span class="ic">' + ic("folder") + '</span><span class="nm">' + esc(en.name) + "</span></div>");
        if (open) walk(childAbs, childRel, depth + 1);
      } else {
        rows.push('<div class="ft-row file" data-abs="' + esc(childAbs) + '" data-rel="' + esc(childRel) + '" style="' + indent + '"><span class="chev"></span><span class="ic">' + ic("file") + '</span><span class="nm">' + esc(en.name) + "</span></div>");
      }
    }
  };
  walk(filesRootKey(), "", 0);
  tree.innerHTML = rows.join("") || '<div class="cc-empty">(空目录或全部隐藏)</div>';
  for (const el of tree.querySelectorAll(".ft-row.dir")) {
    el.onclick = () => {
      const rel = el.dataset.rel;
      if (filesExpanded.has(rel)) filesExpanded.delete(rel); else filesExpanded.add(rel);
      localStorage.setItem("zh:files-expand", JSON.stringify([...filesExpanded].slice(-200)));
      filesRender();
    };
    el.oncontextmenu = (e) => { e.preventDefault(); filesMenu(el.dataset.abs, el.dataset.rel, true, e.clientX, e.clientY); };
  }
  for (const el of tree.querySelectorAll(".ft-row.file")) {
    el.onclick = () => {
      for (const s of tree.querySelectorAll(".ft-row.sel")) s.classList.remove("sel");
      el.classList.add("sel");
      const rp = filesRemoteProject();
      if (rp) { // 远程文件:remote.read → 只读预览弹层
        remoteReadSink = (m) => { remoteReadSink = null; remotePreview(el.dataset.rel, m); };
        wsSafeSend(JSON.stringify({ v: 1, type: "remote.read", projectId: rp.id, path: el.dataset.rel }));
      } else fvOpen(el.dataset.rel, 1); // file.read 沙箱=激活项目根,与树根一致
    };
    el.oncontextmenu = (e) => { e.preventDefault(); filesMenu(el.dataset.abs, el.dataset.rel, false, e.clientX, e.clientY); };
  }
}
function filesMenu(abs, rel, isDir, x, y) {
  const items = [];
  const rp = filesRemoteProject();
  if (!isDir) {
    items.push(rp
      ? { label: "打开(远程预览)", act: () => { remoteReadSink = (m) => { remoteReadSink = null; remotePreview(rel, m); }; wsSafeSend(JSON.stringify({ v: 1, type: "remote.read", projectId: rp.id, path: rel })); } }
      : { label: "打开(预览)", act: () => { switchView("chat"); fvOpen(rel, 1); } });
    if (!rp) items.push({ label: "系统默认打开", act: () => wsSafeSend(JSON.stringify({ v: 1, type: "fs.open", path: abs })) });
  }
  if (!rp) items.push({ label: "在文件管理器中显示", act: () => wsSafeSend(JSON.stringify({ v: 1, type: "fs.open", path: abs, reveal: true })) });
  else if (isDir) items.push({ label: "远程打开此目录(展开)", act: () => { filesExpanded.add(rel); localStorage.setItem("zh:files-expand", JSON.stringify([...filesExpanded].slice(-200))); filesRender(); } });
  items.push({ label: "复制绝对路径", act: () => copyText(abs) });
  items.push({ label: "复制相对路径", act: () => copyText(rel) });
  if (!isDir) items.push({ label: "添加到聊天", act: () => { const inp = $("instruction"); inp.value = (inp.value.trim() + " " + buildFileMention(rel, "file")).trim() + " "; switchView("chat"); fileRefRender(); inp.focus(); } });
  openMenuAt(items, x, y);
}
$("filesRefresh").onclick = () => { dirCache.clear(); filesPending.clear(); filesLoad(); };
$("filesCollapse").onclick = () => { filesExpanded.clear(); localStorage.setItem("zh:files-expand", "[]"); filesRender(); };

let archView = false, pendingRewind = null;
function rowTitle(t) { if (!t) return ""; return t.title || t.instruction || String(t.id || "").slice(0, 8); } // /169b:标题优先取索引 title(TaskIndex 必有;instruction 仅本地已缓存正文时才有)
function openTaskMenu(t, x, y) {
 // 「这些删不掉」：侧栏一行=一个会话（ 聚合），旧菜单只有「删除任务」且只发单条
 // taskId——同会话另外 N 条照旧撑住该行，看起来根本没删掉。拆成「删除本条 / 删除本会话全部 N 条」。
  const sessCount = [...tasks.values()].filter((x2) => x2.sessionId === t.sessionId).length;
  const items = [
    { label: "重命名", act: () => { uiPrompt("新标题(留空恢复默认):", t.title || t.instruction || "", { allowEmpty: true }).then((v) => { if (v !== null) wsSafeSend(JSON.stringify({ v: 1, type: "task.rename", taskId: t.id, title: v })); }); } },
    { label: t.pinned ? "取消置顶" : "置顶", act: () => wsSafeSend(JSON.stringify({ v: 1, type: "task.pin", taskId: t.id, pinned: !t.pinned })) },
    { label: "移入分组…", act: () => { uiPrompt("分组名(空=移出分组):", t.group || "", { allowEmpty: true }).then((v) => { if (v !== null) wsSafeSend(JSON.stringify({ v: 1, type: "task.group", taskId: t.id, group: v.trim() || null })); }); } },
    { label: t.archived ? "取消归档" : "归档", act: () => wsSafeSend(JSON.stringify({ v: 1, type: "task.archive", taskId: t.id, archived: !t.archived })) },
    { label: "从此任务分叉", act: () => forkTask(t) },
    { label: "删除本条任务", act: () => { uiConfirm("彻底删除任务「" + rowTitle(t).slice(0, 30) + "」?(不可恢复;归档可保留历史)", { tone: "danger" }).then((ok) => { if (ok) wsSafeSend(JSON.stringify({ v: 1, type: "task.delete", taskId: t.id })); }); } },
    ...(sessCount > 1 ? [{ label: "删除本会话全部 " + sessCount + " 条任务", act: () => { uiConfirm("彻底删除该会话的 " + sessCount + " 条任务?(不可恢复;归档可保留历史)", { tone: "danger" }).then((ok) => { if (ok) { wsSafeSend(JSON.stringify({ v: 1, type: "task.deleteSession", sessionId: t.sessionId })); sessionModelOverride.delete(t.sessionId); sessionModelStaged.delete(t.sessionId); } }); } }] : []),
    { label: "回滚到此任务前", act: () => { pendingRewind = t.id; wsSafeSend(JSON.stringify({ v: 1, type: "checkpoint.preview", taskId: t.id })); } },
  ];
  openMenuAt(items, x, y);
}
document.addEventListener("click", (e) => { if (!$("taskMenu").contains(e.target)) $("taskMenu").style.display = "none"; });
$("tt-arch").onclick = () => {
  archView = !archView;
  $("tt-arch").classList.toggle("arch-on", archView);
  renderSidebar();
};
function bindArchClear() {
  const el = $("archClear");
  if (el) el.onclick = () => {
    const n = [...tasks.values()].filter((t) => t.archived).length;
    if (n) uiConfirm("清空全部 " + n + " 条归档任务?(不可恢复)", { tone: "danger" }).then((ok) => { if (ok) wsSafeSend(JSON.stringify({ v: 1, type: "archive.clear" })); });
  };
}
// ---- ZCode WorkspaceSidebar 深拷贝状态(purpose 分区/桶顺序/归档分页 ----
// 偏好校验按 ZCode 同款逐字段验证,坏值重置;展开态缺省=true(workspaceExpansionPreference 语义)。
function loadPurpose() {
  try {
    const v = JSON.parse(localStorage.getItem("zh:sb-purpose") || "null");
    if (v && typeof v === "object" && Array.isArray(v.order) && v.order.length === 2 && v.order.every((k) => k === "projects" || k === "tasks") && new Set(v.order).size === 2)
      return { projectsExpanded: v.projectsExpanded !== false, tasksExpanded: v.tasksExpanded !== false, order: v.order };
  } catch (e) {}
  return { projectsExpanded: true, tasksExpanded: true, order: ["projects", "tasks"] };
}
let purpose = loadPurpose();
let projectOrder = (() => { try { const v = JSON.parse(localStorage.getItem("zh:sb-project-order") || "[]"); if (Array.isArray(v)) return v.filter((x) => typeof x === "string"); } catch (e) {} return []; })();
let archShowAll = false; // ZCode ArchivedTasksFlatSection:total>20 时 show all/less 二态,不持久化
let tasksLimit = 20;     // 任务分区首屏 20,show more +20(ZCode WorkspaceTimelineTasksSection)
let lastBucketKeys = []; // 全部展开/收起按钮的数据源(本次渲染的可见桶键)
function persistPurpose() { localStorage.setItem("zh:sb-purpose", JSON.stringify(purpose)); }
function persistProjectOrder() { localStorage.setItem("zh:sb-project-order", JSON.stringify(projectOrder)); }
// ZCode taskListOrdering:运行中整体置顶(按创建时间降序;禁用 updatedAt——流式事件会让排序来回跳)。
// 非运行组与组内次序改按「会话最近活动时间」actOf = max(活动, updatedAt, createdAt)。
// live 组仍按 createdAt 定序(流式期间不跳变),仅在活组内时间相同时回落活动时间。
function runFirstCmp(a, b) {
  const live = (x) => x.state === "running" || x.state === "queued"; // queued 同 running 置顶口径(会话聚合 running=running|queued,cmp 需同口径,否则两行互换跳变)
  const ar = live(a), br = live(b);
  if (ar !== br) return ar ? -1 : 1;
  if (settings.sortBy === "created") return (b.createdAt - a.createdAt) || 0;
  return (actOf(b) - actOf(a)) || (b.createdAt - a.createdAt) || 0;
}
// 会话行标题粘性(ref taskIndexRepo.ts:1328-1330 同步 snapshot 保留已覆盖标题 +
// session-mgmt.ts:132-136 custom 粘性):用户 rename 置 titleCustom 后,会话行标题不再被
// 后续新任务的 instruction 派生标题顶掉;取该会话内最新一条 custom 标题,无 custom 才回默认派生轨。
function sessionRowTitle(ts) {
  const custom = [...ts].filter((x) => x.titleCustom && x.title).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
  return custom ? custom.title : rowTitle(ts[0]);
}
function renderFoldBtn() {
  const keys = lastBucketKeys;
  const allOpen = keys.length > 0 && keys.every((k) => !bucketCollapsed.has(k));
  $("tt-fold").textContent = allOpen ? "全收" : "全展";
  $("tt-fold").title = allOpen ? "收起全部分组" : "展开全部分组";
}
function applyTaskMask() {
 // ZCode 滚动渐隐 mask:内容溢出且未到顶/底时施加 28px 渐变(挂滚动容器本体,非 overlay 层)
  const el = $("taskList");
  if (!el) return;
  const over = el.scrollHeight > el.clientHeight + 4;
  const top = over && el.scrollTop > 4, bot = over && el.scrollTop + el.clientHeight < el.scrollHeight - 4;
  let g = "";
  if (top && bot) g = "linear-gradient(to bottom, rgba(0,0,0,0) 0, #000 28px, #000 calc(100% - 28px), rgba(0,0,0,0) 100%)";
  else if (top) g = "linear-gradient(to bottom, rgba(0,0,0,0) 0, #000 28px)";
  else if (bot) g = "linear-gradient(to bottom, #000 calc(100% - 28px), rgba(0,0,0,0) 100%)";
  el.style.maskImage = g;
  el.style.webkitMaskImage = g;
}
function renderSidebar() {
  let list = [...tasks.values()];
 // F5 一键沉淀:当前会话存在已终态任务时可见(renderSidebar 是 openSession/render 共同路径)
  const hasSettled = !!currentSid && list.some((t) => t.sessionId === currentSid && (t.state === "done" || t.state === "failed"));
  const dBtn = $("expDistillBtn");
  if (dBtn) dBtn.style.display = hasSettled ? "" : "none";
 // F3:归档视图=只看归档;默认视图=排除归档;置顶区恒在顶部(ZCode PinnedTasks 语义)。
  const pinned = archView ? [] : list.filter((t) => t.pinned && !t.archived);
  list = archView ? list.filter((t) => t.archived) : list.filter((t) => !t.archived && !t.pinned);
 // 会话唯一聚合——侧栏一栏 = 一个 session(此前按任务逐条渲染,一个 query 一栏)。
 // 栏态=聚合态:任一子任务 running 即运行中;标题/时间取最新一条;角标=会话内任务数。
  {
    const pinnedSids = new Set(list.filter((t) => t.pinned).map((t) => t.sessionId));
    const bySess = new Map();
    for (const t of list) {
      if (pinnedSids.has(t.sessionId)) continue; // 置顶会话单独成区,不进主列表
      let ts = bySess.get(t.sessionId);
      if (!ts) { ts = []; bySess.set(t.sessionId, ts); }
      ts.push(t);
    }
    list = [...bySess.values()].map((ts) => {
      ts.sort((a, b) => b.updatedAt - a.updatedAt);
      const running = ts.some((x) => x.state === "running" || x.state === "queued");
      let add = 0, del = 0, files = 0;
      for (const x of ts) { const ds = diffstats.get(x.id); if (ds && ds.total) { files += ds.total.files || 0; add += ds.total.add || 0; del += ds.total.del || 0; } }
      return { ...ts[0], title: sessionRowTitle(ts), state: running ? "running" : ts[0].state, __count: ts.length, __files: files, __add: add, __del: del };
    }).sort(runFirstCmp);
  }
 // 归档分页(ZCode ArchivedTasksFlatSection:20 条上限 + show all/less)
  if (archView && !archShowAll && list.length > 20) list = list.slice(0, 20);
 // 无可见项目时不把任务总数挂在「尚未打开项目」后面;任务仍在「任 务」区可见。
  $("projCnt").textContent = activeProjectId && list.length ? String(list.length) : "";
  const buckets = [];
  if (organize === "project") {
 // 按项目分桶(ZCode organizeByProject)。归属三分(修正口径):
 // ①已注册项目(含 harness 本体=独立项目,与其它项目同权进「项 目」分区);
 // ②无 projectId 的会话→__unowned__(「任 务」分区);
 // ③projectId 指向已移除项目→同样归 __unowned__(不再渲染「已移除项目」幽灵桶;服务端 remove/启动 scrub 会先清干净)。
    const byProj = new Map();
    for (const t of list) {
      const pid = t.projectId && projectById(t.projectId) ? t.projectId : "__unowned__";
      if (!byProj.has(pid)) byProj.set(pid, []);
      byProj.get(pid).push(t);
    }
    for (const [pid, items] of byProj) {
      const p = projectById(pid) || { label: "(无归属)" };
      buckets.push({ key: "proj:" + pid, pid, label: p.label, items });
    }
 // 桶顺序=拖拽排序结果(zh:sb-project-order;未登记的按自然序垫底)
    const natIdx = new Map(buckets.map((b2, i) => [b2.pid, i]));
    buckets.sort((x, y) => {
      const ox = projectOrder.indexOf(x.pid), oy = projectOrder.indexOf(y.pid);
      return (ox === -1 ? 1000 + natIdx.get(x.pid) : ox) - (oy === -1 ? 1000 + natIdx.get(y.pid) : oy);
    });
  }
  else if (organize === "group") {
 // F3 自定义分组:task.group 用户桶;无分组任务落「(未分组)」尾置。
    const byGrp = new Map();
    for (const t of list) {
      const g = String(t.group || "").trim() || "__ungrouped__";
      if (!byGrp.has(g)) byGrp.set(g, []);
      byGrp.get(g).push(t);
    }
    const keys = [...byGrp.keys()].sort((a, b) => {
      if (a === "__ungrouped__") return 1;
      if (b === "__ungrouped__") return -1;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    for (const k of keys) buckets.push({ key: "grp:" + k, label: k === "__ungrouped__" ? "(未分组)" : k, items: byGrp.get(k) });
  }
  else {
    const order = ["今天", "昨天", "2 天前", "3 天前", "本周", "上周", "本月", "上月", "更早"];
    for (const b of order) buckets.push({ key: "time:" + b, label: b, items: list.filter((t) => timeBucket(t.updatedAt) === b) });
  }
  for (const b of buckets) b.items.sort(runFirstCmp); // 桶内同样运行置顶(ZCode taskListOrdering)
  const bucketHead = (b, collapsed) => {
    const isProj = organize === "project";
 // harness 也在注册表(projects.ts 默认项目 __harness__,path=harness 根,永在)——文件树/更多与其它项目同权
    const reg = b.pid ? projectById(b.pid) : null;
    const live = b.items.filter((x) => x.state === "running" || x.state === "queued").length;
    return '<div class="t-bucket t-bh" data-bk="' + esc(b.key) + '" data-pid="' + esc(b.pid || "") + '" role="button" tabindex="0" aria-expanded="' + (!collapsed) + '">' +
      (isProj && reg && b.pid !== "__harness__" ? '<span class="bh-grip" data-grip title="拖动排序"></span>' : "") +
      '<span class="bh-chev">' + (collapsed ? ic("chev-right") : ic("chev-down")) + '</span><span class="bh-label">' + esc(b.label) + '</span>' +
      (collapsed && live ? '<span class="bh-live" title="' + live + ' 条在跑"><i></i>' + (live > 1 ? String(live) : "") + '</span>' : "") +
      '<span class="bh-ct">' + b.items.length + "</span>" +
      '<span class="bh-acts">' + (isProj && reg ? '<span class="bh-new" data-new title="新建任务(此项目)">+</span>' : "") +
      (isProj && reg ? '<span class="bh-files" data-files title="文件树">' + ic("folder") + "</span>" : "") +
      (isProj && reg ? '<span class="bh-ide" data-ide="' + esc(b.pid) + '" title="IDE 编辑器">IDE</span>' : "") +
      (isProj && reg ? '<span class="bh-more" data-more title="更多操作">…</span>' : "") + "</span></div>";
  };
  const bucketRows = (b) => {
    const lim = showLimit[b.key] || 5; // 复刻 WORKSPACE_TASK_PAGE_SIZE=5
    let shown = b.items.slice(0, lim);
 // 激活会话的行永不被分页截断(ZCode: active task 恒可见)——命令中心打开旧会话时必须能看到选中态
    if (currentSid) {
      for (const t of b.items) if (t.sessionId === currentSid && !shown.includes(t)) shown.push(t);
    }
 // 分桶折叠(项目内 session 可折叠;折叠态跨刷新持久)。折叠仍显示激活会话行(active-visible 语义)。
    const collapsed = bucketCollapsed.has(b.key);
    if (collapsed) shown = shown.filter((t) => t.sessionId === currentSid);
 // 折叠桶此前只留激活行、被吞掉的条数零提示 → 用户以为「session 漏了」。
 // 现在折叠态显式给出被隐藏条数(与桶头 bh-ct 总数并列),展开出口在桶头 chevron。
    const hiddenCt = collapsed ? Math.max(0, b.items.length - shown.length) : 0;
    let h = bucketHead(b, collapsed) + shown.map((t) =>
      '<div class="t-row' + (t.sessionId === currentSid ? " sel" : "") + '" data-sid="' + esc(t.sessionId) + '" title="' + esc(rowTitle(t)) + '">' +
      indicator(t, Date.now()) + (t.pinned ? '<span class="t-pin">顶</span>' : "") + '<span class="t-title">' + esc(rowTitle(t)) + "</span>" + taskMetaHtml(t, Date.now()) + (t.__count > 1 ? '<span class="t-ct">' + t.__count + "</span>" : "") +
      (t.__files ? '<span class="t-ds" title="变更统计"><span class="da">+' + t.__add + '</span><span class="dd">-' + t.__del + "</span></span>" : "") +
 // 归档行时间用任务时间戳(按归档时点读);活跃视图用会话活动时间
      '<span class="t-time">' + (archView ? ago(t.updatedAt) : ago(actOf(t))) + '</span>' +
      (t.state === "interrupted" ? '<span class="t-acts"><span class="ta-b ta-resume" data-resume="' + esc(t.id) + '" data-sid="' + esc(t.sessionId) + '" title="任务被网关重启打断,点击续跑(同会话继续)">续跑</span></span>' : "") +
      (archView ? '<span class="t-acts"><span class="ta-b" data-unarch data-sid="' + esc(t.sessionId) + '">取档</span><span class="ta-b ta-del" data-delrow data-sid="' + esc(t.sessionId) + '">删</span></span>' : "") + '</div>'
    ).join("");
    if (hiddenCt > 0) h += '<div class="t-fold" style="padding:2px 8px 6px;font-size:10px;color:var(--faint)">已折叠 ' + hiddenCt + ' 条(点桶头展开)</div>';
    if (!collapsed && b.items.length > lim) h += '<div class="t-more" data-key="' + esc(b.key) + '">显示更多(还有 ' + (b.items.length - lim) + " 条)</div>";
    return h;
  };
  lastBucketKeys = buckets.filter((b) => b.items.length).map((b) => b.key);
  let html = "";
  let shownAny = false;
  if (organize === "project" && !archView) {
 // purpose 双分区(ZCode workspacePurpose 二分; 修正口径):「项 目」=按注册项目分桶,
 // harness 本体是独立项目(harness 桶在此区,与其它项目同权);「任 务」=无归属会话(无 projectId
 // 或项目已移除),分区头带 新建/文件树 动作,折叠态显 live 徽标。
    const uBucket = buckets.find((b) => b.pid === "__unowned__");
    const projBuckets = buckets.filter((b) => b.pid !== "__unowned__");
    lastBucketKeys = projBuckets.filter((b) => b.items.length).map((b) => b.key);
    const tempSessions = (uBucket ? uBucket.items : []).sort(runFirstCmp);
    const projBody = projBuckets.filter((b) => b.items.length).map((b) => bucketRows(b)).join("");
    const taskItems = tempSessions.slice(0, tasksLimit);
    if (currentSid && !taskItems.some((t) => t.sessionId === currentSid)) {
      const cur = tempSessions.find((t) => t.sessionId === currentSid);
      if (cur) taskItems.push(cur);
    }
    const taskLive = tempSessions.filter((t) => t.state === "running" || t.state === "queued").length;
    const taskBody = (taskItems.length ? taskItems.map((t) =>
      '<div class="t-row' + (t.sessionId === currentSid ? " sel" : "") + '" data-sid="' + esc(t.sessionId) + '" title="' + esc(rowTitle(t)) + '">' +
      indicator(t, Date.now()) + '<span class="t-title">' + esc(rowTitle(t)) + "</span>" + taskMetaHtml(t, Date.now()) + (t.__count > 1 ? '<span class="t-ct">' + t.__count + "</span>" : "") +
      (t.__files ? '<span class="t-ds"><span class="da">+' + t.__add + '</span><span class="dd">-' + t.__del + "</span></span>" : "") +
      '<span class="t-time">' + ago(actOf(t)) + '</span>' +
      (t.state === "interrupted" ? '<span class="t-acts"><span class="ta-b ta-resume" data-resume="' + esc(t.id) + '" data-sid="' + esc(t.sessionId) + '" title="任务被网关重启打断,点击续跑(同会话继续)">续跑</span></span>' : "") + '</div>').join("") : '<div class="t-bucket" style="padding-top:6px">还没有任务</div>') +
      (tempSessions.length > taskItems.length ? '<div class="t-more" data-key="sec:tasks">显示更多(还有 ' + (tempSessions.length - taskItems.length) + " 条)</div>" : "");
    const secHead = (key, label, open, act, live) => '<div class="t-bucket t-bh sb-sec" data-sec="' + key + '" role="button" tabindex="0" aria-expanded="' + open + '"><span class="bh-grip" title="拖动排序"></span><span class="bh-chev">' + (open ? ic("chev-down") : ic("chev-right")) + '</span><span class="bh-label">' + label + '</span>' + (!open && live ? '<span class="bh-live" title="' + live + ' 条在跑"><i></i>' + (live > 1 ? String(live) : "") + '</span>' : "") + '<span class="bh-acts">' + act + "</span></div>";
    for (const key of purpose.order) {
      if (key === "projects") {
        html += secHead("projects", "项 目", purpose.projectsExpanded, '<span class="bh-new" id="secAddProj" title="添加项目">+</span>') + (purpose.projectsExpanded ? (projBody || '<div class="t-bucket" style="padding:2px 8px 6px">尚未打开项目</div>') : "");
      } else {
        html += secHead("tasks", "任 务", purpose.tasksExpanded, '<span class="bh-new" id="secNewTask" title="新建任务">+</span><span class="bh-files" id="secFtH" title="文件树(harness)">' + ic("folder") + '</span><span class="bh-ide" id="secIdeH" data-ide="__harness__" title="IDE 编辑器(harness 工作区)">IDE</span>', taskLive) + (purpose.tasksExpanded ? taskBody : "");
      }
    }
    shownAny = true;
  } else {
    for (const b of buckets) {
      if (!b.items.length) continue;
      html += bucketRows(b);
      shownAny = true;
    }
    if (archView && list.length >= 20) html += '<div class="t-more" id="archToggle">' + (archShowAll ? "收起" : "显示全部 " + list.length + " 条归档") + "</div>";
  }
  if (!shownAny) html = '<div class="t-bucket" style="padding-top:14px">暂无任务</div>';
  if (archView) html = '<div class="t-bucket" style="display:flex;justify-content:space-between;align-items:center">归档视图<span class="tm-item" id="archClear" style="color:var(--red);font-size:10px">清空归档</span></div>' + html;
  $("taskList").innerHTML = html;
  $("taskList").classList.toggle("sticky-heads", organize === "group" && !archView);
  bindArchClear();
  const at = $("archToggle");
  if (at) at.onclick = () => { archShowAll = !archShowAll; renderSidebar(); };
 // 归档行内动作(ZCode ArchivedTasksFlatSection:取消归档/删除,作用到该会话全部任务)
  for (const b2 of $("taskList").querySelectorAll("[data-unarch]")) {
    b2.onclick = (e) => {
      e.stopPropagation();
      for (const x of tasks.values()) if (x.sessionId === b2.dataset.sid && x.archived) wsSafeSend(JSON.stringify({ v: 1, type: "task.archive", taskId: x.id, archived: false }));
    };
  }
  for (const b2 of $("taskList").querySelectorAll("[data-delrow]")) {
    b2.onclick = (e) => {
      e.stopPropagation();
      const ids = [...tasks.values()].filter((x) => x.sessionId === b2.dataset.sid).map((x) => x.id);
      if (!ids.length) return;
      uiConfirm("彻底删除该会话的 " + ids.length + " 个任务?(不可恢复;归档可保留历史)", { tone: "danger" }).then((ok) => {
        if (ok) for (const id of ids) wsSafeSend(JSON.stringify({ v: 1, type: "task.delete", taskId: id }));
      });
    };
  }
 // interrupted 一键续跑(状态机恢复):服务端 resumeInterrupted 幂等重提
 // (idempotencyKey=resume:<原id>),双击/重连不双跑;原任务转 cancelled(被续跑替代)。
  for (const b2 of $("taskList").querySelectorAll("[data-resume]")) {
    b2.onclick = (e) => {
      e.stopPropagation();
      wsSafeSend(JSON.stringify({ v: 1, type: "task.resume", taskId: String(b2.dataset.resume || "") }));
      toast("已发起续跑(同会话继续)");
    };
  }
 // F3 置顶区
  if (pinned.length) {
    const seenSess = new Set();
    const pinnedRows = pinned.filter((t) => !seenSess.has(t.sessionId) && seenSess.add(t.sessionId)).map((t) =>
 // 置顶区会话行同走 custom 粘性标题(与主列表同源,用户改名不被派生标题顶掉)
      '<div class="t-row' + (t.sessionId === currentSid ? " sel" : "") + '" data-sid="' + esc(t.sessionId) + '">' +
      indicator(t) + '<span class="t-title">' + esc(sessionRowTitle(pinned.filter((x) => x.sessionId === t.sessionId))) + '</span><span class="t-time">' + ago(t.updatedAt) + '</span></div>').join("");
    $("taskList").innerHTML = '<div class="t-bucket">置顶</div>' + pinnedRows + $("taskList").innerHTML;
  }
  for (const row of $("taskList").querySelectorAll(".t-row")) {
    row.onclick = () => openSession(row.dataset.sid);
    row.oncontextmenu = (e) => {
      e.preventDefault();
      const t = [...tasks.values()].find((x) => x.sessionId === row.dataset.sid);
      if (t) openTaskMenu(t, e.clientX, e.clientY);
    };
  }
  for (const more of $("taskList").querySelectorAll(".t-more")) {
    more.onclick = () => {
      if (more.dataset.key === "sec:tasks") { tasksLimit += 20; renderSidebar(); return; } // ZCode timeline show more = +20
      showLimit[more.dataset.key] = (showLimit[more.dataset.key] || 5) + 5;
      renderSidebar();
    };
  }
 // 桶头点击(ZCode applyWorkspaceTriggerSelection 语义):收起态点击=展开+打开该项目(草稿);
 // 展开态点击=仅折叠。group/time 桶无激活语义,纯折叠。
  for (const bh of $("taskList").querySelectorAll(".t-bh[data-bk]")) {
    bh.onclick = (e) => {
      if (e.target.closest(".bh-acts") || e.target.closest(".bh-grip")) return;
      const k = bh.dataset.bk;
      if (bucketCollapsed.has(k)) {
        bucketCollapsed.delete(k);
 // 收起态点击=展开+打开该项目(harness 本体也是项目,同样激活;无归属桶无项目可激活)
        if (organize === "project" && bh.dataset.pid && bh.dataset.pid !== "__unowned__")
          wsSafeSend(JSON.stringify({ v: 1, type: "project.activate", projectId: bh.dataset.pid }));
      } else {
        bucketCollapsed.add(k);
      }
      localStorage.setItem("zh:bucket-collapse", JSON.stringify([...bucketCollapsed]));
      renderSidebar();
    };
    bh.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); bh.click(); } };
 // 桶头右键 = 项目菜单(光标处;ZCode workspace 行右键语义)
    bh.oncontextmenu = (e) => {
      if (e.target.closest(".bh-acts") || e.target.closest(".bh-grip")) return;
      if (organize === "project" && bh.dataset.pid && projectById(bh.dataset.pid)) { e.preventDefault(); openProjectMenu(bh.dataset.pid, e.clientX, e.clientY); }
    };
  }
 // 桶头行内动作:+(新建任务此项目)/…(项目菜单;ZCode 收进行内 "..." 菜单的形态)
  for (const nw of $("taskList").querySelectorAll(".bh-new[data-new]")) {
    nw.onclick = (e) => {
      e.stopPropagation();
      const pid = nw.closest(".t-bh").dataset.pid;
 // + = 新建任务(此项目):harness 本体同样是项目,先激活再开草稿(否则草稿落当前激活项目)
      if (pid && pid !== "__unowned__") wsSafeSend(JSON.stringify({ v: 1, type: "project.activate", projectId: pid }));
      newDraft();
    };
  }
  for (const mo of $("taskList").querySelectorAll(".bh-more[data-more]")) {
    mo.onclick = (e) => {
      e.stopPropagation();
      const pid = mo.closest(".t-bh").dataset.pid;
      const r = mo.getBoundingClientRect();
      openProjectMenu(pid, r.left, r.bottom + 4);
    };
  }
 // 桶头文件树按钮(ZCode ListTree 行内动作):滑入层打开该项目目录树
  for (const fb of $("taskList").querySelectorAll(".bh-files[data-files]")) {
    fb.onclick = (e) => {
      e.stopPropagation();
      sbFtOpen(fb.closest(".t-bh").dataset.pid);
    };
  }
 // 桶头「IDE」( B):激活项目 → 开 #view-ide(树根=该项目工作区)
  for (const ib of $("taskList").querySelectorAll(".bh-ide[data-ide]")) {
    ib.onclick = (e) => {
      e.stopPropagation();
      const pid = ib.dataset.ide || (ib.closest(".t-bh") ? ib.closest(".t-bh").dataset.pid : "") || activeProjectId || "__harness__";
      if (pid && projectById(pid) && pid !== activeProjectId) wsSafeSend(JSON.stringify({ v: 1, type: "project.activate", projectId: pid }));
      ideOpen(pid); // 显式传 pid:activate 回包前 activeProjectId 仍是旧值,不传会把树根落错项目
    };
  }
 // purpose 分区头:点击折叠/展开(持久化 zh:sb-purpose);分区 + 动作
  for (const sec of $("taskList").querySelectorAll(".sb-sec")) {
    sec.onclick = (e) => {
      if (e.target.closest(".bh-acts")) return;
      const k = sec.dataset.sec;
      if (k === "projects") purpose.projectsExpanded = !purpose.projectsExpanded;
      else purpose.tasksExpanded = !purpose.tasksExpanded;
      persistPurpose();
      renderSidebar();
    };
    sec.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); sec.click(); } };
  }
  const addP = document.getElementById("secAddProj");
  if (addP) addP.onclick = (e) => { e.stopPropagation(); const b = document.getElementById("projAddBtn"); if (b) b.click(); };
  const addT = document.getElementById("secNewTask");
  if (addT) addT.onclick = (e) => { e.stopPropagation(); newDraft(); };
  const ftH = document.getElementById("secFtH");
  if (ftH) ftH.onclick = (e) => { e.stopPropagation(); sbFtOpen("__harness__"); };
 // 「任 务」分区头「IDE」( B):harness 工作区 IDE
  const ideH = document.getElementById("secIdeH");
  if (ideH) ideH.onclick = (e) => { e.stopPropagation(); ideOpen(); };
 // 拖拽把手:项目桶排序(vertical-only,只位移不缩放;顺序持久化 zh:sb-project-order)
  for (const g of $("taskList").querySelectorAll(".bh-grip[data-grip]")) {
    g.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      startSidebarDrag("bucket", g.closest(".t-bh").dataset.pid, g.closest(".t-bh"), e);
    });
  }
  renderFoldBtn();
  wireSecGrips();
  applyTaskMask();
}
function chip(name, args) {
  let a = ""; try { const o = JSON.parse(args); a = o.query || o.instructions || o.target || o.name || o.template || ""; } catch (e) { a = String(args); }
  return '<span class="ev-chip">» ' + esc(name) + '<span class="a"> ' + esc(String(a).slice(0, 60)) + '</span></span>';
}
// 轻量 markdown(ZCode streamdown 的零依赖裁剪):围栏/行内代码/粗体/标题/列表/链接。
// 模板字面量纪律:代码围栏字符用 fromCharCode(96) 构造,禁止反斜杠转义与反引号入 PAGE。
const BT = String.fromCharCode(96);
`;
