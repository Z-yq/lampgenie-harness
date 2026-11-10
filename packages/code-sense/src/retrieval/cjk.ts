/**
 * CJK 分词 + 中文→英文开发域词典 + 标识符切分(2026-10-21 符号优先召回)。
 *
 * 为什么独立成文件:explore/wiki ask 的召回质量瓶颈在「入口词」(中文问句无法直接命中
 * camelCase 符号名),而 symbol 一查就准。这里全部是**纯函数**(无 IO、无依赖),把
 * 「中文问句 → 词 → 英文词根 → 符号名 token」这条链拆成可单测的确定性步骤:
 *   1) 停用词剥离(疑问/语气/介连词),内容词保留;
 *   2) 开发域词典最长匹配(greedy,长词优先:「状态机」先于「状态」);
 *   3) 词典未覆盖的整段才做 2 字滑窗兜底(避免「何添/加子」类残渣——2026-10-21 A 修复);
 *   4) 一个中文词可映射多个英文词(「子代理」→ subagent/agent/spawn/worker),
 *      数组序=主次(第一个是主词根,权重更高);
 *   5) 驼峰/下划线/连字符/点号切分(ANSWER_SUBAGENT_SPEC / LlmLoopBackend.spawn)。
 *
 * 词典是单一真相:search.ts(normalizeQuery 的 grep 变体)与 wiki/extractKeywords
 * (页面词法检索)都从这里取词面,不复制——复制=口径漂移。
 */

const CJK_RE = /[\u4e00-\u9fff]/;

/** 中文停用词:疑问/语气/介词/连词/指代词。只收功能词——内容动词(添加/校验/派发)不入。 */
export const CJK_STOPWORDS: ReadonlySet<string> = new Set([
  "怎么", "怎样", "怎么样", "如何", "为何", "为什么", "干嘛", "干什么", "做什么", "什么", "什么样",
  "哪些", "哪个", "哪里", "哪儿", "是不是", "能不能", "可不可以", "有没有", "好不好", "行不行",
  "请", "麻烦", "告诉", "知道", "帮我", "我想", "想要", "请问", "一下", "一些", "一点",
  "吗", "呢", "吧", "啊", "呀", "哦", "嗯", "的", "了", "地", "得", "之",
  "是", "有", "和", "与", "或", "及", "对", "从", "到", "在", "把", "被", "让", "给", "用", "向", "往",
  "这", "那", "这个", "那个", "这些", "那些", "都", "也", "就", "还", "又", "再", "才", "只", "并", "而", "且",
  "但是", "因为", "所以", "如果", "虽然", "不过", "然后", "以及", "还有",
  // 问句里高频的方位/趋向补语(「怎么回到父会话」的「回」是单字,靠 2 字词表拦)
  "回到", "走到", "来到", "进入", "出去", "出来", "起来", "下来", "上来", "过去",
]);

/** 中文→英文开发域词典(≥40 组;一个中文词可映射多个英文词,数组序=主次)。
 * 覆盖本仓与周边 vibe coding 场景:代理/审批/索引/状态机/看板/协议/追踪/阶段/召回/开销…
 * 注意:greedy 最长匹配会优先取长键(「状态机」>「状态」,「总路线」>「路线」)。 */
