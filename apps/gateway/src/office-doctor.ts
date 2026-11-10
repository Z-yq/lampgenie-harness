/**
 * 办公环境 doctor:把「环境依赖探测」从一句话提示变成可执行体检。
 * 核心口径(**不许静默跳过**):
 *   - 三类依赖:core(缺了根本跑不了)/ optional(缺了能力降级)/ install-on-demand(可以现装);
 *   - 缺失且**没尝试安装** → status = "needs-install" 且 installAttempted = false,
 *     不允许标 ok,也不允许直接不报;
 *   - attemptInstall=true 时才真的执行安装:装完必须**复验版本**;安装失败 →
 *     status = "install-failed" 并如实写进 remediation;
 *   - overall ok = false **当且仅当** core 项失败,或有 install-on-demand 项 install-failed。
 * 探测函数可注入(probe),测试用桩即可覆盖全部状态,不依赖宿主装了什么。
 */
import { execFile } from "node:child_process";

export type EnvCheckKind = "core" | "optional" | "install-on-demand";
export type EnvCheckStatus = "ok" | "missing" | "needs-install" | "install-failed";

export interface EnvCheckItem {
  name: string;
  kind: EnvCheckKind;
  status: EnvCheckStatus;
  version?: string;
  /** 缺失/失败时怎么处理(手动安装命令或排查方向)。 */
  remediation: string;
  /** 是否真的执行过安装尝试(没试过就是 false,不允许伪造成 true)。 */
  installAttempted: boolean;
}

export interface DoctorProbeResult {
  ok: boolean;
  out: string;
}

export type DoctorProbe = (cmd: string, args: string[]) => Promise<DoctorProbeResult>;

export interface DoctorOptions {
  probe?: DoctorProbe;
  attemptInstall?: boolean;
}

export interface DoctorReport {
  ok: boolean;
  items: EnvCheckItem[];
}

/** Node 最低要求(低于它就属于 core 失败)。 */
const MIN_NODE_MAJOR = 18;

/** 中文字体识别(Noto CJK / 思源 / 文泉驿 / 微软雅黑 / 黑体 / 苹方…)。 */
const CJK_FONT_RE =
  /(noto\s*(?:sans|serif)\s*(?:sc|cjk|mono)|source\s*han|wenquanyi|wqy|droid\s*sans\s*fallback|microsoft\s*yahei|simhei|simsun|pingfang|arphic|uming|ukai)/i;

function defaultProbe(cmd: string, args: string[]): Promise<DoctorProbeResult> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: 8000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ ok: !err, out: `${stdout ?? ""}\n${stderr ?? ""}`.trim() });
      });
    } catch (err) {
      resolve({ ok: false, out: msgOf(err) });
    }
  });
}

interface DetectResult {
  ok: boolean;
  version?: string;
  detail?: string;
}

interface ToolSpec {
  name: string;
  kind: EnvCheckKind;
  detect: (probe: DoctorProbe) => Promise<DetectResult>;
  /** 自动安装命令(attemptInstall=true 时经 sh -c 执行)。 */
  installCmd: string;
  /** 手动补救建议。 */
  remediation: string;
}

const TOOL_SPECS: ToolSpec[] = [
  {
    name: "node",
    kind: "core",
    detect: async (probe) => {
      const r = await probe("node", ["--version"]);
      if (!r.ok) return { ok: false, detail: r.out || "node --version 失败" };
      const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(r.out);
      if (!m) return { ok: false, detail: `无法识别 node --version 输出: ${firstLine(r.out)}` };
      const version = `${m[1]}.${m[2]}.${m[3]}`;
      if (Number(m[1]) < MIN_NODE_MAJOR) {
        return { ok: false, version, detail: `Node ${version} 低于最低要求 v${MIN_NODE_MAJOR}` };
      }
      return { ok: true, version };
    },
    installCmd: "nvm install --lts",
    remediation: `安装/升级 Node.js 到 v${MIN_NODE_MAJOR} 及以上(nvm install --lts)`,
  },
  {
    name: "libreoffice",
    kind: "install-on-demand",
    detect: async (probe) => {
      const tried: string[] = [];
      for (const cmd of ["soffice", "libreoffice"]) {
        const r = await probe(cmd, ["--version"]);
        if (r.ok) {
          const m = /(\d+\.\d+(?:\.\d+){1,2})/.exec(r.out);
          return m ? { ok: true, version: m[1] } : { ok: true, version: firstLine(r.out) || undefined };
        }
        tried.push(`${cmd}: ${firstLine(r.out) || "不可用"}`);
      }
      return { ok: false, detail: tried.join("; ") || "soffice/libreoffice 均不可用" };
    },
    installCmd: "sudo apt-get install -y libreoffice-core || apt-get install -y libreoffice-core",
    remediation: "安装 LibreOffice(文档转 PDF/PPTX 渲染需要): apt-get install -y libreoffice-core",
  },
  {
    name: "中文字体",
    kind: "optional",
    detect: async (probe) => {
      const r = await probe("fc-list", []);
      if (!r.ok) return { ok: false, detail: `fc-list 不可用: ${firstLine(r.out) || "缺少 fontconfig"}` };
      const m = CJK_FONT_RE.exec(r.out);
      return m ? { ok: true } : { ok: false, detail: "fc-list 未发现常见中文字体" };
    },
    installCmd: "sudo apt-get install -y fonts-noto-cjk || apt-get install -y fonts-noto-cjk",
    remediation: "安装中文字体(避免 PPT/PDF 中文显示为方块): apt-get install -y fonts-noto-cjk",
  },
  {
    name: "python3",
    kind: "install-on-demand",
    detect: async (probe) => {
      const r = await probe("python3", ["--version"]);
      if (!r.ok) return { ok: false, detail: firstLine(r.out) || "python3 --version 失败" };
      const m = /Python\s+(\d+\.\d+\.\d+)/i.exec(r.out);
      return m ? { ok: true, version: m[1] } : { ok: false, detail: `无法识别 python3 --version 输出: ${firstLine(r.out)}` };
    },
    installCmd: "sudo apt-get install -y python3 || apt-get install -y python3",
    remediation: "安装 Python 3: apt-get install -y python3",
  },
];

