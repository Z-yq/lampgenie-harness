import { describe, it, expect } from "vitest";
import {
  applyMediaBudget,
  estimateDataUrlBytes,
  mediaBudgetNote,
  MEDIA_BUDGET_CODES,
  MEDIA_BUDGET_DEFAULT_BYTES,
  MEDIA_BUDGET_DEFAULT_PROTECT_RECENT,
  projectVisionCapability,
  VISION_PROJECTION_CODES,
  type MediaBudgetAccounting,
  type MediaMessageLike,
} from "../src/agent/media-budget";

/**
 * 请求级媒体预算:纯逻辑零 IO,夹具全部用短 base64 重复构造(不写真实图片/大段 base64)。
 * 图片夹具 img(bytes, ch):base64 载荷每 4 字符解码 3 字节,故 bytes 必须是 3 的倍数。
 */

function img(bytes: number, ch = "A"): string {
  if (bytes % 3 !== 0) throw new Error("夹具字节数必须是 3 的倍数");
  return "data:image/png;base64," + ch.repeat((bytes / 3) * 4);
}

/** 深拷贝(不可变断言用;夹具全为纯 JSON 结构)。 */
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function user(content: string, images?: string[]): MediaMessageLike {
  return { role: "user", content, ...(images ? { images } : {}) };
}

function tool(content: string, id = "c1"): MediaMessageLike {
  return { role: "tool", toolCallId: id, content };
}

describe("estimateDataUrlBytes", () => {
  it("base64 无 padding:4 字符 = 3 字节", () => {
    expect(estimateDataUrlBytes("data:image/png;base64,AAAA")).toBe(3);
  });

  it("base64 一个 padding:AAA= = 2 字节", () => {
    expect(estimateDataUrlBytes("data:image/png;base64,AAA=")).toBe(2);
  });

  it("base64 两个 padding:AA== = 1 字节", () => {
    expect(estimateDataUrlBytes("data:image/png;base64,AA==")).toBe(1);
  });

  it("MIME/协议大小写不敏感,载荷空白剔除", () => {
    expect(estimateDataUrlBytes("DATA:IMAGE/PNG;BASE64,AA\nA=")).toBe(2);
  });

  it("空 base64 载荷 = 0 字节", () => {
    expect(estimateDataUrlBytes("data:image/png;base64,")).toBe(0);
  });

  it("http(s) 地址 = 未知(-1)", () => {
    expect(estimateDataUrlBytes("https://cdn.example.com/a.png")).toBe(-1);
    expect(estimateDataUrlBytes("http://cdn.example.com/a.png")).toBe(-1);
  });

  it("非字符串 / 空串 / 非 base64 data URL = 未知(-1)", () => {
    expect(estimateDataUrlBytes(undefined)).toBe(-1);
    expect(estimateDataUrlBytes(42)).toBe(-1);
    expect(estimateDataUrlBytes("")).toBe(-1);
    expect(estimateDataUrlBytes("data:image/svg+xml,<svg/>")).toBe(-1);
  });

  it("夹具字节数与声明一致", () => {
    expect(estimateDataUrlBytes(img(300))).toBe(300);
  });
});