export const CJK_EN_DICT: ReadonlyArray<readonly [string, readonly string[]]> = [
  // —— 产品/界面 ——
  ["路线", ["roadmap", "route", "waypoint"]],
  ["总路线", ["roadmap", "master"]],
  ["导航", ["nav", "route", "menu"]],
  ["看板", ["dashboard", "board", "kanban"]],
  ["白板", ["board", "whiteboard", "canvas"]],
  ["面板", ["panel", "view"]],
  ["侧栏", ["sidebar", "side"]],
  ["顶栏", ["header", "topbar", "navbar"]],
  ["弹窗", ["modal", "dialog", "overlay", "popup"]],
  ["按钮", ["button", "btn"]],
  ["表单", ["form", "input", "field"]],
  ["列表", ["list", "table"]],
  ["详情", ["detail", "profile"]],
  ["首页", ["home", "dashboard", "overview"]],
  ["图表", ["chart", "graph", "mermaid"]],
  ["统计", ["stat", "metric", "trend", "analytic"]],
  ["设置", ["settings", "config", "preference"]],
  ["配置", ["config", "setting", "schema"]],
  ["档案", ["archive", "profile"]],

  // —— 代理/子代理/审批(本次改造的主场) ——
  ["子代理", ["subagent", "agent", "spawn", "worker"]],
  ["代理", ["agent", "proxy", "spawn"]],
  ["父会话", ["parent", "session"]],
  ["父代理", ["parent", "agent"]],
  ["会话", ["session", "conversation"]],
  ["派发", ["dispatch", "spawn", "assign", "delegate"]],
  ["调度", ["schedule", "dispatch", "orchestrate"]],
  ["审批", ["approve", "approval", "permission", "ask", "confirm"]],
  ["审批流", ["approval", "approve", "flow", "request"]],
  ["权限", ["permission", "auth", "capability", "allow", "grant"]],
  ["授权", ["authorize", "permission", "grant"]],
  ["认证", ["auth", "authenticate", "login"]],
  ["登录", ["auth", "login", "signin"]],
  ["应答", ["answer", "reply", "respond"]],
  ["回复", ["reply", "respond", "answer"]],
  ["请求", ["request", "req", "ask"]],
  ["响应", ["response", "res", "reply"]],
  ["排队", ["queue", "pending"]],
  ["取消", ["cancel", "abort"]],
  ["重试", ["retry", "backoff"]],
  ["超时", ["timeout", "deadline"]],
  ["中断", ["abort", "interrupt"]],
  ["等待", ["wait", "await", "pending"]],
  ["阻塞", ["block", "wait"]],
  ["限流", ["throttle", "ratelimit", "limit"]],

  // —— 运行时/循环/工具 ——
  ["主循环", ["main", "loop"]],
  ["循环", ["loop", "cycle"]],
  ["工具调用", ["tool", "call", "invoke"]],
  ["工具", ["tool"]],
  ["技能", ["skill"]],
  ["提示词", ["prompt", "tips"]],
  ["上下文", ["context"]],
  ["压缩", ["compact", "compress", "trim"]],
  ["裁剪", ["trim", "truncate", "clip"]],
  ["心跳", ["heartbeat", "ping"]],
  ["重连", ["reconnect", "retry"]],
  ["网关", ["gateway", "server"]],
  ["模型", ["model", "llm", "provider"]],
  ["语音", ["voice", "audio", "asr", "tts"]],
  ["消息", ["message", "chat", "notify"]],
  ["任务", ["task", "job"]],
  ["队列", ["queue", "channel"]],
  ["进程", ["process", "proc"]],
  ["线程", ["thread"]],
  ["协程", ["coroutine", "async"]],
  ["沙箱", ["sandbox", "isolate"]],
  ["预算", ["budget", "quota"]],
  ["开销", ["cost", "token", "budget", "overhead"]],

  // —— 代码感知/索引 ——
  ["索引", ["index", "sensing"]],
  ["符号", ["symbol", "sym"]],
  ["召回", ["recall", "retrieve", "search"]],
  ["检索", ["search", "query", "retrieve"]],
  ["搜索", ["search", "query"]],
  ["调用链", ["callchain", "call", "chain"]],
  ["调用", ["call", "invoke"]],
  ["影响面", ["impact", "blast", "radius"]],
  ["入口", ["entry", "entrypoint", "main"]],
  ["模块", ["module", "package"]],
  ["依赖", ["depend", "import"]],
  ["接口", ["api", "interface", "endpoint"]],
  ["协议", ["protocol", "proto", "schema"]],
  ["状态机", ["state", "transition", "machine", "status"]],
  ["状态", ["state", "status"]],
  ["流程", ["flow", "pipeline", "workflow"]],
  ["阶段", ["phase", "stage", "step"]],
  ["追踪", ["trace", "track", "span"]],
  ["日志", ["log", "journal"]],
  ["审计", ["audit", "review"]],
  ["评测", ["eval", "benchmark", "score"]],
  ["评审", ["review", "audit"]],
  ["基准", ["benchmark", "baseline"]],
  ["性能", ["perf", "performance", "latency"]],
  ["缓存", ["cache", "memo"]],

  // —— 数据/错误/网络 ——
  ["错误", ["error", "err", "fail"]],
  ["异常", ["exception", "error", "throw"]],
  ["警告", ["warn", "warning"]],
  ["重试次数", ["retry", "attempt"]],
  ["数据库", ["db", "database", "sql"]],
  ["事务", ["transaction", "tx"]],
  ["迁移", ["migration", "migrate"]],
  ["字段", ["field", "column"]],
  ["表格", ["table", "grid"]],
  ["服务", ["service", "server"]],
  ["客户端", ["client", "sdk"]],
  ["中间件", ["middleware", "plugin"]],
  ["钩子", ["hook", "callback"]],
  ["回调", ["callback", "handler", "cb"]],
  ["事件", ["event", "emit"]],
  ["订阅", ["subscribe", "listen", "sub"]],
  ["发布", ["publish", "emit", "release"]],
  ["推送", ["push", "send"]],
  ["上传", ["upload"]],
  ["下载", ["download"]],
  ["导出", ["export", "download"]],
  ["导入", ["import", "upload"]],
  ["加密", ["encrypt", "crypto"]],
  ["解密", ["decrypt", "crypto"]],
  ["签名", ["sign", "signature"]],
  ["证书", ["cert", "certificate"]],
  ["端口", ["port"]],
  ["主机", ["host", "hostname"]],

  // —— 工程动作 ——
  ["添加", ["add", "insert", "append"]],
  ["新增", ["add", "create", "new"]],
  ["删除", ["delete", "remove", "del"]],
  ["修改", ["modify", "update", "edit"]],
  ["更新", ["update", "refresh"]],
  ["查询", ["query", "find", "get"]],
  ["查找", ["find", "search", "lookup"]],
  ["过滤", ["filter"]],
  ["排序", ["sort", "order"]],
  ["合并", ["merge", "combine"]],
  ["拆分", ["split", "parse"]],
  ["复制", ["copy", "clone", "dup"]],
  ["注册", ["register", "registry"]],
  ["校验", ["validate", "check", "verify"]],
  ["验证", ["verify", "validate"]],
  ["检查", ["check", "inspect"]],
  ["测试", ["test", "spec"]],
  ["调试", ["debug", "diagnose"]],
  ["初始化", ["init", "initialize", "bootstrap"]],
  ["定义", ["define", "definition"]],
  ["实现", ["implement", "impl"]],
  ["调用方", ["caller"]],
  ["被调用", ["callee", "called"]],
  ["触发", ["trigger", "fire"]],
  ["返回", ["return", "result"]],
  ["抛出", ["throw", "raise"]],
  ["捕获", ["catch", "capture"]],
  ["解析", ["parse", "resolve"]],
  ["序列化", ["serialize", "json"]],
  ["转换", ["convert", "transform"]],
  ["生成", ["generate", "build", "gen"]],
  ["创建", ["create", "make", "new"]],
  ["构建", ["build", "compile"]],
  ["编译", ["compile", "build"]],
  ["打包", ["bundle", "pack"]],
  ["部署", ["deploy", "release"]],
  ["运行", ["run", "exec", "start"]],
  ["启动", ["start", "boot", "launch"]],
  ["停止", ["stop", "halt"]],
  ["恢复", ["resume", "restore"]],
  ["保存", ["save", "persist"]],
  ["加载", ["load"]],
  ["读取", ["read", "load"]],
  ["写入", ["write", "save"]],
  ["监听", ["listen", "watch"]],
  ["发送", ["send", "emit"]],
  ["接收", ["receive", "recv"]],
  ["转发", ["forward", "relay"]],
  ["继承", ["extend", "inherit"]],
  ["覆盖", ["override", "overwrite"]],
  ["遍历", ["iterate", "walk"]],
  ["递归", ["recursive", "recurse"]],
  ["加锁", ["lock", "mutex"]],
  ["解锁", ["unlock", "release"]],

  // —— 结构/命名 ——
  ["项目", ["project", "repo"]],
  ["仓库", ["repo", "repository"]],
  ["文件", ["file"]],
  ["目录", ["dir", "directory", "folder"]],
  ["函数", ["function", "func", "fn"]],
  ["方法", ["method"]],
  ["变量", ["variable", "var"]],
  ["常量", ["constant", "const"]],
  ["类型", ["type", "typedef"]],
  ["结构体", ["struct", "structure"]],
  ["枚举", ["enum"]],
  ["注释", ["comment", "doc"]],
  ["文档", ["doc", "readme"]],
  ["示例", ["example", "sample", "demo"]],
  ["骨架", ["skeleton", "draft"]],
  ["主线", ["mainline", "master", "primary"]],
  ["分支", ["branch"]],
  ["提交", ["commit"]],
  ["版本", ["version", "ver"]],
  ["标签", ["label", "tag"]],
  ["节点", ["node"]],
  ["路径", ["path", "route"]],
  ["用户", ["user", "member", "account"]],
  ["评审意见", ["review", "comment", "finding"]],
  ["经验", ["experience", "lesson"]],
  ["评论", ["comment", "review"]],
  ["提醒", ["remind", "notice", "toast"]],
  ["终端", ["terminal", "pty", "shell"]],
];

