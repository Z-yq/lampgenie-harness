/**
 * 工作流资产存储:把「一段能跑通的 workflow 脚本 + 参数形状 + 作用域」落成可复用资产。
 * 设计取舍:
 * - 纯 IO 边界:所有文件读写只经构造函数注入的目录;未注入时默认落在系统临时目录(tmpdir)下,
 * 绝不向 /tmp 之外的隐式路径写(要换位置调用方必须显式给 dir)。
 * - 不 throw:校验失败 / 坏文件 / IO 异常都以 code 返回,面板与 CLI 不必用 try/catch 分流。
 * - 原子写:先写同目录 tmp 文件,再 rename(同一文件系统下 rename 原子),中途崩溃不会留下半个 JSON。
 * 为什么资产必须带参数 schema:
 * 资产的复用价值 = 别人(另一个会话 / 另一个项目 / 面板表单)不用读脚本就知道怎么喂参数。
 * 只存脚本的话,复用方只能反读源码猜入参,资产退化成一段不透明片段;paramsSchema 以 JSON 文本
 * 持久化(而不是 zod 实例),是因为它必须能跨进程、跨版本、跨语言可读——文件本身就是真源。
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as pathResolve } from "node:path";

/** 资产作用域:project=随项目走(可提交进仓),global=个人全局。 */
export type WorkflowAssetScope = "project" | "global";

export interface WorkflowAsset {
 /** 资产名,同时是文件名(不含扩展名);正则保证不会越出注入目录。 */
  name: string;
 /** workflow 脚本源码(engine.run 直接消费)。 */
  script: string;
 /** 参数 schema 的 JSON 文本(不是对象;见文件头「为什么资产必须带参数 schema」)。 */
  paramsSchema: string;
  scope: WorkflowAssetScope;
  createdAt: number;
  updatedAt: number;
  description?: string;
}

/** 存储操作的统一结果码:INVALID=入参/文件内容不合法,NOT_FOUND=不存在,IO_ERROR=底层 IO 失败。 */
export type AssetStoreCode = "OK" | "INVALID" | "NOT_FOUND" | "IO_ERROR";

export interface SaveAssetResult {
  ok: boolean;
  code: AssetStoreCode;
  asset?: WorkflowAsset;
  error?: string;
}

export interface GetAssetResult {
  ok: boolean;
  code: AssetStoreCode;
  asset?: WorkflowAsset;
  error?: string;
}

export interface ListAssetsResult {
  ok: boolean;
  code: AssetStoreCode;
  assets: WorkflowAsset[];
 /** 坏文件被跳过时逐条记录(文件名 + 原因),不中断整个列表。 */
  warnings: string[];
  error?: string;
}

export interface RemoveAssetResult {
  ok: boolean;
  code: AssetStoreCode;
  error?: string;
}

export interface AssetStats {
  ok: boolean;
  code: AssetStoreCode;
  count: number;
  byScope: Record<WorkflowAssetScope, number>;
 /** 脚本 + schema 文本总字节(口径只算可复用内容,不算文件名/时间戳)。 */
  totalBytes: number;
  latestUpdatedAt: number;
  names: string[];
  warnings: string[];
  error?: string;
}

export interface WorkflowAssetStoreOptions {
 /** 资产目录;缺省=系统临时目录下的 genie-workflow-assets(默认不向 /tmp 之外写)。 */
  dir?: string;
}

/** 名字即文件名:白名单字符集 + 长度上限,天然排除 `/`、`..`、空格等越界/歧义形态。 */
const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** 原子写的中间文件前缀:list 会跳过它,调试时也能一眼认出残留来源。 */
const TMP_PREFIX = ".tmp-";

export class WorkflowAssetStore {
  private readonly dirPath: string;

  constructor(opts: WorkflowAssetStoreOptions = {}) {
    const dir = typeof opts.dir === "string" && opts.dir.trim().length > 0
      ? opts.dir.trim()
      : join(tmpdir(), "genie-workflow-assets");
    this.dirPath = pathResolve(dir);
  }

 /** 生效目录(只读;测试与调用方可据此确认「没有写到别处」)。 */
  get dir(): string {
    return this.dirPath;
  }

