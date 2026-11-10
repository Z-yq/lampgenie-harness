/**
 * api-semantics 单测(收尾批 I 项):
 * 分片纪律(13 端点→2 请求)、>40 上限截断显式标注、缓存命中(第二次 0 次 LLM 调用)、
 * 无凭证显式 off(不抛错)、writeCache=false 零落盘。全部 mock LLM(注入假 SenseLlm),
 * 真实 LLM 调用不进单测。
 */
import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  annotateApiSemantics,
  endpointFingerprint,
  renderApiSemantics,
  SEMANTICS_BATCH_SIZE,
  SEMANTICS_MAX_ENDPOINTS,
  apiSemanticsCachePath,
  type ApiEndpointForSemantics,
} from "../src/api-semantics.js";
import type { SenseLlm } from "@lampgenie/code-sense/sensing/index";

function tmpRoot(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "gh-apisem-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function eps(n: number): ApiEndpointForSemantics[] {
  return Array.from({ length: n }, (_, i) => ({
    method: i % 2 === 0 ? "GET" : "POST",
    path: `/api/v1/res${i}`,
    handler: `handler${i}`,
    file: `src/routes${Math.floor(i / 5)}.ts`,
    line: 10 + i,
    codeExcerpt: `export async function handler${i}(ctx) { return { ok: true, id: ${i} }; }`,
  }));
}

/** mock LLM:计数请求次数;按批返回合法 JSON(端点 id 从 prompt 里抠出来)。 */
function fakeLlm(onCall?: (prompt: string) => void): { llm: SenseLlm; calls: string[] } {
  const calls: string[] = [];
  const llm: SenseLlm = {
    async generate(prompt: string): Promise<string> {
      calls.push(prompt);
      onCall?.(prompt);
      const ids = [...prompt.matchAll(/\[E(\d+)\]/g)].map((m) => `E${m[1]}`);
      const out: Record<string, string> = {};
      for (const id of ids) out[id] = `「${id}」语义:处理 res 资源的请求`;
      return "```json\n" + JSON.stringify(out) + "\n```";
    },
  };
  return { llm, calls };
}

