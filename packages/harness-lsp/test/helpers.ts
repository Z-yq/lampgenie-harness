/** 测试辅助:按 LSP 帧格式切分(独立于被测解码器,避免自证)。 */
export function decodeFrames(buf: Buffer): unknown[] {
  const out: unknown[] = [];
  let rest = buf;
  for (;;) {
    const sep = rest.indexOf("\r\n\r\n");
    if (sep < 0) break;
    const header = rest.toString("ascii", 0, sep);
    const m = /content-length:\s*(\d+)/i.exec(header);
    if (!m) break;
    const len = Number(m[1]);
    const start = sep + 4;
    if (rest.length < start + len) break;
    out.push(JSON.parse(rest.toString("utf8", start, start + len)));
    rest = rest.subarray(start + len);
  }
  return out;
}
