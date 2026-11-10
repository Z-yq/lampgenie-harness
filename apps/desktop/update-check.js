/**
 * 版本检查与更新引导(2026-11-09,新用户价值轮:能力面设计参考 ZCode 项目 autoUpdater /
 * forceUpdateGuard 语义,致谢;本仓独立实现,不依赖 electron-updater)。
 *
 * 为什么自研而不是直接引入 electron-updater:
 * - 当前发布物是「手动分发的 NSIS 安装包」,没有 latest.yml 发布通道、也没有代码签名;
 *   electron-updater 的价值主要在差分下载与发布通道,引进来只会多一层配置黑洞;
 * - 新用户真正需要的是:启动后知道有没有新版本、看得懂改了什么、一键下载并校验、装完重启。
 *   这些用一个小的状态机就能闭环,且完全可单测。
 *
 * 语义(与 ZCode 对齐的部分):
 * - 自动检查:启动后延迟首查 + 固定间隔;手动检查不受间隔限制;
 * - 状态机:idle/disabled/checking/up-to-date/available/downloading/downloaded/error;
 * - 强制更新:清单里的 minVersion > 当前版本时,面板提示不可忽略(forceUpdateGuard 语义);
 * - 下载落盘后校验 sha256/size,再允许「安装并重启」;绝不执行未经校验且不在更新目录内的文件;
 * - 索引/状态落盘仅记录「上次检查时间 + 最新版本」,不写凭证。
 *
 * 纯逻辑:fetch / 时钟 / 日志 / 落盘目录全部注入,可 `node --test` 脱离 electron 直接跑。
 */
const { createHash, verify: verifySignature } = require("node:crypto");
const { execFile } = require("node:child_process");
const { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, createWriteStream, createReadStream, openSync, closeSync, readSync, writeSync, ftruncateSync } = require("node:fs");
const { basename, dirname, join, resolve, sep } = require("node:path");
const { once } = require("node:events");
const { Readable } = require("node:stream");
const { gunzipSync } = require("node:zlib");

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MIN_INTERVAL_MS = 30 * 60 * 1000;
const MAX_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 8000;
const FIRST_CHECK_DELAY_MS = 20 * 1000;
const NOTES_MAX = 4000;
/** 下载目录清理:半成品超过 30 分钟且无可续传元数据视为中断残留;可续传半成品保留 7 天。 */
const STALE_PART_MS = 30 * 60 * 1000;
const RESUMABLE_PART_MS = 7 * 24 * 60 * 60 * 1000;
const KEEP_INSTALLERS = 1;
/** 桌面壳自己的更新配置(不写 genie.config.json,避免与 gateway 的并发写互相覆盖)。 */
const DESKTOP_UPDATE_CONFIG = join(".genie", "update-config.json");
/**
 * 更新源 Ed25519 公钥(2026-11-09,无代码签名证书下的真实性替代方案):
 * 发布方用对应私钥对清单的规范化字段签名;壳内置公钥验签。私钥不入库(本地 .smoke/keys)。
 * 轮换:替换本常量(或 env GENIE_UPDATE_PUBLIC_KEY 提供 PEM)后发新版本。
 */
