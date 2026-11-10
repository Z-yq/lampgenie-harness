/** wire 人类可读渲染:按 union 分组的表 + 孤儿四类 + 已知边界。 */
import type { WireHandler, WireLocation, WireScanResult, WireTypeRow } from "./types.js";

function shortFile(file: string): string {
  if (file.startsWith("apps/gateway/src/")) return file.slice("apps/gateway/src/".length);
  if (file.startsWith("packages/protocol/src/")) return "protocol/" + file.slice("packages/protocol/src/".length);
  return file;
}

function loc(l: WireLocation): string {
  return `${shortFile(l.file)}:${l.line}`;
}

function multi(locs: WireLocation[], max = 2): string {
  if (locs.length === 0) return "-";
  const seen = new Set<string>();
  const uniq: WireLocation[] = [];
  for (const l of locs) {
    const k = `${l.file}:${l.line}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(l);
  }
  const shown = uniq.slice(0, max).map(loc).join(", ");
  return uniq.length > max ? `${shown},+${uniq.length - max}` : shown;
}

function handlerCell(hs: WireHandler[]): string {
  if (hs.length === 0) return "-";
  const h = hs[0]!;
  const at = h.group.length > 1 && h.handlerLine !== h.line
    ? `${loc(h)}→${h.handlerLine}`
    : loc(h);
  return hs.length > 1 ? `${at},+${hs.length - 1}` : at;
}

function pad(s: string, w: number): string {
  if (s.length > w) return s.slice(0, Math.max(0, w - 1)) + "…";
  return s.padEnd(w);
}

function statusLabel(s: WireTypeRow["status"]): string {
  switch (s) {
    case "orphan:no-handler": return "ORPHAN no-handler";
    case "orphan:undeclared": return "ORPHAN undeclared";
    case "hint:never-sent": return "hint never-sent";
    default: return "ok";
  }
}

function unionTable(r: WireScanResult, unionName: string, kind: string, members: number): string {
  const rows = r.types.filter((t) => t.unions.some((u) => u.name === unionName));
  const out: string[] = [];
  const filtered = r.changed?.filtered === true;
  out.push(
    `[${unionName}] ${filtered && rows.length !== members ? `${rows.length}/${members} members(changed 视图)` : `${members} members`} (${kind})`,
  );
  if (rows.length === 0) {
    out.push("  (无命中)");
    return out.join("\n");
  }
  const wType = Math.min(30, Math.max(10, ...rows.map((x) => x.type.length)));
  const wHandler = 26;
  const wSend = 30;
  const wRecv = 26;
  out.push(
    "  " + pad("TYPE", wType) + "  " + pad("HANDLER", wHandler) + "  " +
    pad("SEND", wSend) + "  " + pad("RECV", wRecv) + "  STATUS",
  );
  for (const t of rows) {
    out.push(
      "  " + pad(t.type, wType) + "  " + pad(handlerCell(t.handlers), wHandler) + "  " +
      pad(multi(t.sends), wSend) + "  " + pad(multi(t.receives), wRecv) + "  " + statusLabel(t.status),
    );
  }
  return out.join("\n");
}

export function renderWire(r: WireScanResult): string {
  const c = r.changed;
  const lines: string[] = [];
  lines.push("codesense wire — WS 消息协议表面");
  lines.push(`  root: ${r.root}`);
  lines.push(
    `  协议: ${r.protocolFiles.join(", ") || "(缺席)"} — ${r.stats.unions} union / ` +
    `${r.stats.memberships} memberships / ${r.stats.uniqueTypes} unique types`,
  );
  lines.push(`  对账: handler ${r.stats.handlers} | 发送点 ${r.stats.sends} | 接收点 ${r.stats.receives}`);
  lines.push(
    `  孤儿: A ${r.stats.orphanDeclaredNoHandler} / B ${r.stats.orphanHandlerUndeclared} / ` +
    `C ${r.stats.orphanSendUndeclared} / D ${r.stats.orphanDeclaredNeverSent}` +
    (r.stats.orphanReceiveUndeclared > 0 ? ` / 补充:接收未声明 ${r.stats.orphanReceiveUndeclared}` : ""),
  );
  if (c) {
    lines.push(
      `  changed: ${c.files.length} 文件 / ${c.types.length} type` +
      (c.filtered
        ? `(新增 ${c.added.length} / 删除 ${c.removed.length} / 改动 ${c.touched.length};git diff + 未跟踪,仅列命中)`
        : "(git 不可用:全量展示)"),
    );
    const catLine = (label: string, list: string[]): void => {
      if (list.length === 0) return;
      const cap = 20;
      const shown = list.slice(0, cap).join(", ");
      lines.push(`    ${label}: ${shown}${list.length > cap ? ` …还有 ${list.length - cap} 条(见 --json)` : ""}`);
    };
    if (c.filtered) {
      catLine("新增", c.added);
      catLine("删除", c.removed);
      catLine("改动", c.touched);
    }
    if (c.note) lines.push(`  (${c.note})`);
  }
  lines.push("");

  if (r.unions.length === 0) {
    lines.push("(协议 union 未解析到——见已知边界)");
  } else {
    for (const u of r.unions) {
      lines.push(unionTable(r, u.name, u.kind, u.members.length));
      lines.push("");
    }
  }

  lines.push("孤儿");
  const orphanBlock = (
    label: string,
    items: { type: string; file: string; line: number; extra?: string }[],
  ): void => {
    lines.push(`  ${label} (${items.length})`);
    const cap = 40;
    for (const it of items.slice(0, cap)) {
      const extra = it.extra ? `  ${it.extra}` : "";
      lines.push(`    ${pad(it.type, 28)} ${shortFile(it.file)}:${it.line}${extra}`);
    }
    if (items.length > cap) lines.push(`    …还有 ${items.length - cap} 条(见 --json)`);
  };
  orphanBlock("A. ClientMessage 声明但 server.ts 无 handler", r.orphans.declaredNoHandler);
  orphanBlock(
    "B. server.ts handler 但协议未声明",
    r.orphans.handlerUndeclared.map((h) => ({ type: h.type, file: h.file, line: h.line, extra: `handler@${h.handlerLine}` })),
  );
  orphanBlock(
    "C. 客户端发送但协议未声明",
    r.orphans.sendUndeclared.map((s) => ({ type: s.type, file: s.file, line: s.line, extra: s.call })),
  );
  orphanBlock("D. 协议声明但客户端从不发送(提示级,不算错)", r.orphans.declaredNeverSent);
  if (r.orphans.receiveUndeclared.length > 0) {
    orphanBlock(
      "补充. 客户端接收但协议未声明(提示级;服务端已发出)",
      r.orphans.receiveUndeclared.map((x) => ({ type: x.type, file: x.file, line: x.line, extra: x.form })),
    );
  }
  lines.push("");

  if (r.unresolved.length > 0) {
    lines.push("未解析 union 成员");
    for (const u of r.unresolved.slice(0, 10)) {
      lines.push(`  [${u.union}] ${shortFile(r.protocolFiles[0] ?? "packages/protocol/src/index.ts")}:${u.line} ${u.text}`);
    }
    if (r.unresolved.length > 10) lines.push(`  …还有 ${r.unresolved.length - 10} 条(见 --json)`);
    lines.push("");
  }

  lines.push("已知边界");
  for (const l of r.knownLimits) lines.push(`  - ${l}`);
  return lines.join("\n");
}
