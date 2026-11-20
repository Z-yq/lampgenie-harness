/**
 * 工具调用参数的历史定形(编辑型任务的增量治理)。
 * 问题:`edit_file` / `write_file` 的 `new_string`/`content` 是**模型输出**,下一步随 assistant
 * toolCalls 回放进请求,成为未命中增量。单步 14 个 edit_file 经验证让下一步 input +13k tok(13%),
 * 而旧的 big-intake/spill 只处理**工具结果**,不处理模型输出 → 1.5% 预算管不到这条。
 * 本模块在 **message.agent 落 journal 之前**定形 toolCalls(只改**历史回放副本**):
 * - 执行仍用原始参数(loop 用 res.toolCalls 原对象);
 * - journal 的 message.agent 存定形后的参数;deriveMessages 后续回放定形版,前缀逐字稳定;
 * - 原始参数落盘 + 在参数里挂 `_shaped` 元数据(字段/原长/策略/dump 路径),模型可据此回读。
 * 定形策略(按字段):
 * 1. 命中 big-intake 闸(≥minTokens 且 >字段份额)→ 复用 chunk-select / 小模型 digest;
 * 2. 未命中/无 bigIntake → 确定性 head + 标记 + tail(有 spill/big-intake dump 根则落盘全文)。
 * 只定形**写类大字段**(edit_file/write_file/apply_patch 等),不碰 path/command 等控制字段;
 * 输出仍是合法 JSON,provider 的 tool_use 历史可直接回放。任何异常 fail-open 返回原参数。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { intakeToolResult, type BigIntakeConfig } from "./big-intake.js";
import { rawTokens } from "./token-estimate.js";

export interface ShapableToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ShapeRecord {
  tool: string;
  callId: string;
  field: string;
  originalChars: number;
  shapedChars: number;
  policy: "intake" | "head-tail" | "head-tail-dump";
  dump?: string;
}

export interface ShapeToolCallOptions {
 /** 单调用可用预算(tokens;通常=本步预算/调用数)。 */
  budgetTokens: number;
 /** big-intake 配置(复用其 chunk-select/digest;缺省走确定性 head/tail)。 */
  bigIntake?: BigIntakeConfig;
 /** 原始参数落盘根(通常 spill.dir / bigIntake.dumpDir);缺省不落盘,只留标记。 */
  dumpDir?: string;
 /** 当前任务目标(big-intake 选块相关性)。 */
  goal: string;
  sessionId: string;
  turn: number;
  step: number;
}

/** 参与定形的字段:写类大文本;控制/选择字段(path/command/replace_all/old_string)不动。
 * old_string 是后续 edit 的匹配锚,压掉会让下一次编辑「找不到原文」而反复重试——不碰。 */
const SHAPE_FIELDS = new Set(["new_string", "content", "patch"]);
/** 单字段最小处理阈值(字符):太小定形反而损失语义。 */
const MIN_FIELD_CHARS = 1_000;
/** 确定性 head/tail 的最小保留量(字符);多调用步按份额压缩时不强行放大。 */
const MIN_HEAD = 128;
const MIN_TAIL = 32;

function safeSegment(raw: unknown, max = 80): string {
  const s = String(raw ?? "").replace(/[^A-Za-z0-9._-]/g, "_");
  return s.length > max ? s.slice(0, max) : s || "x";
}

function clipMarker(originalChars: number, keptHead: number, keptTail: number, dump?: string, policy = "head-tail"): string {
  const where = dump ? `全文已落盘 ${dump}` : "全文未落盘(需要时请重新 read_file)";
  return `\n…[参数已定形:原 ${originalChars} 字符,保留头 ${keptHead} + 尾 ${keptTail}(${policy});${where};执行使用原始参数]…\n`;
}

/** 确定性 head+marker+tail(总长约 0.8×字段预算字符)。 */
function headTail(value: string, budgetChars: number, dump?: string, policy = "head-tail"): string {
  const usable = Math.max(320, budgetChars);
  const markerProbe = clipMarker(value.length, 0, 0, dump, policy).length;
  const head = Math.min(Math.max(MIN_HEAD, Math.floor(usable * 0.6)), Math.max(0, usable - markerProbe - MIN_TAIL));
  const tail = Math.min(Math.max(MIN_TAIL, Math.floor(usable * 0.2)), Math.max(0, usable - markerProbe - head));
  const marker = clipMarker(value.length, head, tail, dump, policy);
  return value.slice(0, head) + marker + (tail > 0 ? value.slice(-tail) : "");
}

