/**
 * LSP base protocol framing: Content-Length 分隔的 JSON-RPC(参照
 * deepseek-harness/packages/lsp/lsp-stdio/src/framing.ts 的实现语义)。
 * 头/体上限双封口,坏 server 不能靠不闭合的头把内存吃穿。
 */

const HEADER_SEPARATOR = "\r\n\r\n";
const MAX_HEADER_BYTES = 1 << 16;

/** 编码一条 JSON-RPC 消息为 LSP 帧。 */
export function encodeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

/** 流式解码器:喂 stdout chunk,吐出完整 JSON body。 */
export class MessageDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  constructor(private readonly maxMessageBytes: number) {}

  push(chunk: Buffer): unknown[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const messages: unknown[] = [];
    for (;;) {
      const step = this.next();
      if (!step.ready) break;
      messages.push(step.message);
    }
    return messages;
  }

  private next(): { ready: false } | { ready: true; message: unknown } {
    const sep = this.buffer.indexOf(HEADER_SEPARATOR);
    if (sep < 0) {
      if (this.buffer.length > MAX_HEADER_BYTES) throw new Error(`LSP header exceeded ${MAX_HEADER_BYTES} bytes`);
      return { ready: false };
    }
    if (sep > MAX_HEADER_BYTES) throw new Error(`LSP header exceeded ${MAX_HEADER_BYTES} bytes`);
    const contentLength = parseContentLength(this.buffer.toString("ascii", 0, sep));
    if (contentLength > this.maxMessageBytes) {
      throw new Error(`LSP message length ${contentLength} exceeds ${this.maxMessageBytes} bytes`);
    }
    const bodyStart = sep + HEADER_SEPARATOR.length;
    const bodyEnd = bodyStart + contentLength;
    if (this.buffer.length < bodyEnd) return { ready: false };
    const body = this.buffer.toString("utf8", bodyStart, bodyEnd);
    this.buffer = this.buffer.subarray(bodyEnd);
    try {
      return { ready: true, message: JSON.parse(body) };
    } catch (err) {
      throw new Error(`LSP message body was not valid JSON: ${String(err)}`);
    }
  }
}

function parseContentLength(headerText: string): number {
  for (const line of headerText.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    if (line.slice(0, colon).trim().toLowerCase() !== "content-length") continue;
    const value = Number(line.slice(colon + 1).trim());
    if (!Number.isInteger(value) || value < 0) throw new Error(`invalid Content-Length header: ${JSON.stringify(line)}`);
    return value;
  }
  throw new Error(`LSP header block missing Content-Length: ${JSON.stringify(headerText)}`);
}
