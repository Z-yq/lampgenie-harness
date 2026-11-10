/**
 * 跳板机网页登录执行器( §5,二期):
 * node-agent 内置网页会话执行器——录制登录脚本(凭证经节点本地解析注入)→ 按序执行 → 输出回放校验。
 * 网页类用浏览器自动化(playwright 系)封装为 backend;playwright 不是本仓依赖——
 * driver 按注入进来的接口调用(测试用 FakeDriver/NoopDriver,生产由部署侧注入 playwright 系驱动)。
 * 凭证红线(值不过 relay 同源):{{cred:NAME}} 占位只在执行到该步时经
 * resolveCredential 现场解析;值不进脚本原文、不进日志(日志恒记未解析原文)、
 * 不进输出回流(output 做值擦除)。缺引用 = typed 错误 fail-visible,不猜。
 */

/** 录制脚本的一步( §5 步集)。 */
export type JumpWebStep =
  | { type: "goto"; url: string }
  | { type: "fill"; selector: string; value: string }
  | { type: "click"; selector: string }
  | { type: "wait"; ms: number }
  | { type: "assert"; selector?: string; textContains?: string };

/** playwright 形驱动接口(仓内零依赖,由注入方实现)。 */
export interface JumpWebDriver {
  goto(url: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  click(selector: string): Promise<void>;
  wait(ms: number): Promise<void>;
  /** selector 存在性/textContains 存在性断言;失败应抛错。 */
  assert(selector?: string, textContains?: string): Promise<void>;
  /** 抓取页面文本,供输出回放校验。 */
  content(): Promise<string>;
}

export type JumpWebErrorCode =
  | "jumpweb:script-invalid"
  | "jumpweb:cred-missing"
  | "jumpweb:step-failed"
  | "jumpweb:step-timeout"
  | "jumpweb:overall-timeout"
  | "jumpweb:markers-missing"
  | "jumpweb:driver-missing"
  | "jumpweb:driver-error";

export interface JumpWebMarker {
  text: string;
  found: boolean;
}

export interface JumpWebRunResult {
  ok: boolean;
  /** 页面内容(已做凭证值擦除+截断);失败路径为空串。 */
  output: string;
  markers: JumpWebMarker[];
  logs: string[];
  error?: { code: JumpWebErrorCode; detail: string };
}

/** {{cred:NAME}} 占位。NAME 限定安全字符集,防注入额外形态。 */
const CRED_RE = /\{\{cred:([A-Za-z0-9_.-]+)\}\}/g;

/** 凭证缺引用(解析抛错/解析为空)——与 task.spec 其余错误区分映射。 */
class CredMissingError extends Error {
  constructor(name: string, detail: string) {
    super(`引用 ${name} 不可解析:${detail}`);
  }
}

class StepTimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new StepTimeoutError(`超过 ${ms}ms`)), ms);
    t.unref?.();
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/** 脚本校验+归一。返回 string = typed 失败原因。 */
function parseScript(script: unknown): { steps?: JumpWebStep[]; invalid?: string } {
  let raw: unknown = script;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return { invalid: "script 为字符串但不是合法 JSON" };
    }
  }
  if (!Array.isArray(raw)) return { invalid: "script 必须是步骤数组( §5 录制脚本)" };
  const steps: JumpWebStep[] = [];
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i] as unknown;
    if (typeof s !== "object" || s === null) return { invalid: `step ${i} 不是对象` };
    const o = s as Record<string, unknown>;
    const type = o.type;
    switch (type) {
      case "goto":
        if (typeof o.url !== "string" || o.url.length === 0) return { invalid: `step ${i} goto 缺 url` };
        steps.push({ type: "goto", url: o.url });
        break;
      case "fill":
        if (typeof o.selector !== "string" || typeof o.value !== "string") return { invalid: `step ${i} fill 缺 selector/value` };
        steps.push({ type: "fill", selector: o.selector, value: o.value });
        break;
      case "click":
        if (typeof o.selector !== "string") return { invalid: `step ${i} click 缺 selector` };
        steps.push({ type: "click", selector: o.selector });
        break;
      case "wait": {
        if (typeof o.ms !== "number" || !Number.isFinite(o.ms) || o.ms < 0 || o.ms > 60_000) {
          return { invalid: `step ${i} wait 的 ms 非法(0..60000)` };
        }
        steps.push({ type: "wait", ms: o.ms });
        break;
      }
      case "assert": {
        const hasSelector = typeof o.selector === "string";
        const hasText = typeof o.textContains === "string";
        if (!hasSelector && !hasText) return { invalid: `step ${i} assert 至少要 selector 或 textContains` };
        steps.push({
          type: "assert",
          ...(hasSelector ? { selector: o.selector as string } : {}),
          ...(hasText ? { textContains: o.textContains as string } : {}),
        });
        break;
      }
      default:
        return { invalid: `step ${i} 未知步骤类型 ${String(type)}(goto|fill|click|wait|assert)` };
    }
  }
  return { steps };
}

