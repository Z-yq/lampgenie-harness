/**
 * sensing/algoprofile 测试(step-077 P3):
 * 六角色信号(model-def/training/inference/data-prep/cv-dsp/eval-metrics)+入口点提取+
 * minHits 防单发误报+模块聚合+反例零误报+codeSense mode=algo e2e+LLM 导读挂载/降级。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractAlgoProfileFromFile, queryAlgoProfiles, renderAlgoProfiles, setSensingDeps, codeSense, type SenseLlm } from "@lampgenie/code-sense";

const TORCH_MODEL = `import torch
import torch.nn as nn
from torch.utils.data import DataLoader, Dataset

class SpeechEncoder(nn.Module):
    def __init__(self):
        super().__init__()
        self.conv = nn.Conv1d(80, 128, 3)

    def forward(self, x):
        return self.conv(x)

def train_loop(model, loader):
    opt = torch.optim.Adam(model.parameters())
    for x, y in loader:
        loss = model(x)
        loss.backward()
        opt.step()

def predict(model, x):
    model.eval()
    with torch.no_grad():
        return model(x)
`;

const ONNX_INFER = `import onnxruntime as ort
import numpy as np

class StreamingPseInfer:
    def __init__(self, model_path):
        self.sess = ort.InferenceSession(model_path)

    def infer(self, feat):
        return self.sess.run(None, {"input": feat})
`;

const CV_FILE = `import cv2
import librosa

def process(frame, wav):
    img = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    img = cv2.resize(img, (224, 224))
    mel = librosa.feature.melspectrogram(wav)
    mel_db = librosa.power_to_db(mel)
    return img, mel_db
`;

const METRICS = `from sklearn.metrics import accuracy_score, f1_score

def evaluate(y_true, y_pred):
    return accuracy_score(y_true, y_pred), f1_score(y_true, y_pred)
`;

const PLAIN_PY = `def add(a, b):
    return a + b
`;

describe("algoprofile 六角色", () => {
  it("torch 模型文件:model-def+training+inference+data-prep 四角色+入口点", () => {
    const p = extractAlgoProfileFromFile("model.py", TORCH_MODEL);
    expect(p).toBeTruthy();
    expect(p!.kinds).toContain("model-def");
    expect(p!.kinds).toContain("training");
    expect(p!.kinds).toContain("inference");
    expect(p!.kinds).toContain("data-prep");
    expect(p!.kinds[0]).toBe("model-def"); // 主角色=信号强度最高
    const entries = p!.entryPoints.map((e) => e.name);
    expect(entries).toContain("forward");
    expect(entries).toContain("predict");
  });

  it("onnx 推理文件:inference(InferenceSession+def infer+sess.run)", () => {
    const p = extractAlgoProfileFromFile("onnx_streaming_infer.py", ONNX_INFER);
    expect(p).toBeTruthy();
    expect(p!.kinds).toEqual(["inference"]);
    expect(p!.entryPoints.some((e) => e.name === "infer" && e.role === "推理入口")).toBe(true);
  });

  it("cv-dsp:cv2/librosa ≥2 次才算(防单发 import 误报)", () => {
    const p = extractAlgoProfileFromFile("dsp.py", CV_FILE);
    expect(p).toBeTruthy();
    expect(p!.kinds).toContain("cv-dsp");
    // 单发 import 不出画像
    const single = `import cv2\ndef f(x):\n    return x\n`;
    expect(extractAlgoProfileFromFile("x.py", single)).toBeNull();
  });

  it("eval-metrics:sklearn 指标", () => {
    const p = extractAlgoProfileFromFile("eval.py", METRICS);
    expect(p!.kinds).toContain("eval-metrics");
  });

  it("反例:纯工具文件零画像", () => {
    expect(extractAlgoProfileFromFile("util.py", PLAIN_PY)).toBeNull();
  });
});

// ============================ 非产品路径过滤(P1-1,2026-10-20) ============================

describe("queryAlgoProfiles 非产品路径过滤(docs/ 与 .md 不是算法实现)", () => {
  // mmdetection 实锤形态:docs/ 下的教程 notebook/脚本被算成算法文件
  const DOC_ALGO_MD = `# 训练教程

\`\`\`python
import torch
import torch.nn as nn
from torch.utils.data import DataLoader

class DocNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.fc = nn.Linear(10, 10)

    def forward(self, x):
        return self.fc(x)
\`\`\`
`;

  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "cssense-algofilter-"));
    mkdirSync(join(dir, "models"), { recursive: true });
    mkdirSync(join(dir, "docs"), { recursive: true });
    mkdirSync(join(dir, "examples"), { recursive: true });
    writeFileSync(join(dir, "models", "encoder.py"), TORCH_MODEL);
    writeFileSync(join(dir, "docs", "tutorial.md"), DOC_ALGO_MD);
    writeFileSync(join(dir, "examples", "demo_dsp.py"), CV_FILE);
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it("docs/*.md 与 examples/ 被过滤 + pathFilter 呈报 + render 注记;all=true 重新出现", async () => {
    const r = await queryAlgoProfiles(dir, { refresh: true });
    // ① 过滤生效:只剩产品路径的 models/encoder.py
    expect(r.profiles.map((p) => p.file)).toEqual(["models/encoder.py"]);
    expect(r.profiles.every((p) => !p.file.startsWith("docs/") && !p.file.startsWith("examples/"))).toBe(true);
    // ② 诚实呈报
    expect(r.pathFilter).toBeTruthy();
    expect(r.pathFilter!.filtered).toBeGreaterThan(0);
    expect(r.pathFilter!.note).toContain("已过滤");
    expect(renderAlgoProfiles(r).split("\n")[1]).toContain("[路径过滤]");
    // ③ 逃生口
    const all = await queryAlgoProfiles(dir, { refresh: true, all: true });
    expect(all.profiles.some((p) => p.file === "examples/demo_dsp.py")).toBe(true);
    expect(all.pathFilter).toBeUndefined();
  });

  it("过滤后清零不静默:只剩 docs/ 算法文件时 pathFilter 仍在", async () => {
    const only = mkdtempSync(join(tmpdir(), "cssense-algofilter-only-"));
    mkdirSync(join(only, "docs"), { recursive: true });
    writeFileSync(join(only, "docs", "train.py"), TORCH_MODEL);
    try {
      const r = await queryAlgoProfiles(only, { refresh: true });
      expect(r.profiles).toEqual([]);
      expect(r.pathFilter?.filtered).toBeGreaterThan(0);
      expect(r.pathFilter?.note).toContain("已过滤");
      expect(renderAlgoProfiles(r)).toContain("[路径过滤]");
    } finally {
      rmSync(only, { recursive: true, force: true });
    }
  });
});

describe("queryAlgoProfiles 仓级 + mode=algo + LLM 导读", () => {
  let ws = "";
  beforeAll(() => {
    ws = mkdtempSync(join(tmpdir(), "cssense-algo-"));
    mkdirSync(join(ws, "models"), { recursive: true });
    mkdirSync(join(ws, "utils"), { recursive: true });
    writeFileSync(join(ws, "models", "encoder.py"), TORCH_MODEL);
    writeFileSync(join(ws, "models", "onnx_infer.py"), ONNX_INFER);
    writeFileSync(join(ws, "utils", "dsp.py"), CV_FILE);
    writeFileSync(join(ws, "utils", "metrics.py"), METRICS);
    writeFileSync(join(ws, "utils", "add.py"), PLAIN_PY);
  });
  afterAll(() => {
    rmSync(ws, { recursive: true, force: true });
    setSensingDeps({});
  });

  it("仓级聚合:profiles+modules 两视图", async () => {
    const r = await queryAlgoProfiles(ws, { refresh: true });
    expect(r.profiles.length).toBe(4);
    const modelDir = r.modules.find((m) => m.dir === "models");
    expect(modelDir?.kinds).toContain("model-def");
    expect(modelDir?.kinds).toContain("inference");
    expect(r.semanticLayer.status).toBe("off");
  });

  it("LLM 导读:挂载与降级(stub LLM)", async () => {
    const stub: SenseLlm = {
      async generate() {
        return JSON.stringify({
          items: [{ ref: "A1", summary: "定义一维卷积语音编码器", evidenceRef: "A1" }],
        });
      },
    };
    setSensingDeps({ senseLlm: stub });
    const r = await queryAlgoProfiles(ws, { refresh: true, withSemantics: true, file: "onnx_infer.py" });
    expect(r.semanticLayer.status).toBe("ok");
    const w = r.walkthroughs?.["models/onnx_infer.py"];
    expect(w?.length).toBeGreaterThan(0);
    setSensingDeps({});
  });

  it("codeSense mode=algo:auto 关键词+证据行", async () => {
    const r = await codeSense(ws, "这个仓的算法画像", {});
    expect(r.mode).toBe("algo");
    expect(r.algo?.profiles.length).toBe(4);
    expect(r.evidence.length).toBeGreaterThan(0);
    expect(r.degraded?.some((d) => d.layer === "sensing-semantic")).toBe(true);
  });

  it("反例:无算法仓显式降级", async () => {
    const empty = mkdtempSync(join(tmpdir(), "cssense-algo-empty-"));
    writeFileSync(join(empty, "util.py"), PLAIN_PY);
    const r = await codeSense(empty, "算法画像", {});
    expect(r.algo?.profiles).toEqual([]);
    expect(r.degraded?.some((d) => d.layer === "sensing-algo")).toBe(true);
    rmSync(empty, { recursive: true, force: true });
  });
});
