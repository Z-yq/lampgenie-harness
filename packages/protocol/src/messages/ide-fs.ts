/**
 * 文件系统/IDE/Git 域消息:fs.* 与 ssh/wsl/remote/file.read/write/ide.office/fs 操作/lsp/term.session/git.* 与 files.search。
 * 自 index.ts(2941 行)按域拆分,逐字搬移。
 */
import { z } from "zod";
import { Envelope } from "./core.js";
// [CROSS-IMPORTS]
// ---- 服务端目录浏览(「选目录弹 Windows 对话框」根治 + 项目文件树) ----
export const FsList = Envelope.extend({
  type: z.literal("fs.list"),
 /** 绝对路径;"" = 返回锚点(home/root/cwd)。 */
  path: z.string(),
  showHidden: z.boolean().optional(),
});
export const SshKeyImport = Envelope.extend({
  type: z.literal("ssh.key.import"),
 /** 本机私钥文件路径(SSH config IdentityFile;读内容入 secrets,路径不入库)。 */
  path: z.string().min(1),
  host: z.string().min(1),
  user: z.string().min(1),
});
export const SshConfigList = Envelope.extend({
  type: z.literal("ssh.config.list"),
});
export const SshTest = Envelope.extend({
  type: z.literal("ssh.test"),
 /** 目标主机;凭证=已存 secrets(env 优先);不传密码字段(不在 WS 明文流密码)。 */
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().min(1),
 /** 连接向导:连通后顺手安装工作区服务并 ping 验证(设置台「测试连接」不传,保持轻量)。 */
  ensureServer: z.boolean().optional(),
});
// WSL 连接向导(与 SSH 同构:先连接→连接中装工作区服务→经服务浏览目录→选目录添加项目)
export const WslList = Envelope.extend({
  type: z.literal("wsl.list"),
});
export const WslTest = Envelope.extend({
  type: z.literal("wsl.test"),
 /** WSL 发行版名(wsl.exe -l -q 输出;如 Ubuntu)。 */
  distro: z.string().min(1),
});
export const WslBrowse = Envelope.extend({
  type: z.literal("wsl.browse"),
 /** 发行版内绝对 POSIX 路径(经工作区服务列目录;供连接向导选项目目录)。 */
  distro: z.string().min(1),
  path: z.string().min(1),
});
export const SshBrowse = Envelope.extend({
  type: z.literal("ssh.browse"),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().min(1),
 /** 远端绝对 POSIX 路径(经工作区服务列目录)。 */
  path: z.string().min(1),
});
export const RemoteLs = Envelope.extend({
  type: z.literal("remote.ls"),
 /** 远程项目 id(项目表内 remote:ssh 条目;路径围栏=其 workspacePath)。 */
  projectId: z.string().min(1),
 /** 工作区内相对路径;""=根。 */
  path: z.string().optional(),
});
export const RemoteDeploy = Envelope.extend({
  type: z.literal("remote.deploy"),
 /** 部署远端工作区服务(shim)到项目的 SSH 主机。 */
  projectId: z.string().min(1),
});
export const RemoteRead = Envelope.extend({
  type: z.literal("remote.read"),
  projectId: z.string().min(1),
 /** 工作区内相对路径。 */
  path: z.string().min(1),
});
export const FsOpen = Envelope.extend({
  type: z.literal("fs.open"),
  path: z.string().min(1),
 /** true=在文件管理器中定位(目录);false=系统默认应用打开。 */
  reveal: z.boolean().optional(),
});

// ---- @ 文件提及(ZCode fileMentionProvider 移植) ----
// ---- F6 workflow ask 面板应答 ----
export const WorkflowAnswer = Envelope.extend({
  type: z.literal("workflow.answer"),
 /** 问题身份(engine cacheKey)。 */
  cacheKey: z.string().min(1),
  value: z.string().min(1),
});