export interface JumpWebSessionOptions {
  driver: JumpWebDriver;
  /** 凭证本地解析(节点凭据库);缺引用应抛错。 */
  resolveCredential: (name: string) => string;
  /** 输出回放校验标记:全部命中才算 ok。 */
  expectTextContains?: string[];
  /** 单步超时(缺省 10s,待标定)。 */
  stepTimeoutMs?: number;
  /** 整会话超时(缺省 120s,待标定)。 */
  overallTimeoutMs?: number;
  /** 日志观察面(收到的行已保证无凭证值——恒记未解析原文)。 */
  log?: (line: string) => void;
  /** output 截断上限(缺省 200_000,与 node-agent 回流口径一致)。 */
  outputCap?: number;
}

/** 一次登录脚本会话:脚本按序执行 + 输出回放校验。错误不抛出,全部落 typed error。 */
export class JumpWebSession {
  constructor(private readonly opts: JumpWebSessionOptions) {}

  async run(script: unknown): Promise<JumpWebRunResult> {
    const logs: string[] = [];
    const secrets: string[] = [];
    const log = (line: string): void => {
      logs.push(line);
      this.opts.log?.(line);
    };
    const stepTimeoutMs = this.opts.stepTimeoutMs ?? 10_000;
    const overallTimeoutMs = this.opts.overallTimeoutMs ?? 120_000;
    const outputCap = this.opts.outputCap ?? 200_000;
    const deadline = Date.now() + overallTimeoutMs;

    const fail = (code: JumpWebErrorCode, detail: string): JumpWebRunResult => ({
      ok: false,
      output: "",
      markers: [],
      logs,
      error: { code, detail: redact(detail, secrets) },
    });

    const parsed = parseScript(script);
    if (parsed.invalid !== undefined || parsed.steps === undefined) {
      return fail("jumpweb:script-invalid", parsed.invalid ?? "script 非法");
    }

    // 凭证现场解析:只在此刻出现,立即登记进擦除表;日志恒记未解析原文。
    const resolveName = (name: string): string => {
      let v: string;
      try {
        v = this.opts.resolveCredential(name);
      } catch (err) {
        throw new CredMissingError(name, String(err).slice(0, 150));
      }
      if (typeof v !== "string" || v.length === 0) throw new CredMissingError(name, "解析结果为空");
      secrets.push(v);
      return v;
    };
    const substitute = (text: string): string =>
      text.replace(CRED_RE, (_m, name: string) => resolveName(name));

    const driver = this.opts.driver;
    const runStep = async (step: JumpWebStep, budget: number): Promise<void> => {
      switch (step.type) {
        case "goto":
          return withTimeout(driver.goto(substitute(step.url)), budget).then(() => undefined);
        case "fill":
          return withTimeout(driver.fill(step.selector, substitute(step.value)), budget).then(() => undefined);
        case "click":
          return withTimeout(driver.click(step.selector), budget).then(() => undefined);
        case "wait":
          return withTimeout(driver.wait(step.ms), budget).then(() => undefined);
        case "assert": {
          const textContains = step.textContains === undefined ? undefined : substitute(step.textContains);
          return withTimeout(driver.assert(step.selector, textContains), budget).then(() => undefined);
        }
      }
    };

    for (let i = 0; i < parsed.steps.length; i++) {
      const step = parsed.steps[i]!;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return fail("jumpweb:overall-timeout", `step ${i} 前整会话超时(${overallTimeoutMs}ms)`);
      log(`[jumpweb] step ${i} ${describeStep(step)}`);
      try {
        await runStep(step, Math.min(stepTimeoutMs, remaining));
      } catch (err) {
        if (err instanceof CredMissingError) {
          return fail("jumpweb:cred-missing", `${err.message}(本地凭据库缺引用,fail-visible 不猜)`);
        }
        if (err instanceof StepTimeoutError) {
          const code: JumpWebErrorCode = deadline - Date.now() <= 0 ? "jumpweb:overall-timeout" : "jumpweb:step-timeout";
          return fail(code, `step ${i}(${step.type})${err.message}`);
        }
        return fail("jumpweb:step-failed", `step ${i}(${step.type}) 失败:${String(err).slice(0, 250)}`);
      }
    }

    // 输出回放校验:抓页面内容,校验必备标记。
    let content: string;
    try {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return fail("jumpweb:overall-timeout", `content() 前整会话超时(${overallTimeoutMs}ms)`);
      content = await withTimeout(driver.content(), Math.min(stepTimeoutMs, remaining));
    } catch (err) {
      if (err instanceof StepTimeoutError) return fail("jumpweb:step-timeout", `content() ${err.message}`);
      return fail("jumpweb:step-failed", `content() 失败:${String(err).slice(0, 250)}`);
    }

    const markers: JumpWebMarker[] = (this.opts.expectTextContains ?? []).map((text) => ({
      text,
      found: content.includes(text),
    }));
    const capped = content.length > outputCap ? content.slice(0, outputCap) : content;
    const output = redact(capped, secrets);
    if (!markers.every((m) => m.found)) {
      const missing = markers.filter((m) => !m.found).map((m) => JSON.stringify(m.text)).join(", ");
      return { ok: false, output, markers, logs, error: { code: "jumpweb:markers-missing", detail: `输出回放校验未命中标记:${missing}` } };
    }
    return { ok: true, output, markers, logs };
  }
}

