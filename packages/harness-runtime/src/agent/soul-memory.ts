/**
 * Soul + Memory(照 hermes-agent 移植,应用于 audio 主 agent):
 * - SOUL.md:人格=行为规格(非特质列表,防漂移);system prompt 第 0 块原文注入;
 *   播种只升级「逐字节等于历史模板」的文件(用户改过一个字就永不覆盖——hermes _ensure_default_soul_md)。
 * - memories/{MEMORY,USER}.md:环境笔记/用户画像双库;条目 "\n§\n" 分隔纯文本;字符预算
 *   (memory 2200/user 1375,~800/500 token);渲染块 "═×46/标题 [pct]/═×46/条目" 注入;
 *   写入走 LLM memory 工具(add/replace/remove/batch,old_text 定位、整条替换);
 *   条目必须陈述句事实(祈使句会被后续会话当指令——hermes 防漂移条款)。
 * 陈述句红线:写入前把「总是/请/应该」类祈使句改写为「用户偏好…」陈述句(确定性正则)。
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_SOUL_MD = `你是 lampgenie-harness 的主 agent(语音管家的大脑):与用户异步交互,负责任务委派与进度播报。

行为规格(不是特质清单——每条都改变行为):
- 直接了当:回复长度匹配请求重量。一行问题给一行答案;完成的任务只报「改了什么/验证了什么/还剩什么」,不复读过程。
- 禁做:没有"好问题!"式开场白;不复述用户请求;不复述自己刚说的;不解说即将调用的工具;不道歉式铺垫。
- 你是调度者不是干活者:具体编码/分析派给子 agent(工具),你负责拆解、委派、验收、汇总。
- 拿不准就问一句,不要长篇澄清;用户说"继续"就继续,不重新确认。
- 对用户的记忆(memory)只写陈述句事实,绝不写成给自己的指令。
`;

const LEGACY_TEMPLATE_SOULS: string[] = [DEFAULT_SOUL_MD];

function normalizeSoul(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/^\uFEFF/, "").trim();
}

export interface SoulLoadResult {
  /** SOUL.md 原文(未加载到=空串,调用方回退默认)。 */
  content: string;
  /** 本次是否执行了播种(旧模板升级或首次创建)。 */
  seeded: boolean;
}

/** 加载/播种 SOUL.md(hermes 语义:仅「逐字节等于历史模板」才允许升级覆盖)。 */
export function loadSoul(soulDir: string): SoulLoadResult {
  mkdirSync(soulDir, { recursive: true });
  const p = join(soulDir, "SOUL.md");
  if (existsSync(p)) {
    const cur = readFileSync(p, "utf-8");
    const isTemplate = LEGACY_TEMPLATE_SOULS.some((t) => normalizeSoul(t) === normalizeSoul(cur));
    if (!isTemplate) return { content: cur, seeded: false }; // 用户自有,永不触碰
    // 模板 → 升级为当前默认
    writeFileSync(p, DEFAULT_SOUL_MD, "utf-8");
    return { content: DEFAULT_SOUL_MD, seeded: true };
  }
  writeFileSync(p, DEFAULT_SOUL_MD, "utf-8");
  return { content: DEFAULT_SOUL_MD, seeded: true };
}

// ── Memory 双库 ──

export type MemoryTarget = "memory" | "user";

export interface MemoryOptions {
  memoryCharLimit?: number;
  userCharLimit?: number;
}

const ENTRY_DELIMITER = "\n§\n";
const BLOCK_TITLES: Record<MemoryTarget, string> = {
  memory: "MEMORY (环境笔记:工具怪癖/项目约定/路径端点)",
  user: "USER PROFILE (用户是谁:偏好/风格/个人信息)",
};

function parseEntries(text: string): string[] {
  return [...new Set(text.split(ENTRY_DELIMITER).map((s) => s.trim()).filter(Boolean))];
}

export class MemoryStore {
  readonly dir: string;
  private limits: Record<MemoryTarget, number>;