describe("applyMediaBudget 基线", () => {
  it("空 messages:OK + 全零账目", () => {
    const r = applyMediaBudget([]);
    expect(r.code).toBe(MEDIA_BUDGET_CODES.OK);
    expect(r.messages).toEqual([]);
    expect(r.accounting).toEqual({ totalBytes: 0, keptImages: 0, omittedImages: 0, omittedBytes: 0, unknownImages: 0, protectedKept: 0 });
  });

  it("无 images 的消息:原样返回同一数组引用", () => {
    const msgs = [user("你好"), tool("ok")];
    const r = applyMediaBudget(msgs);
    expect(r.code).toBe(MEDIA_BUDGET_CODES.OK);
    expect(r.messages).toBe(msgs);
    expect(r.accounting.keptImages).toBe(0);
  });

  it("空 images 数组:按无图处理", () => {
    const msgs = [user("看图", [])];
    const r = applyMediaBudget(msgs);
    expect(r.code).toBe(MEDIA_BUDGET_CODES.OK);
    expect(r.messages).toBe(msgs);
    expect(r.accounting.keptImages).toBe(0);
    expect(r.messages[0]!.images).toEqual([]);
  });

  it("未超预算:消息逐字不变(同一引用)且账目正确", () => {
    const msgs = [user("两图", [img(300, "A"), img(300, "B")])];
    const r = applyMediaBudget(msgs, { maxBytes: 1000 });
    expect(r.code).toBe(MEDIA_BUDGET_CODES.OK);
    expect(r.messages).toBe(msgs);
    expect(r.accounting).toEqual({
      totalBytes: 600,
      keptImages: 2,
      omittedImages: 0,
      omittedBytes: 0,
      unknownImages: 0,
      protectedKept: 2, // 唯一含图消息 = 最后一条含图消息,两张都受保护
    });
  });

  it("恰好等于预算:不省略(≤ 判据)", () => {
    const msgs = [user("图", [img(300)])];
    const r = applyMediaBudget(msgs, { maxBytes: 300 });
    expect(r.code).toBe(MEDIA_BUDGET_CODES.OK);
    expect(r.messages).toBe(msgs);
  });

  it("未知 URL:计数但不占预算", () => {
    const msgs = [user("远程图", ["https://cdn.example.com/a.png"]), tool("ok")];
    const r = applyMediaBudget(msgs, { maxBytes: 1 });
    expect(r.code).toBe(MEDIA_BUDGET_CODES.OK);
    expect(r.messages).toBe(msgs);
    expect(r.accounting.unknownImages).toBe(1);
    expect(r.accounting.totalBytes).toBe(0);
    expect(r.accounting.keptImages).toBe(1);
  });

  it("零字节 data URL:不触发省略", () => {
    const msgs = [user("空图", ["data:image/png;base64,"])];
    const r = applyMediaBudget(msgs, { maxBytes: 0 });
    expect(r.code).toBe(MEDIA_BUDGET_CODES.OK);
    expect(r.accounting.totalBytes).toBe(0);
  });

  it("缺省预算常量 = 40 MiB,缺省保护张数 = 4", () => {
    expect(MEDIA_BUDGET_DEFAULT_BYTES).toBe(40 * 1024 * 1024);
    expect(MEDIA_BUDGET_DEFAULT_PROTECT_RECENT).toBe(4);
  });
});

