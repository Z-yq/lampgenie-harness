import { describe, expect, it } from "vitest";
import { RingBuffer } from "../src/ring-buffer.js";

describe("RingBuffer", () => {
  it("增量读取游标:读一段后游标前进,再读只拿新增", () => {
    const buf = new RingBuffer(1024);
    buf.append("one\n");
    const first = buf.readFrom(0, 100);
    expect(first.text).toBe("one\n");
    expect(first.nextCursor).toBe(4);
    buf.append("two\n");
    const second = buf.readFrom(first.nextCursor, 100);
    expect(second.text).toBe("two\n");
    expect(second.nextCursor).toBe(8);
    expect(buf.endCursor).toBe(8);
  });

  it("超过字节上限淘汰头部,旧游标读=truncated", () => {
    const buf = new RingBuffer(4);
    buf.append("abcdef");
    expect(buf.bufferedBytes).toBeLessThanOrEqual(4);
    const read = buf.readFrom(0, 100);
    expect(read.truncated).toBe(true);
    expect(read.text).toBe("ef");
    expect(buf.startCursor).toBe(4);
  });

  it("maxChars 截断时 nextCursor 指向已返回部分末尾,下次继续", () => {
    const buf = new RingBuffer(1024);
    buf.append("abcdef");
    const first = buf.readFrom(0, 3);
    expect(first.text).toBe("abc");
    expect(first.nextCursor).toBe(3);
    const second = buf.readFrom(first.nextCursor, 100);
    expect(second.text).toBe("def");
  });

  it("多字节字符按 UTF-8 字节淘汰不产生半截", () => {
    const buf = new RingBuffer(3); // 一个中文字=3 字节
    buf.append("中文");
    const read = buf.readFrom(0, 100);
    expect(read.truncated).toBe(true);
    expect(read.text).toBe("文");
  });

  it("游标晚于末尾=空输出", () => {
    const buf = new RingBuffer(1024);
    buf.append("x");
    const read = buf.readFrom(99, 10);
    expect(read.text).toBe("");
    expect(read.nextCursor).toBe(1);
  });
});
