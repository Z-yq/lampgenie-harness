/**
 * typed/python 注解边界修复单测(2026-10-21 批次 D):
 * 四轮实测实锤(py-mmdetection mmdet/apis/inference.py)——多行 def 签名续行与 docstring 行
 * 曾被 ANNOT_RE 当注解赋值收进 vars:
 *  - `video_len: int) -> SampleList:`(def 续行)→ dataType="int) -> SampleList:"
 *  - `ConfigType: new test_pipeline`(docstring Returns 段)→ dataType="new test_pipeline"
 *  - `SampleList: The tracking data samples.`(docstring Returns 段)→ dataType="The tracking ..."
 * 修法:行级词法状态(三引号跨行 + 括号深度)守门注解/赋值解析;类型文本防御拒收 `)`/`->`。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractTypedSymbols, varsOf } from "../src/typed/index";

const created: string[] = [];
function pyFixture(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "gh-pyannot-"));
  created.push(dir);
  writeFileSync(join(dir, "inference.py"), content);
  return dir;
}
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

/** py-mmdetection inference.py 的实锤形态(节选,行号语义保真)。 */
const MMDET_LIKE = [
  "from typing import Optional, Union",
  "",
  "def inference_mot(model: nn.Module, img: np.ndarray, frame_id: int,",
  "                  video_len: int) -> SampleList:",
  '    """Inference image(s) with the mot model.',
  "",
  "    Args:",
  "        video_len (int): demo video length",
  "    Returns:",
  "        SampleList: The tracking data samples.",
  '    """',
  "    cfg = model.cfg",
  "    data: dict = dict(",
  "        img=img,",
  "    )",
  "    return test_step(cfg, data)",
  "",
  "",
  "def _create_pipeline(cfg):",
  '    """',
  "    Returns:",
  "        ConfigType: new test_pipeline",
  '    """',
  "    test_pipeline: Optional[Compose] = None",
  "    return test_pipeline",
].join("\n");

describe("typed/python 注解边界(2026-10-21 D 修复)", () => {
  it("复现形态:mmdet inference.py 的三处坏类型不再出现", async () => {
    const dir = pyFixture(MMDET_LIKE);
    const r = await extractTypedSymbols(dir, "inference.py");
    const types = varsOf(r.symbols).map((s) => `${s.name}:${s.dataType}`);
    // 多行 def 签名续行:video_len 是形参不是变量——不得以任何形态入列
    expect(types.some((t) => t.startsWith("video_len:"))).toBe(false);
    // docstring 行(ConfigType/SampleList 的 Returns 段)不是注解赋值
    expect(types.some((t) => t.startsWith("ConfigType:"))).toBe(false);
    expect(types.some((t) => t.startsWith("SampleList:"))).toBe(false);
    // 全量兜底:任何 dataType 都不得带 `)`/`->`(返回注解切进来的碎片特征)
    for (const v of varsOf(r.symbols)) {
      expect(v.dataType, `${v.name} 的类型不应含返回注解碎片`).not.toMatch(/\)|->/);
    }
  });

  it("合法注解仍正常提取(模块级/类属性/带值),多行字面量不误收", async () => {
    const dir = pyFixture([
      "MAX_RETRIES: int = 5",
      "opts: dict = {",
      "    'a': 1,",
      "}",
      "",
      "class Runner:",
      "    timeout: float = 1.5",
      "",
      "    def run(self):",
      "        x: int = 1",
      "        items = []",
      "        return x",
    ].join("\n"));
    const r = await extractTypedSymbols(dir, "inference.py");
    const byName = new Map(varsOf(r.symbols).map((s) => [s.name, s]));
    expect(byName.get("MAX_RETRIES")?.dataType).toBe("int");
    expect(byName.get("opts")?.dataType).toBe("dict");
    expect(byName.get("timeout")?.kind).toBe("property");
    expect(byName.get("timeout")?.container).toBe("Runner");
    // 函数体内局部(注解 x、字面量 items)与多行字典续行('a': 1)不进入 vars 清单
    expect(byName.has("x")).toBe(false);
    expect(byName.has("items")).toBe(false);
    expect(byName.has("a")).toBe(false);
  });

  it("三引号块内含 # 与括号:注释/深度状态不被字符串内容污染", async () => {
    const dir = pyFixture([
      'DOC = """docstring with ( unbalanced and # hash"""',
      "valid_after: str = \"ok\"",
      "pairs: dict = {}  # 注释里的 ( 括号",
      "later: int = 9",
    ].join("\n"));
    const r = await extractTypedSymbols(dir, "inference.py");
    const names = varsOf(r.symbols).map((s) => s.name);
    expect(names).toContain("valid_after");
    expect(names).toContain("pairs");
    expect(names).toContain("later");
    // DOC 行的三引号在本行闭合——后续行不被当作 docstring
    expect(varsOf(r.symbols).find((s) => s.name === "later")?.dataType).toBe("int");
  });
});