describe("applyMediaBudget 省略", () => {
  it("超预算时从旧到新省略,直到总量 ≤ 预算", () => {
    const msgs = [user("旧1", [img(300, "A")]), tool("t"), user("旧2", [img(300, "B")]), user("新", [img(300, "C")])];
 // 总 900,预算 350:受保护 = 最后一条含图消息(m3)+ 最近 1 张(m3)→ 只能省 m0、m2 的图
    const r = applyMediaBudget(msgs, { maxBytes: 350, protectRecent: 1 });
    expect(r.code).toBe(MEDIA_BUDGET_CODES.OMITTED);
    expect(r.accounting).toEqual({
      totalBytes: 900,
      keptImages: 1,
      omittedImages: 2,
      omittedBytes: 600,
      unknownImages: 0,
      protectedKept: 1,
    });
    expect(r.messages[0]!.images).toBeUndefined();
    expect(r.messages[2]!.images).toBeUndefined();
    expect(r.messages[3]!.images).toEqual([img(300, "C")]);
  });

  it("只缩短 images:content/工具字段与消息条数零变化", () => {
    const msgs = [user("正文一", [img(300, "A")]), tool("工具结果", "call-1"), user("正文二", [img(300, "B")])];
    const r = applyMediaBudget(msgs, { maxBytes: 300, protectRecent: 0 });
    expect(r.code).toBe(MEDIA_BUDGET_CODES.OMITTED);
    expect(r.messages).toHaveLength(3);
    expect(r.messages[0]!.content).toBe("正文一");
    expect(r.messages[1]).toEqual(tool("工具结果", "call-1"));
    expect(r.messages[2]!.content).toBe("正文二");
  });

  it("被裁剪消息是新对象,未裁剪消息沿用原引用", () => {
    const msgs = [user("旧", [img(300, "A")]), user("新", [img(300, "B")])];
    const r = applyMediaBudget(msgs, { maxBytes: 300, protectRecent: 0 });
    expect(r.code).toBe(MEDIA_BUDGET_CODES.OMITTED);
    expect(r.messages[0]).not.toBe(msgs[0]);
    expect(r.messages[1]).toBe(msgs[1]);
  });

  it("一张图都不剩时删除 images 属性(不留空数组)", () => {
    const msgs = [user("旧", [img(300, "A")]), user("新", [img(300, "B")])];
    const r = applyMediaBudget(msgs, { maxBytes: 100, protectRecent: 0 });
 // 受保护 1 张 300 > 100 → 显式失败而不是硬省
    expect(r.code).toBe(MEDIA_BUDGET_CODES.PROTECTED_OVER_BUDGET);
 // 换预算:受保护图 300 不超预算,旧图被省到空
    const r2 = applyMediaBudget(msgs, { maxBytes: 300, protectRecent: 0 });
    expect(r2.messages[0]!.images).toBeUndefined();
    expect("images" in r2.messages[0]!).toBe(false);
  });

  it("最后一条含图消息的图全部保留", () => {
    const msgs = [user("旧", [img(300, "A")]), tool("t"), user("新", [img(300, "B"), img(300, "C")])];
    const r = applyMediaBudget(msgs, { maxBytes: 600, protectRecent: 0 });
    expect(r.code).toBe(MEDIA_BUDGET_CODES.OMITTED);
    expect(r.messages[2]!.images).toEqual([img(300, "B"), img(300, "C")]);
    expect(r.messages[0]!.images).toBeUndefined();
    expect(r.accounting.protectedKept).toBe(2);
  });

  it("缺省 protectRecent=4:最近 4 张受保护(不进来更早的预算)", () => {
 // 6 张各 300(分 6 条消息),预算 1200:只省最旧两张
    const msgs = [0, 1, 2, 3, 4, 5].map((i) => user(`m${i}`, [img(300, "ABCDEF"[i]!)]));
    const r = applyMediaBudget(msgs, { maxBytes: 1200 });
    expect(r.code).toBe(MEDIA_BUDGET_CODES.OMITTED);
 // 总 1800,受保护 = 最后一条含图消息 + 最近 4 张 = 后 4 张(1200),省略 idx0/1
    expect(r.messages[0]!.images).toBeUndefined();
    expect(r.messages[1]!.images).toBeUndefined();
    expect(r.messages.slice(2).map((m) => m.images)).toEqual([
      [img(300, "C")], [img(300, "D")], [img(300, "E")], [img(300, "F")],
    ]);
    expect(r.accounting).toMatchObject({ keptImages: 4, omittedImages: 2, omittedBytes: 600, protectedKept: 4 });
  });

  it("protectRecent=0 时只保护最后一条含图消息,可达更深的历史", () => {
    const msgs = [0, 1, 2, 3, 4, 5].map((i) => user(`m${i}`, [img(300, "ABCDEF"[i]!)]));
    const r = applyMediaBudget(msgs, { maxBytes: 750, protectRecent: 0 });
    expect(r.code).toBe(MEDIA_BUDGET_CODES.OMITTED);
 // 总 1800,受保护仅 idx5(300);从旧到新省 idx0..3 → 剩 600 ≤ 750
    expect(r.messages[0]!.images).toBeUndefined();
    expect(r.messages[3]!.images).toBeUndefined();
    expect(r.messages[4]!.images).toEqual([img(300, "E")]);
    expect(r.messages[5]!.images).toEqual([img(300, "F")]);
    expect(r.accounting).toMatchObject({ keptImages: 2, omittedImages: 4, protectedKept: 1 });
  });

  it("protectRecent 越大,受保护集合越大(同一输入不同预算结局)", () => {
    const msgs = [0, 1, 2].map((i) => user(`m${i}`, [img(300, "ABC"[i]!)]));
 // 总 900:缺省保护集合 = 全部 3 张 → 900 > 预算 350 = 无法满足
    const strict = applyMediaBudget(msgs, { maxBytes: 350 });
    expect(strict.code).toBe(MEDIA_BUDGET_CODES.PROTECTED_OVER_BUDGET);
 // protectRecent=0 → 只保护最后一张(300 ≤ 350),旧两张可省 → 可满足
    const loose = applyMediaBudget(msgs, { maxBytes: 350, protectRecent: 0 });
    expect(loose.code).toBe(MEDIA_BUDGET_CODES.OMITTED);
    expect(loose.messages.map((m) => m.images)).toEqual([undefined, undefined, [img(300, "C")]]);
  });

  it("未知 URL 即使超预算也不省略(省它不减轻字节)", () => {
    const msgs = [
      user("远程+本地", ["https://cdn.example.com/a.png", img(300, "A")]),
      tool("t"),
      user("新", [img(300, "B")]),
    ];
    const r = applyMediaBudget(msgs, { maxBytes: 300, protectRecent: 1 });
    expect(r.code).toBe(MEDIA_BUDGET_CODES.OMITTED);
    expect(r.messages[0]!.images).toEqual(["https://cdn.example.com/a.png"]);
    expect(r.accounting.unknownImages).toBe(1);
    expect(r.accounting.omittedImages).toBe(1);
    expect(r.accounting.keptImages).toBe(2);
  });

  it("省略顺序确定:同尺寸多图按最旧优先", () => {
    const msgs = [user("m0", [img(300, "A")]), user("m1", [img(300, "B")]), user("m2", [img(300, "C")])];
    const r = applyMediaBudget(msgs, { maxBytes: 300, protectRecent: 0 });
    expect(r.code).toBe(MEDIA_BUDGET_CODES.OMITTED);
    expect(r.messages[0]!.images).toBeUndefined();
    expect(r.messages[1]!.images).toBeUndefined();
    expect(r.messages[2]!.images).toEqual([img(300, "C")]);
  });

  it("同一条消息内多图:按数组顺序(旧→新)省略", () => {
    const msgs = [user("同条两图", [img(300, "A"), img(300, "B")]), tool("t")];
    const r = applyMediaBudget(msgs, { maxBytes: 300, protectRecent: 0 });
 // 该消息是唯一含图消息 → 两张全受保护(300+300=600 > 300)→ 显式失败
    expect(r.code).toBe(MEDIA_BUDGET_CODES.PROTECTED_OVER_BUDGET);
 // 再看无保护覆盖时的前缀省略:protectRecent=0 且最后一张图在更后面的消息里
    const msgs2 = [user("旧", [img(300, "A"), img(300, "B")]), user("新", [img(300, "C")])];
    const r2 = applyMediaBudget(msgs2, { maxBytes: 300, protectRecent: 0 });
    expect(r2.code).toBe(MEDIA_BUDGET_CODES.OMITTED);
    expect(r2.messages[0]!.images).toBeUndefined();
    expect(r2.messages[1]!.images).toEqual([img(300, "C")]);
  });

  it("多次调用结果深等(确定性)", () => {
    const msgs = () => [user("a", [img(300, "A")]), tool("t"), user("b", [img(300, "B")])];
    const a = applyMediaBudget(msgs(), { maxBytes: 300, protectRecent: 0 });
    const b = applyMediaBudget(msgs(), { maxBytes: 300, protectRecent: 0 });
    expect(a).toEqual(b);
  });

  it("输入不可变:裁剪后原消息与 images 原数组未被改写", () => {
    const m0 = user("旧", [img(300, "A")]);
    const m1 = user("新", [img(300, "B")]);
    const msgs = [m0, m1];
    const snapshot = clone(msgs);
    applyMediaBudget(msgs, { maxBytes: 300, protectRecent: 0 });
    expect(msgs).toEqual(snapshot);
    expect(msgs[0]).toBe(m0);
    expect(m0.images).toHaveLength(1);
  });
});

