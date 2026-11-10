/**
 * 改进提案持久层:建提案(判重合并)/取/列/流转/发版/发版核对/取代/导出/报表/坏行容忍/只增不改。
 * 全部用例只写 os.tmpdir() 下的临时目录,绝不碰仓库 .genie。
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  changeRequestsPath,
  createRequest,
  exportMarkdown,
  getRequest,
  listRequests,
  loadChangeRequests,
  proposalsDir,
  reportRequests,
  ship,
  supersede,
  transition,
  verify,
} from "../src/change-request-store";

const tempDirs: string[] = [];

async function tmpRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "genie-change-request-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

const T0 = 1_700_000_000_000;
const DAY = 86_400_000;
const MODULE = "apps/gateway/src/change-request-store.ts";

/** 一条合法的 bug 提案输入(带证据 + 复现)。 */
function bugInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Export drops the last row",
    kind: "bug",
    target: { module: MODULE, symbol: "exportMarkdown" },
    evidenceRefs: ["ev-1"],
    reproSteps: ["run exportMarkdown with 3 rows"],
    expectedBehavior: "all rows are exported",
    observedBehavior: "the last row is missing",
    impact: { files: ["apps/gateway/src/change-request-store.ts"] },
    ...overrides,
  };
}

/** 建一条并返回 id(失败即抛,证明前置合法)。 */
async function seedBug(overrides: Record<string, unknown> = {}, at = T0): Promise<{ root: string; id: string }> {
  const root = await tmpRoot();
  const res = createRequest(root, bugInput(overrides), { at });
  if (!res.ok || typeof res.id !== "string") throw new Error(`createRequest failed: ${res.code}`);
  return { root, id: res.id };
}

async function lineCount(root: string): Promise<number> {
  try {
    const text = await readFile(changeRequestsPath(root), "utf8");
    return text.split("\n").filter((line) => line.trim() !== "").length;
  } catch {
    return 0;
  }
}

describe("createRequest", () => {
  it("新建成功 → CREATED,落一行 create,状态 proposed", async () => {
    const root = await tmpRoot();
    const res = createRequest(root, bugInput(), { at: T0 });
    expect(res.ok).toBe(true);
    expect(res.code).toBe("CHANGE_REQ_CREATED");
    expect(res.merged).toBe(false);
    expect(res.request!.status).toBe("proposed");
    expect(res.id).toBe(res.request!.id);
    expect(await lineCount(root)).toBe(1);
    const line = JSON.parse((await readFile(changeRequestsPath(root), "utf8")).trim());
    expect(line.v).toBe(1);
    expect(line.type).toBe("create");
    expect(line.at).toBe(T0);
    expect(line.id).toBe(res.id);
  });

  it("非法输入 → CHANGE_REQ_INVALID 且不写盘", async () => {
    const root = await tmpRoot();
    const res = createRequest(root, bugInput({ title: "" }), { at: T0 });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("CHANGE_REQ_INVALID");
    expect(await lineCount(root)).toBe(0);
  });

  it("同 dedupeKey 再建 → MERGED,证据合并,台账只剩 1 条", async () => {
    const root = await tmpRoot();
    const first = createRequest(root, bugInput(), { at: T0 });
    const second = createRequest(
      root,
      bugInput({ evidenceRefs: ["ev-1", "ev-2"], reproSteps: ["run exportMarkdown with 3 rows", "check count"] }),
      { at: T0 + 1000 },
    );
    expect(second.ok).toBe(true);
    expect(second.code).toBe("CHANGE_REQ_MERGED");
    expect(second.merged).toBe(true);
    expect(second.id).toBe(first.id);
    expect(second.request!.evidenceRefs).toEqual(["ev-1", "ev-2"]);
    const list = listRequests(root);
    expect(list.requests.length).toBe(1);
    expect(await lineCount(root)).toBe(2);
    const types = (await readFile(changeRequestsPath(root), "utf8"))
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => (JSON.parse(line) as { type: string }).type);
    expect(types).toEqual(["create", "merge"]);
  });

  it("已 superseded 的旧条目不再吞掉新提案", async () => {
    const { root, id } = await seedBug();
    expect(supersede(root, id, { byId: "cr-next", at: T0 + 500 }).ok).toBe(true);
    const again = createRequest(root, bugInput(), { at: T0 + 1000 });
    expect(again.merged).toBe(false);
    expect(again.code).toBe("CHANGE_REQ_CREATED");
    const list = listRequests(root);
    expect(list.requests.length).toBe(1);
    expect(list.requests[0]!.status).toBe("proposed");
  });
});