/** 词典键面(wiki/其它消费者建词表用;单一真相,不复制)。 */
export function cjkDomainWords(): string[] {
  return CJK_EN_DICT.map(([cn]) => cn);
}

const DICT_INDEX: ReadonlyMap<string, readonly string[]> = new Map(CJK_EN_DICT);
const CJK_MAX_WORD = CJK_EN_DICT.reduce((n, [cn]) => Math.max(n, cn.length), 2);

/** 中文词→英文词根(未命中=[];主词在前)。 */
export function cjkToEnglish(word: string): readonly string[] {
  return DICT_INDEX.get(word) ?? [];
}

/** 开发域动作/结构词面(词典键面之外的中文内容词;wiki 切词与 query 切词共用)。
 * 只收「独立成词」的双字以上内容词——单字不入(会制造残渣)。 */
const DEV_WORDS = new Set([
  "添加", "新增", "增加", "删除", "移除", "修改", "更改", "变更", "更新", "查找", "查询", "搜索", "检索",
  "过滤", "排序", "分组", "合并", "拆分", "复制", "克隆", "注册", "登录", "登出", "校验", "验证", "检查",
  "审查", "评审", "测试", "调试", "初始化", "配置", "设置", "定义", "声明", "实现", "编写", "调用", "处理",
  "触发", "返回", "抛出", "捕获", "解析", "序列化", "反序列化", "转换", "生成", "创建", "构建", "编译",
  "打包", "部署", "运行", "启动", "停止", "暂停", "恢复", "重试", "取消", "中断", "超时", "导出", "导入",
  "上传", "下载", "保存", "加载", "读取", "写入", "监听", "订阅", "发布", "推送", "发送", "接收", "转发",
  "路由", "继承", "重载", "覆盖", "嵌套", "递归", "迭代", "遍历", "循环", "缓存", "加锁", "解锁",
  "子命令", "命令", "参数", "选项", "标志", "变量", "常量", "函数", "方法", "接口", "类型", "结构体",
  "枚举", "模块", "依赖", "版本", "分支", "标签", "提交", "冲突", "钩子", "回调", "事件", "消息", "队列",
  "线程", "协程", "进程", "异常", "错误", "警告", "日志", "路径", "文件", "目录", "索引", "注解",
  "装饰器", "生成器", "迭代器", "协议", "中间件", "请求", "响应", "会话", "认证", "授权", "加密", "解密",
  "签名", "证书", "端口", "主机", "服务", "客户端", "服务端", "数据库", "字段", "事务", "迁移",
  "模型", "训练", "推理", "数据集", "标注", "检测", "识别", "分割", "跟踪", "评测", "基准", "性能",
  "入口", "文档", "示例", "别名", "命名", "作用域", "上下文", "提示词",
]);
// 词典键面并入(单一真相):「子代理/权限/派发/状态机」等既进词典也进词表
for (const w of cjkDomainWords()) DEV_WORDS.add(w);