const DEFAULT_UPDATE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAQDxF9kFMMD32+vrtzAVRWRS4OwqEHalopf+x3tLt/QY=
-----END PUBLIC KEY-----`;
/** 参与签名的清单字段(顺序固定;signature 自身不参与)。 */
const SIGNED_MANIFEST_FIELDS = [
  "version",
  "downloadUrl",
  "blockmapUrl",
  "pageUrl",
  "sha256",
  "size",
  "minVersion",
  "mandatory",
  "notes",
  "publishedAt",
  "channel",
];

/* ----------------------------- 版本号(语义化精简版) ----------------------------- */

function normalizeVersion(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim().replace(/^v/i, "");
  if (!text) return null;
  if (!/^\d+(?:\.\d+){0,3}(?:[-+][0-9A-Za-z.-]+)?$/.test(text)) return null;
  return text;
}

function splitVersion(text) {
  const v = normalizeVersion(text);
  if (!v) return null;
  const withoutBuild = v.split("+")[0];
  const dash = withoutBuild.indexOf("-");
  const core = dash >= 0 ? withoutBuild.slice(0, dash) : withoutBuild;
  const pre = dash >= 0 ? withoutBuild.slice(dash + 1).split(".") : [];
  const nums = core.split(".").map((n) => Number(n) || 0);
  while (nums.length < 4) nums.push(0);
  return { nums, pre };
}

/** 语义化版本比较:`0.0.10` > `0.0.9`;`1.0.0-beta.1` < `1.0.0`。非法版本返回 null。 */
function compareVersions(a, b) {
  const A = splitVersion(a);
  const B = splitVersion(b);
  if (!A || !B) return null;
  for (let i = 0; i < 4; i++) {
    if (A.nums[i] !== B.nums[i]) return A.nums[i] > B.nums[i] ? 1 : -1;
  }
  // 预发布版本 < 正式版本
  if (!A.pre.length && B.pre.length) return 1;
  if (A.pre.length && !B.pre.length) return -1;
  for (let i = 0; i < Math.max(A.pre.length, B.pre.length); i++) {
    const x = A.pre[i];
    const y = B.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      if (Number(x) !== Number(y)) return Number(x) > Number(y) ? 1 : -1;
    } else if (nx !== ny) {
      return nx ? -1 : 1; // 数字标识 < 字母标识
    } else if (x !== y) {
      return x > y ? 1 : -1;
    }
  }
  return 0;
}

/* ------------------------------- 清单解析 ------------------------------- */

function httpUrlOnly(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const u = new URL(value.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.toString();
  } catch {
    return "";
  }
}

/**
 * 支持两种更新源:
 * 1) 自有清单 `{ version, url, pageUrl?, notes?, sha256?, size?, minVersion?, publishedAt? }`;
 * 2) GitHub Releases API 的 `releases/latest` 返回体(取 tag_name / html_url / assets 里的 exe)。
 * 两种都只是数据来源,校验后落到同一份 manifest。
 */
function parseUpdateManifest(input) {
  let raw = input;
  if (typeof input === "string") {
    try {
      raw = JSON.parse(input);
    } catch {
      return { ok: false, error: "更新源返回的不是有效 JSON" };
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "更新源不是 JSON 对象" };
  }
  const githubAsset = Array.isArray(raw.assets)
    ? raw.assets.find((a) => a && typeof a.browser_download_url === "string" && /\.exe(?:$|\?)/i.test(a.browser_download_url))
    : null;
  const version = normalizeVersion(raw.version || raw.latestVersion || raw.tag_name);
  if (!version) return { ok: false, error: "更新源缺少有效 version(或 tag_name)" };

  const downloadUrl = httpUrlOnly(raw.url || raw.downloadUrl || (githubAsset && githubAsset.browser_download_url));
  const pageUrl = httpUrlOnly(raw.pageUrl || raw.html_url || raw.releaseUrl);
  const sha256 = typeof raw.sha256 === "string" && /^[0-9a-fA-F]{64}$/.test(raw.sha256.trim())
    ? raw.sha256.trim().toLowerCase()
    : "";
  const sizeRaw = Number(raw.size != null ? raw.size : githubAsset && githubAsset.size);
  const size = Number.isFinite(sizeRaw) && sizeRaw > 0 ? Math.floor(sizeRaw) : 0;
  let notes = raw.notes != null ? raw.notes : raw.releaseNotes != null ? raw.releaseNotes : raw.body;
  if (Array.isArray(notes)) {
    notes = notes
      .map((n) => (n && typeof n === "object" ? String(n.note || "") : String(n || "")))
      .filter(Boolean)
      .join("\n");
  }
  notes = typeof notes === "string" ? notes.trim().slice(0, NOTES_MAX) : "";
  const minVersion = normalizeVersion(raw.minVersion || raw.minimumVersion);
  const mandatory = raw.mandatory === true || raw.forceUpdate === true;
  const publishedAt = typeof raw.publishedAt === "string" ? raw.publishedAt.slice(0, 40) : "";
  const channel = typeof raw.channel === "string" ? raw.channel.trim().slice(0, 32) : "";
  const signature = typeof raw.signature === "string" && /^[A-Za-z0-9+/=]{80,120}$/.test(raw.signature.trim())
    ? raw.signature.trim()
    : "";
  // 差分下载:electron-builder 默认在安装包旁发布 <artifact>.blockmap(gzip JSON,内容定义分块)
  const blockmapUrl = httpUrlOnly(raw.blockmapUrl || (downloadUrl ? downloadUrl + ".blockmap" : ""));

  return {
    ok: true,
    manifest: { version, downloadUrl, blockmapUrl, pageUrl, sha256, size, notes, minVersion, mandatory, publishedAt, channel, signature },
  };
}

/** 签名载荷:固定字段顺序的 JSON(签名脚本与壳必须一致)。 */
function canonicalManifestPayload(manifest) {
  const out = {};
  for (const key of SIGNED_MANIFEST_FIELDS) {
    const value = manifest ? manifest[key] : undefined;
    if (value === undefined || value === null) {
      out[key] = key === "size" ? 0 : key === "mandatory" ? false : "";
    } else {
      out[key] = value;
    }
  }
  return JSON.stringify(out);
}

/**
 * 清单签名校验:
 * - 有签名且 Ed25519 验签通过 → verified;
 * - 有签名但验签失败 → invalid(调用方必须拒绝该更新,防篡改);
 * - 无签名 → unsigned(默认降级为仅 sha256 校验并提示;requireSignature 时拒绝)。
 */
function verifyManifestSignature(manifest, publicKeyPem) {
  const signature = manifest && manifest.signature;
  if (!signature) return { status: "unsigned" };
  try {
    const ok = verifySignature(
      null,
      Buffer.from(canonicalManifestPayload(manifest), "utf8"),
      publicKeyPem || DEFAULT_UPDATE_PUBLIC_KEY,
      Buffer.from(signature, "base64"),
    );
    return ok ? { status: "verified" } : { status: "invalid", error: "更新清单签名无效(可能被篡改或密钥不匹配)" };
  } catch (err) {
    return { status: "invalid", error: `更新清单验签失败:${(err && err.message) || err}` };
  }
}

/** 解析 Get-AuthenticodeSignature 的 JSON 输出(纯函数,便于单测)。 */
function parseAuthenticodeOutput(stdout) {
  try {
    const obj = JSON.parse(String(stdout || "").trim());
    if (!obj || typeof obj !== "object") return { status: "unknown", error: "空输出" };
    return {
      status: typeof obj.Status === "string" ? obj.Status : "unknown",
      message: typeof obj.StatusMessage === "string" ? obj.StatusMessage : "",
      signer: typeof obj.Signer === "string" ? obj.Signer : "",
    };
  } catch (err) {
    return { status: "unknown", error: `Authenticode 输出解析失败:${(err && err.message) || err}` };
  }
}

/**
 * Authenticode 探测(Windows,尽力而为):未签名包返回 NotSigned;自签/不受信返回 NotTrusted;
 * 文件哈希与签名不符返回 HashMismatch。无证书环境下作为「签名状态透明化」的兜底,
 * 不替代清单 Ed25519 验签。
 */
function checkAuthenticode(filePath, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "win32") return Promise.resolve({ status: "unsupported" });
  const run = options.execFileImpl || execFile;
  const safePath = String(filePath || "").replace(/'/g, "''");
  const script =
    `$s = Get-AuthenticodeSignature -LiteralPath '${safePath}'; ` +
    `$signer = ''; if ($s.SignerCertificate) { $signer = $s.SignerCertificate.Subject }; ` +
    `[pscustomobject]@{ Status = $s.Status.ToString(); StatusMessage = $s.StatusMessage; Signer = $signer } | ConvertTo-Json -Compress`;
  return new Promise((resolve) => {
    run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout: 10000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve({ status: "unknown", error: (err && err.message) || String(err) });
          return;
        }
        resolve(parseAuthenticodeOutput(stdout));
      },
    );
  });
}
function evaluateUpdate(currentVersion, manifest) {
  const current = normalizeVersion(currentVersion) || "0.0.0";
  const latest = manifest && normalizeVersion(manifest.version);
  const cmp = latest ? compareVersions(latest, current) : null;
  const available = cmp === 1;
  const belowMin = available && manifest.minVersion ? compareVersions(current, manifest.minVersion) === -1 : false;
  return {
    currentVersion: current,
    available,
    latestVersion: latest || "",
    notes: (manifest && manifest.notes) || "",
    downloadUrl: (manifest && manifest.downloadUrl) || "",
    blockmapUrl: (manifest && manifest.blockmapUrl) || "",
    pageUrl: (manifest && manifest.pageUrl) || "",
    sha256: (manifest && manifest.sha256) || "",
    size: (manifest && manifest.size) || 0,
    publishedAt: (manifest && manifest.publishedAt) || "",
    mandatory: !!(manifest && (manifest.mandatory || belowMin)),
    signature: (manifest && manifest.signature) || "",
    signed: !!(manifest && manifest.signature),
  };
}

/* ------------------------------- 配置读取 ------------------------------- */

function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * 更新配置来源(优先级从高到低):
 * 1. env.GENIE_UPDATE_FEED_URL / GENIE_UPDATE_AUTOCHECK / GENIE_UPDATE_INTERVAL_HOURS;
 * 2. 桌面壳自己的 `<dataRoot>/.genie/update-config.json`(面板「关于 → 应用更新」写入);
 * 3. `<dataRoot>/genie.config.json` 的 `update: { feedUrl, autoCheck, intervalHours }`
 *    (分发方/部署方预置的兜底)。
 * 没有 feedUrl = 未配置更新源(状态 disabled),不向任何地址发请求。
 */
function readDesktopUpdateConfig(dataRoot) {
  if (!dataRoot) return null;
  const raw = readJsonFile(join(dataRoot, DESKTOP_UPDATE_CONFIG));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return {
    feedUrl: httpUrlOnly(raw.feedUrl),
    autoCheck: typeof raw.autoCheck === "boolean" ? raw.autoCheck : undefined,
    intervalHours: Number.isFinite(Number(raw.intervalHours)) && Number(raw.intervalHours) > 0
      ? Number(raw.intervalHours)
      : undefined,
  };
}

function readUpdateConfig(dataRoot, env = process.env) {
  const e = env || {};
  const cfg = dataRoot ? readJsonFile(join(dataRoot, "genie.config.json")) || {} : {};
  const raw = cfg.update && typeof cfg.update === "object" ? cfg.update : {};
  const desktop = readDesktopUpdateConfig(dataRoot) || {};
  const feedUrl = httpUrlOnly(e.GENIE_UPDATE_FEED_URL || desktop.feedUrl || raw.feedUrl);
  const autoCheck = e.GENIE_UPDATE_AUTOCHECK === "0"
    ? false
    : e.GENIE_UPDATE_AUTOCHECK === "1"
      ? true
      : desktop.autoCheck === false
        ? false
        : raw.autoCheck !== false;
  const hoursRaw = Number(e.GENIE_UPDATE_INTERVAL_HOURS || desktop.intervalHours || raw.intervalHours);
  const intervalMs = Number.isFinite(hoursRaw) && hoursRaw > 0
    ? Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(hoursRaw * 60 * 60 * 1000)))
    : DEFAULT_INTERVAL_MS;
  const diff = e.GENIE_UPDATE_DIFF === "0"
    ? false
    : desktop.diff === false
      ? false
      : raw.diff !== false;
  const requireSignature = e.GENIE_REQUIRE_UPDATE_SIGNATURE === "1"
    || desktop.requireSignature === true
    || raw.requireSignature === true;
  return { feedUrl, autoCheck, intervalMs, diff, requireSignature };
}

/**
 * 写入桌面壳更新配置(原子写)。只接受 http(s) URL;`feedUrl: ""` 表示撤销本条覆盖,
 * 回退到 genie.config.json / 环境变量。非法输入抛错由 IPC 侧转成可读 message。
 */
function writeUpdateConfig(dataRoot, patch = {}) {
  if (!dataRoot) throw new Error("数据目录未就绪");
  const file = join(dataRoot, DESKTOP_UPDATE_CONFIG);
  const prev = readJsonFile(file) || {};
  const next = { ...prev };
  if (patch.feedUrl !== undefined) {
    const text = String(patch.feedUrl || "").trim();
    if (text) {
      const url = httpUrlOnly(text);
      if (!url) throw new Error("更新源必须是 http(s) URL");
      next.feedUrl = url;
    } else {
      next.feedUrl = "";
    }
  }
  if (patch.autoCheck !== undefined) next.autoCheck = !!patch.autoCheck;
  if (patch.diff !== undefined) next.diff = !!patch.diff;
  if (patch.requireSignature !== undefined) next.requireSignature = !!patch.requireSignature;
  if (patch.intervalHours !== undefined) {
    const hours = Number(patch.intervalHours);
    if (!Number.isFinite(hours) || hours <= 0) throw new Error("intervalHours 必须是正数");
    next.intervalHours = Math.min(168, Math.max(0.5, hours));
  }
  next.updatedAt = Date.now();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(next, null, 2));
  renameSync(tmp, file);
  return { feedUrl: next.feedUrl || "", autoCheck: next.autoCheck, intervalHours: next.intervalHours, updatedAt: next.updatedAt };
}

/* ------------------------------- 下载校验 ------------------------------- */

function safeFileName(value) {
  const name = String(value || "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/^\.+/, "")
    .trim();
  return name.slice(0, 120);
}

/**
 * 异步 sha256(整文件流式读取):断点续传时半成品可能是多次追加的,
 * 统一在收尾阶段对完整文件做一次校验,避免「下载中哈希」与续传拼接的复杂度。
 */
/* ------------------------------- 差分下载(blockmap) ------------------------------- */

/**
 * electron-builder 的 .blockmap 是 gzip JSON:
 * { version:"2", files:[{ name, offset, checksums:[base64(blake2b-18)], sizes:[byte] }] }
 * 块由内容定义分块(Rabin)产生,未变化区域的块校验和在新旧版本间可复用。
 * 这里只消费校验和/大小/偏移,不重新实现分块算法。
 */
function parseBlockMapBuffer(buffer) {
  if (!buffer || !buffer.length) throw new Error("blockmap 为空");
  let raw = buffer;
  if (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) raw = gunzipSync(buffer);
  const obj = JSON.parse(raw.toString("utf8"));
  if (!obj || !Array.isArray(obj.files) || !obj.files.length) throw new Error("blockmap 缺少 files");
  const file = obj.files[0];
  if (!Array.isArray(file.checksums) || !Array.isArray(file.sizes) || file.checksums.length !== file.sizes.length) {
    throw new Error("blockmap 的 checksums/sizes 不匹配");
  }
  return { version: obj.version, file };
}

/** checksum → {offset,size};同一校验和取首个(内容相同,偏移不同也等价)。 */
function blockMapIndex(file) {
  const map = new Map();
  let offset = Number(file.offset) || 0;
  for (let i = 0; i < file.sizes.length; i++) {
    const size = Number(file.sizes[i]);
    const checksum = String(file.checksums[i] || "");
    if (size > 0 && checksum && !map.has(checksum)) map.set(checksum, { offset, size });
    offset += Number.isFinite(size) && size > 0 ? size : 0;
  }
  return { map, totalSize: offset };
}

/** 在更新目录里找可复用的旧安装包(必须同时有 .blockmap,否则无法做块匹配)。 */
function findDiffSource(dir, dest) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const candidates = [];
  for (const name of names) {
    if (!/\.exe$/i.test(name)) continue;
    const file = join(dir, name);
    const blockmap = file + ".blockmap";
    if (!existsSync(blockmap)) continue;
    try {
      const st = statSync(file);
      if (st.isFile() && st.size > 0) candidates.push({ file, blockmap, mtime: st.mtimeMs, isDest: resolve(file) === resolve(dest) });
    } catch {
      /* 跳过不可读文件 */
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0] || null;
}

function writeDownloadMeta(file, meta) {
  try {
    writeFileSync(file, JSON.stringify(meta, null, 2));
  } catch {
    /* 元数据写失败只影响续传,不影响整包下载 */
  }
}

function sha256FileAsync(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * 更新目录清理(2026-11-09 残留收口 + 断点续传):
 * - `.part` + 同名 `.meta.json`(可续传)保留 RESUMABLE_PART_MS(7 天);
 *   没有 meta 的半成品超过 stalePartMs(默认 30 分钟)视为中断残留删除;
 * - 失去 `.part` 的孤儿 meta 删除;
 * - `.exe` 安装包保留 keepPath(当前已下载) + 最新 keepCount 个,其余删除;
 * - 只处理本目录内的 .exe/.part/.meta.json,其它文件不动;目录不存在/文件被占用跳过不抛。
 */
function pruneUpdateDir(dir, options = {}) {
  const now = Number(options.now) || Date.now();
  const keepPath = options.keepPath ? resolve(options.keepPath) : "";
  const keepCount = Number.isInteger(options.keepCount) ? Math.max(0, options.keepCount) : KEEP_INSTALLERS;
  const stalePartMs = Number(options.stalePartMs) || STALE_PART_MS;
  const resumablePartMs = Number(options.resumablePartMs) || RESUMABLE_PART_MS;
  const removed = [];
  const kept = [];
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return { removed, kept };
  }
  const nameSet = new Set(names);
  const exes = [];
  const blockmaps = [];
  for (const name of names) {
    const file = join(dir, name);
    let stat;
    try {
      stat = statSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const lower = name.toLowerCase();
    if (lower.endsWith(".blockmap")) {
      blockmaps.push({ file, name, mtime: stat.mtimeMs });
      continue;
    }
    if (lower.endsWith(".meta.json")) {
      const partName = name.slice(0, -".meta.json".length);
      if (!nameSet.has(partName)) {
        try { rmSync(file, { force: true }); removed.push(file); } catch { /* 忽略 */ }
      } else {
        kept.push(file);
      }
      continue;
    }
    if (lower.endsWith(".part")) {
      const metaName = name + ".meta.json";
      let metaAge = Number.POSITIVE_INFINITY;
      if (nameSet.has(metaName)) {
        try { metaAge = now - statSync(join(dir, metaName)).mtimeMs; } catch { /* 忽略 */ }
      }
      const resumable = metaAge <= resumablePartMs;
      const stale = now - stat.mtimeMs > stalePartMs;
      if (!resumable && stale) {
        try {
          rmSync(file, { force: true });
          removed.push(file);
          if (nameSet.has(metaName)) {
            rmSync(join(dir, metaName), { force: true });
            removed.push(join(dir, metaName));
          }
        } catch { /* 杀软占用,下次再清 */ }
      } else {
        kept.push(file);
      }
      continue;
    }
    if (lower.endsWith(".exe")) exes.push({ file, mtime: stat.mtimeMs, pinned: resolve(file) === keepPath });
  }
  exes.sort((a, b) => b.mtime - a.mtime);
  let remaining = keepCount;
  for (const item of exes) {
    if (item.pinned) {
      kept.push(item.file);
      if (remaining > 0) remaining -= 1; // 当前已下载的包计入保留名额
      continue;
    }
    if (remaining > 0) {
      remaining -= 1;
      kept.push(item.file);
      continue;
    }
    try {
      rmSync(item.file, { force: true });
      removed.push(item.file);
    } catch {
      kept.push(item.file);
    }
  }
  // blockmap 跟随其安装包:保留的包保留 .blockmap(供下次差分),被删的包清掉块表。
  const keptExeSet = new Set(kept.filter((p) => p.toLowerCase().endsWith(".exe")).map((p) => resolve(p)));
  for (const bm of blockmaps) {
    const baseName = bm.name.slice(0, -".blockmap".length);
    const basePath = resolve(join(dir, baseName));
    if (keptExeSet.has(basePath)) {
      kept.push(bm.file);
    } else {
      try { rmSync(bm.file, { force: true }); removed.push(bm.file); } catch { kept.push(bm.file); }
    }
  }
  return { removed, kept };
}

/**
 * 安装启动规格:只允许「更新目录内、真实存在、扩展名 .exe」的文件。
 * 下载校验(sha256/size)在 download() 内完成,状态为 downloaded 才允许走到这里。
 * /currentuser 显式声明按用户安装(本产品 nsis.perMachine=false):silent 升级时避免
 * electron-builder 因历史注册表状态误判为「为所有用户安装」而去申请提权(提权失败即静默退出)。
 * --force-run:electron-builder 模板在 silent 安装结束时会拉起应用(assisted installer 的
 * 「完成后运行」在静默态不执行),这样「安装并重启」的文案才成立。
 */
function installLaunchSpec(filePath, platform = process.platform, updatesDir = null) {
  if (!filePath || typeof filePath !== "string") return { ok: false, error: "缺少安装包路径" };
  if (platform !== "win32") return { ok: false, error: "当前平台暂不支持应用内安装" };
  if (!/\.exe$/i.test(filePath)) return { ok: false, error: "安装包不是 .exe" };
  if (!existsSync(filePath)) return { ok: false, error: "安装包不存在(可能已被清理)" };
  if (updatesDir) {
    const root = resolve(updatesDir);
    const file = resolve(filePath);
    if (file !== root && !file.startsWith(root + sep)) {
      return { ok: false, error: "安装包不在更新目录内,拒绝执行" };
    }
  }
  return { ok: true, filePath: resolve(filePath), args: ["/S", "/currentuser", "--force-run"], cwd: dirname(resolve(filePath)) };
}

/* ------------------------------- 检查器 ------------------------------- */

function readPersistedState(stateFile) {
  if (!stateFile) return null;
  const raw = readJsonFile(stateFile);
  if (!raw || typeof raw !== "object") return null;
  return {
    lastCheckedAt: Number.isFinite(Number(raw.lastCheckedAt)) ? Number(raw.lastCheckedAt) : null,
    latestVersion: typeof raw.latestVersion === "string" ? raw.latestVersion : "",
  };
}

function persistState(stateFile, patch) {
  if (!stateFile) return;
  try {
    mkdirSync(dirname(stateFile), { recursive: true });
    const next = { ...(readPersistedState(stateFile) || {}), ...patch, savedAt: Date.now() };
    writeFileSync(stateFile, JSON.stringify(next, null, 2));
  } catch {
    /* 落盘失败只影响「上次检查时间」展示,不影响检查本身 */
  }
}

/**
 * 创建检查器。所有副作用可注入:
 * - fetchImpl:测试用本地 http server 或桩;
 * - now/intervalMs/initialDelayMs:自动检查节奏;
 * - downloadDir/stateFile:落盘位置;
 * - onState:每次状态变化回调(主进程据此发 IPC/系统通知);
 * - notify:不在此层做系统通知(由主进程决定何时打扰用户)。
 */
function createUpdateChecker(options = {}) {
  const currentVersion = normalizeVersion(options.currentVersion) || "0.0.0";
  const feedUrl = httpUrlOnly(options.feedUrl);
  const fetchImpl = typeof options.fetchImpl === "function" ? options.fetchImpl : globalThis.fetch;
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const log = typeof options.log === "function" ? options.log : () => undefined;
  const onState = typeof options.onState === "function" ? options.onState : () => undefined;
  const downloadDir = options.downloadDir || null;
  const stateFile = options.stateFile || null;
  const autoCheck = options.autoCheck !== false;
  const diffEnabled = options.diff !== false;
  const requireSignature = options.requireSignature === true;
  const publicKey = options.publicKey || process.env.GENIE_UPDATE_PUBLIC_KEY || DEFAULT_UPDATE_PUBLIC_KEY;
  const intervalMs = Math.min(
    MAX_INTERVAL_MS,
    Math.max(MIN_INTERVAL_MS, Number(options.intervalMs) || DEFAULT_INTERVAL_MS),
  );
  const initialDelayMs = Number.isFinite(Number(options.initialDelayMs))
    ? Math.max(0, Number(options.initialDelayMs))
    : FIRST_CHECK_DELAY_MS;

  const persisted = readPersistedState(stateFile);
  let dismissedVersion = "";
  let checkInFlight = null;
  let downloadInFlight = null;
  let timer = null;
  let stopped = false;
  let state = {
    status: feedUrl ? "idle" : "disabled",
    reason: feedUrl ? "" : "未配置更新源(设置 GENIE_UPDATE_FEED_URL 或 genie.config.json 的 update.feedUrl)",
    currentVersion,
    feedUrl,
    lastCheckedAt: persisted ? persisted.lastCheckedAt : null,
    latestVersion: persisted ? persisted.latestVersion : "",
    notes: "",
    downloadUrl: "",
    blockmapUrl: "",
    pageUrl: "",
    sha256: "",
    size: 0,
    publishedAt: "",
    mandatory: false,
    progress: null,
    downloadedPath: "",
    verified: false,
    error: "",
    dismissed: false,
    manual: false,
    autoCheck,
    intervalMinutes: Math.round(intervalMs / 60000),
    diff: diffEnabled,
    signatureStatus: "unknown",
    signature: "",
    requireSignature,
  };

  function snapshot() {
    return JSON.parse(JSON.stringify(state));
  }

  function setState(patch) {
    state = { ...state, ...patch };
    try {
      onState(snapshot());
    } catch (e) {
      log(`[update] onState 回调异常: ${(e && e.message) || e}`);
    }
    return snapshot();
  }

  function checkDisabled(reason) {
    if (feedUrl) return false;
    const message = "未配置更新源(设置 GENIE_UPDATE_FEED_URL 或 genie.config.json 的 update.feedUrl)";
    setState({ status: "disabled", reason: message, manual: reason === "manual", error: "" });
    return true;
  }

  async function fetchText(url) {
    if (typeof fetchImpl !== "function") throw new Error("当前运行环境没有 fetch");
    const controller = new AbortController();
    const timerId = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, {
        signal: controller.signal,
        headers: { accept: "application/json", "cache-control": "no-cache" },
      });
      if (!res || !res.ok) throw new Error(`更新源返回 HTTP ${res ? res.status : "(无响应)"}`);
      return await res.text();
    } catch (err) {
      if (err && err.name === "AbortError") throw new Error(`更新源请求超时(${CHECK_TIMEOUT_MS}ms)`);
      throw err;
    } finally {
      clearTimeout(timerId);
    }
  }

  async function checkNow(checkOptions = {}) {
    const reason = checkOptions.reason === "manual" ? "manual" : "auto";
    if (checkDisabled(reason)) return { ok: false, error: state.reason, disabled: true };
    if (checkInFlight) return checkInFlight;
    if (state.status === "downloading") {
      return { ok: false, error: "正在下载更新,稍后再检查" };
    }
    if (reason === "manual") dismissedVersion = "";
    checkInFlight = (async () => {
      setState({ status: "checking", reason: state.reason, manual: reason === "manual", error: "", dismissed: false });
      try {
        const text = await fetchText(feedUrl);
        const parsed = parseUpdateManifest(text);
        if (!parsed.ok) throw new Error(parsed.error);
        const signature = verifyManifestSignature(parsed.manifest, publicKey);
        if (signature.status === "invalid") throw new Error(signature.error);
        if (signature.status === "unsigned" && requireSignature) {
          throw new Error("更新源未提供发布者签名(已启用强制签名 GENIE_REQUIRE_UPDATE_SIGNATURE=1)");
        }
        const evaluated = evaluateUpdate(currentVersion, parsed.manifest);
        evaluated.signatureStatus = signature.status;
        const checkedAt = now();
        persistState(stateFile, { lastCheckedAt: checkedAt, latestVersion: evaluated.latestVersion });
        if (!evaluated.available) {
          setState({
            status: "up-to-date",
            ...evaluated,
            lastCheckedAt: checkedAt,
            manual: reason === "manual",
            progress: null,
            downloadedPath: "",
            verified: false,
            error: "",
            dismissed: false,
          });
          log(`[update] 已是最新版本 v${currentVersion}`);
          return { ok: true, available: false, latestVersion: evaluated.latestVersion };
        }
        // 已下载完成的同一版本:保留 downloaded 状态,别让一次自动检查把「可安装」抹掉。
        if (state.status === "downloaded" && state.latestVersion === evaluated.latestVersion) {
          setState({ ...evaluated, lastCheckedAt: checkedAt, manual: reason === "manual" });
          return { ok: true, available: true, latestVersion: evaluated.latestVersion, downloaded: true };
        }
        setState({
          status: "available",
          ...evaluated,
          lastCheckedAt: checkedAt,
          manual: reason === "manual",
          progress: null,
          downloadedPath: "",
          verified: false,
          error: "",
          dismissed: dismissedVersion === evaluated.latestVersion,
        });
        log(`[update] 发现新版本 v${evaluated.latestVersion}(当前 v${currentVersion}${evaluated.mandatory ? ",强制更新" : ""})`);
        return { ok: true, available: true, latestVersion: evaluated.latestVersion };
      } catch (err) {
        const message = (err && err.message) || String(err);
        setState({
          status: "error",
          error: message,
          lastCheckedAt: state.lastCheckedAt,
          manual: reason === "manual",
          dismissed: false,
        });
        log(`[update] 检查失败: ${message}`);
        return { ok: false, error: message };
      } finally {
        checkInFlight = null;
      }
    })();
    return checkInFlight;
  }

  function progressSnapshot(received, total) {
    const percent = total > 0 ? Math.min(100, Math.round((received / total) * 1000) / 10) : null;
    return { received, total: total > 0 ? total : 0, percent };
  }

  async function saveBlockmap(dest) {
    if (!state.blockmapUrl) return;
    try {
      const res = await fetchImpl(state.blockmapUrl, { headers: { accept: "application/octet-stream" } });
      if (!res || !res.ok) return;
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > 20 * 1024 * 1024) return;
      parseBlockMapBuffer(buf); // 能解析才落盘,避免存坏块表影响下次差分
      writeFileSync(dest + ".blockmap", buf);
      log(`[update] blockmap 已保存(${buf.length} 字节),下次可差分`);
    } catch (err) {
      log(`[update] blockmap 保存失败(不影响安装): ${(err && err.message) || err}`);
    }
  }

  async function finalizeDownload(dest, actualSize, knownBlockmap) {
    if (knownBlockmap) {
      try { writeFileSync(dest + ".blockmap", knownBlockmap); } catch { /* 下次全量 */ }
    } else {
      await saveBlockmap(dest);
    }
    setState({
      status: "downloaded",
      downloadedPath: dest,
      verified: !!state.sha256,
      progress: progressSnapshot(actualSize, actualSize),
      error: "",
      resumable: false,
      resumableBytes: 0,
    });
    log(`[update] 更新包已下载并校验: ${dest} (${actualSize} 字节)`);
    const pruned = pruneUpdateDir(downloadDir, { keepPath: dest, keepCount: KEEP_INSTALLERS });
    if (pruned.removed.length) {
      log(`[update] 已清理旧更新包/半成品 ${pruned.removed.length} 个`);
    }
    return { ok: true, downloadedPath: dest, size: actualSize };
  }

  /**
   * 差分下载:复用更新目录里旧安装包(及其 .blockmap)中内容相同的块,只 Range 拉取变化块。
   * 任何一步失败都抛错,由调用方回退全量下载(dest 旧文件在成功 rename 前不被改动)。
   */
  async function downloadViaDiff(dest) {
    const source = findDiffSource(downloadDir, dest);
    if (!source) throw new Error("没有可复用的旧安装包(缺 .blockmap)");
    setState({ status: "downloading", progress: progressSnapshot(0, state.size), error: "", dismissed: false, manual: false });
    const res = await fetchImpl(state.blockmapUrl, { headers: { accept: "application/octet-stream" } });
    if (!res || !res.ok) throw new Error(`blockmap 下载失败(HTTP ${res ? res.status : "?"})`);
    const newMapBuf = Buffer.from(await res.arrayBuffer());
    const newFile = parseBlockMapBuffer(newMapBuf).file;
    const newIdx = blockMapIndex(newFile);
    const newTotal = newIdx.totalSize;
    if (state.size && newTotal !== state.size) throw new Error("blockmap 总大小与清单不一致");
    const oldFile = parseBlockMapBuffer(readFileSync(source.blockmap)).file;
    const oldIdx = blockMapIndex(oldFile);
    const oldSize = statSync(source.file).size;
    if (oldIdx.totalSize !== oldSize) throw new Error("旧安装包与 blockmap 大小不一致");

    const plan = [];
    let matched = 0;
    let newOffset = Number(newFile.offset) || 0;
    for (let i = 0; i < newFile.sizes.length; i++) {
      const size = Number(newFile.sizes[i]);
      const checksum = String(newFile.checksums[i] || "");
      const old = oldIdx.map.get(checksum);
      const oldOffset = old && old.size === size ? old.offset : null;
      if (oldOffset !== null) matched += size;
      plan.push({ offset: newOffset, size, oldOffset });
      newOffset += size;
    }
    if (matched < newTotal * 0.15) {
      throw new Error(`可复用块不足(${matched}/${newTotal}),改用全量下载`);
    }
    log(`[update] 差分下载:可复用 ${(matched / 1048576).toFixed(1)}MB/${(newTotal / 1048576).toFixed(1)}MB(旧包 ${basename(source.file)})`);

    const diffPart = dest + ".diff.part";
    try { rmSync(diffPart, { force: true }); } catch { /* 忽略 */ }
    const oldFd = openSync(source.file, "r");
    let newFd = null;
    let downloaded = 0;
    let lastEmit = 0;
    try {
      newFd = openSync(diffPart, "w");
      let sinceYield = 0;
      for (const block of plan) {
        if (block.oldOffset === null) continue;
        const buf = Buffer.allocUnsafe(block.size);
        let read = 0;
        while (read < block.size) {
          const n = readSync(oldFd, buf, read, block.size - read, block.oldOffset + read);
          if (!n) throw new Error("读取旧安装包失败");
          read += n;
        }
        writeSync(newFd, buf, 0, block.size, block.offset);
        if (++sinceYield >= 500) {
          sinceYield = 0;
          await new Promise((r) => setImmediate(r));
        }
      }
      // 缺失块合并成连续 Range 段
      const ranges = [];
      for (const block of plan) {
        if (block.oldOffset !== null) continue;
        const last = ranges[ranges.length - 1];
        if (last && last.end + 1 === block.offset) last.end = block.offset + block.size - 1;
        else ranges.push({ start: block.offset, end: block.offset + block.size - 1 });
      }
      const missingBytes = ranges.reduce((sum, r) => sum + (r.end - r.start + 1), 0);
      log(`[update] 差分下载:需下载 ${ranges.length} 段共 ${(missingBytes / 1048576).toFixed(1)}MB`);
      for (const range of ranges) {
        const partRes = await fetchImpl(state.downloadUrl, {
          headers: { accept: "application/octet-stream", Range: `bytes=${range.start}-${range.end}` },
        });
        if (!partRes || partRes.status !== 206) {
          throw new Error(`差分分片下载失败(HTTP ${partRes ? partRes.status : "?"})`);
        }
        const contentRange = partRes.headers && partRes.headers.get
          ? String(partRes.headers.get("content-range") || "")
          : "";
        const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(contentRange);
        if (!m || Number(m[1]) !== range.start) throw new Error("差分分片区间不匹配");
        let pos = range.start;
        for await (const chunk of Readable.fromWeb(partRes.body)) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          writeSync(newFd, buf, 0, buf.length, pos);
          pos += buf.length;
          downloaded += buf.length;
          const ts = now();
          if (ts - lastEmit >= 200) {
            lastEmit = ts;
            setState({ progress: progressSnapshot(Math.min(newTotal, matched + downloaded), newTotal) });
          }
        }
        if (pos !== range.end + 1) throw new Error("差分分片长度不符");
      }
      ftruncateSync(newFd, newTotal);
    } finally {
      try { closeSync(oldFd); } catch { /* 忽略 */ }
      if (newFd !== null) { try { closeSync(newFd); } catch { /* 忽略 */ } }
    }
    const actualSize = statSync(diffPart).size;
    if (state.size && actualSize !== state.size) throw new Error("差分产物大小不符");
    if (state.sha256) {
      const actual = await sha256FileAsync(diffPart);
      if (actual !== state.sha256) throw new Error("差分产物 sha256 校验失败");
    }
    try { rmSync(dest, { force: true }); } catch { /* 覆盖旧包 */ }
    renameSync(diffPart, dest);
    log(`[update] 差分下载完成:复用 ${(matched / 1048576).toFixed(1)}MB,下载 ${(downloaded / 1048576).toFixed(1)}MB`);
    const result = await finalizeDownload(dest, actualSize, newMapBuf);
    return { ...result, diff: { matchedBytes: matched, downloadedBytes: downloaded } };
  }

  async function download() {
    if (state.status === "downloaded") return { ok: true, downloadedPath: state.downloadedPath, already: true };
    if (state.status === "downloading") {
      return downloadInFlight || { ok: false, error: "正在下载更新" };
    }
    if (state.status !== "available" && state.status !== "error") {
      return { ok: false, error: "当前没有可下载的更新" };
    }
    if (!state.downloadUrl) return { ok: false, error: "更新源未提供安装包下载地址" };
    if (!downloadDir) return { ok: false, error: "未配置更新下载目录" };

    let fileName = "";
    try {
      fileName = safeFileName(decodeURIComponent(basename(new URL(state.downloadUrl).pathname)));
    } catch {
      fileName = "";
    }
    if (!fileName) fileName = `LampGenie-${safeFileName(state.latestVersion) || "update"}.exe`;
    const dest = join(downloadDir, fileName);
    const part = dest + ".part";
    const metaFile = part + ".meta.json";

    downloadInFlight = (async () => {
      let writeStream = null;
      // keepPartial:失败时是否保留 .part 供下次续传(网络中断=true;校验失败/区间失效=false)
      let keepPartial = true;
      try {
        mkdirSync(downloadDir, { recursive: true });
        let partSize = 0;
        try { partSize = existsSync(part) ? statSync(part).size : 0; } catch { partSize = 0; }
        let meta = readJsonFile(metaFile) || null;
        const metaMatches = !!(
          meta &&
          meta.url === state.downloadUrl &&
          String(meta.sha256 || "") === String(state.sha256 || "") &&
          Number(meta.size) === state.size
        );
        const canResume = !!(metaMatches && partSize > 0 && state.size > 0 && partSize < state.size);
        const canVerify = !!(metaMatches && partSize > 0 && state.size > 0 && partSize === state.size);
        if (partSize > 0 && !canResume && !canVerify) {
          log("[update] 半成品与当前版本不匹配,放弃续传并重下");
          try { rmSync(part, { force: true }); } catch { /* 忽略 */ }
          try { rmSync(metaFile, { force: true }); } catch { /* 忽略 */ }
          partSize = 0;
          meta = null;
        } else if (!partSize && existsSync(metaFile)) {
          try { rmSync(metaFile, { force: true }); } catch { /* 忽略 */ }
          meta = null;
        }
        let resumeFrom = canResume ? partSize : 0;
        // 没有可续传的半成品时,优先尝试差分(复用旧安装包的未变化块);失败静默回退全量。
        if (diffEnabled && state.blockmapUrl && resumeFrom === 0) {
          try {
            return await downloadViaDiff(dest);
          } catch (err) {
            log(`[update] 差分下载不可用,回退全量下载: ${(err && err.message) || err}`);
            try { rmSync(dest + ".diff.part", { force: true }); } catch { /* 忽略 */ }
          }
        }
        meta = {
          url: state.downloadUrl,
          sha256: state.sha256 || "",
          size: state.size || 0,
          version: state.latestVersion || "",
          etag: (meta && meta.etag) || "",
          lastModified: (meta && meta.lastModified) || "",
          updatedAt: now(),
        };
        writeDownloadMeta(metaFile, meta);
        setState({
          status: "downloading",
          progress: progressSnapshot(resumeFrom, state.size),
          error: "",
          dismissed: false,
          manual: false,
          resumable: resumeFrom > 0,
          resumableBytes: resumeFrom,
        });
        if (resumeFrom > 0) {
          log(`[update] 断点续传:从 ${resumeFrom} 字节继续(${partSize}/${state.size})`);
        }

        // 半成品已经等于清单大小(上次在收尾阶段被中断):直接进入校验
        if (!(state.size > 0 && partSize === state.size)) {
          const headers = { accept: "application/octet-stream" };
          if (resumeFrom > 0) {
            headers.Range = `bytes=${resumeFrom}-`;
            if (meta.etag) headers["If-Range"] = meta.etag;
            else if (meta.lastModified) headers["If-Range"] = meta.lastModified;
          }
          const res = await fetchImpl(state.downloadUrl, { headers });
          if (!res) throw new Error("更新源无响应");
          if (res.status === 416) {
            keepPartial = false;
            try { rmSync(part, { force: true }); } catch { /* 忽略 */ }
            try { rmSync(metaFile, { force: true }); } catch { /* 忽略 */ }
            throw new Error("服务器拒绝续传(416),半成品已清理,请重新下载");
          }
          if (!res.ok && res.status !== 206) throw new Error(`下载更新失败:HTTP ${res.status}`);
          let total = state.size || 0;
          let append = resumeFrom > 0;
          if (res.status === 206) {
            const contentRange = res.headers && res.headers.get ? String(res.headers.get("content-range") || "") : "";
            const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(contentRange);
            if (!m || Number(m[1]) !== resumeFrom) {
              keepPartial = false;
              try { rmSync(part, { force: true }); } catch { /* 忽略 */ }
              try { rmSync(metaFile, { force: true }); } catch { /* 忽略 */ }
              throw new Error("服务器返回的续传区间不匹配,已重置下载,请重试");
            }
            if (m[3] !== "*") {
              const serverTotal = Number(m[3]);
              if (state.size && serverTotal !== state.size) {
                keepPartial = false;
                try { rmSync(part, { force: true }); } catch { /* 忽略 */ }
                try { rmSync(metaFile, { force: true }); } catch { /* 忽略 */ }
                throw new Error(`服务端包大小(${serverTotal})与清单(${state.size})不一致,已重置下载`);
              }
              if (!total) total = serverTotal;
            }
          } else {
            // 200:服务器忽略 Range(或本来就没有半成品)→ 从头写
            if (append) {
              log("[update] 服务器未接受 Range,从头下载");
              append = false;
              resumeFrom = 0;
            }
            const contentLength = Number(res.headers && res.headers.get ? res.headers.get("content-length") : 0) || 0;
            if (!total && contentLength > 0) total = contentLength;
          }
          const etag = res.headers && res.headers.get ? String(res.headers.get("etag") || "") : "";
          const lastModified = res.headers && res.headers.get ? String(res.headers.get("last-modified") || "") : "";
          meta.etag = etag || meta.etag || "";
          meta.lastModified = lastModified || meta.lastModified || "";
          meta.updatedAt = now();
          writeDownloadMeta(metaFile, meta);

          writeStream = createWriteStream(part, { flags: append ? "a" : "w" });
          let received = resumeFrom;
          let lastEmit = 0;
          const body = res.body;
          if (!body) throw new Error("更新源响应没有数据体");
          for await (const chunk of Readable.fromWeb(body)) {
            if (stopped) throw new Error("应用正在退出,下载中断(半成品已保留,可续传)");
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            received += buf.length;
            if (!writeStream.write(buf)) await once(writeStream, "drain");
            const ts = now();
            if (ts - lastEmit >= 200) {
              lastEmit = ts;
              setState({ progress: progressSnapshot(received, total) });
            }
          }
          await new Promise((resolveEnd, rejectEnd) => {
            writeStream.end((err) => (err ? rejectEnd(err) : resolveEnd()));
          });
          writeStream = null;
        } else {
          log("[update] 半成品大小与清单一致,直接进入校验");
        }

        // 收尾校验:大小 → sha256(完整文件)。大小不足但连接正常结束 = 可续传的不完整包。
        const actualSize = statSync(part).size;
        if (state.size && actualSize < state.size) {
          throw new Error(`下载不完整(${actualSize}/${state.size} 字节),半成品已保留,可重试续传`);
        }
        if (state.size && actualSize > state.size) {
          keepPartial = false;
          throw new Error(`安装包大小超出清单(期望 ${state.size} 字节,实际 ${actualSize} 字节),半成品已清理`);
        }
        if (state.sha256) {
          setState({ progress: progressSnapshot(actualSize, actualSize) });
          log("[update] 校验安装包 sha256…");
          const actual = await sha256FileAsync(part);
          if (actual !== state.sha256) {
            keepPartial = false;
            throw new Error("安装包 sha256 校验失败(下载内容损坏或被篡改),半成品已清理");
          }
        } else {
          log("[update] 更新源未提供 sha256,已按大小校验后落盘(建议发布方补 sha256)");
        }
        try { rmSync(dest, { force: true }); } catch { /* 覆盖旧包 */ }
        renameSync(part, dest);
        try { rmSync(metaFile, { force: true }); } catch { /* 忽略 */ }
        return await finalizeDownload(dest, actualSize);
      } catch (err) {
        if (writeStream) {
          try { writeStream.destroy(); } catch { /* 忽略 */ }
        }
        let remaining = 0;
        try { if (existsSync(part)) remaining = statSync(part).size; } catch { remaining = 0; }
        if (!keepPartial) {
          try { rmSync(part, { force: true }); } catch { /* 忽略 */ }
          try { rmSync(metaFile, { force: true }); } catch { /* 忽略 */ }
          remaining = 0;
        }
        const raw = (err && err.message) || String(err);
        const message = /terminated|socket|network|fetch failed|aborted|ECONN|ETIMEDOUT/i.test(raw)
          ? `网络中断,下载未完成(${raw})`
          : raw;
        // 回到 available:横幅留在面板上,用户可重试;有半成品时下一次自动走 Range 续传。
        setState({
          status: "available",
          error: message,
          progress: remaining > 0 ? progressSnapshot(remaining, state.size) : null,
          resumable: remaining > 0,
          resumableBytes: remaining,
        });
        log(`[update] 下载失败: ${message}${remaining > 0 ? `(已保留 ${remaining} 字节,可续传)` : ""}`);
        return { ok: false, error: message, resumable: remaining > 0, resumableBytes: remaining };
      } finally {
        downloadInFlight = null;
      }
    })();
    return downloadInFlight;
  }

  function start() {
    if (stopped || !feedUrl || !autoCheck) return;
    const run = () => {
      if (stopped) return;
      void checkNow({ reason: "auto" }).catch(() => undefined);
    };
    if (initialDelayMs > 0) {
      timer = setTimeout(() => {
        run();
        timer = setInterval(run, intervalMs);
        if (timer.unref) timer.unref();
      }, initialDelayMs);
    } else {
      run();
      timer = setInterval(run, intervalMs);
    }
    if (timer.unref) timer.unref();
  }

  function stop() {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      clearInterval(timer);
      timer = null;
    }
  }

  function dismiss() {
    if (!state.latestVersion) return { ok: false, error: "当前没有可忽略的更新" };
    dismissedVersion = state.latestVersion;
    setState({ dismissed: true });
    return { ok: true };
  }

  return {
    getState: snapshot,
    start,
    stop,
    checkNow,
    download,
    dismiss,
    pruneDownloads: () => pruneUpdateDir(downloadDir || "", { keepPath: state.downloadedPath || "", keepCount: KEEP_INSTALLERS }),
    isConfigured: () => !!feedUrl,
  };
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  CHECK_TIMEOUT_MS,
  FIRST_CHECK_DELAY_MS,
  normalizeVersion,
  compareVersions,
  canonicalManifestPayload,
  verifyManifestSignature,
  parseAuthenticodeOutput,
  checkAuthenticode,
  DEFAULT_UPDATE_PUBLIC_KEY,
  parseUpdateManifest,
  evaluateUpdate,
  readUpdateConfig,
  readDesktopUpdateConfig,
  writeUpdateConfig,
  pruneUpdateDir,
  installLaunchSpec,
  safeFileName,
  sha256FileAsync,
  createUpdateChecker,
};