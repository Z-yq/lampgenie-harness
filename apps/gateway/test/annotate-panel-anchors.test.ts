import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 截图标注面板锚点(2026-10-29):取屏偏移修复 + 录音评论提交链。
 * 面板 UI 全在 panel.ts 模板字符串内,这里直接读源码文本断言结构性锚点(同 annotate-submit.test.ts 风格)。
 * 锁四件事:①取屏换算走共用换算层、不再拿位图 device px 当上界;②桌面壳真进全屏分支;
 * ③录音状态机(MediaRecorder/opus/120s/删除);④提交链 audioUrl + 8MB 上限 + 回执整理状态文案。 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_SRC = readFileSync(join(HERE, "../src/panel.ts"), "utf8");

/** 取一个函数体(从 `function name(` 到下一个同缩进的 `}` 行)。 */
function bodyOf(name: string): string {
  const at = PANEL_SRC.indexOf("function " + name + "(");
  expect(at).toBeGreaterThan(-1);
  const end = PANEL_SRC.indexOf("\n  }", at);
  expect(end).toBeGreaterThan(at);
  return PANEL_SRC.slice(at, end);
}

describe("取屏画框坐标(偏移根因)", () => {
  it("① capPos 走共用换算层,且不再拿 capCanvas.width/height(位图 device px)当上界", () => {
    const body = bodyOf("capPos");
    expect(body).toMatch(/annCoords\(\)|GenieAnnotateCoords/);
    expect(body).toContain("clientToImage");
    expect(body).not.toContain("capCanvas.width");
    expect(body).not.toContain("capCanvas.height");
    // 上界改为布局 CSS 尺寸(cssW/cssH),越右越往下才不再累积比例误差
    expect(body).toContain("cap.cssW");
    expect(body).toContain("cap.cssH");
  });

  it("② 桌面壳真进全屏才走 cover 分支;浏览器路径恒 contain(否则取景被裁、落点整体偏移)", () => {
    // E2E 实测回归锚:曾经无条件传 true → 浏览器路径也按 cover 取景,选区 500×400 变成 358×346。
    expect(PANEL_SRC).toContain("enterCaptureFullscreen(function (isFull) { openCaptureOverlay(url, img, isFull); })");
    expect(PANEL_SRC).not.toContain("openCaptureOverlay(url, img, true)");
    expect(bodyOf("enterCaptureFullscreen")).toContain("done(false)");
    const open = bodyOf("openCaptureOverlay");
    expect(open).toContain("bitmapOf");
    expect(open).toContain("devicePixelRatio");
    expect(open).toContain("cssW");
    expect(open).toContain("cssH");
    expect(open).toContain("dpr");
    expect(open).toContain("fitScale");
  });

  it("capBox 只做「client→布局 px」归一(offset=0/scale=1),换算到图像像素只由 confirmCapture 做一次", () => {
    // 回归锚:capBox 一旦把 cap.scale/cap.ox 一起塞进换算层,cap.sel 会变成图像像素而被
    // capPaint/confirmCapture 当布局 px 用,E2E 实测 300×400 的拖框被算成别的尺寸。
    const box = bodyOf("capBox");
    expect(box).toContain("offsetX: 0, offsetY: 0, scale: 1");
    expect(box).toContain("layoutWidth: cap.cssW");
    expect(bodyOf("confirmCapture")).toContain("(s.x - cap.ox) / sc");
  });

  it("capPaint 按 dpr 设变换(位图=device px、绘制=布局 CSS px),平移/角标跟同一坐标系", () => {
    expect(bodyOf("capPaint")).toContain("setTransform");
    expect(bodyOf("capPaintSelChrome")).toContain("imageToClient");
    // 平移量按布局/rect 比例换算
    const panAt = PANEL_SRC.indexOf("if (cap.pan) {", PANEL_SRC.indexOf("capCanvas.onpointermove"));
    expect(panAt).toBeGreaterThan(-1);
    expect(PANEL_SRC.slice(panAt, panAt + 600)).toContain("cap.cssW / rp.width");
  });

  it("#capCanvas 显式 width/height 100%(消除 flex 压缩导致的 rect≠位图)", () => {
    expect(PANEL_SRC).toMatch(/#capCanvas\{display:block;width:100%;height:100%/);
  });
});

describe("编辑器换算统一 + 录音评论", () => {
  it("annImgPoint 走唯一换算入口,数值口径仍是图像原生像素", () => {
    const body = bodyOf("annImgPoint");
    expect(body).toContain("clientToImage");
    expect(body).toContain("ann.zoom");
    expect(body).toContain("clamp(p.x, 0, ann.w)");
  });

  it("③ 录音状态机:MediaRecorder + opus 优先 + 120s 上限 + 删除录音 + 状态位 ann.rec", () => {
    expect(PANEL_SRC).toContain("MediaRecorder");
    expect(PANEL_SRC).toContain("audio/webm;codecs=opus");
    expect(PANEL_SRC).toContain("audio/webm\"");
    expect(PANEL_SRC).toMatch(/REC_MAX_MS\s*=\s*120\s*\*\s*1000/);
    expect(PANEL_SRC).toContain('id="annRecBtn"');
    expect(PANEL_SRC).toContain('id="annRecState"');
    expect(PANEL_SRC).toContain('id="annRecAudio"');
    expect(PANEL_SRC).toContain('id="annRecDel"');
    expect(PANEL_SRC).toContain("annRecDel");
    expect(PANEL_SRC).toContain("ann.rec = {");
    expect(PANEL_SRC).toContain("getUserMedia({ audio: true })");
    expect(PANEL_SRC).toContain("URL.revokeObjectURL");
    // 录音时关编辑器/换图/发送成功都要清理
    expect(bodyOf("closeAnnotateEditor")).toContain("annRecDispose()");
  });

  it("④ annSubmit 带 audioUrl、8MB 上限、纯录音可提交,且异步读音频后仍保持发送锁/超时兜底", () => {
    const body = bodyOf("annSubmit");
    expect(body).toContain("audioUrl");
    expect(body).toMatch(/8 \* 1024 \* 1024/);
    expect(body).toContain("见录音评论");
    expect(body).toContain("readAsDataURL");
    expect(body).toContain("doSend");
    expect(body).toContain("30000");
  });

  it("⑤ onAnnotateResult 回执文案含整理状态与录音解析失败提示", () => {
    const body = bodyOf("onAnnotateResult");
    expect(body).toContain("已 LLM 整理");
    expect(body).toContain("未经 LLM 整理");
    expect(body).toContain("m.refined === true");
    expect(body).toContain("m.refined === false");
    expect(body).toContain("voiceError");
    expect(body).toContain("音频已保留");
  });

  it("⑥ 换算层资产按既有 /assets/ 机制加载(script 标签 + 路由 + 缺失兜底)", () => {
    expect(PANEL_SRC).toContain('<script src="/assets/annotate-coords.js">');
    expect(PANEL_SRC).toContain('req.url === "/assets/annotate-coords.js"');
    expect(PANEL_SRC).toContain("window.GenieAnnotateCoords");
    expect(PANEL_SRC).toContain("使用内联坐标换算兜底");
  });
});
