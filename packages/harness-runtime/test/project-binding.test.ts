import { describe, it, expect } from "vitest";
import { normalizeRepoUrl, matchProjectId } from "../src/team/project-binding";
import { InviteStore } from "../src/team/invite-store";
import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("normalizeRepoUrl(designs/23 绑定键归一化)", () => {
  it("协议/凭据/scp/尾斜杠/.git 后缀/大小写全部归一", () => {
    const want = normalizeRepoUrl("https://codeup.aliyun.com/636228d50cd435624679a77b/CMG-Live/lampgenie-harness.git");
    expect(normalizeRepoUrl("https://codeup.aliyun.com/636228d50cd435624679a77b/CMG-Live/lampgenie-harness")).toBe(want);
    expect(normalizeRepoUrl("https://codeup.aliyun.com/636228d50cd435624679a77b/CMG-Live/lampgenie-harness/")).toBe(want);
    expect(normalizeRepoUrl("git@codeup.aliyun.com:636228d50cd435624679a77b/CMG-Live/lampgenie-harness.git")).toBe(want);
    expect(normalizeRepoUrl("ssh://git@codeup.aliyun.com/636228d50cd435624679a77b/CMG-Live/lampgenie-harness")).toBe(want);
    expect(normalizeRepoUrl("HTTPS://Codeup.Aliyun.com/636228d50cd435624679a77b/cmg-live/Genie-Harness.GIT")).toBe(want);
    expect(normalizeRepoUrl("https://user:token@codeup.aliyun.com/636228d50cd435624679a77b/CMG-Live/lampgenie-harness.git")).toBe(want);
  });

  it("不同仓不误配;空串安全", () => {
    const a = normalizeRepoUrl("https://x.com/a/b.git");
    expect(normalizeRepoUrl("https://x.com/a/c.git")).not.toBe(a);
    expect(normalizeRepoUrl("")).toBe("");
  });
});

describe("matchProjectId(designs/23 绑定解析)", () => {
  const registry = {
    "lampgenie-harness": { type: "team", repo: "https://codeup.aliyun.com/636228d50cd435624679a77b/CMG-Live/lampgenie-harness.git" },
    "teamai": { type: "team", repo: "https://codeup.aliyun.com/636228d50cd435624679a77b/CMG-Live/genie-teamai.git" },
  };

  it("remote 归一化命中", () => {
    expect(matchProjectId(registry, "https://codeup.aliyun.com/636228d50cd435624679a77b/CMG-Live/lampgenie-harness.git", "whatever")).toBe("lampgenie-harness");
    expect(matchProjectId(registry, "git@codeup.aliyun.com:636228d50cd435624679a77b/CMG-Live/genie-teamai.git", "x")).toBe("teamai");
  });

  it("无 remote 回退 label 匹配(大小写不敏感)", () => {
    expect(matchProjectId(registry, null, "lampgenie-harness")).toBe("lampgenie-harness");
    expect(matchProjectId(registry, null, "Genie-Harness")).toBe("lampgenie-harness");
  });

  it("绑不上返回 null(候选-only 信号)", () => {
    expect(matchProjectId(registry, "https://github.com/some/other.git", "other")).toBeNull();
    expect(matchProjectId(registry, null, "unknown")).toBeNull();
    expect(matchProjectId({}, "https://x.com/a/b.git", "b")).toBeNull();
  });
});

describe("InviteRecord.projects(designs/23 邀请绑定项目)", () => {
  it("issue 带项目→兑换记录携带;旧记录缺字段归一空数组", () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-invproj-"));
    const file = join(dir, "invites.jsonl");
    try {
      const store = new InviteStore(file);
      store.issue("code-1", "zhongyuqi", Date.now() + 60_000, ["lampgenie-harness"]);
      expect(store.get("code-1")?.projects).toEqual(["lampgenie-harness"]);
      // 模拟旧记录(无 projects 字段)落盘后重载
      appendFileSync(file, JSON.stringify({ code: "legacy-1", createdAt: Date.now(), expiresAt: Date.now() + 60_000, createdBy: "x", redeemedBy: null, redeemedAt: null, branch: null }) + "\n");
      const store2 = new InviteStore(file);
      expect(store2.get("legacy-1")?.projects).toEqual([]);
      expect(store2.get("code-1")?.projects).toEqual(["lampgenie-harness"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