/** 只读词面(构建期填充完成;消费方只读)。 */
export const CJK_DEV_WORDS: ReadonlySet<string> = DEV_WORDS;

/** 中文段切词:停用词剥离 + 词典最长匹配;整段无任何词典命中才滑窗兜底。
 * 词典命中过 → 残段按整段产出(保留原短语的 grep 特异性);
 * 完全无词典命中(纯领域专名) → 2 字滑窗兜底(停用词过滤)。
 * 这个行为与 2026-10-21 A 修复的单测口径一致(「何添/加子」残渣不得出现)。 */
export function segmentCjkRun(run: string, add: (w: string) => void): void {
  let pos = 0;
  let dictHit = false;
  const residues: string[] = [];
  let buf = "";
  const flush = (): void => {
    if (buf) {
      residues.push(buf);
      buf = "";
    }
  };
  const kindOf = (w: string): "stop" | "word" | null => {
    if (CJK_STOPWORDS.has(w)) return "stop";
    if (CJK_DEV_WORDS.has(w)) return "word";
    return null;
  };
  while (pos < run.length) {
    let hit: "stop" | "word" | null = null;
    let hitLen = 0;
    for (let len = Math.min(CJK_MAX_WORD, run.length - pos); len >= 2; len--) {
      const kind = kindOf(run.slice(pos, pos + len));
      if (kind) {
        hit = kind;
        hitLen = len;
        break;
      }
    }
    if (hit) {
      flush();
      dictHit = true;
      if (hit === "word") add(run.slice(pos, pos + hitLen));
      pos += hitLen; // stop:功能词消耗不产出
    } else {
      buf += run[pos]!;
      pos += 1;
    }
  }
  flush();
  if (dictHit) {
    for (const r of residues) if (r.length >= 2 && !CJK_STOPWORDS.has(r)) add(r);
    return;
  }
  for (let i = 0; i + 2 <= run.length; i++) {
    const w = run.slice(i, i + 2);
    if (!CJK_STOPWORDS.has(w)) add(w);
  }
}