/** 步骤描述(恒为未解析原文——占位符在,凭证值永不出现)。 */
function describeStep(step: JumpWebStep): string {
  switch (step.type) {
    case "goto": return `goto url=${step.url}`;
    case "fill": return `fill selector=${step.selector} value=${step.value}`;
    case "click": return `click selector=${step.selector}`;
    case "wait": return `wait ms=${step.ms}`;
    case "assert": return `assert selector=${step.selector ?? "-"} textContains=${step.textContains ?? "-"}`;
  }
}

/** 值擦除:resolved 凭证值在输出/错误信息里替换为 ***。 */
function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s.length > 0) out = out.split(s).join("***");
  }
  return out;
}

/** 无操作驱动(仅测试/占位):一切成功,content 恒空——标记校验自然失败,不伪造成功。 */
export class NoopDriver implements JumpWebDriver {
  readonly calls: string[] = [];
  async goto(url: string): Promise<void> { this.calls.push(`goto ${url}`); }
  async fill(selector: string, value: string): Promise<void> { this.calls.push(`fill ${selector}`); void value; }
  async click(selector: string): Promise<void> { this.calls.push(`click ${selector}`); }
  async wait(ms: number): Promise<void> { this.calls.push(`wait ${ms}`); }
  async assert(selector?: string, textContains?: string): Promise<void> {
    this.calls.push(`assert ${selector ?? "-"} ${textContains ?? "-"}`);
  }
  async content(): Promise<string> { return ""; }
}

/** 可编程假驱动(测试/联调):记录调用序,可按方法挂起或抛错,content 返回预置页面文本。 */
export class FakeDriver implements JumpWebDriver {
  readonly calls: { method: string; args: unknown[] }[] = [];
  constructor(
    private readonly page: string = "",
    /** 每个驱动调用的副作用钩子(返回 promise 则被 await——挂起/延迟用)。 */
    private readonly behavior?: (method: string, args: unknown[]) => Promise<void> | void) {}

  private async record(method: string, args: unknown[]): Promise<void> {
    this.calls.push({ method, args });
    await this.behavior?.(method, args);
  }
  async goto(url: string): Promise<void> { await this.record("goto", [url]); }
  async fill(selector: string, value: string): Promise<void> { await this.record("fill", [selector, value]); }
  async click(selector: string): Promise<void> { await this.record("click", [selector]); }
  async wait(ms: number): Promise<void> {
    await this.record("wait", [ms]);
    // 模拟真实驱动的等待语义(超时/预算测试依赖它真实耗时;上限 2s 防夹具挂测试)。
    await new Promise<void>((r) => setTimeout(r, Math.min(ms, 2000)));
  }
  async assert(selector?: string, textContains?: string): Promise<void> {
    await this.record("assert", [selector, textContains]);
    if (textContains !== undefined && !this.page.includes(textContains)) {
      throw new Error(`assert 失败:页面不含指定文本`);
    }
  }
  async content(): Promise<string> { await this.record("content", []); return this.page; }
}