/** 环境体检:core 必过,install-on-demand 允许「未尝试安装」但不能漏报。 */
export async function runOfficeDoctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const probe = opts.probe ?? defaultProbe;
  const attemptInstall = Boolean(opts.attemptInstall);
  const items: EnvCheckItem[] = [];
  for (const spec of TOOL_SPECS) items.push(await checkItem(spec, probe, attemptInstall));

  const coreFailed = items.some((it) => it.kind === "core" && it.status !== "ok");
  const installFailed = items.some((it) => it.kind === "install-on-demand" && it.status === "install-failed");
  return { ok: !coreFailed && !installFailed, items };
}

async function checkItem(spec: ToolSpec, probe: DoctorProbe, attemptInstall: boolean): Promise<EnvCheckItem> {
  const detected = await safeDetect(spec, probe);
  const item: EnvCheckItem = {
    name: spec.name,
    kind: spec.kind,
    status: "ok",
    version: detected.version,
    remediation: "",
    installAttempted: false,
  };

  if (detected.ok) {
    item.remediation = "无需处理";
    return item;
  }

  if (spec.kind === "core") {
    // core 缺失/过低 = 整体不 ok;不尝试自动装(装不上 node 是宿主决策,不能替用户拍板)。
    item.status = "missing";
    item.remediation = spec.remediation + (detected.detail ? `(探测: ${detected.detail})` : "");
    return item;
  }

  // 非 core 且缺失:先如实标 needs-install —— 没试装就不能当通过、也不能跳过。
  item.status = "needs-install";
  item.remediation = `尚未尝试安装。可运行 office-doctor --install 自动安装,或手动: ${spec.installCmd}`;
  if (detected.detail) item.remediation += `(探测: ${detected.detail})`;
  if (!attemptInstall) return item;

  // 尝试安装 → 复验版本 → 只有复验通过才算 ok。
  item.installAttempted = true;
  const install = await safeProbe(probe, "sh", ["-c", spec.installCmd]);
  if (!install.ok) {
    item.status = "install-failed";
    item.remediation = `自动安装失败(${firstLine(install.out) || "安装命令非零退出"});手动安装: ${spec.installCmd}`;
    return item;
  }

  const rechecked = await safeDetect(spec, probe);
  if (rechecked.ok) {
    item.status = "ok";
    item.version = rechecked.version ?? item.version;
    item.remediation = "安装成功,版本已复验";
  } else {
    item.status = "install-failed";
    item.remediation = `安装命令返回成功但复验仍失败(${rechecked.detail || "工具仍不可用"});手动安装: ${spec.installCmd}`;
  }
  return item;
}

async function safeDetect(spec: ToolSpec, probe: DoctorProbe): Promise<DetectResult> {
  try {
    return await spec.detect(probe);
  } catch (err) {
    return { ok: false, detail: msgOf(err) };
  }
}

async function safeProbe(probe: DoctorProbe, cmd: string, args: string[]): Promise<DoctorProbeResult> {
  try {
    return await probe(cmd, args);
  } catch (err) {
    return { ok: false, out: msgOf(err) };
  }
}

function firstLine(s: string): string {
  return String(s || "").split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "";
}

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