  private fileOf(name: string): string {
    return join(this.dirPath, `${name}.json`);
  }

  private tmpName(name: string): string {
    return join(this.dirPath, `${TMP_PREFIX}${name}-${randomBytes(6).toString("hex")}.json`);
  }

 /** 目录不存在自动创建(写操作前幂等 mkdir,读操作不产生副作用)。 */
  private async ensureDir(): Promise<void> {
    await mkdir(this.dirPath, { recursive: true });
  }

 /** 入参校验:返回错误文本,合法返回 undefined。 */
  private validateInput(asset: WorkflowAsset): string | undefined {
    if (!asset || typeof asset !== "object") return "asset 必须是对象";
    if (typeof asset.name !== "string" || !NAME_RE.test(asset.name)) {
      return `name 非法(需 ^[A-Za-z0-9._-]{1,64}$): ${String(asset.name)}`;
    }
 // "." / ".." 也命名字符集,但作为文件名有特殊语义,显式拒绝
    if (asset.name === "." || asset.name === "..") return `name 不得为 ${asset.name}`;
    if (typeof asset.script !== "string" || asset.script.trim().length === 0) return "script 不得为空";
    if (typeof asset.paramsSchema !== "string") return "paramsSchema 必须是 JSON 文本";
    try {
      JSON.parse(asset.paramsSchema);
    } catch {
      return "paramsSchema 不是合法 JSON";
    }
    if (asset.scope !== "project" && asset.scope !== "global") return `scope 非法: ${String(asset.scope)}`;
    if (asset.description !== undefined && typeof asset.description !== "string") return "description 必须是字符串";
    return undefined;
  }

 /** 磁盘内容解析 + 形状校验:任何一处不符都视为坏文件(由调用方决定跳过还是报错)。 */
  private parseAsset(raw: string): WorkflowAsset | undefined {
    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return undefined;
    const a = obj as Partial<WorkflowAsset>;
    if (typeof a.name !== "string" || !NAME_RE.test(a.name)) return undefined;
    if (typeof a.script !== "string" || a.script.length === 0) return undefined;
    if (typeof a.paramsSchema !== "string") return undefined;
    if (a.scope !== "project" && a.scope !== "global") return undefined;
    if (typeof a.createdAt !== "number" || !Number.isFinite(a.createdAt)) return undefined;
    if (typeof a.updatedAt !== "number" || !Number.isFinite(a.updatedAt)) return undefined;
    return {
      name: a.name,
      script: a.script,
      paramsSchema: a.paramsSchema,
      scope: a.scope,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
      ...(typeof a.description === "string" ? { description: a.description } : {}),
    };
  }

 /** 读单个资产(内部用;不存在/坏文件一律 undefined,调用方按场景区分)。 */
  private async readOne(name: string): Promise<WorkflowAsset | undefined> {
    try {
      return this.parseAsset(await readFile(this.fileOf(name), "utf-8"));
    } catch {
      return undefined;
    }
  }

 /** 保存(同 name 覆盖)。createdAt 一旦诞生就不因改稿重置,updatedAt 每次保存推进。 */
  async save(input: WorkflowAsset): Promise<SaveAssetResult> {
    const invalid = this.validateInput(input);
    if (invalid) return { ok: false, code: "INVALID", error: invalid };
    let tmp: string | undefined;
    try {
      await this.ensureDir();
      const now = Date.now();
      const existing = await this.readOne(input.name);
      const asset: WorkflowAsset = {
        name: input.name,
        script: input.script,
        paramsSchema: input.paramsSchema,
        scope: input.scope,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        ...(input.description !== undefined ? { description: input.description } : {}),
      };
      tmp = this.tmpName(input.name);
      await writeFile(tmp, JSON.stringify(asset, null, 2) + "\n", "utf-8");
 // 同目录 rename 原子替换:读者要么看到旧完整文件,要么看到新完整文件
      await rename(tmp, this.fileOf(input.name));
      tmp = undefined;
      return { ok: true, code: "OK", asset };
    } catch (err) {
 // 失败时清掉中间文件,别把半成品留在目录里被 list 当坏文件报
      if (tmp) await rm(tmp, { force: true }).catch(() => {});
      return { ok: false, code: "IO_ERROR", error: String(err).slice(0, 200) };
    }
  }

