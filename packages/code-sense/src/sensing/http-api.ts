/**
 * sensing/http-api( / §2.1):HTTP 接口确定性提取。
 * pageflow 同款方法论:纯行扫描(零 ts-morph/零 tree-sitter,与 的 Python 提取核心零交叠),
 * 每条 endpoint 带 {file,line} 证据;框架指纹预筛(grep 级)后才读文件,大仓秒级。
 * 覆盖形态(设计稿 §2.1 表):
 *   TS/JS:express/koa/fastify(app.METHOD/router.METHOD+use 前缀)、Next.js 文件约定;
 *   Python:FastAPI(@app.METHOD/APIRouter(prefix)+include_router)、Flask(@app.route/@bp.route+
 *          Blueprint(url_prefix)+register_blueprint)、aiohttp(web.METHOD/add_routes/add_get 族);
 *   Java:Spring(@RestController+@RequestMapping 类级前缀 × @*Mapping 方法级);
 *   Go:gin(r.GET 族)/net-http(http.HandleFunc)/gorilla mux(HandleFunc+Methods)。
 * 诚实边界(设计稿砍量):裸 node createServer if-chain 路由不支持(无确定性形态);
 * 跨文件挂载解析不到=prefixInferred 标注,不猜前缀值。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface ApiEndpoint {
  method: string;           // GET/POST/.../ANY;WS 端点 method="WS"
  path: string;             // 前缀合成后的路径(如 /v1/users/{id})
  handler?: string;         // 具名 handler 符号(内联函数=undefined)
  handlerInline?: boolean;  // handler 是匿名/箭头函数
  file: string;             // 仓内相对路径
  line: number;             // 证据行(路由声明行)
  framework: string;        // fastapi/flask/aiohttp/express/koa/fastify/nextjs/spring/gin/net-http/mux
  kind: "http" | "ws";
  /** 路由对象的前缀在本文件解析不到(跨文件挂载)——path 只含本地已知部分,如实标注。 */
  prefixInferred?: boolean;
  /** 确定性摘录:docstring 首行 / 紧邻注释(非 LLM 产物)。 */
  docHint?: string;
}

export interface ApiSurface {
  endpoints: ApiEndpoint[];
  /** 检出到的框架(去重)。 */
  frameworks: string[];
  /** 参与扫描的候选文件数(指纹预筛后)。 */
  scannedFiles: number;
}