describe("applyMediaBudget 受保护媒体超预算", () => {
  it("单张受保护图 > 预算:PROTECTED_OVER_BUDGET 且消息原样", () => {
    const msgs = [user("刚发的", [img(600, "A")])];
    const r = applyMediaBudget(msgs, { maxBytes: 300 });
    expect(r.code).toBe(MEDIA_BUDGET_CODES.PROTECTED_OVER_BUDGET);
    expect(r.messages).toBe(msgs);
    expect(r.messages[0]!.images).toEqual([img(600, "A")]);
  });

  it("超预算账目带该图字节,且 protectedKept 如实", () => {
    const msgs = [user("旧", [img(300, "A")]), user("刚发的", [img(600, "B")])];
    const r = applyMediaBudget(msgs, { maxBytes: 300, protectRecent: 1 });
    expect(r.code).toBe(MEDIA_BUDGET_CODES.PROTECTED_OVER_BUDGET);
    expect(r.accounting).toEqual({
      totalBytes: 900,
      keptImages: 2,
      omittedImages: 0,
      omittedBytes: 0,
      unknownImages: 0,
      protectedKept: 1,
    });
  });

  it("受保护集合合计超预算(单张都不超):同样显式失败、消息原样", () => {
    const msgs = [user("a", [img(300, "A")]), user("b", [img(300, "B")])];
    const r = applyMediaBudget(msgs, { maxBytes: 300 });
    expect(r.code).toBe(MEDIA_BUDGET_CODES.PROTECTED_OVER_BUDGET);
    expect(r.messages).toBe(msgs);
  });

  it("非受保护的大图可被省略,不误判为失败", () => {
    const msgs = [user("旧大图", [img(900, "A")]), tool("t"), user("新图", [img(300, "B")])];
    const r = applyMediaBudget(msgs, { maxBytes: 300, protectRecent: 0 });
    expect(r.code).toBe(MEDIA_BUDGET_CODES.OMITTED);
    expect(r.accounting.omittedBytes).toBe(900);
    expect(r.messages[2]!.images).toEqual([img(300, "B")]);
  });
});