export const FileRead = Envelope.extend({
  type: z.literal("file.read"),
 /** 项目内相对路径(citation 点击来源)。 */
  path: z.string().min(1),
 /** 目标行(视图滚动定位);缺省=1。 */
  line: z.number().int().positive().optional(),
 /** IDE:回全文(startLine=1+全文 content);缺省行为不变(±20 行窗口)。 */
  full: z.literal(true).optional(),
 /** :解析根的项目 id——IDE 树按桶打开时必带(否则 server 回退 activeId,
 * 活动项目≠树项目时读错根→missing→编辑区空白,经验证复现)。缺省=旧语义(活动项目)。 */
  projectId: z.string().optional(),
});
// IDE 保存链:全文覆盖写(首版不带锁、不做多写者冲突检测;写权限=激活项目根内全可写)。
export const FileWrite = Envelope.extend({
  type: z.literal("file.write"),
 /** 项目内相对路径;越界/.git/超限在 server 侧沙箱拒绝。 */
  path: z.string().min(1),
 /** UTF-8 全文覆盖内容(>512KB 拒;允许新建文件,父目录须已存在)。 */
  content: z.string(),
 /** :解析根的项目 id(IDE 树桶项目);缺省=旧语义(活动项目)。 */
  projectId: z.string().optional(),
});
/**
 * 板「OOXML 文本回写」P2:Office 文档文本级编辑(服务端处理路径)。
 * 为什么不让前端自己拼 zip:浏览器得先拿 10MB 原始字节(/ide/asset 走 Range 分块)、
 * 再在页面里引 zip + XML 重打包,内存与坑都翻倍。改由服务端读原文件 → rewriteOfficeText → 写回,
 * 前端只发「哪一段要换成什么文本」。沙箱同 /ide/office(ideOfficeResolve)。
 */
export const IdeOfficeEdit = Envelope.extend({
  type: z.literal("ide.office.edit"),
 /** 文档在项目内的相对路径(必须 .pptx/.docx)。 */
  path: z.string().min(1),
 /** 解析根的项目 id(IDE 树桶项目);缺省=活动项目。 */
  pid: z.string().optional(),
 /** 文本编辑指令(下标语义与 parseOffice 输出一致;整段替换,不保留 run 级差异)。 */
  edits: z.array(z.object({
 /** pptx:第几页(1-based)。 */
    slideIndex: z.number().int().positive().optional(),
 /** pptx:该页 shapes 数组下标(与 parseOffice 输出一致)。 */
    shapeIndex: z.number().int().nonnegative().optional(),
 /** docx:blocks 数组下标。 */
    blockIndex: z.number().int().nonnegative().optional(),
 /** 新文本(整段替换)。 */
    text: z.string(),
  })).min(1).max(5000),
});

// ---- IDE 文件操作(P0 编辑体验):mkdir / remove / rename / grep ----
// 沙箱口径与 file.write 完全一致(realpath 前缀比对 + 拒 .git 段 + 拒绝对路径/越界);失败统一走
// fs.*.result { ok:false, error }(二选一即可,此处选回包式:前端能按 op 精确定位失败的那一条)。
export const FsMkdir = Envelope.extend({
  type: z.literal("fs.mkdir"),
 /** 项目内相对路径(单层:父目录须已存在,与 file.write 一致,不隐式建多层)。 */
  path: z.string().min(1),
  projectId: z.string().optional(),
});
export const FsRemove = Envelope.extend({
  type: z.literal("fs.remove"),
 /** 项目内相对路径(文件或目录)。 */
  path: z.string().min(1),
 /** 目录:必须显式 true 才递归删除(非空目录不带此标志=拒绝)。 */
  recursive: z.boolean().optional(),
  projectId: z.string().optional(),
});
export const FsRename = Envelope.extend({
  type: z.literal("fs.rename"),
 /** 源(项目内相对路径,必须存在)。 */
  from: z.string().min(1),
 /** 目标(项目内相对路径,父目录须已存在;已存在=覆盖)。 */
  to: z.string().min(1),
  projectId: z.string().optional(),
});
/** 全项目文件内容搜索(IDE Ctrl+Shift+F):跳过 .git/node_modules/dist/.genie、单文件 >1MB、二进制。 */
export const FsGrep = Envelope.extend({
  type: z.literal("fs.grep"),
 /** 起始子路径(项目内相对;缺省=项目根)。 */
  path: z.string().optional(),
  query: z.string().min(1),
 /** true=按正则匹配(query 非法则回 error 字段)。 */
  regex: z.boolean().optional(),
 /** 结果上限(缺省 200,硬顶 2000)。 */
  maxResults: z.number().int().positive().optional(),
  projectId: z.string().optional(),
});

