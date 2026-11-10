/**
 * 有界输出环形缓冲:字符游标 + 字节上限。
 * - 游标是字符偏移(UTF-16 code unit),单调递增;缓冲只淘汰头部,不改变既有游标含义。
 * - 读取按游标增量返回;游标早于缓冲头=已被淘汰,返回现有全部并标 truncated。
 * - 淘汰按整 chunk 进行;单 chunk 超限时按尾部字节截断(保留最近的 maxBytes)。
 */

interface Chunk {
  /** chunk 首字符的绝对游标。 */
  start: number;
  text: string;
  bytes: number;
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** 从字符串尾部保留 <= maxBytes 的后缀,返回截断后的文本。 */
function tailByBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let bytes = utf8Bytes(text);
  if (bytes <= maxBytes) return text;
  let index = text.length;
  while (index > 0 && bytes > maxBytes) {
    const code = text.charCodeAt(index - 1);
    bytes -= code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
    index -= 1;
  }
  return text.slice(index);
}

export class RingBuffer {
  private chunks: Chunk[] = [];
  private head = 0; // 缓冲头游标
  private end = 0; // 缓冲尾游标(=总写入字符数)
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  get startCursor(): number {
    return this.head;
  }

  get endCursor(): number {
    return this.end;
  }

  get bufferedBytes(): number {
    return this.bytes;
  }

  append(text: string): void {
    if (text.length === 0) return;
    const chunk: Chunk = { start: this.end, text, bytes: utf8Bytes(text) };
    this.chunks.push(chunk);
    this.end += text.length;
    this.bytes += chunk.bytes;
    this.trim();
  }

  /**
   * 从 cursor 读最多 maxChars 字符。
   * nextCursor=已返回部分末尾的绝对游标(可直接作为下一次 cursor)。
   */
  readFrom(cursor: number, maxChars: number): { text: string; nextCursor: number; truncated: boolean } {
    const truncated = cursor < this.head;
    let effective = Math.max(cursor, this.head);
    if (effective > this.end) effective = this.end;
    const limit = Math.max(1, Math.floor(maxChars));
    let out = "";
    let next = effective;
    for (const chunk of this.chunks) {
      const chunkEnd = chunk.start + chunk.text.length;
      if (chunkEnd <= effective) continue;
      const from = Math.max(0, effective - chunk.start);
      const room = limit - out.length;
      if (room <= 0) break;
      const take = Math.min(chunk.text.length - from, room);
      if (take <= 0) break;
      out += chunk.text.slice(from, from + take);
      next = chunk.start + from + take;
      if (out.length >= limit) break;
    }
    return { text: out, nextCursor: next, truncated };
  }

  clear(): void {
    this.chunks = [];
    this.head = 0;
    this.end = 0;
    this.bytes = 0;
  }

  private trim(): void {
    while (this.bytes > this.maxBytes && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!;
      this.bytes -= dropped.bytes;
      this.head = dropped.start + dropped.text.length;
    }
    if (this.bytes <= this.maxBytes) return;
    const only = this.chunks[0];
    if (!only) return;
    const kept = tailByBytes(only.text, this.maxBytes);
    const droppedChars = only.text.length - kept.length;
    only.start += droppedChars;
    only.text = kept;
    only.bytes = utf8Bytes(kept);
    this.bytes = only.bytes;
    this.head = only.start;
  }
}