describe("getRequest / listRequests", () => {
  it("取到 / 取不到", async () => {
    const { root, id } = await seedBug();
    const hit = getRequest(root, id);
    expect(hit.ok).toBe(true);
    expect(hit.request!.id).toBe(id);
    const miss = getRequest(root, "cr-missing");
    expect(miss.ok).toBe(false);
    expect(miss.code).toBe("CHANGE_REQ_NOT_FOUND");
  });

  it("空目录列出空表且 parseErrors=0", async () => {
    const root = await tmpRoot();
    const list = listRequests(root);
    expect(list.ok).toBe(true);
    expect(list.requests).toEqual([]);
    expect(list.parseErrors).toBe(0);
  });

  it("按 status 过滤", async () => {
    const root = await tmpRoot();
    const a = createRequest(root, bugInput(), { at: T0 });
    const b = createRequest(
      root,
      bugInput({
        title: "Retry storm in queue",
        target: { module: "apps/other.ts", symbol: "queue" },
        expectedBehavior: "retries back off",
        observedBehavior: "queue melts",
        evidenceRefs: ["ev-9"],
      }),
      { at: T0 + 10 },
    );
    expect(a.ok && b.ok).toBe(true);
    expect(listRequests(root).requests.length).toBe(2);
    expect(listRequests(root, { status: "accepted" }).requests).toEqual([]);
    transition(root, a.id!, "accepted", { by: "lead", at: T0 + 100 });
    const accepted = listRequests(root, { status: "accepted" });
    expect(accepted.requests.length).toBe(1);
    expect(accepted.requests[0]!.id).toBe(a.id);
  });
});

describe("transition / ship / verify / supersede", () => {
  it("accepted → scheduled 成功并落 transition 行(带 by/note)", async () => {
    const { root, id } = await seedBug();
    const res = transition(root, id, "accepted", { by: "lead", note: "排期", at: T0 + 100 });
    expect(res.ok).toBe(true);
    expect(res.request!.status).toBe("accepted");
    expect(res.request!.lastTransition).toEqual({ to: "accepted", by: "lead", note: "排期", at: T0 + 100 });
    const line = (await readFile(changeRequestsPath(root), "utf8")).trim().split("\n")[1]!;
    const parsed = JSON.parse(line) as { type: string; payload: Record<string, unknown> };
    expect(parsed.type).toBe("transition");
    expect(parsed.payload["to"]).toBe("accepted");
    expect(parsed.payload["by"]).toBe("lead");
    expect(getRequest(root, id).request!.status).toBe("accepted");
    const scheduled = transition(root, id, "scheduled", { at: T0 + 200 });
    expect(scheduled.request!.status).toBe("scheduled");
  });

  it("非法流转 → TRANSITION_INVALID 且不写盘", async () => {
    const { root, id } = await seedBug();
    const res = transition(root, id, "shipped", { at: T0 + 100 });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("CHANGE_REQ_TRANSITION_INVALID");
    expect(await lineCount(root)).toBe(1);
    expect(getRequest(root, id).request!.status).toBe("proposed");
  });

  it("同状态 → STATUS_UNCHANGED 且不写盘", async () => {
    const { root, id } = await seedBug();
    const res = transition(root, id, "proposed", { at: T0 + 100 });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("CHANGE_REQ_STATUS_UNCHANGED");
    expect(await lineCount(root)).toBe(1);
  });

  it("不存在的 id → NOT_FOUND", async () => {
    const root = await tmpRoot();
    expect(transition(root, "cr-nope", "accepted").code).toBe("CHANGE_REQ_NOT_FOUND");
    expect(ship(root, "cr-nope", { version: "1.0.0" }).code).toBe("CHANGE_REQ_NOT_FOUND");
    expect(verify(root, "cr-nope", { observed: false }).code).toBe("CHANGE_REQ_NOT_FOUND");
    expect(supersede(root, "cr-nope", { byId: "x" }).code).toBe("CHANGE_REQ_NOT_FOUND");
  });

  it("ship → verify(true) 回到 accepted;再 ship → verify(false) 保持 shipped", async () => {
    const { root, id } = await seedBug();
    transition(root, id, "accepted", { at: T0 + 100 });
    const shipped = ship(root, id, { version: "0.9.0", at: T0 + 200 });
    expect(shipped.ok).toBe(true);
    expect(shipped.request!.status).toBe("shipped");
    expect(shipped.request!.release).toEqual({ version: "0.9.0", at: T0 + 200 });

    const stillObserved = verify(root, id, { observed: true, note: "还在丢", at: T0 + 300 });
    expect(stillObserved.code).toBe("CHANGE_REQ_STILL_OBSERVED");
    expect(stillObserved.request!.status).toBe("accepted");
    expect(getRequest(root, id).request!.status).toBe("accepted");

    ship(root, id, { version: "0.9.1", at: T0 + 400 });
    const verified = verify(root, id, { observed: false, at: T0 + 500 });
    expect(verified.code).toBe("CHANGE_REQ_VERIFIED");
    expect(verified.request!.status).toBe("shipped");
    expect(getRequest(root, id).request!.verification).toEqual({ checkedAt: T0 + 500, stillObserved: false });
  });

  it("proposed 状态不可 ship(TRANSITION_INVALID)", async () => {
    const { root, id } = await seedBug();
    const res = ship(root, id, { version: "0.9.0", at: T0 + 100 });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("CHANGE_REQ_TRANSITION_INVALID");
    expect(await lineCount(root)).toBe(1);
  });

  it("supersede 写 supersededBy 并落 supersede 行", async () => {
    const { root, id } = await seedBug();
    const res = supersede(root, id, { byId: "cr-next", at: T0 + 100 });
    expect(res.ok).toBe(true);
    expect(res.code).toBe("CHANGE_REQ_SUPERSEDED");
    expect(res.request!.status).toBe("superseded");
    expect(res.request!.supersededBy).toBe("cr-next");
    const parsed = JSON.parse((await readFile(changeRequestsPath(root), "utf8")).trim().split("\n")[1]!) as {
      type: string;
      payload: Record<string, unknown>;
    };
    expect(parsed.type).toBe("supersede");
    expect(parsed.payload["byId"]).toBe("cr-next");
  });
});