 /** 读取单个资产:不存在 NOT_FOUND,文件损坏 INVALID。 */
  async get(name: string): Promise<GetAssetResult> {
    if (typeof name !== "string" || !NAME_RE.test(name)) {
      return { ok: false, code: "INVALID", error: `name 非法: ${String(name)}` };
    }
    let raw: string;
    try {
      raw = await readFile(this.fileOf(name), "utf-8");
    } catch (err) {
      const code = (err as { code?: string }).code;
      return code === "ENOENT"
        ? { ok: false, code: "NOT_FOUND", error: `资产不存在: ${name}` }
        : { ok: false, code: "IO_ERROR", error: String(err).slice(0, 200) };
    }
    const asset = this.parseAsset(raw);
    if (!asset) return { ok: false, code: "INVALID", error: `资产文件损坏: ${name}.json` };
    return { ok: true, code: "OK", asset };
  }

 /** 列出全部资产,按 name 排序;坏文件跳过并计入 warnings(列表不能因为一个坏文件整体失败)。 */
  async list(): Promise<ListAssetsResult> {
    const warnings: string[] = [];
    let entries: string[];
    try {
      entries = await readdir(this.dirPath);
    } catch (err) {
 // 目录还没建 = 空仓,不算错误(读路径不该有副作用地建目录)
      if ((err as { code?: string }).code === "ENOENT") return { ok: true, code: "OK", assets: [], warnings };
      return { ok: false, code: "IO_ERROR", assets: [], warnings, error: String(err).slice(0, 200) };
    }
    const assets: WorkflowAsset[] = [];
    for (const f of entries.sort()) {
      if (f.startsWith(".") || f.startsWith(TMP_PREFIX) || !f.endsWith(".json")) continue;
      let raw: string;
      try {
        raw = await readFile(join(this.dirPath, f), "utf-8");
      } catch (err) {
        warnings.push(`${f}: 读取失败 ${String(err).slice(0, 80)}`);
        continue;
      }
      const asset = this.parseAsset(raw);
      if (!asset) {
        warnings.push(`${f}: 结构损坏,已跳过`);
        continue;
      }
 // 文件名与内部 name 不一致 = 有人手工改过文件,提示但不影响读取
      if (`${asset.name}.json` !== f) warnings.push(`${f}: 文件名与内部 name(${asset.name})不一致`);
      assets.push(asset);
    }
    assets.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
    return { ok: true, code: "OK", assets, warnings };
  }

 /** 删除资产:不存在返回 NOT_FOUND(区分「删掉了」与「本来就没有」,避免误报成功)。 */
  async remove(name: string): Promise<RemoveAssetResult> {
    if (typeof name !== "string" || !NAME_RE.test(name)) {
      return { ok: false, code: "INVALID", error: `name 非法: ${String(name)}` };
    }
    try {
      await rm(this.fileOf(name));
      return { ok: true, code: "OK" };
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return { ok: false, code: "NOT_FOUND", error: `资产不存在: ${name}` };
      return { ok: false, code: "IO_ERROR", error: String(err).slice(0, 200) };
    }
  }

 /** 目录画像:数量 / 作用域分布 / 可复用内容体量 / 最近更新时间。 */
  async stats(): Promise<AssetStats> {
    const listed = await this.list();
    const byScope: Record<WorkflowAssetScope, number> = { project: 0, global: 0 };
    let totalBytes = 0;
    let latestUpdatedAt = 0;
    for (const a of listed.assets) {
      byScope[a.scope] += 1;
      totalBytes += Buffer.byteLength(a.script, "utf-8") + Buffer.byteLength(a.paramsSchema, "utf-8");
      latestUpdatedAt = Math.max(latestUpdatedAt, a.updatedAt);
    }
    return {
      ok: listed.ok,
      code: listed.code,
      count: listed.assets.length,
      byScope,
      totalBytes,
      latestUpdatedAt,
      names: listed.assets.map((a) => a.name),
      warnings: listed.warnings,
      ...(listed.error ? { error: listed.error } : {}),
    };
  }
}