/** 中文段 → 词列表(去重保序;不含停用词)。 */
export function segmentCjk(run: string): string[] {
  const out: string[] = [];
  segmentCjkRun(run, (w) => {
    if (!out.includes(w)) out.push(w);
  });
  return out;
}

/** 标识符切分:camelCase / PascalCase / snake_case / kebab-case / 点号 / 中文段。
 * 例:makeSubagentPermissionAsker → [make, subagent, permission, asker]
 *     ANSWER_SUBAGENT_SPEC        → [answer, subagent, spec]
 *     LlmLoopBackend.spawn        → [llm, loop, backend, spawn]
 * 返回小写 token(中文段原样);空串不产。 */
export function splitIdentifier(raw: string): string[] {
  const out: string[] = [];
  for (const chunk of raw.split(/[^A-Za-z0-9\u4e00-\u9fff]+/)) {
    if (!chunk) continue;
    const pieces = chunk.match(/[\u4e00-\u9fff]+|[A-Za-z0-9]+/g) ?? [];
    for (const piece of pieces) {
      if (CJK_RE.test(piece)) {
        out.push(piece);
        continue;
      }
      // 小写→大写边界(makeSubagent)+ 连续大写→大写+小写边界(HTTPServer)
      const spaced = piece
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
      for (const tok of spaced.split(/\s+/)) if (tok) out.push(tok.toLowerCase());
    }
  }
  return out;
}