export interface JumpWebTaskInput {
  instruction: string;
  /** 录制脚本(步骤数组或 JSON 字符串)。缺失/非法 = typed 错误。 */
  script?: unknown;
  /** 预声明凭证引用:执行前先预检(缺引用直接失败,不启动浏览器)。 */
  credRefs?: string[];
}

export interface JumpWebHandleResult {
  ok: boolean;
  /** 成功=擦除后的页面内容;失败=typed 错误+日志(均已保证无凭证值)。 */
  output: string;
  error?: { code: string; detail: string };
}

export interface JumpWebHostOptions {
  /**
   * playwright 系驱动;可以是实例或按任务惰性工厂(每次会话一个)。
   * 未注入 = 每个任务 typed 错误 fail-visible(部署侧经 NodeAgentOptions.jumpwebDriverFactory 提供)。
   */
  driver?: JumpWebDriver | (() => JumpWebDriver | Promise<JumpWebDriver>);
  /** 凭证本地解析(节点凭据库);缺引用应抛错。 */
  resolveCredential: (name: string) => string;
  /** 输出回放校验标记:全部命中才算 ok。 */
  expectTextContains?: string[];
  stepTimeoutMs?: number;
  overallTimeoutMs?: number;
  log?: (line: string) => void;
}

/** 跳板机网页登录执行器宿主:node-agent execute 注入面适配( §5)。 */
export class JumpWebHost {
  constructor(private readonly opts: JumpWebHostOptions) {}

  async handle(task: JumpWebTaskInput): Promise<JumpWebHandleResult> {
    const logs: string[] = [];
    const log = (line: string): void => {
      logs.push(line);
      this.opts.log?.(line);
    };

    // credRefs 预检:声明面先行,缺引用不启动浏览器(值解析后即弃,不落地)。
    for (const ref of task.credRefs ?? []) {
      try {
        void this.opts.resolveCredential(ref);
      } catch (err) {
        const code = "jumpweb:cred-missing";
        const detail = `预检失败:${String(err).slice(0, 150)}`;
        log(`[jumpweb] ${code} ${detail}`);
        return { ok: false, output: logs.join("\n"), error: { code, detail } };
      }
    }

    const driverOpt = this.opts.driver;
    if (!driverOpt) {
      const code = "jumpweb:driver-missing";
      const detail = "未注入 playwright 系驱动(部署侧经 NodeAgentOptions.jumpwebDriverFactory 提供;fail-visible,不伪造成功)";
      log(`[jumpweb] ${code} ${detail}`);
      return { ok: false, output: logs.join("\n"), error: { code, detail } };
    }
    let driver: JumpWebDriver;
    try {
      driver = typeof driverOpt === "function" ? await driverOpt() : driverOpt;
    } catch (err) {
      const code = "jumpweb:driver-error";
      const detail = `驱动构造失败:${String(err).slice(0, 150)}`;
      log(`[jumpweb] ${code} ${detail}`);
      return { ok: false, output: logs.join("\n"), error: { code, detail } };
    }

    const session = new JumpWebSession({
      driver,
      resolveCredential: this.opts.resolveCredential,
      expectTextContains: this.opts.expectTextContains,
      stepTimeoutMs: this.opts.stepTimeoutMs,
      overallTimeoutMs: this.opts.overallTimeoutMs,
      log,
    });
    const r = await session.run(task.script);
    if (r.ok) return { ok: true, output: r.output };
    return {
      ok: false,
      output: [r.error ? `${r.error.code}: ${r.error.detail}` : "", ...r.logs].filter(Boolean).join("\n"),
      error: r.error ? { code: r.error.code, detail: r.error.detail } : undefined,
    };
  }
}

/** 工厂:返回 node-agent execute 注入面同构的 { handle }。 */
export function createJumpWebHandler(opts: JumpWebHostOptions): {
  handle: (task: JumpWebTaskInput) => Promise<JumpWebHandleResult>;
} {
  const host = new JumpWebHost(opts);
  return { handle: (task) => host.handle(task) };
}