describe("applyMediaBudget 非法输入", () => {
  it("messages 非数组:INVALID + 空 messages", () => {
    const r = applyMediaBudget(null as unknown as MediaMessageLike[]);
    expect(r.code).toBe(MEDIA_BUDGET_CODES.INVALID);
    expect(r.messages).toEqual([]);
  });

  it("消息元素非对象:INVALID 且原样返回", () => {
    const msgs = [null as unknown as MediaMessageLike];
    const r = applyMediaBudget(msgs);
    expect(r.code).toBe(MEDIA_BUDGET_CODES.INVALID);
    expect(r.messages).toBe(msgs);
  });

  it("负数预算:INVALID 且原样返回", () => {
    const msgs = [user("x", [img(300)])];
    const r = applyMediaBudget(msgs, { maxBytes: -1 });
    expect(r.code).toBe(MEDIA_BUDGET_CODES.INVALID);
    expect(r.messages).toBe(msgs);
  });

  it("NaN / Infinity 预算:INVALID", () => {
    const msgs = [user("x", [img(300)])];
    expect(applyMediaBudget(msgs, { maxBytes: Number.NaN }).code).toBe(MEDIA_BUDGET_CODES.INVALID);
    expect(applyMediaBudget(msgs, { maxBytes: Number.POSITIVE_INFINITY }).code).toBe(MEDIA_BUDGET_CODES.INVALID);
  });

  it("protectRecent 非整数/负数:INVALID", () => {
    const msgs = [user("x", [img(300)])];
    expect(applyMediaBudget(msgs, { protectRecent: 1.5 }).code).toBe(MEDIA_BUDGET_CODES.INVALID);
    expect(applyMediaBudget(msgs, { protectRecent: -1 }).code).toBe(MEDIA_BUDGET_CODES.INVALID);
  });
});

describe("mediaBudgetNote", () => {
  const base: MediaBudgetAccounting = {
    totalBytes: 2 * 1024 * 1024,
    keptImages: 4,
    omittedImages: 0,
    omittedBytes: 0,
    unknownImages: 0,
    protectedKept: 4,
  };

  it("无省略返回空串", () => {
    expect(mediaBudgetNote(base)).toBe("");
  });

  it("有省略:包含张数、MB 与原因", () => {
    const note = mediaBudgetNote({ ...base, omittedImages: 3, omittedBytes: 3 * 1024 * 1024, keptImages: 1 });
    expect(note).toContain("[媒体预算]");
    expect(note).toContain("省略 3 张旧图");
    expect(note).toContain("3.0 MB");
    expect(note).toContain("保留 1 张");
    expect(note).toContain("最后一条含图消息");
    expect(note).toContain("历史消息与文本未改动");
  });

  it("有未知图时附一句说明", () => {
    const note = mediaBudgetNote({ ...base, omittedImages: 1, omittedBytes: 1024 * 1024, unknownImages: 2 });
    expect(note).toContain("2 张远程图片无法在本地计量");
  });
});

describe("projectVisionCapability", () => {
  it("未声明能力:不投影图片并给 reason", () => {
    const p = projectVisionCapability(undefined);
    expect(p.projectImages).toBe(false);
    expect(p.formats).toEqual([]);
    expect(p.reason).toContain("剥离图片");
    expect(p.code).toBe(VISION_PROJECTION_CODES.INVALID);
  });

  it("vision=false:不投影图片", () => {
    const p = projectVisionCapability({ vision: false });
    expect(p.projectImages).toBe(false);
    expect(p.code).toBe(VISION_PROJECTION_CODES.NO_VISION);
    expect(p.reason).toContain("不支持视觉输入");
  });

  it("vision=true 未声明格式:投影图片,reason 说明按 provider 默认", () => {
    const p = projectVisionCapability({ vision: true });
    expect(p.projectImages).toBe(true);
    expect(p.formats).toEqual([]);
    expect(p.reason).toContain("未声明输入格式");
    expect(p.code).toBe(VISION_PROJECTION_CODES.OK);
  });

  it("inputFormats 只保留 image/*,小写去重", () => {
    const p = projectVisionCapability({ vision: true, inputFormats: ["image/PNG", "text/plain", "image/png", "image/jpeg", 42 as unknown as string] });
    expect(p.projectImages).toBe(true);
    expect(p.formats).toEqual(["image/png", "image/jpeg"]);
    expect(p.reason).toContain("image/png");
  });

  it("输入不被修改", () => {
    const caps = { vision: true, inputFormats: ["image/png"] };
    const snapshot = clone(caps);
    projectVisionCapability(caps);
    expect(caps).toEqual(snapshot);
  });
});