// ---------- 框架指纹预筛(内容含任一才进入行扫描) ----------
const FINGERPRINTS: { framework: string; re: RegExp }[] = [
  { framework: "fastapi", re: /from\s+fastapi\s+import|import\s+fastapi/ },
  { framework: "flask", re: /from\s+flask\s+import|import\s+flask/ },
  { framework: "flask-restful", re: /flask_restful|flask-restful|flask_restx|flask-restx/ },
  { framework: "aiohttp", re: /aiohttp(\.web|\s+import\s+web)|from\s+aiohttp\s+import/ },
  { framework: "starlette", re: /starlette/ },
  { framework: "tornado", re: /tornado|web\.Application|add_handlers|handlers\.append/ },
  { framework: "express", re: /require\(["']express["']\)|from\s+["']express["']|import\s+express\b/ },
  { framework: "koa", re: /koa-router|@koa\/router|from\s+["']koa["']/ },
  { framework: "fastify", re: /require\(["']fastify["']\)|from\s+["']fastify["']/ },
  { framework: "nextjs", re: /next\/server|NextResponse/ },
  { framework: "spring", re: /@RestController|@RequestMapping|@(Get|Post|Put|Delete|Patch)Mapping/ },
  { framework: "gin", re: /gin-gonic\/gin/ },
  { framework: "net-http", re: /["']net\/http["']/ },
  { framework: "mux", re: /gorilla\/mux/ },
  { framework: "chi", re: /go-chi\/chi|chi\.Router|RouteRegister/ },
];

export function detectFrameworks(text: string): string[] {
  const out: string[] = [];
  for (const f of FINGERPRINTS) if (f.re.test(text)) out.push(f.framework);
  return out;
}

const HTTP_METHODS = new Set(["get", "post", "put", "delete", "patch", "head", "options"]);
const WS_METHODS = new Set(["websocket", "ws"]);

// ============================ 公共设施 ============================

/** Python 三引号字符串行屏蔽(注意:starlette_app.py:392 docstring 里的
 * `Route("/health", health)` doctest 示例会被行扫描当真路由——与 python.ts moduleTripleLines
 * 同纪律:进入三引号作用域的行不参与提取;同一行开合同合的 docstring 不屏蔽)。 */
function pythonTripleMask(lines: string[]): Uint8Array {
  const mask = new Uint8Array(lines.length);
  let open: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (open === null) {
      const m = /("""|''')/.exec(line);
      if (!m) continue;
      const start = m.index + 3;
      const closeIdx = line.indexOf(m[1]!, start);
      if (closeIdx >= 0) continue; // 同行开合(单行 docstring)——不屏蔽
      open = m[1]!;
      mask[i] = 1;
    } else {
      mask[i] = 1;
      const closeIdx = line.indexOf(open);
      if (closeIdx >= 0) { open = null; }
    }
  }
  return mask;
}

/** 从 ( 起始下标收集括号平衡的调用实参全文(跨行;帽 maxLines;字符串感知)。 */
function collectCallSpan(lines: string[], lineIdx: number, openParenCol: number, maxLines = 40): string {
  let depth = 0;
  let quote: string | null = null;
  const parts: string[] = [];
  for (let i = lineIdx; i < Math.min(lines.length, lineIdx + maxLines); i++) {
    const line = lines[i]!;
    const from = i === lineIdx ? openParenCol : 0;
    let lineDone = false;
    for (let j = from; j < line.length; j++) {
      const ch = line[j]!;
      if (quote) {
        if (ch === "\\") { j++; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"') { quote = ch; continue; }
      if (ch === "#") {
 // python 行内注释(注意:注释里的撇号 "don't" 会吊死引号配对)——只收注释前片段
        parts.push(line.slice(from, j));
        lineDone = true;
        break;
      }
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") {
        depth--;
        if (depth === 0) { parts.push(line.slice(from, j + 1)); return parts.join("\n"); }
      }
    }
    if (!lineDone) parts.push(line.slice(from));
  }
  return parts.join("\n"); // 未闭合(超帽)——尽力而为
}

/** 实参span按顶层逗号切分(深度 0、字符串外)。 */
function splitCallArgs(span: string): string[] {
  const inner = span.slice(span.indexOf("(") + 1, span.lastIndexOf(")"));
  const out: string[] = [];
  let depth = 0, quote: string | null = null, cur = "";
  for (let j = 0; j < inner.length; j++) {
    const ch = inner[j]!;
    if (quote) {
      cur += ch;
      if (ch === "\\") { cur += inner[++j] ?? ""; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    if (ch === "#") break; // python 行内注释
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Python 同文件字符串/f-string 常量表(NAME: Final = "…"/NAME = f"…{CONST}/x"),
 * f-string 的 {CONST} 用同表迭代折叠(深 3;解析不掉的占位保留原样)。 */
function pythonStringConsts(lines: string[]): Map<string, string> {
  const defs = new Map<string, string>();
  const valRe = /^(?:[A-Za-z_][\w.\s]*,\s*)?([fFrRbB]*)["']([^"']*)["']\s*$/;
  for (const line of lines) {
    const m = /^\s*([A-Za-z_]\w*)\s*:\s*[^=;\n]+?=\s*(.+?)\s*$/.exec(line)
      ?? /^\s*([A-Za-z_]\w*)\s*=\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const vm = valRe.exec(m[2]!);
    if (vm) defs.set(m[1]!, vm[2]!);
  }
  // f-string 常量折叠:{NAME} → 常量值(迭代,深 3)
  for (let round = 0; round < 3; round++) {
    let changed = false;
    for (const [name, val] of defs) {
      if (!/\{[A-Za-z_]\w*\}/.test(val)) continue;
      const folded = val.replace(/\{([A-Za-z_]\w*)\}/g, (whole, ref: string) => {
        const v = defs.get(ref);
        return v === undefined ? whole : v;
      });
      if (folded !== val) { defs.set(name, folded); changed = true; }
    }
    if (!changed) break;
  }
  return defs;
}

/** 表达式文本中的常量折叠(替换裸名字 token),再取其中「路径形」字符串字面量。 */
function resolvePathLikeExpr(expr: string, consts: Map<string, string>): { path?: string; inferred: boolean } {
  const t = expr.trim();
  const lit = /^(?:[fFrRbB]*)["']([^"']*)["']$/.exec(t);
  if (lit) {
    const p = lit[1]!;
    return { path: p.startsWith("/") ? p : "/" + p, inferred: false };
  }
  // 调用/常量形态:把已知常量按 token 折叠进文本(带引号回填——值表存的是裸值,
  // 折叠后必须仍是字符串字面量,后续 lit 提取才能看到),再收集字符串字面量
  let folded = t.replace(/[A-Za-z_]\w*/g, (name) => {
    const v = consts.get(name);
    return v === undefined ? name : JSON.stringify(v);
  });
  // 注意 * 不是 +:空字符串字面量(base_url or "" 形态常见)必须参与配对,否则后续引号错位
  const lits = [...folded.matchAll(/(?:[fFrRbB]*)["']([^"']*)["']/g)].map((m) => m[1]!);
  // 取最后一个路径形字面量(实参里运行时值不是字面量,不会进来)
  const pathLike = lits.filter((v) => v.includes("/") || /\{\w/.test(v));
 // 路径形优先;无路径形时唯一字面量兜底(注意:_ROUTE_OAUTH_CALLBACK="oauth2callback"
  // 无斜杠,是 make_url_path 的路径实参位——多字面量时不猜)
  const pick = pathLike[pathLike.length - 1] ?? (lits.length === 1 ? lits[0] : undefined);
  if (!pick) return { inferred: true };
  return { path: pick.startsWith("/") ? pick : "/" + pick, inferred: true };
}

/** Next.js 文件约定路径推导(pages/api/x/[id].ts → /api/x/{id};app/api/x/route.ts → /api/x)。 */
function nextjsRoutePath(file: string): string | null {
  let m = /(?:^|\/)pages\/api\/(.+)\.[jt]sx?$/.exec(file);
  if (m) return "/api/" + m[1]!.replace(/\[(.+?)\]/g, "{$1}").replace(/\/index$/, "");
  m = /(?:^|\/)app\/api\/(.+)\/route\.[jt]sx?$/.exec(file);
  if (m) return "/api/" + m[1]!.replace(/\[(.+?)\]/g, "{$1}");
  return null;
}

function joinPath(prefix: string, p: string): string {
  if (!prefix) return p || "/";
  if (!p) return prefix;
  const a = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  const b = p.startsWith("/") ? p : "/" + p;
  return (a + b) || "/";
}

/** 注释行守卫(注意:本模块自身源码的注释里写着 @GetMapping("/x") 示例,被 Spring 提取器
 * 当真实路由——行扫描层必须先剔注释行再匹配;docHint 读取是另一条路,不受影响)。 */
function isCommentLine(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith("//") || t.startsWith("#") || t.startsWith("*") || t.startsWith("/*");
}

/** docstring 行守卫(三引号开头的行是 docstring 内容——多行 docstring 由
 * pythonTripleMask 屏蔽,单行 docstring(同行开合)mask 覆盖不到,这里按行首形态拦。
 * 注意形态:fixture 与真实仓都有 `"""...Route("/x", h)..."""` 的 doctest/示例行)。 */
function isPyDocLine(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith('"""') || t.startsWith("'''");
}

/** 文档路径守卫( RC-M,streamlit 注意:specs/*.md 产品文档里的接口示例被提取成
 * 「真端点」——api.endpoints[0].file=specs/…product-spec.md:322,桥对账全城假数据)。
 * 文档扩展名 + docs 目录段一律不提取;守卫放 extractApiSurface 入口,指纹预筛即使放进候选也拦。 */
const DOC_EXT_RE = /\.(md|mdx|markdown|adoc|asciidoc|rst|txt)$/i;
export function isDocPath(rel: string): boolean {
  if (DOC_EXT_RE.test(rel)) return true;
  return /(^|\/)docs?\//i.test(rel);
}

function cleanDoc(line: string): string {
  return line.replace(/^\s*["']{0,3}/, "").replace(/["']{0,3}\s*$/, "").trim().slice(0, 80);
}

/** decorator 首参(路径)提取:字面量(精确)或调用包裹字面量(包装器或加运行时前缀→pi)。
 * 跨行形态(redash embed.py `@routes.route(\n org_scoped_rule("/embed/…")` 注意):本行空参时前瞻 ≤4 行。 */
function decoratorPathArg(lines: string[], i: number, afterParen: string): { path: string; inferred: boolean } | undefined {
  const tryText = (s: string): { path: string; inferred: boolean } | undefined => {
    const lit = /^(["'`])([^"'`]+)\1/.exec(s);
    if (lit) return { path: lit[2]!, inferred: false };
    const cw = /^[A-Za-z_][\w.]*\(\s*(["'`])([^"'`]+)\1/.exec(s);
    if (cw) return { path: cw[2]!, inferred: true };
    return undefined;
  };
  let r = tryText(afterParen);
  if (!r && !afterParen.trim()) {
    for (let k = 1; k <= 4 && i + k < lines.length; k++) {
      const nl = lines[i + k]!.trim();
      if (nl.startsWith(")")) break; // 空调用
      r = tryText(nl);
      if (r) break;
    }
  }
  if (!r || !r.path.startsWith("/")) return undefined;
  return r;
}

/** Python decorator 形态提取(fastapi/flask)。 */
function extractPythonDecorators(file: string, lines: string[]): ApiEndpoint[] {
  const out: ApiEndpoint[] = [];
  // 变量注册:X = FastAPI()/Flask(__name__)/APIRouter(prefix=..)/Blueprint(..,url_prefix=..)
  const varPrefix = new Map<string, string>();
  const isRouter = new Set<string>();
  for (const line of lines) {
    const reg = /(\w+)\s*=\s*(APIRouter|Blueprint)\s*\(([^)]*)\)/.exec(line);
    if (reg) {
      const kw = /(?:prefix|url_prefix)\s*=\s*["']([^"']*)["']/.exec(reg[3]!);
      varPrefix.set(reg[1]!, kw?.[1] ?? "");
      isRouter.add(reg[1]!);
    }
    if (/(\w+)\s*=\s*(FastAPI|Flask)\s*\(/.test(line)) {
      const v = /(\w+)\s*=\s*(?:FastAPI|Flask)\s*\(/.exec(line)![1]!;
      varPrefix.set(v, "");
    }
  }
  // 同文件挂载:app.include_router(router, prefix="..") / app.register_blueprint(bp, url_prefix="..")
  const mountPrefix = new Map<string, string>();
  const mountedVars = new Set<string>();
  for (const line of lines) {
    const mi = /\.include_router\(\s*(\w+)\s*([^)]*)\)/.exec(line);
    if (mi) {
      const kw = /prefix\s*=\s*["']([^"']*)["']/.exec(mi[2]!);
      mountPrefix.set(mi[1]!, kw?.[1] ?? "");
      mountedVars.add(mi[1]!);
    }
    const mb = /\.register_blueprint\(\s*(\w+)\s*([^)]*)\)/.exec(line);
    if (mb) {
      const kw = /url_prefix\s*=\s*["']([^"']*)["']/.exec(mb[2]!);
      mountPrefix.set(mb[1]!, kw?.[1] ?? "");
      mountedVars.add(mb[1]!);
    }
  }
  const decoRe = /@(\w+)\.(get|post|put|delete|patch|head|options|route|websocket)\s*\(\s*/;
  for (let i = 0; i < lines.length; i++) {
    if (isCommentLine(lines[i]!)) continue;
    const m = decoRe.exec(lines[i]!);
    if (!m) continue;
    const recv = m[1]!;
    const methodRaw = m[2]!;
    if (!varPrefix.has(recv) && recv !== "app" && recv !== "bp" && recv !== "router") continue; // 防误命中无关 decorator
 // 路径实参:字面量(精确)或调用包裹字面量(`org_scoped_rule("/login")` redash 注意——
    // 包装器可能加运行时前缀,取内层字面量+prefixInferred 如实;跨行 decorator 前瞻 ≤4 行)
    const afterParen = lines[i]!.slice(m.index + m[0].length);
    const pr = decoratorPathArg(lines, i, afterParen);
    if (!pr) continue;
    const localPath = pr.path;
    const pathInferred = pr.inferred;
    const kwText = afterParen.trim() ? afterParen : [afterParen, ...lines.slice(i + 1, i + 5)].join(" ");
    const isWs = WS_METHODS.has(methodRaw);
    let methods: string[] = isWs ? ["WS"] : [methodRaw.toUpperCase()];
    if (methodRaw === "route") {
      const mm = /methods\s*=\s*\[([^\]]*)\]/.exec(kwText);
      methods = mm
        ? (mm[1]!.match(/["']([A-Z]+)["']/g) ?? ["GET"]).map((s) => s.replace(/["']/g, ""))
        : ["GET"];
    }
    // handler:后续 ≤8 行内第一个 def(跳过其它 decorator)
    let handler: string | undefined;
    let docHint: string | undefined;
    for (let j = i + 1; j < Math.min(lines.length, i + 9); j++) {
      const dm = /^\s*(?:async\s+)?def\s+(\w+)\s*\(/.exec(lines[j]!);
      if (dm) {
        handler = dm[1]!;
        // docstring 首行
        for (let k = j + 1; k < Math.min(lines.length, j + 4); k++) {
          const dl = lines[k]!.trim();
          if (!dl) continue;
          if (dl.startsWith('"""') || dl.startsWith("'''")) { docHint = cleanDoc(dl); }
          break;
        }
        break;
      }
      if (/^\s*@/.test(lines[j]!)) continue; // 串行 decorator
      if (/^\s*(#|$)/.test(lines[j]!)) continue;
      break;
    }
    // 前缀叠加(两跳):路由对象自带注册前缀(APIRouter(prefix="/v1"))× 挂载点前缀
    // (include_router(router, prefix="/api"))→ /api/v1/x;挂载注册空前字符串不覆盖注册前缀
    // (register_blueprint(bp) 无 url_prefix 时 bp 的 /admin 仍生效)
    const mount = mountPrefix.get(recv);
    const regPrefix = varPrefix.get(recv) ?? "";
    const prefix = mount !== undefined ? joinPath(mount, regPrefix) : regPrefix;
    const prefixInferred = (isRouter.has(recv) && !mountedVars.has(recv) && !regPrefix) || pathInferred;
    for (const method of methods) {
      out.push({
        method, path: joinPath(prefix, localPath), file, line: i + 1,
        framework: "python-decorator", kind: isWs ? "ws" : "http",
        ...(handler ? { handler } : {}),
        ...(prefixInferred ? { prefixInferred: true } : {}),
        ...(docHint ? { docHint } : {}),
      });
    }
  }
  return out;
}

/** starlette 提取器( RC-M; 扩 Mount):Route/WebSocketRoute 列表形态。
 * 真实形态(poly-streamlit):`Route(_with_base(ROUTE_HEALTH, base_url), _health_endpoint,
 * methods=["GET","HEAD"])` 多行;常量 `ROUTE_HEALTH: Final = f"{BASE_ROUTE_CORE}/health"`。
 * path 实参=纯字面量→精确路径;调用/常量表达式→折叠同文件常量取路径形值+prefixInferred
 * (base_url 类运行时前缀静态未知,如实标注)。
 * Mount:`Mount(prefix, routes=[Route(...)…])`——Mount 跨度按括号深度定界
 * (字符串/行内注释感知),界内 Route/WebSocketRoute 继承 Mount 前缀(嵌套 Mount 前缀复合);
 * prefix 为运行时变量(streamlit `Mount(mount_path, app=…)` 注意)→ 前缀不解析,
 * 内层路由以本地路径+prefixInferred 如实入账;`app=子应用` 形态内部无路由,零端点(边界)。
 * `routes=变量` 形态:同文件 `NAME = […Route…]` 列表赋值按行区间绑定前缀。 */
function extractStarlette(file: string, lines: string[], mask: Uint8Array): ApiEndpoint[] {
  const out: ApiEndpoint[] = [];
  const consts = pythonStringConsts(lines);
  const routeRe = /(?:^|[^\w.])\s*(Route|WebSocketRoute|Mount)\s*\(/;
  // 预扫:列表赋值行区间(NAME = [ … ];Mount(routes=NAME) 的绑定目标)
  const listRanges: { name: string; end: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue;
    const am = /^\s*([A-Za-z_]\w*)\s*=\s*\[/.exec(lines[i]!);
    if (!am) continue;
    let depth = 0, quote: string | null = null, end = i;
    for (let k = i; k < Math.min(lines.length, i + 200); k++) {
      for (const ch of lines[k]!) {
        if (quote) { if (ch === quote) quote = null; continue; }
        if (ch === "'" || ch === '"') { quote = ch; continue; }
        if (ch === "[") depth++;
        else if (ch === "]") { depth--; if (depth === 0) { end = k; k = lines.length; break; } }
      }
    }
    listRanges.push({ name: am[1]!, end });
  }
  interface MountScope { prefix: string; inferred: boolean; endLine: number }
  const mountStack: MountScope[] = [];
  const varMounts = new Map<string, { prefix: string; inferred: boolean }>();
  // Mount 调用跨度定界(括号平衡,字符串与 # 行内注释感知)
  const mountEndLine = (startIdx: number, openCol: number): number => {
    let depth = 0, quote: string | null = null;
    for (let i = startIdx; i < Math.min(lines.length, startIdx + 200); i++) {
      const line = lines[i]!;
      for (let j = i === startIdx ? openCol : 0; j < line.length; j++) {
        const ch = line[j]!;
        if (quote) { if (ch === "\\") { j++; continue; } if (ch === quote) quote = null; continue; }
        if (ch === "'" || ch === '"') { quote = ch; continue; }
        if (ch === "#") break;
        if (ch === "(" || ch === "[" || ch === "{") depth++;
        else if (ch === ")" || ch === "]" || ch === "}") { depth--; if (depth === 0) return i; }
      }
    }
    return startIdx;
  };
  // 预扫 Mount(routes=NAME) 绑定——列表赋值通常先于 Mount 出现,绑定必须在主扫前完成
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue;
    const line = lines[i]!;
    if (isCommentLine(line) || isPyDocLine(line)) continue;
    if (!/(?:^|[^\w.])\s*Mount\s*\(/.test(line)) continue;
    const openCol = line.indexOf("(", line.search(/(?:^|[^\w.])\s*Mount/));
    const args = splitCallArgs(collectCallSpan(lines, i, openCol));
    if (args.length < 1) continue;
    const rv = args.find((a) => /^routes\s*=\s*[A-Za-z_]\w*$/.test(a));
    if (!rv) continue; // 内联 routes=[…]/app= 子应用:无需变量绑定(内层行扫描/零产出)
    const resolved = resolvePathLikeExpr(args[0]!, consts);
    varMounts.set(rv.slice(rv.indexOf("=") + 1).trim(), {
      prefix: resolved.path ?? "",
      inferred: resolved.inferred || !resolved.path,
    });
  }
  // 列表赋值区间栈(逐行推进;name→ Mount 前缀绑定)
  let listIdx = 0;
  let activeList: { name: string; end: number } | undefined;
  /** 单个 Route/WebSocketRoute 命中处理(携带当前 Mount 栈前缀与列表变量绑定前缀)。 */
  const handleRoute = (kind: "Route" | "WebSocketRoute", i: number, openParenCol: number): void => {
    const span = collectCallSpan(lines, i, openParenCol);
    const args = splitCallArgs(span);
    if (args.length < 2) return;
    const isWs = kind === "WebSocketRoute";
    const resolved = resolvePathLikeExpr(args[0]!, consts);
    if (!resolved.path) return;
    // Mount 前缀复合(栈自底向上)+ 列表变量绑定前缀
    let prefix = "";
    let inferred = resolved.inferred;
    for (const s of mountStack) { prefix = joinPath(prefix, s.prefix); inferred = inferred || s.inferred; }
    if (activeList) {
      const vm = varMounts.get(activeList.name);
      if (vm) { prefix = joinPath(vm.prefix, prefix); inferred = inferred || vm.inferred; }
    }
    const hm = /^[A-Za-z_]\w*$/.exec(args[1]!);
    const mm = /methods\s*=\s*\[([^\]]*)\]/.exec(span);
    const methods: string[] = isWs
      ? ["WS"]
      : mm
        ? (mm[1]!.match(/["']([A-Za-z]+)["']/g) ?? ["ANY"]).map((s) => s.replace(/["']/g, "").toUpperCase())
        : ["ANY"];
    for (const method of methods) {
      out.push({
        method, path: joinPath(prefix, resolved.path), file, line: i + 1,
        framework: "starlette", kind: isWs ? "ws" : "http",
        ...(hm ? { handler: hm[0]! } : {}),
        ...(inferred ? { prefixInferred: true } : {}),
      });
    }
  };
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue;
    const line = lines[i]!;
    if (isCommentLine(line) || isPyDocLine(line)) continue;
    while (mountStack.length && i > mountStack[mountStack.length - 1]!.endLine) mountStack.pop();
    while (activeList && i > activeList.end) activeList = undefined;
    while (listIdx < listRanges.length && listRanges[listIdx]!.end < i) listIdx++;
    const lr = listRanges.find((r) => lines[i]!.includes("=") && new RegExp(`^\\s*${r.name}\\s*=\\s*\\[`).test(line));
    if (lr) activeList = lr;
    const rm = routeRe.exec(line);
    if (!rm) continue;
    const openCol = line.indexOf("(", rm.index);
    if (rm[1] === "Mount") {
      const span = collectCallSpan(lines, i, openCol);
      const args = splitCallArgs(span);
      if (args.length < 1) continue;
      const resolved = resolvePathLikeExpr(args[0]!, consts);
      // 内联 routes=[…] 的内层 Route 由栈内行扫描继承前缀;app= 子应用形态内部无路由,零端点(边界)
      mountStack.push({
        prefix: resolved.path ?? "",
        inferred: resolved.inferred || !resolved.path,
        endLine: mountEndLine(i, openCol),
      });
      // 同行内联形态 Mount("/api", routes=[Route("/x", h)]):内层首个 Route 在本行继续处理
      const innerM = /(?:^|[^\w.])(WebSocketRoute|Route)\s*\(/.exec(line.slice(openCol + 1));
      if (innerM) handleRoute(innerM[1]! as "Route" | "WebSocketRoute", i, openCol + 1 + innerM.index + innerM[0].lastIndexOf("("));
      continue;
    }
    handleRoute(rm[1]! as "Route" | "WebSocketRoute", i, openCol);
  }
  return out;
}

/** Tornado 提取器( RC-M; 扩:变量绑定元组+import 常量):(path, Handler[, settings])
 * 元组族——web.Application([...])/add_handlers(...)/URLRouter(...) 调用 span 与
 * `handlers.append/extend/= [` 变量语境;首元 raw/str 字面量或含路径字面量的调用表达式
 * (regex 尾巴确定性清洗)。`NAME = (path, Handler, …)` 变量绑定元组登记后被
 * 语境 span 内裸名引用即收(jupyterlab labapp `build_handler = (build_path, BuildHandler, …)`
 * → `handlers.append(build_handler)` 注意);extraConsts=仓级 import 常量表(由
 * expandTornadoSurface 注入;缺省=同文件常量,091 行为恒等)。 */
function extractTornado(file: string, lines: string[], mask: Uint8Array, extraConsts?: Map<string, string>): ApiEndpoint[] {
  const out: ApiEndpoint[] = [];
  const consts: Map<string, string> = extraConsts
    ? new Map([...extraConsts, ...pythonStringConsts(lines)]) // 同文件常量优先(近作用域)
    : pythonStringConsts(lines);
  // 变量绑定元组表(同文件;首元可以是 import 常量——repo pass 经 extraConsts 注入后解析)
  const tupleAssign = new Map<string, { span: string; line: number }>();
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue;
    const line = lines[i]!;
    if (isCommentLine(line) || isPyDocLine(line)) continue;
    const am = /^\s*([A-Za-z_]\w*)\s*=\s*\(\s*(?:[rRuUbB]*["']\/|[A-Za-z_]\w*\s*,|$)/.exec(line);
    if (!am) continue;
    const openCol = line.indexOf("(", am.index);
    tupleAssign.set(am[1]!, { span: collectCallSpan(lines, i, openCol, 40), line: i + 1 });
  }
  const seen = new Set<string>();
  const pushTuple = (tupleSpan: string, line: number): void => {
    // 元组形态门:字面量/调用表达式/裸常量名首元(裸名=纯标识符不带点,靠 consts/extraConsts
 // 解析,解不出即弃;带点属性表达式 self.base_url 不是常量,误收注意:ujoin 内层组被当元组)
    if (!/^\(\s*(?:[rRuUbB]*["']|[A-Za-z_]\w*\s*[\(,]|[A-Za-z_][\w.]*\()/.test(tupleSpan)) return;
    const args = splitCallArgs(tupleSpan);
    if (args.length < 2) return;
    let path: string;
    let inferred = false;
    const lm = /^[rRuUbB]*(["'])(\/[^"']*)\1$/.exec(args[0]!);
    if (lm) {
      path = lm[2]!;
    } else {
      // 首元是调用表达式(如 ujoin(base_url, r"/listings/(.*)"))或裸常量名——取其中路径形字面量;
      // 裸常量名解析成功=路径全知,不标推断(推断标记留给真·运行时前缀形态)
      const r = resolvePathLikeExpr(args[0]!, consts);
      if (!r.path || !r.path.startsWith("/")) return;
      path = r.path;
      inferred = r.inferred && !/^[A-Za-z_]\w*$/.test(args[0]!.trim());
    }
    // regex 尾巴确定性清洗:(.*)→{*};剥 lookaround 组与结尾 $
    path = path.replace(/\(\.\*\)/g, "{*}").replace(/\(\?<[=!][^)]*\)|\(\?=[^)]*\)/g, "").replace(/\$$/, "");
    const hm = /^[A-Za-z_]\w*$/.exec(args[1]!);
    const key = `${path}|${hm?.[1] ?? ""}|${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      method: "ANY", path, file, line,
      framework: "tornado", kind: "http",
      ...(hm ? { handler: hm[0]! } : {}),
      ...(inferred ? { prefixInferred: true } : {}),
    });
  };
 // 语境 span:web.Application(/add_handlers(/URLRouter(调用;handlers 变量 = [ / .append(
  const ctxRe = /web\.Application\s*\(|add_handlers\s*\(|URLRouter\s*\(/;
  const varDefRe = /^\s*(\w*[hH]andlers?\w*)\s*(?:=|:)\s*\[/;
  const appendRe = /(\w*[hH]andlers?\w*)\.(append|extend|insert)\s*\(/;
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue;
    const line = lines[i]!;
    if (isCommentLine(line) || isPyDocLine(line)) continue;
    let openCol = -1;
    const cm = ctxRe.exec(line);
    const vm = varDefRe.exec(line);
    const am = appendRe.exec(line);
    if (cm) openCol = line.indexOf("(", cm.index);
    else if (vm) openCol = line.indexOf("[", vm.index);
    else if (am) openCol = line.indexOf("(", am.index);
    if (openCol < 0) continue;
    // 帽 200(语境 span 是整个 handler 列表,真实仓可达 50+ 行)
    const span = collectCallSpan(lines, i, openCol, 200);
    // 逐括号组扫描:每个闭合的 (…) 组尝试一次元组解析(非元组形态在 pushTuple 里校验失败即弃)
    const opens: { start: number; d: number }[] = [];
 // P0:元组行号 = 语境 span 起点 + span 内换行数。旧实现整段用 i+1,
 // web.Application([...]) 里所有路由都报到 Application 行(经验证 7 条全 @449)。
    const lineOfOffset = (off: number): number => i + 1 + (span.slice(0, off).match(/\n/g)?.length ?? 0);
    let depth = 0, quote: string | null = null;
    for (let j = 0; j < span.length; j++) {
      const ch = span[j]!;
      if (quote) { if (ch === "\\") { j++; continue; } if (ch === quote) quote = null; continue; }
      if (ch === "'" || ch === '"') { quote = ch; continue; }
      // 行内注释已在 collectCallSpan 收集期剥除;此处无 # 分支(span 内引号外不应再有 #)
      if (ch === "(") { opens.push({ start: j, d: depth }); depth++; }
      else if (ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") {
        depth--;
 // 只有) 弹栈:] } 只减深度(否则 dict 收尾 } 会弹掉元组条目,真元组被外层冒名)
        if (ch !== ")") continue;
        const o = opens.pop();
        if (o) {
          const tuple = span.slice(o.start, j + 1);
          // 预筛「元组形态开头」(字面量/调用表达式/裸常量名——纯标识符不带点),完整校验在 pushTuple
          const g = /^\(\s*(?:[rRuUbB]*["']\/|[A-Za-z_]\w*\s*[\(,]|[A-Za-z_][\w.]*\()/.test(tuple);
          if (g) pushTuple(tuple, lineOfOffset(o.start));
        }
      }
    }
 // 变量绑定元组引用:语境 span 内的裸名命中同文件赋值表即收
 // (注意 jupyterlab `handlers.append(build_handler)`;span 外裸名不收——无挂载语境不猜)
    for (const [name, t] of tupleAssign) {
      if (new RegExp(`\\b${name}\\b`).test(span)) pushTuple(t.span, t.line);
    }
  }
  return out;
}

/** Flask-RESTful 提取器( RC-M):api.add_resource(Resource, "/url1", "/url2", …) 及
 * 子类化形态(redash ApiExt.add_org_resource)。每个 "/…" 开头位置参数字面量=一个端点
 * (RESTful 资源类方法决定动词,method=ANY 如实);handler=首参资源类简单名。多行调用支持。 */
function extractFlaskRestful(file: string, lines: string[], mask: Uint8Array): ApiEndpoint[] {
  const out: ApiEndpoint[] = [];
  const callRe = /\.add_(?:[\w]+_)?resource\s*\(/;
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue;
    const line = lines[i]!;
    if (isCommentLine(line) || isPyDocLine(line)) continue;
    const cm = callRe.exec(line);
    if (!cm) continue;
    const openCol = line.indexOf("(", cm.index);
    const span = collectCallSpan(lines, i, openCol);
    const args = splitCallArgs(span);
    // 首参=资源类(简单名;redash 传 import 的 Resource 类)
    const rm = /^[\w.]+$/.exec(args[0] ?? "");
    const handler = rm ? args[0]!.split(".").pop() : undefined;
    for (const arg of args.slice(1)) {
      const um = /^(?:[fFrRbB]*)["']([^"']+)["']$/.exec(arg);
      if (!um) continue;
      const url = um[1]!;
      if (!url.startsWith("/")) continue;
      out.push({
        method: "ANY", path: url, file, line: i + 1,
        framework: "flask-restful", kind: "http",
        ...(handler ? { handler } : {}),
      });
    }
  }
  return out;
}

/** TS/JS 调用形态(express/koa/fastify)。 */
function extractJsCalls(file: string, lines: string[]): ApiEndpoint[] {
  const out: ApiEndpoint[] = [];
  // 挂载:app.use("/prefix", router)
  const mountPrefix = new Map<string, string>();
  for (const line of lines) {
    const mu = /\.use\(\s*["'`]([^"'`]+)["'`]\s*,\s*(\w+)\s*\)/.exec(line);
    if (mu) mountPrefix.set(mu[2]!, mu[1]!);
  }
  // Router({prefix}) / new Router()
  const routerPrefix = new Map<string, string>();
  for (const line of lines) {
    const rr = /(?:const|let|var)\s+(\w+)\s*=\s*(?:new\s+)?(?:express\.Router|Router)\s*\(([^)]*)\)/.exec(line);
    if (rr) {
      const kw = /prefix\s*:\s*["']([^"']*)["']/.exec(rr[2]!);
      routerPrefix.set(rr[1]!, kw?.[1] ?? "");
    }
  }
  const routeRe = /(\w+)\.(get|post|put|delete|patch|head|options|all)\s*\(\s*["'`]([^"'`]+)["'`]\s*,\s*(.+)$/;
  for (let i = 0; i < lines.length; i++) {
    if (isCommentLine(lines[i]!)) continue;
    const m = routeRe.exec(lines[i]!);
    if (!m) continue;
    const [, recv, methodRaw, localPath, argsText] = m as unknown as [string, string, string, string, string];
    const isRouterVar = routerPrefix.has(recv) || mountPrefix.has(recv);
    // handler=最后一个顶层参数;标识符→具名,箭头/函数字面量→inline
    const tail = argsText.trim().replace(/\)\s*;?\s*$/, "");
    const lastArg = tail.split(",").pop()!.trim();
    let handler: string | undefined;
    let handlerInline = false;
    const idm = /^([\w.]+)$/.exec(lastArg);
    if (idm) handler = idm[1]!.split(".").pop()!;
    else handlerInline = true;
    const mnt = mountPrefix.get(recv);
    const prefix = mnt !== undefined ? joinPath(mnt, routerPrefix.get(recv) ?? "") : (routerPrefix.get(recv) ?? "");
    const prefixInferred = isRouterVar && routerPrefix.has(recv) && !mountPrefix.has(recv) && !routerPrefix.get(recv);
    // 前行注释作 docHint
    let docHint: string | undefined;
    const prev = lines[i - 1]?.trim() ?? "";
    if (prev.startsWith("//") || prev.startsWith("*")) docHint = cleanDoc(prev.replace(/^\/\/+|^\*+/, ""));
    out.push({
      method: methodRaw.toUpperCase(), path: joinPath(prefix, localPath), file, line: i + 1,
      framework: "js-call", kind: "http",
      ...(handler ? { handler } : {}), ...(handlerInline ? { handlerInline: true } : {}),
      ...(prefixInferred ? { prefixInferred: true } : {}),
      ...(docHint ? { docHint } : {}),
    });
  }
  return out;
}

/** Next.js 文件约定。 */
function extractNextjs(file: string, lines: string[]): ApiEndpoint[] {
  const routePath = nextjsRoutePath(file);
  if (!routePath) return [];
  const out: ApiEndpoint[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /export\s+(?:async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/.exec(lines[i]!);
    if (m) {
      out.push({ method: m[1]!, path: routePath, file, line: i + 1, framework: "nextjs", kind: "http" });
    }
    if (/export\s+default\s+(?:async\s+)?function\s+(\w+)/.test(lines[i]!) && out.length === 0) {
      const h = /export\s+default\s+(?:async\s+)?function\s+(\w+)/.exec(lines[i]!)![1];
      out.push({ method: "ANY", path: routePath, handler: h, file, line: i + 1, framework: "nextjs", kind: "http" });
    }
  }
  return out;
}

/** Spring 注解。 */
function extractSpring(file: string, lines: string[]): ApiEndpoint[] {
  const out: ApiEndpoint[] = [];
  let classPrefix = "";
  let inRestController = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (isCommentLine(line)) continue;
    if (/@RestController|@Controller/.test(line)) inRestController = true;
    if (inRestController) {
      // 类级前缀:@RequestMapping("/api") 纯路径形态(带 method= 的是方法级,不吃)
      const cp = /@RequestMapping\(\s*(?:value\s*=\s*)?["']([^"']*)["']\s*\)/.exec(line);
      if (cp && !classPrefix) { classPrefix = cp[1]!; continue; }
    }
    // 方法级注解:@GetMapping("/x") / @PostMapping(无括号裸形态)/ @RequestMapping(value=.., method=..)
    const mm = /@(Get|Post|Put|Delete|Patch)Mapping(?:\(\s*(?:value\s*=\s*)?["']([^"']*)["'][^)]*\))?/.exec(line)
      ?? (() => { const r = /@RequestMapping\(\s*(?:value\s*=\s*)?["']([^"']*)["'][^)]*method\s*=\s*RequestMethod\.(GET|POST|PUT|DELETE|PATCH)/.exec(line); return r ? [r[0], r[2]!, r[1]!] as unknown as RegExpExecArray : null; })();
    if (!mm || !inRestController) continue;
    const method = mm[1]!.toUpperCase();
    const localPath = mm[2] ?? "";
    // handler:后续 ≤4 行内第一个方法签名
    let handler: string | undefined;
    for (let j = i + 1; j < Math.min(lines.length, i + 5); j++) {
      const hm = /(?:public|private|protected)\s+[\w<>\[\],.? ]+\s+(\w+)\s*\(/.exec(lines[j]!);
      if (hm) { handler = hm[1]!; break; }
    }
    out.push({ method, path: joinPath(classPrefix, localPath), file, line: i + 1, framework: "spring", kind: "http", ...(handler ? { handler } : {}) });
  }
  return out;
}

/** Go(gin / net-http / mux)。 */
function extractGo(file: string, lines: string[], frameworks: string[]): ApiEndpoint[] {
  const out: ApiEndpoint[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (isCommentLine(line)) continue;
    let m: RegExpExecArray | null;
    if (frameworks.includes("gin")) {
      m = /(\w+)\.(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\(\s*"([^"]+)"\s*,\s*([\w.]+)/.exec(line);
      if (m) {
        out.push({ method: m[2]!, path: m[3]!, handler: m[4]!.split(".").pop()!, file, line: i + 1, framework: "gin", kind: "http" });
        continue;
      }
    }
    if (frameworks.includes("mux")) {
      m = /\.HandleFunc\(\s*"([^"]+)"\s*,\s*([\w.]+)\s*\)\.Methods\(\s*"([A-Z]+)"/.exec(line);
      if (m) {
        out.push({ method: m[3]!, path: m[1]!, handler: m[2]!.split(".").pop()!, file, line: i + 1, framework: "mux", kind: "http" });
        continue;
      }
    }
    if (frameworks.includes("net-http") || frameworks.includes("mux")) {
      m = /(?:http\.)?HandleFunc\(\s*"([^"]+)"\s*,\s*(?:([\w.]+)|func\b)/.exec(line);
      if (m && !line.includes(".Methods(")) {
        out.push({ method: "ANY", path: m[1]!, ...(m[2] ? { handler: m[2]!.split(".").pop()! } : { handlerInline: true }), file, line: i + 1, framework: frameworks.includes("mux") ? "mux" : "net-http", kind: "http" });
      }
    }
  }
  return out;
}

/** Go chi 族( RC-N 上游):方法化路由(recv.Get/Post/…)+ Group/Route 作用域前缀拼装
 * + Handle 字面量 + 「常量+字面量」拼接路径。真实形态:
 *   grafana  `r := hs.RouteRegister; r.Get("/login/:name", quota(…), hs.OAuthLogin)`;
 *            `apiRoute.Group("/folders", func(folderRoute …) { folderRoute.Get("/id/:id", …) })`
 *   owncast  `r.Get(options.BaseURL+"/status", wrapper.GetStatus)`(generated.gen.go ×241,
 *            BaseURL 为运行时字段——取字面量尾段+prefixInferred,与 RC-N 前端折叠通道对齐);
 *            `m.Handle("/api/admin/plugins", pluginAdmin)`。
 * 与 gin 的天然不交:gin 方法名 UPPERCASE、chi 首字母大写;HandleFunc 留给 net-http 分支防双发。
 * 误报面(验证):HTTP 客户端取值 `Query.Get("forceLogin")` 单参且首参非 "/" 字面量——被
 * 「首参路径字面量+≥2 实参」规则排除。 */
interface ChiScope { param: string; prefix: string; endLine: number }

/** Go 同文件字符串常量(single-line 声明 + const 块)。 */
function goStringConsts(lines: string[]): Map<string, string> {
  const defs = new Map<string, string>();
  let inBlock = false;
  for (const line of lines) {
    if (/^\s*const\s*\(/.test(line)) { inBlock = true; continue; }
    if (inBlock) {
      if (/^\s*\)/.test(line)) { inBlock = false; continue; }
      const bm = /^\s*([A-Za-z_]\w*)\s*=\s*"([^"]*)"\s*$/.exec(line);
      if (bm) defs.set(bm[1]!, bm[2]!);
      continue;
    }
    const m = /^\s*(?:const\s+)?([A-Za-z_]\w*)\s*=\s*"([^"]*)"\s*$/.exec(line);
    if (m) defs.set(m[1]!, m[2]!);
  }
  return defs;
}

/** chi 路径实参解析:纯字面量/"a"+"b" 相邻折叠(全字面量=精确);`EXPR+"/lit"` EXPR 为同文件
 * 常量→折叠拼接(精确),否则字面量尾段+prefixInferred(运行时前缀,如实标注)。
 * 跨行扩展:调用包裹字面量 `toMacaronPath("/x")` 单字面量调用——callee 名以
 * path/route/url 结尾(纯路径变换语义,grafana ngalert 注意)→字面量精确;其它调用→字面量
 * +prefixInferred(变换语义静态未知,如实)。 */
function resolveChiPath(expr: string, consts: Map<string, string>): { path?: string; inferred: boolean } {
  const t = expr.trim();
  if (!t) return { inferred: false };
  // 调用包裹单字面量(多行形态的常见包装)
  const cw = /^(?:[A-Za-z_]\w*\.)*[A-Za-z_]\w*\(\s*"([^"]*)"\s*\)$/.exec(t);
  if (cw) {
    const p = cw[1]!;
    if (!p.startsWith("/")) return { inferred: true };
    const callee = t.slice(0, t.indexOf("(")).split(".").pop()!.trim();
    return { path: p, inferred: !/(?:path|route|url)$/i.test(callee) };
  }
  // 顶层 + 切分(字符串感知)
  const parts: string[] = [];
  let cur = "", quote: string | null = null, depth = 0;
  for (let j = 0; j < t.length; j++) {
    const ch = t[j]!;
    if (quote) { cur += ch; if (ch === "\\") { cur += t[++j] ?? ""; continue; } if (ch === quote) quote = null; continue; }
    if (ch === '"') { quote = ch; cur += ch; continue; }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "+" && depth === 0) { parts.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  parts.push(cur.trim());
  let path = "";
  let inferred = false;
  let hasLiteral = false;
  for (const part of parts) {
    const lm = /^"([^"]*)"$/.exec(part);
    if (lm) {
      path += lm[1]!;
      hasLiteral = true;
      continue;
    }
    const cv = consts.get(part);
    if (cv !== undefined) { path += cv; hasLiteral = true; continue; }
    // 非字面量非已知常量(字段/参数):标记推断,跳过该段
    inferred = true;
  }
  if (!hasLiteral || !path.startsWith("/")) return { inferred };
  return { path, inferred };
}

/** chi 末参 handler:纯标识符(dotted 取末段)、`X.Wrap(ident)` 包装形态解出真 handler;
 * 其余(中间件链/inline func)=handlerInline。不猜:解不出就 inline,不冒充实名。
 * 兼容入参带/不带外层调用残留尾括号两种形态(先原样判,再剥一层重试)。
 * 跨行末参的深层包装(grafana ngalert `metrics.Instrument(…, api.Hooks.Wrap(
 * srv.RouteGetAlertStatuses), m)` 注意)——未命中时取参数文本内最后一个 Wrap 调用。 */
function chiHandlerOf(lastArg: string): { handler?: string; inline?: boolean } {
  const t0 = lastArg.trim();
  const cands = t0.endsWith(")") ? [t0, t0.slice(0, -1).trimEnd()] : [t0];
  for (const t of cands) {
    const idm = /^[\w.]+$/.exec(t);
    if (idm) return { handler: t.split(".").pop()! };
    const wm = /^[A-Za-z_][\w.]*\.?Wrap\(([\w.]+)\)$/.exec(t);
    if (wm) return { handler: wm[1]!.split(".").pop()! };
  }
  const deep = [...t0.matchAll(/[A-Za-z_][\w.]*\.Wrap\(([\w.]+)\)/g)];
  const lastWrap = deep[deep.length - 1];
  if (lastWrap) return { handler: lastWrap[1]!.split(".").pop()! };
  return { inline: true };
}

/** Go 版括号平衡 span 收集(跨行 chi 路由用):字符串 `"` 与反引号感知、`//` 行内注释
 * 剥除(注释里的引号/括号会吊死配对);返回含外层括号的完整 span,未闭合(超帽)返回空串=不猜。 */
function collectGoCallSpan(lines: string[], lineIdx: number, openParenCol: number, maxLines = 20): string {
  let depth = 0;
  let quote: string | null = null;
  const parts: string[] = [];
  for (let i = lineIdx; i < Math.min(lines.length, lineIdx + maxLines); i++) {
    const line = lines[i]!;
    const from = i === lineIdx ? openParenCol : 0;
    let lineDone = false;
    for (let j = from; j < line.length; j++) {
      const ch = line[j]!;
      if (quote) {
        if (quote !== "`" && ch === "\\") { j++; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "`") { quote = ch; continue; }
      if (ch === "/" && line[j + 1] === "/") { parts.push(line.slice(from, j)); lineDone = true; break; }
      if (ch === "(" || ch === "{" || ch === "[") depth++;
      else if (ch === ")" || ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) { parts.push(line.slice(from, j + 1)); return parts.join("\n"); }
      }
    }
    if (!lineDone) parts.push(line.slice(from));
  }
  return ""; // 未闭合——不猜
}

function extractChi(file: string, lines: string[], frameworks: string[]): ApiEndpoint[] {
  const out: ApiEndpoint[] = [];
  const consts = goStringConsts(lines);
  const scopes: ChiScope[] = [];
  const methodRe = /(\w+)\.(Get|Post|Put|Delete|Patch|Head|Options|Handle)\(\s*/;
  const groupRe = /(\w+)\.(?:Group|Route)\(\s*"([^"]*)"\s*,\s*func\s*\((\w+)/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (isCommentLine(line)) continue;
    // 作用域弹出:本行已越过 scope 结束行
    while (scopes.length && i > scopes[scopes.length - 1]!.endLine) scopes.pop();
    const gm = groupRe.exec(line);
    if (gm) {
      const endLine = chiCallEndLine(lines, i, line.indexOf("(", gm.index));
      const parent = scopes.length ? scopes[scopes.length - 1]!.prefix : "";
      scopes.push({ param: gm[3]!, prefix: joinPath(parent, gm[2]!), endLine });
      // 不 continue:同行 Group+方法化一行的形态也要扫到(one-liner)
    }
    const mm = methodRe.exec(line);
    if (!mm) continue;
    const recv = mm[1]!;
    const method = mm[2]!;
    const scope = scopes.length && scopes[scopes.length - 1]!.param === recv ? scopes[scopes.length - 1]! : undefined;
 // 路径实参:从 (后到首个深度 0 逗号(单行形态);跨行回退 collectGoCallSpan( // grafana 132 处 `route.Post(\n "/import",\n …\n)` 注意;超帽未闭合=不猜,维持 skip)
    const openCol = line.indexOf("(", mm.index);
    let depth = 0, quote: string | null = null, endCol = -1;
    for (let j = openCol; j < line.length; j++) {
      const ch = line[j]!;
      if (quote) { if (ch === "\\") { j++; continue; } if (ch === quote) quote = null; continue; }
      if (ch === '"') { quote = ch; continue; }
      if (ch === "/" && line[j + 1] === "/") break; // go 行内注释
      if (ch === "(") depth++;
      else if (ch === ")") { depth--; if (depth === 0) { endCol = j; break; } }
      else if (ch === "," && depth === 1) { endCol = j; break; }
    }
    if (endCol < 0) {
      // 跨行形态
      const span = collectGoCallSpan(lines, i, openCol, 20);
      if (!span) continue;
      const inner = span.slice(1, -1);
      const margs = splitGoArgsTop(inner);
      if (margs.length < 2) continue;
      const resolvedM = resolveChiPath(margs[0]!, consts);
      if (!resolvedM.path) continue;
      const hM = chiHandlerOf(margs[margs.length - 1]!);
      out.push({
        method: method === "Handle" ? "ANY" : method.toUpperCase(),
        path: joinPath(scope?.prefix ?? "", resolvedM.path),
        file, line: i + 1, framework: "chi", kind: "http",
        ...(hM.handler ? { handler: hM.handler } : {}),
        ...(hM.inline ? { handlerInline: true } : {}),
        ...(resolvedM.inferred ? { prefixInferred: true } : {}),
      });
      continue;
    }
    const pathExpr = line.slice(openCol + 1, endCol);
    const resolved = resolveChiPath(pathExpr, consts);
    if (!resolved.path) continue;
    // 实参余部:剥掉本调用的收尾括号后按顶层逗号切分,末参=handler 候选
    let rest = line.slice(endCol + 1).trim();
    if (rest.endsWith(")")) rest = rest.slice(0, rest.lastIndexOf(")")).trimEnd();
    const args = rest ? splitGoArgsTop(rest) : [];
    const h = args.length ? chiHandlerOf(args[args.length - 1]!) : { inline: true };
    out.push({
      method: method === "Handle" ? "ANY" : method.toUpperCase(),
      path: joinPath(scope?.prefix ?? "", resolved.path),
      file, line: i + 1, framework: "chi", kind: "http",
      ...(h.handler ? { handler: h.handler } : {}),
      ...(h.inline ? { handlerInline: true } : {}),
      ...(resolved.inferred ? { prefixInferred: true } : {}),
    });
  }
  return out;
}

/** chi Group/Route 调用的括号平衡结束行(作用域定界;帽 400 行——真实仓 group 体内可达百余行)。 */
function chiCallEndLine(lines: string[], lineIdx: number, openParenCol: number, maxLines = 400): number {
  let depth = 0, quote: string | null = null;
  for (let i = lineIdx; i < Math.min(lines.length, lineIdx + maxLines); i++) {
    const line = lines[i]!;
    for (let j = i === lineIdx ? openParenCol : 0; j < line.length; j++) {
      const ch = line[j]!;
      if (quote) { if (ch === "\\") { j++; continue; } if (ch === quote) quote = null; continue; }
      if (ch === '"') { quote = ch; continue; }
      if (ch === "`") { quote = "`"; continue; }
      if (ch === "/" && line[j + 1] === "/") break; // go 行内注释(注释里的引号会吊死配对)
      if (ch === "(" || ch === "{" || ch === "[") depth++;
      else if (ch === ")" || ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) return i;
      }
    }
  }
  return lineIdx;
}

/** Go 顶层逗号切分(字符串感知;用于 Handle 的多实参尾参定位)。 */
function splitGoArgsTop(text: string): string[] {
  const out: string[] = [];
  let depth = 0, quote: string | null = null, cur = "";
  for (let j = 0; j < text.length; j++) {
    const ch = text[j]!;
    if (quote) { cur += ch; if (ch === "\\") { cur += text[++j] ?? ""; continue; } if (ch === quote) quote = null; continue; }
    if (ch === '"') { quote = ch; cur += ch; continue; }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** aiohttp(web.get/post + add_routes + router.add_get 族)。 */
function extractAiohttp(file: string, lines: string[]): ApiEndpoint[] {
  const out: ApiEndpoint[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (isCommentLine(line)) continue;
    let m = /web\.(get|post|put|delete|patch|head|options)\(\s*["']([^"']+)["']\s*,\s*(\w+)/.exec(line);
    if (m) {
      out.push({ method: m[1]!.toUpperCase(), path: m[2]!, handler: m[3]!, file, line: i + 1, framework: "aiohttp", kind: "http" });
      continue;
    }
    m = /\.router\.add_(get|post|put|delete|patch|head|options)\(\s*["']([^"']+)["']\s*,\s*(\w+)/.exec(line);
    if (m) {
      out.push({ method: m[1]!.toUpperCase(), path: m[2]!, handler: m[3]!, file, line: i + 1, framework: "aiohttp", kind: "http" });
    }
  }
  return out;
}

// ============================ 仓级 pass ============================
// 跨文件形态(Tornado Handler 方法级绑定 / Flask blueprint 定义与注册分居两文件)需要仓级视野:
// 单文件提取器(extractEndpointsFromFile)保持同步纯函数不变(091 测试面零影响),仓级 pass 仅在
// extractApiSurface 内以 import 图+盘存读取做确定性解析——解析不到=原样保留/不产出,不猜。

/** 仓级 pass 磁盘读缓存(带帽;import 目标文件可能不在指纹候选集内)。 */
type PyTextOf = (rel: string) => Promise<string | undefined>;
function makePyTextOf(root: string): PyTextOf {
  const cache = new Map<string, Promise<string | undefined>>();
  return (rel) => {
    let p = cache.get(rel);
    if (!p) {
      if (cache.size >= 60) return Promise.resolve(undefined); // 帽:病态 import 扇出防炸
      p = readFile(join(root, rel), "utf-8").then(
        (t) => t,
        () => undefined);
      cache.set(rel, p);
    }
    return p;
  };
}

/** Python import 图:name → 有序候选模块文件(仓内相对路径)。
 * 形态:`from .handlers.build_handler import Builder, BuildHandler, build_path`(相对点)
 *      `from redash.handlers import (admin, authentication, …)`(括号多行)
 *      `import redash.authentication.saml_auth as saml_auth`(别名)
 * `from M import N` 的 N 是模块或模块内名,静态不可分——候选 [M/N.py, M.py] 有序(子模块优先),
 * 由消费方按「文件内是否真有目标符号」定夺。 */
async function pythonImportMap(root: string, file: string, lines: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
  // 存在性检查走 statSync(不碰文本读缓存——stdlib/三方包探测 miss 会把缓存帽吃满,
 // jupyterlab labapp 前 60 行 import 探测注意把第 61 行的 build_handler 挤出)
  const { statSync } = await import("node:fs");
  const exists = (rel: string): boolean => {
    try { return statSync(join(root, rel)).isFile(); } catch { return false; }
  };
  const moduleCandidates = (dots: number, modPath: string, name?: string): string[] => {
    // 相对 import:dots≥1 锚定文件目录(dots-1 级上行);绝对 import:仓根为基
    let base = dots === 0 ? "" : dir;
    for (let d = 1; d < dots; d++) base = base.includes("/") ? base.slice(0, base.lastIndexOf("/")) : "";
    const segs = modPath ? modPath.split(".") : [];
    const modFile = [base, ...segs].filter(Boolean).join("/");
    const out: string[] = [];
    if (name) {
      // from M import N:[M/N.py, M.py, M/N/__init__.py, M/__init__.py(包级 re-export 中转)]
      if (exists(`${modFile}/${name}.py`)) out.push(`${modFile}/${name}.py`);
      if (exists(`${modFile}.py`)) out.push(`${modFile}.py`);
      if (exists(`${modFile}/${name}/__init__.py`)) out.push(`${modFile}/${name}/__init__.py`);
      if (exists(`${modFile}/__init__.py`)) out.push(`${modFile}/__init__.py`);
    } else {
      if (exists(`${modFile}.py`)) out.push(`${modFile}.py`);
      if (exists(`${modFile}/__init__.py`)) out.push(`${modFile}/__init__.py`);
    }
    return out;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fm = /^\s*from\s+([.\w]+)\s+import\s+(.+)$/.exec(line);
    if (fm) {
      let namesText = fm[2]!;
      // 括号多行 import:收集到括号平衡
      if (namesText.includes("(") && !namesText.includes(")")) {
        for (let j = i + 1; j < Math.min(lines.length, i + 15); j++) {
          namesText += " " + lines[j]!.trim();
          if (lines[j]!.includes(")")) break;
        }
      }
      const modRaw = fm[1]!;
      const dots = modRaw.match(/^\.+/)?.[0].length ?? 0;
      const modPath = modRaw.replace(/^\.+/, "");
      for (const part of namesText.replace(/[()]/g, " ").split(",")) {
        const nm = /^\s*([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?\s*$/.exec(part);
        if (!nm) continue;
        const orig = nm[1]!;
        const alias = nm[2] ?? orig;
        const cands = moduleCandidates(dots, modPath, orig);
        if (cands.length) map.set(alias, cands);
      }
      continue;
    }
    const im = /^\s*import\s+([A-Za-z_][\w.]*)(?:\s+as\s+([A-Za-z_]\w*))?\s*$/.exec(line);
    if (im) {
      const modPath = im[1]!;
      const alias = im[2] ?? modPath.split(".")[0]!;
      const cands = moduleCandidates(0, modPath);
      if (cands.length) map.set(alias, cands);
    }
  }
  return map;
}

const TORNADO_HTTP_METHODS = new Set(["get", "post", "put", "delete", "patch", "head", "options"]);

/** Tornado Handler 类的方法面扫描:类体缩进域内 `def get/post/…`(装饰器行跳过)。
 * 返回大写方法名集合;类不存在或无 HTTP 方法=undefined(不猜,ANY 端点保留)。 */
function scanTornadoClassMethods(text: string, cls: string): string[] | undefined {
  const lines = text.split("\n");
  const out = new Set<string>();
  let inCls = false, clsIndent = 0;
  for (const line of lines) {
    if (!inCls) {
      if (new RegExp(`^\\s*class\\s+${cls}\\b`).test(line)) {
        inCls = true;
        clsIndent = line.length - line.trimStart().length;
      }
      continue;
    }
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= clsIndent && !t.startsWith("@")) break; // 类域结束(顶层语句)
    const dm = /^(?:async\s+)?def\s+(get|post|put|delete|patch|head|options)\b/.exec(t);
    if (dm && TORNADO_HTTP_METHODS.has(dm[1]!)) out.add(dm[1]!.toUpperCase());
  }
  return out.size ? [...out] : undefined;
}

/** import 名的 re-export 链解析(≤depth 跳):候选文件自身再 import 同名时跟随——
 * 包级 __init__.py 中转形态(redash `from redash.handlers import routes` → __init__
 * → `from redash.handlers.base import routes` 注意)。 */
async function resolveNameFile(
  root: string,
  cands: string[],
  name: string,
  has: (fileText: string, file: string) => boolean,
  textOf: PyTextOf,
  depth = 2): Promise<string | undefined> {
  for (const c of cands) {
    const t = await textOf(c);
    if (t === undefined) continue;
    if (has(t, c)) return c;
    if (depth > 0) {
      const im2 = await pythonImportMap(root, c, t.split("\n"));
      const next = im2.get(name);
      if (next) {
        const r = await resolveNameFile(root, next, name, has, textOf, depth - 1);
        if (r) return r;
      }
    }
  }
  return undefined;
}

/** 仓级 pass ①:Tornado——import 已知常量重解析(变量绑定元组首元的 build_path 族)
 * + Handler 方法级绑定(web.Application 元组与 Handler.get/post 的确定性绑定:
 * 同文件类定义或 import 已知时,ANY 端点升级为逐方法端点;解析不到=保留 ANY,091 边界不退化)。 */
async function expandTornadoSurface(root: string, texts: Map<string, string>, endpoints: ApiEndpoint[]): Promise<void> {
  const tFiles = [...texts.keys()].filter((f) => detectFrameworks(texts.get(f)!).includes("tornado"));
  if (tFiles.length === 0) return;
  const textOf = makePyTextOf(root);
  const importMaps = new Map<string, Map<string, string[]>>();
  const importMapOf = async (f: string): Promise<Map<string, string[]>> => {
    let m = importMaps.get(f);
    if (!m) {
      m = await pythonImportMap(root, f, texts.get(f)!.split("\n"));
      importMaps.set(f, m);
    }
    return m;
  };
  // ① import 常量重解析:对每个 tornado 文件构造 extraConsts(import 名→字符串常量),带之重跑
  // extractTornado 并合并(同 file+line+handler 键:path 相同去重/标记升级替换/新端点追加)
  for (const f of tFiles) {
    const text = texts.get(f)!;
    const lines = text.split("\n");
    const im = await importMapOf(f);
    const extra = new Map<string, string>();
    for (const [name, cands] of im) {
      // re-export 链解析(包 __init__ 中转);常量所在文件=首个含该字符串常量的候选
      const f2 = await resolveNameFile(root, cands, name, (tx) => pythonStringConsts(tx.split("\n")).has(name), textOf);
      if (!f2) continue;
      const t2 = await textOf(f2);
      const v = t2 !== undefined ? pythonStringConsts(t2.split("\n")).get(name) : undefined;
      if (v !== undefined) extra.set(name, v);
    }
    if (extra.size === 0) continue;
    const repoEps = extractTornado(f, lines, pythonTripleMask(lines), extra);
    for (const e of repoEps) {
      const dupIdx = endpoints.findIndex(
        (x) => x.framework === "tornado" && x.file === e.file && x.line === e.line && (x.handler ?? "") === (e.handler ?? ""),
      );
      if (dupIdx >= 0) {
        const cur = endpoints[dupIdx]!;
        if (cur.path === e.path && cur.prefixInferred && !e.prefixInferred) endpoints.splice(dupIdx, 1, e);
        else if (cur.path !== e.path && !e.prefixInferred) endpoints.splice(dupIdx, 1, e); // 更精确路径升级
        continue;
      }
      endpoints.push(e);
    }
  }
  // ② 方法级绑定:ANY 端点的 handler 类方法面可解析时,逐方法端点替换(handler 仍=类名,
  // 供 handler→索引挂载;路径/行号不变,桥配对不受影响)
  for (let idx = 0; idx < endpoints.length; idx++) {
    const e = endpoints[idx]!;
    if (e.framework !== "tornado" || !e.handler || e.method !== "ANY") continue;
    const dotted = e.handler.split(".");
    const cls = dotted[dotted.length - 1]!;
    if (!/^[A-Za-z_]\w*$/.test(cls)) continue;
    let methods: string[] | undefined;
    const local = texts.get(e.file);
    if (dotted.length === 1 && local) methods = scanTornadoClassMethods(local, cls);
    if (!methods) {
      const im = await importMapOf(e.file);
      const head = dotted.length > 1 ? dotted[0]! : cls;
      const clsRe = new RegExp(`\\bclass\\s+${cls}\\b`);
      const f2 = await resolveNameFile(root, im.get(head) ?? [], cls, (tx) => clsRe.test(tx), textOf);
      if (f2) {
        const t = await textOf(f2);
        if (t !== undefined) methods = scanTornadoClassMethods(t, cls);
      }
    }
    if (!methods || methods.length === 0) continue;
    endpoints.splice(idx, 1, ...methods.map((m) => ({ ...e, method: m })));
    idx += methods.length - 1;
  }
}

/** 仓级 pass ②:Flask blueprint 跨文件挂载——定义表(`NAME = Blueprint(…, url_prefix=…)`)
 * × 注册表(`app.register_blueprint(ref, url_prefix=…)`,ref 经注册方 import 图解析;循环变量/
 * 工厂调用诚实跳过)× import 已知 recv 的 decorator 提取(redash `@routes.route(…)` 族:
 * recv 经本文件 import 图落到定义表才收,守卫强度不退化)。 */
async function expandFlaskBlueprints(root: string, texts: Map<string, string>, endpoints: ApiEndpoint[]): Promise<void> {
  const flaskFiles = [...texts.keys()].filter((f) => {
    const tx = texts.get(f)!;
    return detectFrameworks(tx).includes("flask") || /@\w+\.(route|get|post|put|delete|patch|head|options|websocket)\s*\(\s*["'A-Za-z_]/.test(tx);
  });
  const regFiles = [...texts.keys()].filter((f) => /register_blueprint\s*\(/.test(texts.get(f)!));
  if (flaskFiles.length === 0) return;
  const textOf = makePyTextOf(root);
  // 定义表
  const bpDef = new Map<string, string>(); // `${file}#${var}` → url_prefix(缺省 "")
  for (const f of flaskFiles) {
    for (const m of texts.get(f)!.matchAll(/(\w+)\s*=\s*Blueprint\s*\(([^)]*)\)/g)) {
      const kw = /url_prefix\s*=\s*["']([^"']*)["']/.exec(m[2]!);
      bpDef.set(`${f}#${m[1]!}`, kw?.[1] ?? "");
    }
  }
  if (bpDef.size === 0) return;
  // 注册表(跨文件):defKey → mountPrefix
  const regTable = new Map<string, string>();
  for (const f of regFiles) {
    const text = texts.get(f)!;
    const im = await pythonImportMap(root, f, text.split("\n"));
    const localVars = new Set([...bpDef.keys()].filter((k) => k.startsWith(f + "#")).map((k) => k.slice(f.length + 1)));
    for (const m of text.matchAll(/\.register_blueprint\s*\(\s*([A-Za-z_][\w.]*)([^)]*)\)/g)) {
      const ref = m[1]!;
 // 循环变量/工厂返回值不可静态归属(redash `for blueprint in […]: register_blueprint(blueprint)` 注意)
      if (new RegExp(`for\\s+${ref.split(".")[0]!}\\s+in\\b`).test(text)) continue;
      const kw = /url_prefix\s*=\s*["']([^"']*)["']/.exec(m[2]!);
      const mountPrefix = kw?.[1] ?? "";
      let defKey: string | undefined;
      if (ref.includes(".")) {
        const head = ref.split(".")[0]!;
        const varName = ref.split(".").pop()!;
        // 模块属性的蓝图定义:模块文件内需有该 Blueprint 定义(不跨跳——属性归属已定)
        for (const c of im.get(head) ?? []) {
          if (bpDef.has(`${c}#${varName}`)) { defKey = `${c}#${varName}`; break; }
        }
      } else if (localVars.has(ref)) {
        defKey = `${f}#${ref}`;
      } else {
        // 裸名:import 解析 + re-export 链(包 __init__ 中转)
        const rf = await resolveNameFile(root, im.get(ref) ?? [], ref, (_tx, c) => bpDef.has(`${c}#${ref}`), textOf);
        if (rf) defKey = `${rf}#${ref}`;
      }
      if (defKey && !regTable.has(defKey)) regTable.set(defKey, mountPrefix);
    }
  }
  // 逐文件:import 已知 recv 的新端点提取 + 同文件 blueprint 端点的跨文件注册升级
  const decoRe = /@(\w+)\.(get|post|put|delete|patch|head|options|route|websocket)\s*\(\s*/;
  for (const f of flaskFiles) {
    const text = texts.get(f)!;
    const lines = text.split("\n");
    const im = await pythonImportMap(root, f, lines);
    const localDefs = new Map<string, string>();
    for (const k of bpDef.keys()) if (k.startsWith(f + "#")) localDefs.set(k.slice(f.length + 1), k);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (isCommentLine(line)) continue;
      const m = decoRe.exec(line);
      if (!m) continue;
      const recv = m[1]!;
      const methodRaw = m[2]!;
      let defKey: string | undefined;
      let isLocal = false;
      if (localDefs.has(recv)) { defKey = localDefs.get(recv)!; isLocal = true; }
      else {
 // import 解析 + re-export 链(redash `from redash.handlers import routes` 注意)
        const rf = await resolveNameFile(root, im.get(recv) ?? [], recv, (_tx, c) => bpDef.has(`${c}#${recv}`), textOf);
        if (rf) defKey = `${rf}#${recv}`;
      }
      if (!defKey) continue;
      const mount = regTable.get(defKey);
      if (isLocal) {
        // 升级:一期已按同文件信息提取;跨文件注册已知→合成 mount 并清推断标记。
        // 同文件已挂载的(一期已合成该 mount)不叠加——本文件内存在对该变量的注册调用即视为已挂载。
        if (mount === undefined) continue;
        if (new RegExp(`\\.register_blueprint\\s*\\(\\s*${recv}\\b`).test(text)) continue;
        for (const e of endpoints) {
          if (e.file !== f || e.line !== i + 1 || (e.framework !== "flask" && e.framework !== "python-decorator")) continue;
          // 一期 path 已含定义前缀(若有);此处合成跨文件注册前缀(mount 为空=仅清标记)
          e.path = joinPath(mount, e.path);
          delete e.prefixInferred;
        }
        continue;
      }
      // 新增:recv 为 import 的 blueprint(一期守卫拒绝面)
      const afterParen = line.slice(m.index + m[0].length);
      const pr = decoratorPathArg(lines, i, afterParen);
      if (!pr) continue;
      const localPath = pr.path;
      const pathInferred = pr.inferred;
      const isWs = WS_METHODS.has(methodRaw);
      let methods: string[] = isWs ? ["WS"] : [methodRaw.toUpperCase()];
      if (methodRaw === "route") {
        const kwText = afterParen.trim() ? afterParen : [afterParen, ...lines.slice(i + 1, i + 5)].join(" ");
        const mm = /methods\s*=\s*\[([^\]]*)\]/.exec(kwText);
        methods = mm
          ? (mm[1]!.match(/["']([A-Z]+)["']/g) ?? ["GET"]).map((s) => s.replace(/["']/g, ""))
          : ["GET"];
      }
      // handler:后续 ≤8 行第一个 def(与一期同口径)
      let handler: string | undefined;
      for (let j = i + 1; j < Math.min(lines.length, i + 9); j++) {
        const dm = /^\s*(?:async\s+)?def\s+(\w+)\s*\(/.exec(lines[j]!);
        if (dm) { handler = dm[1]!; break; }
        if (/^\s*@/.test(lines[j]!) || /^\s*(#|$)/.test(lines[j]!)) continue;
        break;
      }
      const defPrefix = bpDef.get(defKey) ?? "";
      const prefix = mount !== undefined ? joinPath(mount, defPrefix) : defPrefix;
      const inferred = (mount === undefined && !defPrefix) || pathInferred;
      for (const method of methods) {
        const dup = endpoints.some((e) => e.file === f && e.line === i + 1 && e.method === method && e.path === joinPath(prefix, localPath!));
        if (dup) continue;
        endpoints.push({
          method, path: joinPath(prefix, localPath), file: f, line: i + 1,
          framework: "flask", kind: isWs ? "ws" : "http",
          ...(handler ? { handler } : {}),
          ...(inferred ? { prefixInferred: true } : {}),
        });
      }
    }
  }
}
/** 单文件提取(框架分派)。 */
export function extractEndpointsFromFile(file: string, text: string): ApiEndpoint[] {
  const frameworks = detectFrameworks(text);
  const lines = text.split("\n");
  const out: ApiEndpoint[] = [];
  if (frameworks.includes("fastapi") || frameworks.includes("flask")) {
    out.push(...extractPythonDecorators(file, lines));
  }
  if (frameworks.some((f) => ["starlette", "tornado", "flask-restful"].includes(f))) {
    const mask = pythonTripleMask(lines);
    if (frameworks.includes("starlette")) out.push(...extractStarlette(file, lines, mask));
    if (frameworks.includes("tornado")) out.push(...extractTornado(file, lines, mask));
    if (frameworks.includes("flask-restful")) out.push(...extractFlaskRestful(file, lines, mask));
  }
  if (frameworks.includes("aiohttp")) out.push(...extractAiohttp(file, lines));
  if (frameworks.some((f) => ["express", "koa", "fastify"].includes(f))) {
    out.push(...extractJsCalls(file, lines));
  }
  if (frameworks.includes("nextjs")) out.push(...extractNextjs(file, lines));
  // Next.js 纯文件约定(无 next/server import 也可能是 pages/api 目录):补扫
  if (out.length === 0 && nextjsRoutePath(file)) out.push(...extractNextjs(file, lines));
  if (frameworks.includes("spring")) out.push(...extractSpring(file, lines));
  if (frameworks.some((f) => ["gin", "net-http", "mux"].includes(f))) out.push(...extractGo(file, lines, frameworks));
  if (frameworks.includes("chi")) out.push(...extractChi(file, lines, frameworks));
  // framework 标注回填(提取器内部给的是形态名,统一为指纹框架名)
  for (const e of out) {
    if (e.framework === "python-decorator") e.framework = frameworks.includes("fastapi") ? "fastapi" : "flask";
    if (e.framework === "js-call") e.framework = frameworks.find((f) => ["express", "koa", "fastify"].includes(f))!;
  }
  return out;
}

/** 仓级提取:候选文件(指纹预筛后的集合,调用方用 grep 预筛或全量小仓)逐文件行扫描。
 * RC-M:文档路径(.md/.adoc/.rst/…/docs 目录)不提取——specs/*.md 里的接口示例
 * 此前直接成了「端点」。 */
export async function extractApiSurface(root: string, files: string[]): Promise<ApiSurface> {
  const endpoints: ApiEndpoint[] = [];
  let scanned = 0;
 // python 面文件文本留存(仓级 pass 用;register_blueprint 注册方可能无框架指纹,显式收编)
  const pyTexts = new Map<string, string>();
  const PY_PASS_FW = new Set(["fastapi", "flask", "flask-restful", "starlette", "tornado"]);
  for (const f of files) {
    if (isDocPath(f)) continue;
    let text = "";
    try {
      text = await readFile(join(root, f), "utf-8");
    } catch { continue; }
    const fw = detectFrameworks(text);
    const hasBpReg = /register_blueprint\s*\(/.test(text);
 // blueprint 使用方信号(redash admin.py 注意:@routes.route 但零 flask import——指纹层不认识,
    // 仓级 pass 的 recv→import→定义解析是精度闸,这里只负责让文件进入仓级视野)
    const hasBpDeco = f.endsWith(".py") && /@\w+\.(route|get|post|put|delete|patch|head|options|websocket)\s*\(\s*["'A-Za-z_]/.test(text);
    if (fw.length === 0 && !nextjsRoutePath(f) && !hasBpReg && !hasBpDeco) continue;
    scanned++;
    endpoints.push(...extractEndpointsFromFile(f, text));
    if (hasBpReg || hasBpDeco || fw.some((x) => PY_PASS_FW.has(x))) pyTexts.set(f, text);
  }
 // 仓级 pass(确定性解析;解析不到=原样保留,不猜)
  await expandTornadoSurface(root, pyTexts, endpoints);
  await expandFlaskBlueprints(root, pyTexts, endpoints);
  endpoints.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  // frameworks=实际产出了端点的框架(防「文件 import 了 NextResponse 但不是 API 路由」类指纹误报)
  const frameworks = [...new Set(endpoints.map((e) => e.framework))];
  return { endpoints, frameworks, scannedFiles: scanned };
}

/** 指纹预筛用的字面量清单(search.grepIn 是字面量匹配——传正则源会被转义失效,
 * 这里必须给字面串;宁可多收候选文件,提取层按 detectFrameworks 精确判定)。
 * 重排:框架特异字面量在前、泛型("net/http" 单 pattern 可命中数千文件)垫后——
 * grepFilesIn 逐 pattern 累积、配额满即早退,泛型先跑会把特异 pattern 挤出候选
 * (grafana 1500 配额验证)。小仓(候选<max)集合恒等=零回退面。 */
export const API_FINGERPRINT_LITERALS = [
  "fastapi",
  "from flask import",
  "flask_restful",
  "flask_restx",
  "add_org_resource",
  "add_resource",
  "register_blueprint(",
  "routes.route(",
  "blueprint.route(",
  "starlette",
  "tornado",
  "web.Application",
  "handlers.append",
  "aiohttp",
  "Blueprint(",
  "APIRouter(",
  "gin-gonic/gin",
  "gorilla/mux",
  "go-chi/chi",
  "chi.Router",
  "RouteRegister",
  '"express"',
  "'express'",
  "koa-router",
  "@koa/router",
  "fastify",
  "next/server",
  "NextResponse",
  "@RestController",
  "RequestMapping(",
  '"net/http"',
];

/** 路径归一(对账口径):/users/:id 与 /users/{id} 与 Flask 转换器 /users/<int:id> 同形;尾斜杠剥离。 */
export function normalizePath(p: string): string {
  return p
    .replace(/:([\w]+)/g, "{$1}")
    .replace(/\{[^}]+\}/g, "{}")
    .replace(/<(?:\w+:)?\w+>/g, "{}")
    .replace(/\/+$/, "") || "/";
}
