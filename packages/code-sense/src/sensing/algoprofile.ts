/**
 * sensing/algoprofile( P3 / §2.3):算法画像——框架 API 模式识别。
 * 文件级「算法角色」判定(每条信号带 {line} 证据):
 *   model-def(nn.Module 子类+forward / keras.Model)/ training(loss.backward/optimizer.step/
 *   .fit(/GradientTape)/ inference(predict/infer/model.eval()/onnx InferenceSession.run/torch.no_grad)/
 *   data-prep(DataLoader/Dataset/tf.data/transforms)/ cv-dsp(cv2./librosa./torchaudio./PIL/scipy.signal ≥2 次)/
 *   eval-metrics(sklearn.metrics/accuracy_score/f1_score 等)。
 * 诚实边界:不编造跨文件「数据流」边(文件间真实调用边由 callgraph 消费方自行 join);
 * 管线序=data-prep→model-def→training→inference→eval-metrics 声明式排序,非数据流断言。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type AlgoKind = "model-def" | "training" | "inference" | "data-prep" | "cv-dsp" | "eval-metrics";

export interface AlgoSignal {
  pattern: string;   // 命中的框架 API 形态(如 "nn.Module 子类" / "loss.backward")
  line: number;
}

export interface AlgoProfile {
  file: string;
  /** 角色(多角色文件按信号强度排序,首个=主角色)。 */
  kinds: AlgoKind[];
  signals: AlgoSignal[];
  /** 入口点(def/class 名+行号):模型类的 forward、训练主函数、predict/infer 等。 */
  entryPoints: { name: string; line: number; role: string }[];
}

export interface AlgoSurface {
  profiles: AlgoProfile[];
  /** 模块级聚合:目录 → 角色分布。 */
  modules: { dir: string; kinds: AlgoKind[]; files: number }[];
  scannedFiles: number;
}

interface SignalDef {
  kind: AlgoKind;
  pattern: string;
  re: RegExp;
  /** 同一文件内该信号的最小命中数(防单发 import 行误报)。 */
  minHits: number;
  role?: string;   // entryPoint 角色标注
 /** 权重(主角色判定):类/def 定义形态重于调用点形态(注意:模型文件里 demo 用的
   *  predict/no_grad 调用点计数会压过 nn.Module 类定义,主角色被误判成 inference)。 */
  weight?: number;
}