async function dumpOriginal(opts: ShapeToolCallOptions, call: ShapableToolCall, field: string, value: string): Promise<string | undefined> {
  if (!opts.dumpDir) return undefined;
  try {
    const dir = resolve(join(opts.dumpDir, "toolcall-args", safeSegment(opts.sessionId)));
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${safeSegment(call.id)}-${safeSegment(field)}.txt`);
    await writeFile(file, value, "utf8");
    return file;
  } catch {
    return undefined; // fail-open:落盘失败仍可只留 head/tail
  }
}

/**
 * 定形一批 toolCall 的**历史副本**。返回新数组(原数组/原参数对象不修改);
 * 未触发定形时返回原引用(调用方零成本判断)。任何异常 fail-open 返回原引用。
 */
export async function shapeToolCallsForHistory(
  calls: readonly ShapableToolCall[],
  opts: ShapeToolCallOptions,
): Promise<{ calls: ShapableToolCall[]; records: ShapeRecord[] }> {
  if (!Array.isArray(calls) || calls.length === 0) return { calls: calls as ShapableToolCall[], records: [] };
  const shareTokens = Math.max(1, Math.floor(opts.budgetTokens));
  const shareChars = Math.max(256, Math.floor(shareTokens / 0.25));
  const records: ShapeRecord[] = [];
  let changed = false;
  const out: ShapableToolCall[] = [];
  for (const call of calls) {
    let parsed: Record<string, unknown> | undefined;
    try {
      const p = JSON.parse(call.arguments || "{}") as unknown;
      if (p && typeof p === "object" && !Array.isArray(p)) parsed = p as Record<string, unknown>;
    } catch { /* 非法 JSON:保持原样(执行面本来也会失败) */ }
    if (!parsed) { out.push(call); continue; }
 // 只有整条参数超过本调用份额才定形——单个 1~2k 字符的小 edit 不该被无谓压缩。
    if (call.arguments.length <= shareChars) { out.push(call); continue; }
    const fields = Object.keys(parsed).filter((k) => SHAPE_FIELDS.has(k) && typeof parsed![k] === "string" && (parsed![k] as string).length > MIN_FIELD_CHARS);
    if (fields.length === 0) { out.push(call); continue; }
 // 字段间均分本调用份额;多字段调用也按份额压,不强行放大(否则 14 个 edit 的合计又会超 1.5%)。
    const perFieldChars = Math.max(256, Math.floor(shareChars / fields.length));
    const shapedObj: Record<string, unknown> = { ...parsed };
    const shapedMeta: Array<Record<string, unknown>> = [];
    let touched = false;
    for (const field of fields) {
      const original = parsed[field] as string;
      let replacement: string | undefined;
      let policy: ShapeRecord["policy"] = "head-tail";
      let dump: string | undefined;
 // ① 先试 big-intake(chunk-select/摘要);② 失败/未命中再确定性 head/tail。
      if (opts.bigIntake) {
        try {
          const outcome = await intakeToolResult({
            content: original,
            callId: `${call.id}-${field}`,
            toolName: `${call.name}.${field}`,
            goal: opts.goal,
            budgetTokens: Math.max(1, Math.floor(perFieldChars * 0.25)),
            config: opts.bigIntake,
          });
          if (outcome && typeof outcome.content === "string" && outcome.content.length > 0 && outcome.content.length < original.length) {
            replacement = outcome.content;
            policy = "intake";
            dump = outcome.meta.dumpPath;
 // intake 产物按绝对上限(如 6000 字符)封顶,不一定符合本调用的小份额;超了再头尾定形。
            if (replacement.length > Math.max(512, perFieldChars)) {
              replacement = headTail(replacement, perFieldChars, dump, dump ? "head-tail-dump" : "head-tail");
              policy = dump ? "head-tail-dump" : "head-tail";
            }
          }
        } catch { /* 下沉确定性路径 */ }
      }
      if (replacement === undefined) {
        dump = await dumpOriginal(opts, call, field, original);
        replacement = headTail(original, perFieldChars, dump, dump ? "head-tail-dump" : "head-tail");
        policy = dump ? "head-tail-dump" : "head-tail";
      }
      shapedObj[field] = replacement;
      shapedMeta.push({ field, originalChars: original.length, shapedChars: replacement.length, policy, ...(dump ? { dump } : {}) });
      records.push({ tool: call.name, callId: call.id, field, originalChars: original.length, shapedChars: replacement.length, policy, ...(dump ? { dump } : {}) });
      touched = true;
    }
    if (!touched) { out.push(call); continue; }
    shapedObj._shaped = { reason: "tool-args-over-budget", turn: opts.turn, step: opts.step, fields: shapedMeta, note: "原始参数已用于执行;历史回放为定形版,需要全文按 dump/read_file 回读" };
    changed = true;
    out.push({ ...call, arguments: JSON.stringify(shapedObj) });
  }
  return changed ? { calls: out, records } : { calls: calls as ShapableToolCall[], records: [] };
}