  constructor(dir: string, opts: MemoryOptions = {}) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.limits = { memory: opts.memoryCharLimit ?? 2200, user: opts.userCharLimit ?? 1375 };
  }

  private path(t: MemoryTarget): string {
    return join(this.dir, t === "memory" ? "MEMORY.md" : "USER.md");
  }

  entries(t: MemoryTarget): string[] {
    const p = this.path(t);
    return existsSync(p) ? parseEntries(readFileSync(p, "utf-8")) : [];
  }

  private write(t: MemoryTarget, entries: string[]): void {
    const p = this.path(t);
    const tmp = p + ".tmp-" + Date.now();
    writeFileSync(tmp, entries.length ? entries.join(ENTRY_DELIMITER) + "\n" : "", "utf-8");
    renameSync(tmp, p); // 原子写(hermes tmp+rename)
  }

  usage(t: MemoryTarget): { used: number; limit: number } {
    const used = this.entries(t).join(ENTRY_DELIMITER).length;
    return { used, limit: this.limits[t] };
  }

  add(t: MemoryTarget, content: string): { ok: boolean; reason?: string } {
    const c = rewriteImperativeToFact(content.trim());
    if (!c) return { ok: false, reason: "空条目" };
    const cur = this.entries(t);
    if (cur.includes(c)) return { ok: false, reason: "条目已存在" };
    const next = [...cur, c];
    const size = next.join(ENTRY_DELIMITER).length;
    if (size > this.limits[t]) return { ok: false, reason: `超出预算(${size}/${this.limits[t]} 字符);请先 replace/remove 腾位` };
    this.write(t, next);
    return { ok: true };
  }

  /** old_text=定位条目的唯一短子串;整条替换(hermes whole-entry 契约)。 */
  replace(t: MemoryTarget, oldText: string, content: string): { ok: boolean; reason?: string } {
    const cur = this.entries(t);
    const i = cur.findIndex((e) => e.includes(oldText.trim()));
    if (i < 0) return { ok: false, reason: "old_text 未命中任何条目" };
    const c = rewriteImperativeToFact(content.trim());
    const next = [...cur];
    next[i] = c;
    const size = next.join(ENTRY_DELIMITER).length;
    if (size > this.limits[t]) return { ok: false, reason: `替换后超预算(${size}/${this.limits[t]})` };
    this.write(t, next);
    return { ok: true };
  }

  remove(t: MemoryTarget, oldText: string): { ok: boolean; reason?: string } {
    const cur = this.entries(t);
    const i = cur.findIndex((e) => e.includes(oldText.trim()));
    if (i < 0) return { ok: false, reason: "old_text 未命中任何条目" };
    this.write(t, cur.filter((_, k) => k !== i));
    return { ok: true };
  }

  /** 渲染注入块(hermes format_for_system_prompt:═×46/标题 [pct]/═×46/条目)。 */
  render(t: MemoryTarget): string {
    const entries = this.entries(t);
    if (!entries.length) return "";
    const { used, limit } = this.usage(t);
    const sep = "═".repeat(46);
    const pct = Math.round((used / limit) * 100);
    return `${sep}\n${BLOCK_TITLES[t]} [${pct}% — ${used}/${limit} chars]\n${sep}\n${entries.join(ENTRY_DELIMITER)}`;
  }

  renderAll(): string {
    return [this.render("memory"), this.render("user")].filter(Boolean).join("\n\n");
  }

  /** 当前条目清单(超限时回给模型逼整合,hermes IF FULL 语义)。 */
  listing(t: MemoryTarget): string {
    const entries = this.entries(t);
    return entries.length ? entries.map((e, i) => `${i + 1}. ${e}`).join("\n") : "(空)";
  }
}

/** 祈使句→陈述句改写(确定性;防「条目变指令覆盖用户当前请求」的漂移)。 */
export function rewriteImperativeToFact(entry: string): string {
  let s = entry.trim();
  s = s.replace(/^(总是|永远|请|务必|一定要?|应该|必须)(尽量?)?/u, "用户偏好");
  s = s.replace(/^(要用|使用|采用)(?=[^的])/u, "用户偏好使用");
  s = s.replace(/^(不要|别|禁止)(?=[^把给将])/u, "用户不希望");
  if (/^(回答|回复|输出|说)要/u.test(s)) s = "用户希望" + s;
  return s;
}

/** soul+memory 组装成 system 第 0 块(hermes stable tier:SOUL 原文裸注入,块后置)。 */
export function buildSoulPreamble(soulDir: string, memory: MemoryStore): string {
  const soul = loadSoul(soulDir).content || DEFAULT_SOUL_MD;
  const memBlocks = memory.renderAll();
  return memBlocks ? soul + "\n\n" + memBlocks : soul;
}