describe("api-semantics 语义层", () => {
  it("无端点=ok 且 0 次 LLM 调用", async () => {
    const { llm } = fakeLlm();
    const r = await annotateApiSemantics([], { llm });
    expect(r.status).toBe("ok");
    expect(r.llmCalls).toBe(0);
    expect(r.endpoints).toEqual([]);
  });

  it("分片纪律:13 端点 → 2 次 LLM 请求(≤12/请求),语义逐端点回填", async () => {
    const { llm, calls } = fakeLlm();
    const r = await annotateApiSemantics(eps(13), { llm });
    expect(r.llmCalls).toBe(2);
    expect(calls.length).toBe(2);
    expect(r.batches).toBe(2);
    expect(calls[0]!.match(/\[E\d+\]/g)!.length).toBe(SEMANTICS_BATCH_SIZE);
    expect(calls[1]!.match(/\[E\d+\]/g)!.length).toBe(1);
    expect(r.status).toBe("ok");
    expect(r.endpoints.every((e) => typeof e.semantic === "string" && e.semantic.length > 0)).toBe(true);
    expect(r.dropped).toBeUndefined();
  });

  it("上限纪律:45 端点只取前 40 送 LLM,truncated 显式标注,第 41+ 不静默丢", async () => {
    const { llm, calls } = fakeLlm();
    const r = await annotateApiSemantics(eps(45), { llm });
    expect(r.llmCalls).toBe(Math.ceil(40 / SEMANTICS_BATCH_SIZE)); // 40→4 片
    expect(calls.length).toBe(4);
    expect(r.truncated).toEqual({ total: 45, kept: 40 });
    expect(r.endpoints.length).toBe(45); // 全量保留
    const out = r.endpoints.filter((e) => e.truncatedOut);
    expect(out.length).toBe(5);
    expect(out.every((e) => !("semantic" in e))).toBe(true); // 未送 LLM=无语义字段,不伪造
    const keptEp = r.endpoints.filter((e) => !e.truncatedOut);
    expect(keptEp.every((e) => "semantic" in e)).toBe(true);
    expect(renderApiSemantics(r)).toContain("截断");
  });

  it("LLM 输出全坏=failed 显式呈报(dropped 计数),不冒充成功", async () => {
    const bad: SenseLlm = { async generate() { return "抱歉我不明白"; } };
    const r = await annotateApiSemantics(eps(3), { llm: bad });
    expect(r.status).toBe("failed");
    expect(r.llmCalls).toBe(1);
    expect(r.dropped).toBe(3);
    expect(r.reason).toBeTruthy();
  });

  it("无凭证=显式 off(不抛错,0 次 LLM 调用),文案指路确定性清单", async () => {
    const t = tmpRoot();
    try {
      const r = await annotateApiSemantics(eps(3), { root: t.dir, env: {}, configFile: null });
      expect(r.status).toBe("off");
      expect(r.llmCalls).toBe(0);
      expect(r.reason).toContain("未配置 LLM 凭证");
      expect(r.reason).toContain("独立可用");
      // 确定性信息原样保留(降级不丢数据)
      expect(r.endpoints.length).toBe(3);
      expect(r.endpoints[0]!.handler).toBe("handler0");
      const text = renderApiSemantics(r);
      expect(text).toContain("off");
      expect(text).toContain("0 次 LLM 调用");
    } finally {
      t.cleanup();
    }
  });

  it("缓存:writeCache=true 第一次落盘,第二次命中 → 0 次 LLM 调用;缓存文件无凭证", async () => {
    const t = tmpRoot();
    try {
      const first = fakeLlm();
      const r1 = await annotateApiSemantics(eps(5), { root: t.dir, llm: first.llm, writeCache: true });
      expect(r1.status).toBe("ok");
      expect(r1.llmCalls).toBe(1);
      expect(r1.cache?.written).toBe(true);
      const cachePath = apiSemanticsCachePath(t.dir);
      expect(existsSync(cachePath)).toBe(true);
      const raw = readFileSync(cachePath, "utf8");
      expect(raw).not.toMatch(/sk-|apiKey|Bearer/i); // 凭证红线:缓存内容零密钥
      expect(JSON.parse(raw).version).toBe(1);

      // 第二次:换一个计数 mock——命中缓存则一次都不会被调
      const second = fakeLlm();
      const r2 = await annotateApiSemantics(eps(5), { root: t.dir, llm: second.llm });
      expect(r2.status).toBe("cached");
      expect(r2.llmCalls).toBe(0);
      expect(second.calls.length).toBe(0); // fetch 零次证明
      expect(r2.cache?.hit).toBe(true);
      // 缓存命中也回填语义
      expect(r2.endpoints.every((e) => "semantic" in e)).toBe(true);
      expect(renderApiSemantics(r2)).toContain("0 次 LLM 调用");
    } finally {
      t.cleanup();
    }
  });

  it("writeCache=false(默认)不写盘:跑完 sense-index 下零新文件", async () => {
    const t = tmpRoot();
    try {
      const { llm } = fakeLlm();
      const r = await annotateApiSemantics(eps(3), { root: t.dir, llm });
      expect(r.status).toBe("ok");
      expect(r.cache).toBeUndefined();
      expect(existsSync(apiSemanticsCachePath(t.dir))).toBe(false);
      expect(existsSync(join(t.dir, ".genie"))).toBe(false); // 连目录都没建
    } finally {
      t.cleanup();
    }
  });

  it("端点集指纹:路径参数归一且全集参与(第 41 个端点变更也换指纹)", () => {
    const base = eps(45);
    const fp1 = endpointFingerprint(base);
    expect(endpointFingerprint([...base])).toBe(fp1); // 顺序无关
    expect(endpointFingerprint(eps(44))).not.toBe(fp1); // 全集敏感
    const paramA: ApiEndpointForSemantics[] = [{ method: "GET", path: "/users/:id" }];
    const paramB: ApiEndpointForSemantics[] = [{ method: "GET", path: "/users/{uid}" }];
    expect(endpointFingerprint(paramA)).toBe(endpointFingerprint(paramB)); // :id ≡ {id}
  });
});
