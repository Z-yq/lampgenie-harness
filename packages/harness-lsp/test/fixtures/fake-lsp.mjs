// 最小 fake LSP server(单测夹具):Content-Length JSON-RPC。
// 行为:
// - initialize → 声明全量同步 + formatting;
// - didOpen/didChange → publishDiagnostics(含 "BAD" 的行报 FAKE001 error);
// - textDocument/formatting → 全文件替换,删除行尾空白(可预测的格式化);
// - shutdown/exit → 退出。
import { stdin, stdout } from "node:process";

let buffer = Buffer.alloc(0);
const docs = new Map();

function send(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]));
}

function publish(uri, text) {
  const diagnostics = [];
  const lines = String(text ?? "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const idx = lines[i].indexOf("BAD");
    if (idx >= 0) {
      diagnostics.push({
        range: { start: { line: i, character: idx }, end: { line: i, character: idx + 3 } },
        severity: 1,
        code: "FAKE001",
        source: "fake-lsp",
        message: "found BAD token",
      });
    }
  }
  send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics, version: docs.get(uri)?.version } });
}

function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: { capabilities: { textDocumentSync: 1, documentFormattingProvider: true } } });
    return;
  }
  if (method === "initialized") return;
  if (method === "textDocument/didOpen") {
    const doc = params?.textDocument ?? {};
    docs.set(doc.uri, { version: doc.version ?? 1, text: doc.text ?? "" });
    publish(doc.uri, doc.text ?? "");
    return;
  }
  if (method === "textDocument/didChange") {
    const doc = params?.textDocument ?? {};
    const text = params?.contentChanges?.[0]?.text ?? "";
    docs.set(doc.uri, { version: doc.version ?? 1, text });
    publish(doc.uri, text);
    return;
  }
  if (method === "textDocument/formatting") {
    const uri = params?.textDocument?.uri;
    const text = docs.get(uri)?.text ?? "";
    const formatted = text.split("\n").map((l) => l.replace(/[ \t]+$/g, "")).join("\n");
    const lines = text.split("\n");
    send({
      jsonrpc: "2.0",
      id,
      result: [{
        range: {
          start: { line: 0, character: 0 },
          end: { line: lines.length - 1, character: (lines[lines.length - 1] ?? "").length },
        },
        newText: formatted,
      }],
    });
    return;
  }
  if (method === "shutdown") {
    send({ jsonrpc: "2.0", id, result: null });
    return;
  }
  if (method === "exit") {
    process.exit(0);
  }
  if (id !== undefined) send({ jsonrpc: "2.0", id, result: null });
}

stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const sep = buffer.indexOf("\r\n\r\n");
    if (sep < 0) return;
    const header = buffer.toString("ascii", 0, sep);
    const m = /content-length:\s*(\d+)/i.exec(header);
    if (!m) return;
    const length = Number(m[1]);
    const bodyStart = sep + 4;
    if (buffer.length < bodyStart + length) return;
    const body = buffer.toString("utf8", bodyStart, bodyStart + length);
    buffer = buffer.subarray(bodyStart + length);
    try { handle(JSON.parse(body)); } catch { /* ignore */ }
  }
});