describe("exportMarkdown / reportRequests", () => {
  it("导出写入 <root>/.genie/rsi/proposals/<id>.md", async () => {
    const { root, id } = await seedBug();
    const res = exportMarkdown(root, id);
    expect(res.ok).toBe(true);
    expect(res.path).toBe(join(proposalsDir(root), `${id}.md`));
    const md = await readFile(res.path!, "utf8");
    expect(md.startsWith("# Export drops the last row")).toBe(true);
    expect(md).toContain("## 证据链");
    expect(md).toContain("- ev-1");
    expect(exportMarkdown(root, "cr-missing").code).toBe("CHANGE_REQ_NOT_FOUND");
  });

  it("报表统计 byStatus/byKind 与 7 天积压", async () => {
    const root = await tmpRoot();
    const aged = createRequest(root, bugInput(), { at: T0 });
    const fresh = createRequest(
      root,
      bugInput({
        title: "Retry storm in queue",
        target: { module: "apps/other.ts", symbol: "queue" },
        expectedBehavior: "retries back off",
        observedBehavior: "queue melts",
        evidenceRefs: ["ev-9"],
      }),
      { at: T0 + 20 * DAY },
    );
    transition(root, fresh.id!, "accepted", { at: T0 + 20 * DAY + 10 });
    const report = reportRequests(root, { at: T0 + 20 * DAY + DAY });
    expect(report.total).toBe(2);
    expect(report.byStatus).toEqual({ proposed: 1, accepted: 1 });
    expect(report.byKind).toEqual({ bug: 2 });
    expect(report.openAged).toEqual({ olderThanDays: 7, count: 1, ids: [aged.id!] });
    expect(report.parseErrors).toBe(0);
    expect(report.totalLines).toBe(3);
  });
});

describe("坏行容忍与只增不改", () => {
  it("坏行(JSON 坏 / v≠1 / type 未知 / 既缺 request 又缺 id)计入 parseErrors 不整文件失效", async () => {
    const root = await tmpRoot();
    const good = createRequest(root, bugInput(), { at: T0 });
    const path = changeRequestsPath(root);
    const lines = [
      "{not json",
      JSON.stringify({ v: 2, type: "create", at: T0, request: { id: "cr-v2" } }),
      JSON.stringify({ v: 1, type: "explode", at: T0, request: { id: "cr-unknown" } }),
      JSON.stringify({ v: 1, type: "transition", at: T0 }),
      JSON.stringify({ v: 1, type: "transition", at: T0, id: good.id }),
    ];
    await mkdir(dirname(path), { recursive: true });
    const existing = await readFile(path, "utf8");
    await writeFile(path, `${existing}${lines.join("\n")}\n`, { encoding: "utf8" });
    const projection = loadChangeRequests(root);
    expect(projection.parseErrors).toBe(4);
    expect(projection.totalLines).toBe(6);
    expect(projection.entries.size).toBe(1);
    expect(projection.entries.get(good.id!)!.status).toBe("proposed");
    const list = listRequests(root);
    expect(list.parseErrors).toBe(4);
    expect(list.requests.length).toBe(1);
  });

  it("多次流转只增不改:latest-wins 且行数=操作数+1", async () => {
    const { root, id } = await seedBug();
    transition(root, id, "accepted", { at: T0 + 100 });
    transition(root, id, "scheduled", { at: T0 + 200 });
    ship(root, id, { version: "0.9.0", at: T0 + 300 });
    verify(root, id, { observed: false, at: T0 + 400 });
    expect(await lineCount(root)).toBe(5);
    const final = getRequest(root, id).request!;
    expect(final.status).toBe("shipped");
    expect(final.release!.version).toBe("0.9.0");
    const projection = loadChangeRequests(root);
    expect(projection.totalLines).toBe(5);
    expect(projection.parseErrors).toBe(0);
    expect(projection.entries.size).toBe(1);
  });
});