/** 英文功能词(查询里出现不改召回,不入词表)。只收纯虚词——内容动词(get/set/use)保留。 */
const ENGLISH_STOPWORDS: ReadonlySet<string> = new Set([
  "the", "and", "for", "how", "what", "which", "where", "when", "why", "who", "with", "from",
  "into", "onto", "this", "that", "these", "those", "are", "was", "were", "does", "did", "doing",
  "can", "could", "should", "would", "will", "you", "your", "our", "its", "not", "but", "all",
  "any", "about", "there", "here", "they", "them", "then", "than", "have", "has", "had",
  "to", "of", "in", "on", "or", "by", "as", "at", "if", "it", "is", "be", "do",
]);

export type QueryTermSource = "identifier" | "english" | "dict" | "cjk";

export interface QueryTerm {
  /** 小写英文词根 / 中文词原文。 */
  term: string;
  /** 相对权重:标识符整名 2.5 > 直给英文 1.5 > 词典主词 1.3 > 词典次词 0.8 > 未映射中文 0.6。 */
  weight: number;
  source: QueryTermSource;
}

export interface QueryTerms {
  raw: string;
  /** 去重(同词取最大权重),已按权重降序稳定排列。 */
  terms: QueryTerm[];
  /** 原样标识符(camel/snake/dotted 形态;整名精确命中是强信号)。 */
  identifiers: string[];
  /** 中文词(含未映射的整段残留)。 */
  cjkWords: string[];
  /** 英文词根(直给 + 词典扩出),按出现序去重。 */
  englishWords: string[];
}

/** 中文问句 → 召回词表(纯函数;explore 与 wiki ask 同源)。
 * 优先级:标识符整名 > 直给英文词 > 词典主词根 > 词典次词根 > 未映射中文短语。 */
export function queryTerms(query: string): QueryTerms {
  const byTerm = new Map<string, QueryTerm>();
  const identifiers: string[] = [];
  const cjkWords: string[] = [];
  const englishWords: string[] = [];
  const push = (term: string, weight: number, source: QueryTermSource): void => {
    if (!term) return;
    const prev = byTerm.get(term);
    if (!prev || weight > prev.weight) byTerm.set(term, { term, weight, source });
  };

  // ① 英文标识符(原样 + 切分 token)
  for (const m of query.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
    const raw = m[0];
    const hasShape = /[_$]/.test(raw) || /[a-z0-9][A-Z]/.test(raw);
    if (hasShape && raw.length >= 3) {
      if (!identifiers.includes(raw)) identifiers.push(raw);
      push(raw.toLowerCase(), 2.5, "identifier");
    }
    for (const tok of splitIdentifier(raw)) {
      if (tok.length < 2 || CJK_RE.test(tok) || ENGLISH_STOPWORDS.has(tok)) continue;
      if (!englishWords.includes(tok)) englishWords.push(tok);
      push(tok, raw.length >= 4 ? 1.5 : 1.0, "english");
    }
  }

  // ② 中文段:词典最长匹配 → 英文词根
  for (const m of query.matchAll(/[\u4e00-\u9fff]+/g)) {
    for (const w of segmentCjk(m[0])) {
      if (CJK_STOPWORDS.has(w)) continue;
      if (!cjkWords.includes(w)) cjkWords.push(w);
      const en = cjkToEnglish(w);
      if (en.length === 0) {
        push(w, 0.6, "cjk");
        continue;
      }
      en.forEach((root, i) => {
        if (!englishWords.includes(root)) englishWords.push(root);
        push(root, i === 0 ? 1.3 : 0.8, "dict");
      });
    }
  }

  const terms = [...byTerm.values()].sort((a, b) => b.weight - a.weight);
  return { raw: query, terms, identifiers, cjkWords, englishWords };
}