const SIGNALS: SignalDef[] = [
  { kind: "model-def", pattern: "nn.Module 子类", re: /class\s+(\w+)\s*\(\s*(?:nn\.)?Module\s*\)/, minHits: 1, weight: 2 },
  { kind: "model-def", pattern: "keras.Model 子类", re: /class\s+(\w+)\s*\(\s*(?:tf\.)?(?:keras\.)?Model\s*\)/, minHits: 1, weight: 2 },
  { kind: "model-def", pattern: "def forward(", re: /def\s+(forward)\s*\(/, minHits: 1, role: "模型前向", weight: 2 },
  { kind: "training", pattern: "loss.backward()", re: /\.backward\s*\(\s*\)/, minHits: 1 },
  { kind: "training", pattern: "optimizer.step()", re: /(?:optimizer|\bopt)\w*\.step\s*\(/, minHits: 1 },
  { kind: "training", pattern: ".fit(训练调用", re: /\.fit\s*\(\s*[^)]/, minHits: 1, role: "训练入口" },
  { kind: "training", pattern: "GradientTape", re: /GradientTape\s*\(/, minHits: 1 },
  { kind: "inference", pattern: "def predict(", re: /def\s+(predict)\s*\(/, minHits: 1, role: "推理入口" },
  { kind: "inference", pattern: "def infer(", re: /def\s+(infer\w*)\s*\(/, minHits: 1, role: "推理入口" },
  { kind: "inference", pattern: "model.eval()", re: /\.eval\s*\(\s*\)/, minHits: 1 },
  { kind: "inference", pattern: "onnx InferenceSession", re: /InferenceSession\s*\(/, minHits: 1, role: "onnx 推理" },
  { kind: "inference", pattern: "torch.no_grad", re: /torch\.no_grad\s*\(/, minHits: 1 },
  { kind: "inference", pattern: "sess.run(推理执行", re: /(?:sess|session|ort_session)\.run\s*\(/, minHits: 1 },
  { kind: "data-prep", pattern: "DataLoader", re: /DataLoader\s*\(/, minHits: 1, role: "数据加载" },
  { kind: "data-prep", pattern: "torch.utils.data import", re: /(?:from\s+torch\.utils\.data\s+import|import\s+torch\.utils\.data)/, minHits: 1 },
  { kind: "data-prep", pattern: "Dataset 子类", re: /class\s+(\w+)\s*\(\s*(?:data\.)?Dataset\s*\)/, minHits: 1, weight: 2 },
  { kind: "data-prep", pattern: "tf.data", re: /tf\.data\.\w+/, minHits: 1 },
  { kind: "data-prep", pattern: "transforms.Compose", re: /transforms\.Compose\s*\(/, minHits: 1 },
  { kind: "cv-dsp", pattern: "cv2 调用", re: /\bcv2\.\w+/g as unknown as RegExp, minHits: 2 },
  { kind: "cv-dsp", pattern: "librosa 调用", re: /\blibrosa\.\w+/, minHits: 2 },
  { kind: "cv-dsp", pattern: "torchaudio 调用", re: /\btorchaudio\.\w+/, minHits: 2 },
  { kind: "cv-dsp", pattern: "PIL.Image", re: /\bPIL\.Image|from\s+PIL\s+import\s+Image/, minHits: 1 },
  { kind: "cv-dsp", pattern: "scipy.signal", re: /scipy\.signal\.\w+/, minHits: 1 },
  { kind: "eval-metrics", pattern: "sklearn.metrics", re: /sklearn\.metrics|from\s+sklearn\s+import\s+metrics/, minHits: 1 },
  { kind: "eval-metrics", pattern: "指标函数(accuracy/f1/auc)", re: /\b(accuracy_score|f1_score|roc_auc_score|precision_score|recall_score)\s*\(/, minHits: 1 },
 // P0:C/C++ 算法面(嵌入式 CV 仓的算法库不能被判 0 文件)。
  { kind: "cv-dsp", pattern: "opencv2 include", re: /#\s*include\s*[<"]opencv2\//, minHits: 1 },
  { kind: "cv-dsp", pattern: "cv:: 调用", re: /\bcv::\w+/, minHits: 2 },
  { kind: "cv-dsp", pattern: "OpenCV C API(cvXxx)", re: /\bcv(?:Load|Create|Run|Resize|Cvt|Clone|Release|Get|Set|Warp|Filter|Threshold)\w*\s*\(/, minHits: 3 },
  { kind: "cv-dsp", pattern: "视觉后处理(NMS/letterbox/Resize)", re: /\b(?:NMS\w*|Letterbox|letterbox|Bbox|bbox|Resize|CvtColor|NV12|nv12|Postprocess\w*|PostProcess\w*)\s*\(/, minHits: 2 },
  { kind: "inference", pattern: "推理调用(RunSession/Infer)", re: /(?:RunSession|RunInference|Infer\w*|Predict\w*|Forward)\s*\(/, minHits: 1, role: "推理入口" },
  { kind: "model-def", pattern: "C/C++ 模型结构(权重字段)", re: /typedef\s+struct[\s\S]{0,400}?\b(weights?|bias|kernel|params)\b/, minHits: 1 },
];

/** 单文件算法画像。 */
export function extractAlgoProfileFromFile(file: string, text: string): AlgoProfile | null {
  const lines = text.split("\n");
  const signals: AlgoSignal[] = [];
  const kinds = new Map<AlgoKind, number>();
  const entryPoints: AlgoProfile["entryPoints"] = [];
  for (const def of SIGNALS) {
    let hits = 0;
    let firstLine = 0;
    for (let i = 0; i < lines.length; i++) {
      {
        const t = lines[i]!.trimStart();
        if (t.startsWith("//") || t.startsWith("#") || t.startsWith("*")) continue; // 注释行守卫
      }
      // 全局标志的信号(cv2 计数)用 test 重置:lastIndex 安全起见每次 new RegExp
      const re = new RegExp(def.re.source, def.re.flags.includes("g") ? def.re.flags : def.re.flags);
      const m = re.exec(lines[i]!);
      if (m) {
        hits++;
        if (!firstLine) firstLine = i + 1;
        if (def.role && m[1]) {
          entryPoints.push({ name: m[1], line: i + 1, role: def.role });
        }
      }
    }
    if (hits >= def.minHits) {
      signals.push({ pattern: def.pattern, line: firstLine });
      kinds.set(def.kind, (kinds.get(def.kind) ?? 0) + hits * (def.weight ?? 1));
    }
  }
  if (signals.length === 0) return null;
  const orderedKinds = [...kinds.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  return { file, kinds: orderedKinds, signals, entryPoints };
}

/** 指纹(字面量;grep 预筛用)。 */
export const ALGO_FINGERPRINT_LITERALS = [
  "nn.Module",
  "loss.backward",
  "optimizer.step",
  "DataLoader",
  "InferenceSession",
  "torch.no_grad",
  "cv2.",
  "librosa.",
  "torchaudio.",
  "sklearn.metrics",
  "GradientTape",
  "transforms.Compose",
  "def predict(",
  "def infer",
  ".eval()",
  "tf.data.",
 // C/C++
  "#include <opencv2/",
  "#include \"opencv2/",
  "cv::",
  "RunSession",
  "Infer",
  "Postprocess",
  "NPU_",
];

/** 仓级画像:候选文件逐文件判定 + 目录聚合。 */
export async function extractAlgoSurface(root: string, files: string[]): Promise<AlgoSurface> {
  const profiles: AlgoProfile[] = [];
  for (const f of files) {
    let text = "";
    try { text = await readFile(join(root, f), "utf-8"); } catch { continue; }
    const p = extractAlgoProfileFromFile(f, text);
    if (p) profiles.push(p);
  }
  profiles.sort((a, b) => a.file.localeCompare(b.file));
  // 模块级聚合(目录粒度;角色=成员文件角色的去重并集)
  const byDir = new Map<string, { kinds: Set<AlgoKind>; files: number }>();
  for (const p of profiles) {
    const dir = p.file.split("/").slice(0, -1).join("/") || ".";
    const cur = byDir.get(dir) ?? { kinds: new Set<AlgoKind>(), files: 0 };
    cur.files++;
    for (const k of p.kinds) cur.kinds.add(k);
    byDir.set(dir, cur);
  }
  const modules = [...byDir.entries()]
    .map(([dir, v]) => ({ dir, kinds: [...v.kinds], files: v.files }))
    .sort((a, b) => a.dir.localeCompare(b.dir));
  return { profiles, modules, scannedFiles: files.length };
}