// ---- 面板 IDE 第二批:问题面板诊断(lsp.diagnostics)与持久终端(term.session.*) ----
// 路由:panel → gateway;实现不新起检查器,harness-lsp checkEditedFile(TS 兜底)与
// harness-terminal TerminalSessionService 与 agent 侧同源(同进程单例,owner="panel:<连接标识>")。
/** 诊断请求:paths=项目内相对路径数组(.ts/.tsx/.js/.jsx/.mts/.cts 之外的扩展名静默跳过)。 */
export const LspDiagnostics = Envelope.extend({
  type: z.literal("lsp.diagnostics"),
 /** 请求 id(原样回传,面板按 requestId 对齐请求/响应)。 */
  requestId: z.string().min(1),
  projectId: z.string().optional(),
  paths: z.array(z.string().min(1)).min(1),
});
/** 持久终端:面板开一个交互式会话(shell 进程跨消息常驻,cwd/env 状态保持)。 */
export const TermSessionOpen = Envelope.extend({
  type: z.literal("term.session.open"),
  requestId: z.string().min(1),
 /** 工作目录(项目内相对路径;缺省=项目根;越界拒绝)。 */
  cwd: z.string().optional(),
 /** 终端尺寸(cols/rows);当前实现(PTY 面板推流)不支持动态 resize,忽略。 */
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
  projectId: z.string().optional(),
});
export const TermSessionSend = Envelope.extend({
  type: z.literal("term.session.send"),
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
 /** 写入 shell 的原始输入(通常带换行)。 */
  data: z.string(),
});
export const TermSessionRead = Envelope.extend({
  type: z.literal("term.session.read"),
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
 /** 起始游标(缺省=上次已消费位置;单调递增)。 */
  cursor: z.number().int().nonnegative().optional(),
});
export const TermSessionClose = Envelope.extend({
  type: z.literal("term.session.close"),
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
});
/** 单文件历史内容(git show ref:path;文件不在 ref / 超 2MB → error 帧)。 */
export const GitShow = Envelope.extend({
  type: z.literal("git.show"),
  requestId: z.string().min(1),
  projectId: z.string().optional(),
 /** 项目内相对路径。 */
  path: z.string().min(1),
 /** 提交/分支/tag;缺省 HEAD。 */
  ref: z.string().min(1).optional(),
});

export const FilesSearch = Envelope.extend({
  type: z.literal("files.search"),
 /** 查询串(路径/文件名子串;空=热门根文件)。 */
  query: z.string().default(""),
});

/** 会话全文检索:面板命令中心 `#` 域;空 query=最近会话浏览。 */
// ---- Git 面板(批C,ZCode GitPane/GitActionMenu 移植) ----
export const GitStatus = Envelope.extend({ type: z.literal("git.status") });
export const GitDiff = Envelope.extend({ type: z.literal("git.diff"), file: z.string().min(1) });
export const GitBranches = Envelope.extend({ type: z.literal("git.branches") });
export const GitLog = Envelope.extend({ type: z.literal("git.log"), limit: z.number().int().positive().max(200).optional() });

// ---- 定时自动化(ZCode Automations 移植) ----
export const GitCommitMsg = Envelope.extend({ type: z.literal("git.commitmsg") });

export const GitCheckout = Envelope.extend({ type: z.literal("git.checkout"), branch: z.string().min(1) });
export const GitCommit = Envelope.extend({
  type: z.literal("git.commit"),
  message: z.string().min(1),
 /** 提交文件列表;缺省=全部变更(add -A)。 */
  files: z.array(z.string()).optional(),
});
// ---- push/pull(二期:面板 GitPane 同步操作;作用于激活项目工作目录,与 git.commit 同语义) ----
export const GitPush = Envelope.extend({
  type: z.literal("git.push"),
 /** 远端名;缺省 origin。 */
  remote: z.string().min(1).optional(),
 /** 分支;缺省=当前分支(-u 设 upstream)。 */
  branch: z.string().min(1).optional(),
});
export const GitPull = Envelope.extend({
  type: z.literal("git.pull"),
 /** 远端名;缺省=当前分支 upstream(git pull 原语义)。 */
  remote: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
});
