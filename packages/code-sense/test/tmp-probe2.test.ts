import { it } from "vitest";
import { loadIndex } from "../src/callgraph/c2f";
import { buildCodeFlow } from "../src/callgraph/flow";
import { scanProcessEntriesSync } from "../src/sensing/procentries";
import { collectSurfaces, clusterPipelines } from "../src/wiki/surfaces";

it("probe2", async () => {
  for (const root of ["/mnt/e/workship/genie/genie-memory", "/mnt/e/workship/genie/lampgenie-harness"]) {
    const index = loadIndex(root);
    const proc = scanProcessEntriesSync(root, index).entries;
    const pf = buildCodeFlow(index, { level: "file", maxNodes: 0, maxEdges: 0, processEntries: proc });
    const http = await collectSurfaces(root, proc);
    const inS = [
      ...(http.http?.in ?? []),
      ...proc.filter((e) => e.file !== "package.json").map((e) => ({ kind: "process" as const, direction: "in" as const, name: e.file.split("/").pop() || e.file, file: e.file, line: e.line })),
    ];
    const pipes = clusterPipelines(pf, inS, 8);
    console.log(`\n=== ${root.split("/").pop()} nodes=${pf.nodes.length} edges=${pf.edges.length} in=${inS.length} clusters=${pipes.length}`);
    for (const p of pipes) console.log(" -", p.id, "| trig", p.triggers.length, "| reach", p.reach, "|", p.triggers.slice(0, 2).map((t) => t.name).join(","));
  }
}, 180000);
