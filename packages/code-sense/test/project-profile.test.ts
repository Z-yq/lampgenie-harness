/**
 * project-profile 单测(step-089 P3 / designs/26 §4):
 * 确定性骨架(README 首段/包清单/框架指纹/目录拓扑,全带证据行)、entrypoints 缺席显式降级、
 * LLM purpose 层(runSemanticBatch 管线:正常/引用伪造拒收/无 LLM 显式 off)、
 * manifest 落盘与指纹缓存、≤300 字符注入块与缺席零注入。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildSkeleton, detectFrameworks, queryProjectProfile, writeProjectProfile, loadProjectProfile,
  renderProjectProfile, projectMainlineBlock, readmeFirstParagraph, readmeHeadings, isNonProductPath,
} from "../src/project-profile";
import { setSensingDeps } from "./../src/sensing/semantic";

const created: string[] = [];
function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "gh-profile-"));
  created.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}
afterEach(() => {
  setSensingDeps({});
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

const REPO = {
  "README.md": [
    "# fancy-vision",
    "",
    "[![badge](https://x)](https://x)",
    "A vision training toolkit for autonomous driving datasets.",
    "It converts raw camera rosbags into training-ready frames.",
    "",
    "## Install",
    "pip install fancy-vision",
  ].join("\n"),
  "package.json": JSON.stringify({ name: "fancy-vision", description: "Vision dataset training toolkit", version: "0.1.0" }, null, 2),
  "src/main.py": "import torch\nfrom torch import nn\n\nclass Net(nn.Module):\n    def forward(self, x):\n        return x\n",
  "src/data.py": "from torch.utils.data import DataLoader\n\ndef load():\n    return DataLoader([])\n",
};

describe("确定性骨架(永不依赖 LLM)", () => {
  it("README 首段(跳过 badge/标题)+description 双 purpose 候选,全带证据行", async () => {
    const dir = fixture(REPO);
    const { skeleton, anchors } = await buildSkeleton(dir);
    expect(skeleton.purposeCandidates.length).toBeGreaterThanOrEqual(2);
    const readme = skeleton.purposeCandidates.find((p) => p.source === "README 首段");
    expect(readme?.text).toContain("vision training toolkit");
    expect(readme?.text).not.toContain("badge");
    expect(readme?.text).not.toContain("Install");
    expect(readme?.evidence.file).toBe("README.md");
    const desc = skeleton.purposeCandidates.find((p) => p.source === "package.json" && p.text.startsWith("description"));
    expect(desc?.text).toContain("Vision dataset training toolkit");
    expect(desc?.evidence.line).toBeGreaterThan(0);
    // 证据锚=LLM 白名单(全部来自真实文件事实)
    expect(anchors.length).toBeGreaterThanOrEqual(2);
    expect(anchors.every((a) => a.id.startsWith("E"))).toBe(true);
  });

  it("框架指纹(PyTorch)+领域映射+技术栈/目录拓扑", async () => {
    const dir = fixture(REPO);
    const { skeleton } = await buildSkeleton(dir);
    expect(skeleton.frameworks.some((f) => f.name === "PyTorch")).toBe(true);
    const torch = skeleton.frameworks.find((f) => f.name === "PyTorch")!;
    // 单次全仓扫描后候选顺序由文件系统决定;两份真实 import 都可作证据
    expect(["src/main.py", "src/data.py"]).toContain(torch.evidence.file);
    expect(torch.evidence.line).toBe(1);
    expect(skeleton.domain).toBe("ml-training");
    expect(skeleton.techStack.some((t) => t.language === ".py")).toBe(true);
    expect(skeleton.topoNotes.some((n) => n.startsWith("src/"))).toBe(true);
  });

  it("C/C++ 仓:技术栈/拓扑/成熟度不再失真,构建文件单独采集(2026-10-22 P0)", async () => {
    const files: Record<string, string> = {
      "CMakeLists.txt": "project(libsaalg)\n",
      "Makefile": "all:\n",
      "inc/api.h": "int run(int);\n",
    };
    // 12 个源文件:C 族必须计入 scan.files,否则成熟度恒 SEEDLING、拓扑只剩 (根)
    for (let i = 0; i < 6; i++) {
      files[`src/m${i}.c`] = `int f${i}(void) { return ${i}; }\n`;
      files[`src/h${i}.h`] = `int f${i}(void);\n`;
    }
    const dir = fixture(files);
    const { skeleton } = await buildSkeleton(dir);
    expect(skeleton.techStack.some((t) => t.language === ".c")).toBe(true);
    expect(skeleton.techStack.some((t) => t.language === ".h")).toBe(true);
    expect(skeleton.topoNotes.some((n) => n.startsWith("src/"))).toBe(true);
    expect(skeleton.maturity).not.toBe("SEEDLING"); // 12 源文件 > SEEDLING_MAX
    expect(skeleton.buildFiles?.count).toBe(2);
    expect(skeleton.buildFiles?.samples).toEqual(expect.arrayContaining(["CMakeLists.txt", "Makefile"]));
  });

  it("索引缺席=entrypoints 显式降级,不阻塞骨架;无 README=显式 degraded", async () => {
    const dir = fixture({ "a.py": "x = 1\n" });
    const { skeleton } = await buildSkeleton(dir);
    expect(skeleton.entrypoints).toBeUndefined();
    expect(skeleton.degraded.some((d) => d.layer === "index")).toBe(true);
    expect(skeleton.degraded.some((d) => d.layer === "readme")).toBe(true);
    expect(readmeFirstParagraph(dir)).toBeNull();
  });
});

describe("LLM purpose 层(step-077 管线复用)", () => {
  it("无 LLM=off 显式降级(骨架独立可用,不冒充)", async () => {
    const dir = fixture(REPO);
    const profile = await queryProjectProfile(dir, { withLlm: true });
    expect(profile.llm).toBeUndefined();
    expect(profile.llmState.status).toBe("off");
    expect(profile.skeleton.purposeCandidates.length).toBeGreaterThan(0);
  });

  it("注入 stub LLM=产出 purpose/capabilities/drift(引用回查通过)", async () => {
    const dir = fixture(REPO);
    setSensingDeps({
      senseLlm: {
        async generate() {
          return JSON.stringify({
            items: [
              { ref: "purpose", summary: "面向自动驾驶数据集的视觉训练工具包", evidenceRef: "E1" },
              { ref: "cap-1", summary: "rosbag 转训练帧", evidenceRef: "E1" },
              { ref: "drift-1", summary: "改造成通用商品推荐系统会偏离主线", evidenceRef: "E2" },
            ],
          });
        },
      },
    });
    const profile = await queryProjectProfile(dir, { withLlm: true });
    expect(profile.llmState.status).toBe("ok");
    expect(profile.llm?.purpose).toContain("视觉训练");
    expect(profile.llm?.capabilities).toHaveLength(1);
    expect(profile.llm?.driftWarnings).toHaveLength(1);
  });

  it("LLM 输出带说明/markdown 围栏也能解析(不再整批拒收)", async () => {
    const dir = fixture(REPO);
    setSensingDeps({
      senseLlm: {
        async generate() {
          return "好的,以下是结果:\n```json\n" + JSON.stringify({
            items: [{ ref: "purpose", summary: "视觉训练工具包", evidenceRef: "E1" }],
          }) + "\n```\n请查收。";
        },
      },
    });
    const profile = await queryProjectProfile(dir, { withLlm: true });
    expect(profile.llmState.status).toBe("ok");
    expect(profile.llm?.purpose).toContain("视觉训练");
  });

  it("引用伪造=修复环后仍坏拒收(purpose 缺位=failed,不冒充)", async () => {
    const dir = fixture(REPO);
    setSensingDeps({
      senseLlm: {
        async generate() {
          return JSON.stringify({ items: [{ ref: "purpose", summary: "编造", evidenceRef: "FAKE-9" }] });
        },
      },
    });
    const profile = await queryProjectProfile(dir, { withLlm: true });
    expect(profile.llmState.status).toBe("failed");
    expect(profile.llm).toBeUndefined();
  });
});

describe("manifest 落盘与注入块", () => {
  it("write→load 往返;指纹不匹配=stale 如实标注;指纹同=LLM 产物缓存复用", async () => {
    const dir = fixture(REPO);
    // 首轮:注入合法 stub → LLM 产物进 manifest
    setSensingDeps({
      senseLlm: {
        async generate() {
          return JSON.stringify({ items: [{ ref: "purpose", summary: "视觉训练工具包", evidenceRef: "E1" }] });
        },
      },
    });
    const profile = await queryProjectProfile(dir, { withLlm: true });
    expect(profile.llmState.status).toBe("ok");
    const path = writeProjectProfile(dir, profile);
    expect(existsSync(path)).toBe(true);
    const loaded = loadProjectProfile(dir);
    expect(loaded?.stale).toBe(false);
    expect(loaded?.profile.llm?.purpose).toContain("视觉训练");
    // 指纹键=文件数:mtime;人为改旧→stale
    const bumped = JSON.parse(readFileSync(path, "utf-8")) as { fingerprint: string };
    bumped.fingerprint = "999:1";
    writeFileSync(path, JSON.stringify(bumped));
    expect(loadProjectProfile(dir)?.stale).toBe(true);
    // 指纹恢复=缓存复用:再查不调 LLM(stub 抛错即失败)
    writeFileSync(path, JSON.stringify(profile));
    setSensingDeps({ senseLlm: { async generate() { throw new Error("不应被调用(缓存命中)"); } } });
    const again = await queryProjectProfile(dir, { withLlm: true });
    expect(again.llmState.status).toBe("ok");
    expect(again.llm?.purpose).toContain("视觉训练");
  });

  it("注入块 ≤300 字符;无 manifest=空串(零注入)", async () => {
    const dir = fixture(REPO);
    expect(projectMainlineBlock(dir)).toBe("");
    const profile = await queryProjectProfile(dir, { withLlm: false });
    writeProjectProfile(dir, profile);
    const block = projectMainlineBlock(dir);
    if (profile.llm || profile.skeleton.purposeCandidates.length > 0) {
      expect(block.length).toBeLessThanOrEqual(300 + 40); // 300 预算+固定头
      expect(block).toContain("项目主线");
    }
    // 渲染面
    const text = renderProjectProfile(profile);
    expect(text).toContain("项目画像");
    expect(text).toContain("技术栈");
  });
});

// 2026-10-20 多仓实测:README 首段提取把语言切换行/安装代码块/badge alt 当 purpose,
// LLM 只能顺着噪声总结(dify 只写出「名为 Dify 的项目」、opencode 写成「curl 安装工具」)。
describe("README 首段抗导航噪声", () => {
  it("语言切换行/logo 行不算首段,取真正的描述段(ZCode 形态)", () => {
    const dir = fixture({
      "README.md": [
        "# ZCode", "", '<div align="center">', '  <img src="logo.png" alt="ZCode" />', "</div>",
        '<p align="center">', '  简体中文 | <a href="README.en.md">English</a>', "</p>",
        "", "ZCode 是 AI 编程工作台,提供桌面应用、浏览器界面和终端 Agent。", "", "## 更新",
      ].join("\n"),
    });
    const p = readmeFirstParagraph(dir);
    expect(p?.text).toContain("AI 编程工作台");
    expect(p?.line).toBe(10);
  });

  it("<p>单行一句话可取(opencode 形态);代码块不冒充首段", () => {
    const dir = fixture({
      "README.md": [
        '<p align="center">', '  <img src="logo.svg" alt="logo">', "</p>",
        '<p align="center">The open source AI coding agent.</p>',
        '<p align="center">', '  <a href="x"><img alt="Discord" src="badge.svg"></a>', "</p>",
        "", "### Installation", "```bash", "curl -fsSL https://example.com/install | bash", "```",
      ].join("\n"),
    });
    const p = readmeFirstParagraph(dir);
    expect(p?.text).toBe("The open source AI coding agent.");
  });

  it("badge 墙/alt 行跳过后继续找真段落(dify 形态),不抓第一行 alt=", () => {
    const dir = fixture({
      "README.md": [
        "![cover](./images/cover.png)", "", '<p align="center">',
        '  <a href="https://x">Cloud</a> ·', '  <a href="https://y">Docs</a>', "</p>", "",
        '<p align="center">', '    <img src="badge1.svg"', '        alt="chat on Discord"></a>',
        '    <img src="badge2.svg"', '        alt="join Reddit"></a>', "</p>", "",
        "Dify is an open-source LLM app development platform. Its interface combines AI workflow and RAG.",
        "", "## Quick start",
      ].join("\n"),
    });
    const p = readmeFirstParagraph(dir);
    expect(p?.text).toContain("open-source LLM app development platform");
  });

  it("只有导航/badge 的 README 返回 null(不用垃圾当 purpose)", () => {
    const dir = fixture({ "README.md": "![badge](x)\n\n[![b](y)](z)\n" });
    expect(readmeFirstParagraph(dir)).toBeNull();
  });

  it("badge 链接续行(纯 URL)跳过,取真正的描述段(fmt 形态)", () => {
    const dir = fixture({
      "README.md": [
        "[![image](https://example.com/badge.svg)](",
        "https://github.com/fmtlib/fmt/actions?query=workflow%3Alinux)",
        "",
        "**fmt** is an open-source formatting library providing a fast and safe alternative to C stdio.",
        "",
        "## Features",
        "- Simple format API",
      ].join("\n"),
    });
    const p = readmeFirstParagraph(dir);
    expect(p?.text).toContain("formatting library");
  });

  it("Resources 导航+程序性章节内容跳过;无散文时用描述性 H2 作 purpose(OpenCV 形态)", async () => {
    const dir = fixture({
      "README.md": [
        "## OpenCV: Open Source Computer Vision Library",
        "",
        "### Resources",
        "",
        "* Homepage: <https://opencv.org>",
        "  * Courses: <https://opencv.org/courses>",
        "* Docs: <https://docs.opencv.org/5.x/>",
        "",
        "### Contributing",
        "",
        "Please read the contribution guidelines before starting work.",
        "",
      ].join("\n"),
    });
    expect(readmeFirstParagraph(dir)).toBeNull();
    const { skeleton } = await buildSkeleton(dir);
    const p = skeleton.purposeCandidates.find((c) => c.source === "README 标题");
    expect(p?.text).toContain("OpenCV");
    expect(p?.evidence.line).toBe(1);
  });

  it("纯导航列表 README 不硬凑 purpose(Newtonsoft 形态)", () => {
    const dir = fixture({
      "README.md": [
        "# ![Logo](Doc/icons/logo.jpg) Json.NET",
        "",
        "- [Homepage](https://www.newtonsoft.com/json)",
        "- [Documentation](https://www.newtonsoft.com/json/help)",
      ].join("\n"),
    });
    expect(readmeFirstParagraph(dir)).toBeNull();
  });

  it("README.markdown 也能识别(Jekyll 形态)", () => {
    const dir = fixture({ "README.markdown": "Jekyll is a blog-aware static site generator in Ruby.\n" });
    expect(readmeFirstParagraph(dir)?.text).toContain("Jekyll");
  });

  it("安装/文档/贡献多链接导航行跳过(JupyterLab 形态)", () => {
    const dir = fixture({
      "README.md": [
        "**[Installation](#installation)** | **[Documentation](https://docs.example.com)** | **[Contributing](#contributing)**",
        "",
        "JupyterLab is the next-generation web-based user interface for Project Jupyter.",
      ].join("\n"),
    });
    const p = readmeFirstParagraph(dir);
    expect(p?.text).toContain("JupyterLab is");
  });

  it("多语言翻译导航行跳过(poly-electron 形态)", () => {
    const dir = fixture({
      "README.md": [
        ":memo: Available Translations: 🇨🇳 🇧🇷 🇪🇸 🇯🇵.",
        "View these docs in other languages on our [Crowdin](https://crowdin.com/project/electron) project.",
        "",
        "The Electron framework lets you write cross-platform desktop applications using JavaScript, HTML and CSS. It is based on [Node.js](https://nodejs.org/) and [Chromium](https://www.chromium.org) and is used by [Visual Studio Code](https://github.com/microsoft/vscode/) and many other [apps](https://electronjs.org/apps).",
      ].join("\n"),
    });
    const p = readmeFirstParagraph(dir);
    expect(p?.text).toContain("Electron framework");
  });
});

// 2026-10-20 实报:lampgenie-harness「总路线」把项目总结成「code-sense 框架指纹识别 + Python 解析」。
// 根因=指纹表自指 12 族假框架 + 无 README/description 时 LLM 硬猜 + 任务探针进产品入口。
describe("总路线失真修复:只认真实导入与产品级 purpose", () => {
  it("指纹表/任务文档/夹具字符串里的字面量不算框架(自指不再回 12 族)", async () => {
    const dir = fixture({
      "src/project-profile.ts": [
        "const FRAMEWORKS = [",
        '  { name: "FastAPI", literals: ["from fastapi", "import fastapi"] },',
        '  { name: "Express", literals: [\'require("express")\'] },',
        '  { name: "React", literals: [\'from "react"\'] },',
        "];",
      ].join("\n"),
      "tasks/step-001/step.md": "from fastapi import FastAPI\n",
      "docs/guide.md": "import torch\n",
      "src/fixture.ts": "const s = 'from \"react\"'; // 字符串不是导入\n",
      "src/py-fixture.ts": "const PY = `\nimport torch\nfrom flask import Flask\n`;\n", // 模板字符串里的 Python 片段
    });
    const r = await detectFrameworks(dir);
    expect(r.frameworks).toHaveLength(0);
    expect(r.domain).toBeUndefined();
  });

  it("真实 import 才算依赖;工具库不决定项目领域", async () => {
    const dir = fixture({
      "src/schema.ts": 'import { z } from "zod";\n',
      "src/app.py": "from flask import Flask\n",
      "src/routes.py": "from flask import Blueprint\n", // 领域判定要求 ≥2 个产品源码文件
    });
    const r = await detectFrameworks(dir);
    expect(r.frameworks.map((f) => f.name).sort()).toEqual(["Flask", "Zod"]);
    expect(r.domain).toBe("web-backend"); // Flask 是应用领域;Zod 只作依赖事实
  });

  it("Go import 块内的 Cobra 算依赖;文档里的同一字面量不算", async () => {
    const dir = fixture({
      "cmd/main.go": 'package main\n\nimport (\n\t"github.com/spf13/cobra"\n)\n\nfunc main() {}\n',
      "tasks/step-x/step.md": "使用 github.com/spf13/cobra 构建 CLI\n",
    });
    const r = await detectFrameworks(dir);
    expect(r.frameworks.map((f) => f.name)).toEqual(["Cobra"]);
    expect(r.frameworks[0]!.evidence.file).toBe("cmd/main.go");
  });

  it("只有仓库名/代码事实=语义层显式 failed,一次 LLM 都不调(不猜测)", async () => {
    const dir = fixture({
      "package.json": JSON.stringify({ name: "bare-repo" }),
      "src/a.ts": 'import { z } from "zod";\n',
    });
    let calls = 0;
    setSensingDeps({ senseLlm: { async generate() { calls++; return "{}"; } } });
    const profile = await queryProjectProfile(dir, { withLlm: true });
    expect(calls).toBe(0);
    expect(profile.llmState.status).toBe("failed");
    expect(profile.llmState.reason).toContain("README");
    expect(profile.llm).toBeUndefined();
  });

  it("仅仓库名的画像不注入项目主线(错误主线比零注入更伤)", async () => {
    const dir = fixture({ "package.json": JSON.stringify({ name: "bare-repo" }) });
    const profile = await queryProjectProfile(dir, { withLlm: false });
    writeProjectProfile(dir, profile);
    expect(projectMainlineBlock(dir)).toBe("");
  });

  it("README 章节标题作事实锚(推进 capability 判断),不冒充 purpose 候选", async () => {
    const dir = fixture({
      "README.md": [
        "# demo",
        "",
        "A local agent runtime for reliable code changes.",
        "",
        "## 白板规划",
        "Plan nodes with acceptance evidence.",
        "",
        "## 子代理编排",
        "Dispatch workers in isolated scopes.",
        "",
        "## Install",
        "pnpm install",
      ].join("\n"),
    });
    const { skeleton, anchors } = await buildSkeleton(dir);
    expect(skeleton.purposeCandidates.filter((c) => c.source === "README 首段")).toHaveLength(1);
    expect(anchors.some((a) => a.text.includes("README 章节 白板规划"))).toBe(true);
    expect(anchors.some((a) => a.text.includes("README 章节 子代理编排"))).toBe(true);
    expect(anchors.some((a) => a.text.includes("README 章节 Install"))).toBe(false); // 程序性章节不抬成能力
    expect(readmeHeadings(dir).map((h) => h.text)).not.toContain("Install");
  });

  it("tasks/docs/vendor 路径判为非产品(入口与框架证据都不取)", () => {
    expect(isNonProductPath("tasks/step-124/evidence/probe.cjs")).toBe(true);
    expect(isNonProductPath("docs/reference/x.ts")).toBe(true);
    expect(isNonProductPath("vendor/some-lib/tool.ts")).toBe(true);
    expect(isNonProductPath("apps/gateway/src/server.ts")).toBe(false);
  });

  it("旧代次缓存(无 generation)读侧失效,防止新骨架复用旧错误语义", async () => {
    const dir = fixture({ "README.md": "# demo\n\nA local agent runtime.\n" });
    const profile = await queryProjectProfile(dir, { withLlm: false });
    expect(profile.generation).toBe(2);
    const path = writeProjectProfile(dir, profile);
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    delete raw.generation;
    writeFileSync(path, JSON.stringify(raw));
    expect(loadProjectProfile(dir)).toBeNull();
  });
});
