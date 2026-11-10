const test = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { createHash } = require("node:crypto");
const { generateKeyPairSync, sign } = require("node:crypto");
const { gzipSync } = require("node:zlib");
const { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, utimesSync, statSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { readFileSync: readRepoFile } = require("node:fs");

const {
  compareVersions,
  normalizeVersion,
  canonicalManifestPayload,
  verifyManifestSignature,
  parseAuthenticodeOutput,
  checkAuthenticode,
  parseUpdateManifest,
  evaluateUpdate,
  readUpdateConfig,
  readDesktopUpdateConfig,
  writeUpdateConfig,
  pruneUpdateDir,
  installLaunchSpec,
  createUpdateChecker,
  safeFileName,
} = require("../update-check");

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function startServer(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return { server, port, url: `http://127.0.0.1:${port}` };
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/** 测试用 blockmap:块边界与校验和自行生成(生产格式只要求 checksums/sizes 对齐)。 */
function makeBlockMap(file, blockSizes) {
  const buf = readFileSync(file);
  const checksums = [];
  let offset = 0;
  for (const size of blockSizes) {
    checksums.push(sha256(buf.subarray(offset, offset + size)));
    offset += size;
  }
  return gzipSync(JSON.stringify({ version: "2", files: [{ name: "file", offset: 0, checksums, sizes: blockSizes }] }));
}

function serveBytes(req, res, payload) {
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d+)-(\d*)$/.exec(range);
    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : payload.length - 1;
    res.writeHead(206, {
      "content-type": "application/octet-stream",
      "content-length": end - start + 1,
      "content-range": `bytes ${start}-${end}/${payload.length}`,
    });
    res.end(payload.subarray(start, end + 1));
    return;
  }
  res.writeHead(200, { "content-length": payload.length });
  res.end(payload);
}

test("版本比较:数值段/预发布/v 前缀", () => {
  assert.equal(compareVersions("0.0.10", "0.0.9"), 1);
  assert.equal(compareVersions("0.0.9", "0.0.10"), -1);
  assert.equal(compareVersions("v0.0.10", "0.0.10"), 0);
  assert.equal(compareVersions("1.0.0", "0.9.9"), 1);
  assert.equal(compareVersions("1.0.0-beta.1", "1.0.0"), -1);
  assert.equal(compareVersions("1.0.0-beta.2", "1.0.0-beta.10"), -1);
  assert.equal(compareVersions("1.0.0-beta", "1.0.0-beta.1"), -1);
  assert.equal(compareVersions("1.0.0+build.5", "1.0.0"), 0);
  assert.equal(compareVersions("bad", "1.0.0"), null);
  assert.equal(normalizeVersion("  0.0.10 "), "0.0.10");
  assert.equal(normalizeVersion("release-1"), null);
});

test("清单解析:自有清单/GitHub Releases/非法输入", () => {
  const own = parseUpdateManifest(JSON.stringify({
    version: "0.0.10",
    url: "https://example.com/LampGenie%20Setup%200.0.10.exe",
    pageUrl: "https://example.com/releases/0.0.10",
    notes: "修复若干问题",
    sha256: "A".repeat(64),
    size: 1234.6,
    minVersion: "0.0.9",
  }));
  assert.equal(own.ok, true);
  assert.equal(own.manifest.version, "0.0.10");
  assert.equal(own.manifest.sha256, "a".repeat(64));
  assert.equal(own.manifest.size, 1234);
  assert.equal(own.manifest.minVersion, "0.0.9");

  const gh = parseUpdateManifest({
    tag_name: "v0.0.11",
    html_url: "https://github.com/x/y/releases/tag/v0.0.11",
    assets: [{ name: "notes.txt", size: 1, browser_download_url: "https://example.com/a.txt" },
      { name: "setup.exe", size: 999, browser_download_url: "https://example.com/LampGenie-Setup.exe" }],
  });
  assert.equal(gh.ok, true);
  assert.equal(gh.manifest.version, "0.0.11");
  assert.equal(gh.manifest.downloadUrl, "https://example.com/LampGenie-Setup.exe");
  assert.equal(gh.manifest.size, 999);

  assert.equal(parseUpdateManifest("not json").ok, false);
  assert.equal(parseUpdateManifest([]).ok, false);
  assert.equal(parseUpdateManifest({ version: "abc" }).ok, false);
  assert.equal(parseUpdateManifest({ version: "1.0.0", url: "file:///x.exe" }).manifest.downloadUrl, "");
});

test("升级判定:可用/最新/强制更新(minVersion)", () => {
  const manifest = parseUpdateManifest({ version: "0.0.10", url: "https://example.com/a.exe" }).manifest;
  const yes = evaluateUpdate("0.0.9", manifest);
  assert.equal(yes.available, true);
  assert.equal(yes.mandatory, false);
  const no = evaluateUpdate("0.0.10", manifest);
  assert.equal(no.available, false);
  const old = evaluateUpdate("0.0.8", { ...manifest, minVersion: "0.0.9" });
  assert.equal(old.mandatory, true);
  assert.equal(old.downloadUrl, "https://example.com/a.exe");
});

test("更新配置:文件/环境变量/非法值", () => {
  const dir = tmpDir("genie-update-cfg-");
  writeFileSync(join(dir, "genie.config.json"), JSON.stringify({
    update: { feedUrl: "https://example.com/update.json", autoCheck: true, intervalHours: 2 },
  }));
  const cfg = readUpdateConfig(dir, {});
  assert.equal(cfg.feedUrl, "https://example.com/update.json");
  assert.equal(cfg.intervalMs, 2 * 3600 * 1000);

  const envCfg = readUpdateConfig(dir, {
    GENIE_UPDATE_FEED_URL: "http://127.0.0.1:9999/feed.json",
    GENIE_UPDATE_AUTOCHECK: "0",
    GENIE_UPDATE_INTERVAL_HOURS: "48",
  });
  assert.equal(envCfg.feedUrl, "http://127.0.0.1:9999/feed.json");
  assert.equal(envCfg.autoCheck, false);
  assert.equal(envCfg.intervalMs, 48 * 3600 * 1000);

  const empty = readUpdateConfig(tmpDir("genie-update-cfg-empty-"), {});
  assert.equal(empty.feedUrl, "");
  // 非法 scheme 不进入请求面
  const bad = readUpdateConfig(dir, { GENIE_UPDATE_FEED_URL: "file:///etc/passwd" });
  assert.equal(bad.feedUrl, "");
});

test("安装启动规格:只允许更新目录内的 .exe", () => {
  const dir = tmpDir("genie-update-install-");
  const exe = join(dir, "update.exe");
  writeFileSync(exe, "stub");
  assert.equal(installLaunchSpec(exe, "win32", dir).ok, true);
  assert.deepEqual(installLaunchSpec(exe, "win32", dir).args, ["/S", "/currentuser", "--force-run"]);
  assert.equal(installLaunchSpec(exe, "linux", dir).ok, false);
  const outside = join(tmpDir("genie-update-outside-"), "update.exe");
  writeFileSync(outside, "stub");
  assert.equal(installLaunchSpec(outside, "win32", dir).ok, false);
  assert.equal(installLaunchSpec(join(dir, "update.txt"), "win32", dir).ok, false);
  assert.equal(installLaunchSpec(join(dir, "missing.exe"), "win32", dir).ok, false);
  assert.equal(safeFileName('LampGenie Setup 0.0.10.exe'), "LampGenie Setup 0.0.10.exe");
  const evil = safeFileName("../../evil.exe");
  assert.ok(!evil.includes("/") && !evil.includes("\\"));
  assert.notEqual(evil, "evil.exe");
});

test("更新配置:桌面壳 update-config.json 覆盖 genie.config.json,env 最高", () => {
  const dir = tmpDir("genie-update-priority-");
  writeFileSync(join(dir, "genie.config.json"), JSON.stringify({
    update: { feedUrl: "https://example.com/base.json", autoCheck: true, intervalHours: 6 },
  }));
  let cfg = readUpdateConfig(dir, {});
  assert.equal(cfg.feedUrl, "https://example.com/base.json");

  // 面板写入的桌面配置覆盖 genie.config.json
  writeUpdateConfig(dir, { feedUrl: "https://example.com/user.json", autoCheck: false, intervalHours: 2 });
  cfg = readUpdateConfig(dir, {});
  assert.equal(cfg.feedUrl, "https://example.com/user.json");
  assert.equal(cfg.autoCheck, false);
  assert.equal(cfg.intervalMs, 2 * 3600 * 1000);
  assert.equal(readDesktopUpdateConfig(dir).feedUrl, "https://example.com/user.json");

  // env 优先级最高(含 autoCheck 显式打开)
  cfg = readUpdateConfig(dir, {
    GENIE_UPDATE_FEED_URL: "http://127.0.0.1:1/env.json",
    GENIE_UPDATE_AUTOCHECK: "1",
    GENIE_UPDATE_INTERVAL_HOURS: "24",
  });
  assert.equal(cfg.feedUrl, "http://127.0.0.1:1/env.json");
  assert.equal(cfg.autoCheck, true);
  assert.equal(cfg.intervalMs, 24 * 3600 * 1000);

  // 清空桌面覆盖 → 回退 genie.config.json
  writeUpdateConfig(dir, { feedUrl: "" });
  cfg = readUpdateConfig(dir, {});
  assert.equal(cfg.feedUrl, "https://example.com/base.json");
  // 差分默认开,env 可关
  assert.equal(cfg.diff, true);
  assert.equal(readUpdateConfig(dir, { GENIE_UPDATE_DIFF: "0" }).diff, false);

  assert.throws(() => writeUpdateConfig(dir, { feedUrl: "file:///x" }), /http/);
});

test("更新目录清理:.part 过期清理/安装包只留最新1个/其它文件不动", () => {
  const dir = tmpDir("genie-update-prune-");
  const age = (file, ms) => {
    const t = new Date(Date.now() - ms);
    utimesSync(file, t, t);
  };
  const oldExe = join(dir, "old-setup.exe");
  const newExe = join(dir, "new-setup.exe");
  const stalePart = join(dir, "broken.exe.part");
  const freshPart = join(dir, "active.exe.part");
  const note = join(dir, "notes.txt");
  for (const f of [oldExe, newExe, stalePart, freshPart, note]) writeFileSync(f, "x");
  age(oldExe, 3 * 3600 * 1000);
  age(newExe, 5 * 1000);
  age(stalePart, 2 * 3600 * 1000);
  age(freshPart, 5 * 1000);
  const r = pruneUpdateDir(dir, { keepPath: newExe });
  assert.equal(existsSync(oldExe), false);
  assert.equal(existsSync(newExe), true);
  assert.equal(existsSync(stalePart), false);
  assert.equal(existsSync(freshPart), true);
  assert.equal(existsSync(note), true);
  assert.ok(r.removed.some((p) => p.endsWith("old-setup.exe")));

  // keepPath 不存在时按 mtime 保留最新 1 个
  const dir2 = tmpDir("genie-update-prune2-");
  const a = join(dir2, "a.exe");
  const b = join(dir2, "b.exe");
  writeFileSync(a, "x");
  writeFileSync(b, "x");
  age(a, 10 * 60 * 1000);
  age(b, 5 * 1000);
  pruneUpdateDir(dir2, {});
  assert.equal(existsSync(a), false);
  assert.equal(existsSync(b), true);

  // 目录不存在不抛
  assert.deepEqual(pruneUpdateDir(join(dir2, "nope"), {}).removed, []);

  // 可续传半成品(.part + .meta.json)2 小时后仍保留;孤儿 meta 删除;超 7 天的可续传半成品删除
  const dir3 = tmpDir("genie-update-prune3-");
  const resPart = join(dir3, "resume.exe.part");
  const resMeta = resPart + ".meta.json";
  const orphanMeta = join(dir3, "gone.exe.part.meta.json");
  const oldResPart = join(dir3, "old-resume.exe.part");
  for (const f of [resPart, resMeta, orphanMeta, oldResPart]) writeFileSync(f, "x");
  writeFileSync(oldResPart + ".meta.json", "{}");
  age(resPart, 2 * 3600 * 1000);
  age(resMeta, 2 * 3600 * 1000);
  age(orphanMeta, 5 * 1000);
  age(oldResPart, 8 * 24 * 3600 * 1000);
  age(oldResPart + ".meta.json", 8 * 24 * 3600 * 1000);
  pruneUpdateDir(dir3, {});
  assert.equal(existsSync(resPart), true, "带 meta 的半成品应保留");
  assert.equal(existsSync(resMeta), true);
  assert.equal(existsSync(orphanMeta), false, "孤儿 meta 应删除");
  assert.equal(existsSync(oldResPart), false, "超 7 天的半成品应删除");
});

test("下载成功后顺带清理旧安装包与半成品", async () => {
  const payload = Buffer.from("fresh installer bytes");
  const { server, url } = await startServer((req, res) => {
    if (req.url === "/feed.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ version: "0.0.10", url: url + "/new.exe", sha256: sha256(payload), size: payload.length }));
      return;
    }
    res.writeHead(200, { "content-length": payload.length });
    res.end(payload);
  });
  try {
    const dir = tmpDir("genie-update-dl-prune-");
    const updates = join(dir, "updates");
    mkdirSync(updates, { recursive: true });
    const oldExe = join(updates, "old.exe");
    const stalePart = join(updates, "stale.exe.part");
    writeFileSync(oldExe, "old");
    writeFileSync(stalePart, "part");
    const old = new Date(Date.now() - 3 * 3600 * 1000);
    utimesSync(oldExe, old, old);
    utimesSync(stalePart, old, old);
    const checker = createUpdateChecker({
      currentVersion: "0.0.9",
      feedUrl: url + "/feed.json",
      downloadDir: updates,
      log: () => undefined,
    });
    await checker.checkNow({ reason: "manual" });
    const r = await checker.download();
    assert.equal(r.ok, true);
    assert.equal(existsSync(oldExe), false);
    assert.equal(existsSync(stalePart), false);
    assert.equal(existsSync(r.downloadedPath), true);
  } finally {
    server.close();
  }
});

test("断点续传:中断保留 .part,重试发 Range(206)续传并通过 sha256", async () => {
  const payload = Buffer.alloc(400 * 1024);
  for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
  const expected = sha256(payload);
  let first = true;
  const ranges = [];
  const { server, url } = await startServer((req, res) => {
    if (req.url === "/feed.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ version: "0.0.10", url: url + "/big.exe", sha256: expected, size: payload.length }));
      return;
    }
    const range = req.headers.range || "";
    ranges.push(range);
    if (first) {
      first = false;
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": payload.length });
      res.write(payload.subarray(0, 100 * 1024));
      setTimeout(() => res.destroy(), 30);
      return;
    }
    if (range) {
      const m = /^bytes=(\d+)-$/.exec(range);
      const start = Number(m[1]);
      res.writeHead(206, {
        "content-type": "application/octet-stream",
        "content-length": payload.length - start,
        "content-range": `bytes ${start}-${payload.length - 1}/${payload.length}`,
      });
      res.end(payload.subarray(start));
      return;
    }
    res.writeHead(200, { "content-length": payload.length });
    res.end(payload);
  });
  try {
    const dir = tmpDir("genie-resume-");
    const updates = join(dir, "updates");
    const checker = createUpdateChecker({
      currentVersion: "0.0.9",
      feedUrl: url + "/feed.json",
      downloadDir: updates,
      log: () => undefined,
    });
    await checker.checkNow({ reason: "manual" });
    const r1 = await checker.download();
    assert.equal(r1.ok, false);
    assert.equal(r1.resumable, true);
    assert.ok(r1.resumableBytes > 0 && r1.resumableBytes < payload.length);
    assert.equal(checker.getState().status, "available");
    assert.match(checker.getState().error, /中断|terminated|socket|aborted|下载/i);
    const part = join(updates, "big.exe.part");
    assert.ok(existsSync(part), "中断后半成品应保留");
    assert.ok(existsSync(part + ".meta.json"), "续传元数据应保留");
    const partSize = statSync(part).size;

    const r2 = await checker.download();
    assert.equal(r2.ok, true);
    assert.equal(checker.getState().status, "downloaded");
    assert.equal(checker.getState().verified, true);
    assert.equal(readFileSync(r2.downloadedPath).length, payload.length);
    assert.equal(sha256(readFileSync(r2.downloadedPath)), expected);
    assert.ok(ranges.some((r) => r === `bytes=${partSize}-`), "应发出与半成品大小一致的 Range");
    assert.equal(existsSync(part), false);
    assert.equal(existsSync(part + ".meta.json"), false);
  } finally {
    server.close();
  }
});

test("断点续传:服务器忽略 Range(200)时从头写并成功", async () => {
  const payload = Buffer.alloc(200 * 1024, 5);
  const expected = sha256(payload);
  const ranges = [];
  const { server, url } = await startServer((req, res) => {
    if (req.url === "/feed.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ version: "0.0.10", url: url + "/big.exe", sha256: expected, size: payload.length }));
      return;
    }
    ranges.push(req.headers.range || "");
    res.writeHead(200, { "content-length": payload.length });
    res.end(payload);
  });
  try {
    const dir = tmpDir("genie-resume-200-");
    const updates = join(dir, "updates");
    mkdirSync(updates, { recursive: true });
    const part = join(updates, "big.exe.part");
    writeFileSync(part, payload.subarray(0, 50 * 1024));
    writeFileSync(part + ".meta.json", JSON.stringify({
      url: url + "/big.exe", sha256: expected, size: payload.length, version: "0.0.10",
    }));
    const checker = createUpdateChecker({
      currentVersion: "0.0.9",
      feedUrl: url + "/feed.json",
      downloadDir: updates,
      log: () => undefined,
    });
    await checker.checkNow({ reason: "manual" });
    const r = await checker.download();
    assert.equal(r.ok, true);
    assert.equal(readFileSync(r.downloadedPath).length, payload.length);
    assert.equal(sha256(readFileSync(r.downloadedPath)), expected);
    assert.ok(ranges[0].startsWith("bytes="), "首选应尝试 Range");
    assert.equal(existsSync(part), false);
  } finally {
    server.close();
  }
});

test("断点续传:416 清理半成品;版本不匹配的旧半成品不发 Range", async () => {
  const payload = Buffer.alloc(120 * 1024, 9);
  const expected = sha256(payload);
  const modes = { reject: true, ranges: [] };
  const { server, url } = await startServer((req, res) => {
    if (req.url === "/feed.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ version: "0.0.10", url: url + "/big.exe", sha256: expected, size: payload.length }));
      return;
    }
    modes.ranges.push(req.headers.range || "");
    if (modes.reject) {
      res.writeHead(416, { "content-range": `bytes */${payload.length}` });
      res.end();
      return;
    }
    res.writeHead(200, { "content-length": payload.length });
    res.end(payload);
  });
  try {
    // 416:有可续传半成品但服务端拒绝
    const dir = tmpDir("genie-resume-416-");
    const updates = join(dir, "updates");
    mkdirSync(updates, { recursive: true });
    const part = join(updates, "big.exe.part");
    writeFileSync(part, payload.subarray(0, 30 * 1024));
    writeFileSync(part + ".meta.json", JSON.stringify({
      url: url + "/big.exe", sha256: expected, size: payload.length, version: "0.0.10",
    }));
    const checker = createUpdateChecker({
      currentVersion: "0.0.9",
      feedUrl: url + "/feed.json",
      downloadDir: updates,
      log: () => undefined,
    });
    await checker.checkNow({ reason: "manual" });
    const r = await checker.download();
    assert.equal(r.ok, false);
    assert.match(r.error, /416/);
    assert.equal(existsSync(part), false);
    assert.equal(existsSync(part + ".meta.json"), false);

    // 版本不匹配:meta 的 sha 不同 → 直接重下,不发 Range
    modes.reject = false;
    modes.ranges.length = 0;
    const dir2 = tmpDir("genie-resume-mismatch-");
    const updates2 = join(dir2, "updates");
    mkdirSync(updates2, { recursive: true });
    const part2 = join(updates2, "big.exe.part");
    writeFileSync(part2, payload.subarray(0, 30 * 1024));
    writeFileSync(part2 + ".meta.json", JSON.stringify({
      url: url + "/big.exe", sha256: "f".repeat(64), size: payload.length, version: "0.0.9",
    }));
    const checker2 = createUpdateChecker({
      currentVersion: "0.0.9",
      feedUrl: url + "/feed.json",
      downloadDir: updates2,
      log: () => undefined,
    });
    await checker2.checkNow({ reason: "manual" });
    const r2 = await checker2.download();
    assert.equal(r2.ok, true);
    assert.equal(modes.ranges[0], "", "版本不匹配时不应发 Range");
  } finally {
    server.close();
  }
});

test("断点续传:半成品已等于清单大小时跳过下载直接校验", async () => {
  const payload = Buffer.alloc(100 * 1024, 4);
  const expected = sha256(payload);
  let installerRequests = 0;
  const { server, url } = await startServer((req, res) => {
    if (req.url === "/feed.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ version: "0.0.10", url: url + "/big.exe", sha256: expected, size: payload.length }));
      return;
    }
    if (req.url.endsWith(".blockmap")) {
      res.writeHead(404).end();
      return;
    }
    installerRequests += 1;
    res.writeHead(200, { "content-length": payload.length });
    res.end(payload);
  });
  try {
    const dir = tmpDir("genie-resume-verify-");
    const updates = join(dir, "updates");
    mkdirSync(updates, { recursive: true });
    const part = join(updates, "big.exe.part");
    writeFileSync(part, payload);
    writeFileSync(part + ".meta.json", JSON.stringify({
      url: url + "/big.exe", sha256: expected, size: payload.length, version: "0.0.10",
    }));
    const checker = createUpdateChecker({
      currentVersion: "0.0.9",
      feedUrl: url + "/feed.json",
      downloadDir: updates,
      diff: false,
      log: () => undefined,
    });
    await checker.checkNow({ reason: "manual" });
    const r = await checker.download();
    assert.equal(r.ok, true);
    assert.equal(installerRequests, 0, "完整半成品不应再发起下载请求");
    assert.equal(checker.getState().verified, true);
    assert.equal(existsSync(part), false);
  } finally {
    server.close();
  }
});

test("差分下载:复用旧包未变化块,只 Range 下载变化块", async () => {
  const blockSize = 32 * 1024;
  const oldPayload = Buffer.alloc(blockSize * 4);
  for (let i = 0; i < oldPayload.length; i++) oldPayload[i] = (i * 7) % 251;
  const newPayload = Buffer.from(oldPayload);
  for (let i = blockSize * 2; i < blockSize * 3; i++) newPayload[i] = (newPayload[i] + 13) % 256;
  const sizes = [blockSize, blockSize, blockSize, blockSize];
  const dir = tmpDir("genie-diff-");
  const updates = join(dir, "updates");
  mkdirSync(updates, { recursive: true });
  const oldPath = join(updates, "old-setup.exe");
  writeFileSync(oldPath, oldPayload);
  writeFileSync(oldPath + ".blockmap", makeBlockMap(oldPath, sizes));
  const newPath = join(dir, "new-setup.exe");
  writeFileSync(newPath, newPayload);
  const newBlockmap = makeBlockMap(newPath, sizes);
  const ranges = [];
  const { server, url } = await startServer((req, res) => {
    if (req.url === "/feed.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        version: "0.0.10",
        url: url + "/installer.exe",
        blockmapUrl: url + "/installer.exe.blockmap",
        sha256: sha256(newPayload),
        size: newPayload.length,
      }));
      return;
    }
    if (req.url === "/installer.exe.blockmap") {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": newBlockmap.length });
      res.end(newBlockmap);
      return;
    }
    ranges.push(req.headers.range || "");
    serveBytes(req, res, newPayload);
  });
  try {
    const checker = createUpdateChecker({
      currentVersion: "0.0.9",
      feedUrl: url + "/feed.json",
      downloadDir: updates,
      log: () => undefined,
    });
    await checker.checkNow({ reason: "manual" });
    const r = await checker.download();
    assert.equal(r.ok, true);
    assert.equal(r.diff.matchedBytes, blockSize * 3);
    assert.equal(r.diff.downloadedBytes, blockSize);
    assert.deepEqual(ranges, [`bytes=${blockSize * 2}-${blockSize * 3 - 1}`], "只应请求变化块的 Range");
    assert.equal(sha256(readFileSync(r.downloadedPath)), sha256(newPayload));
    assert.equal(existsSync(join(updates, "installer.exe.blockmap")), true, "新 blockmap 应落盘供下次差分");
    assert.equal(existsSync(oldPath), false, "旧安装包应被清理");
    assert.equal(existsSync(oldPath + ".blockmap"), false);
  } finally {
    server.close();
  }
});

test("差分下载:无可复用旧包时回退全量并成功", async () => {
  const payload = Buffer.alloc(90 * 1024, 6);
  const mapFile = join(tmpDir("genie-diff-fallback-"), "m.bin");
  writeFileSync(mapFile, payload);
  const blockmap = makeBlockMap(mapFile, [payload.length]);
  let installerRequests = 0;
  const { server, url } = await startServer((req, res) => {
    if (req.url === "/feed.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        version: "0.0.10",
        url: url + "/installer.exe",
        blockmapUrl: url + "/installer.exe.blockmap",
        sha256: sha256(payload),
        size: payload.length,
      }));
      return;
    }
    if (req.url === "/installer.exe.blockmap") {
      res.writeHead(200, { "content-length": blockmap.length });
      res.end(blockmap);
      return;
    }
    installerRequests += 1;
    serveBytes(req, res, payload);
  });
  try {
    const updates = join(tmpDir("genie-diff-fallback-dl-"), "updates");
    const checker = createUpdateChecker({
      currentVersion: "0.0.9",
      feedUrl: url + "/feed.json",
      downloadDir: updates,
      log: () => undefined,
    });
    await checker.checkNow({ reason: "manual" });
    const r = await checker.download();
    assert.equal(r.ok, true);
    assert.equal(r.diff, undefined, "回退全量时不应带 diff 结果");
    assert.equal(installerRequests, 1);
    assert.equal(sha256(readFileSync(r.downloadedPath)), sha256(payload));
  } finally {
    server.close();
  }
});

function signUpdateManifest(raw, privateKey) {
  const parsed = parseUpdateManifest(raw);
  assert.equal(parsed.ok, true);
  const payload = Buffer.from(canonicalManifestPayload(parsed.manifest), "utf8");
  return { ...raw, signature: sign(null, payload, privateKey).toString("base64") };
}

test("清单 Ed25519 验签:有效/被篡改/未签名降级/强制签名", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = publicKey.export({ type: "spki", format: "pem" });
  const base = {
    version: "0.0.10",
    url: "https://example.com/LampGenie Setup 0.0.10.exe",
    sha256: "a".repeat(64),
    size: 1234,
    notes: "release notes",
  };
  const signed = signUpdateManifest(base, privateKey);
  assert.equal(verifyManifestSignature(parseUpdateManifest(signed).manifest, pub).status, "verified");

  let body = signed;
  const { server, url } = await startServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  try {
    const checker = createUpdateChecker({
      currentVersion: "0.0.9",
      feedUrl: url + "/update.json",
      publicKey: pub,
      log: () => undefined,
    });
    const r = await checker.checkNow({ reason: "manual" });
    assert.equal(r.ok, true);
    assert.equal(r.available, true);
    assert.equal(checker.getState().signatureStatus, "verified");

    // 篡改 notes 后签名失效 → 必须拒绝该更新
    body = { ...signed, notes: "tampered" };
    const bad = createUpdateChecker({ currentVersion: "0.0.9", feedUrl: url + "/update.json", publicKey: pub, log: () => undefined });
    const rb = await bad.checkNow({ reason: "manual" });
    assert.equal(rb.ok, false);
    assert.match(rb.error, /签名无效|验签失败/);
    assert.equal(bad.getState().status, "error");

    // 无签名:默认降级为 unsigned 但仍可用;强制签名时拒绝
    body = base;
    const plain = createUpdateChecker({ currentVersion: "0.0.9", feedUrl: url + "/update.json", publicKey: pub, log: () => undefined });
    const rp = await plain.checkNow({ reason: "manual" });
    assert.equal(rp.ok, true);
    assert.equal(plain.getState().signatureStatus, "unsigned");

    const strict = createUpdateChecker({
      currentVersion: "0.0.9",
      feedUrl: url + "/update.json",
      publicKey: pub,
      requireSignature: true,
      log: () => undefined,
    });
    const rs = await strict.checkNow({ reason: "manual" });
    assert.equal(rs.ok, false);
    assert.match(rs.error, /强制签名|未提供发布者签名/);
    assert.equal(strict.getState().status, "error");
  } finally {
    server.close();
  }
});

test("Authenticode 解析/探测注入/平台降级", async () => {
  assert.equal(parseAuthenticodeOutput(JSON.stringify({ Status: "NotSigned", StatusMessage: "", Signer: "" })).status, "NotSigned");
  assert.equal(parseAuthenticodeOutput(JSON.stringify({ Status: "Valid", Signer: "CN=Test" })).signer, "CN=Test");
  assert.equal(parseAuthenticodeOutput("not json").status, "unknown");

  const calls = [];
  const fakeOk = (cmd, argv, opts, cb) => {
    calls.push(argv);
    cb(null, JSON.stringify({ Status: "NotSigned", StatusMessage: "not signed", Signer: "" }));
  };
  const r = await checkAuthenticode("C:\\x\\a.exe", { platform: "win32", execFileImpl: fakeOk });
  assert.equal(r.status, "NotSigned");
  assert.ok(calls[0].includes("-Command"));

  const r2 = await checkAuthenticode("C:\\x\\a.exe", { platform: "linux" });
  assert.equal(r2.status, "unsupported");

  const r3 = await checkAuthenticode("C:\\x\\a.exe", {
    platform: "win32",
    execFileImpl: (cmd, argv, opts, cb) => cb(new Error("probe failed")),
  });
  assert.equal(r3.status, "unknown");
  assert.match(r3.error, /probe failed/);
});

test("检查器:发现新版本/已是最新/未配置/并发去重/状态落盘", async () => {
  const { server, url } = await startServer((req, res) => {
    if (req.url === "/feed.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ version: "0.0.10", notes: "修复 3 个问题", pageUrl: "https://example.com/notes" }));
    } else {
      res.writeHead(404).end("no");
    }
  });
  try {
    const dir = tmpDir("genie-update-check-");
    const states = [];
    const checker = createUpdateChecker({
      currentVersion: "0.0.9",
      feedUrl: url + "/feed.json",
      stateFile: join(dir, "update-state.json"),
      downloadDir: join(dir, "updates"),
      onState: (s) => states.push(s.status),
      log: () => undefined,
    });
    const r1 = await checker.checkNow({ reason: "manual" });
    assert.equal(r1.ok, true);
    assert.equal(r1.available, true);
    assert.equal(checker.getState().status, "available");
    assert.equal(checker.getState().latestVersion, "0.0.10");
    assert.equal(checker.getState().manual, true);
    assert.ok(states.includes("checking"));
    const persisted = JSON.parse(readFileSync(join(dir, "update-state.json"), "utf8"));
    assert.equal(persisted.latestVersion, "0.0.10");
    assert.equal(typeof persisted.lastCheckedAt, "number");

    // 已是最新
    const up = createUpdateChecker({
      currentVersion: "0.0.10",
      feedUrl: url + "/feed.json",
      log: () => undefined,
    });
    const r2 = await up.checkNow({ reason: "auto" });
    assert.equal(r2.ok, true);
    assert.equal(r2.available, false);
    assert.equal(up.getState().status, "up-to-date");

    // 未配置更新源:不发请求,状态 disabled
    const disabled = createUpdateChecker({ currentVersion: "0.0.9", log: () => undefined });
    const r3 = await disabled.checkNow({ reason: "manual" });
    assert.equal(r3.ok, false);
    assert.equal(r3.disabled, true);
    assert.equal(disabled.getState().status, "disabled");
    assert.equal(disabled.getState().manual, true);

    // 并发两次手动检查只打一次源
    let count = 0;
    const counting = createUpdateChecker({
      currentVersion: "0.0.9",
      feedUrl: url + "/feed.json",
      fetchImpl: async (...args) => {
        count += 1;
        return fetch(...args);
      },
      log: () => undefined,
    });
    await Promise.all([counting.checkNow({ reason: "manual" }), counting.checkNow({ reason: "manual" })]);
    assert.equal(count, 1);
  } finally {
    server.close();
  }
});

test("检查器:忽略更新后手动检查会重新展示", async () => {
  const { server, url } = await startServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ version: "0.0.10" }));
  });
  try {
    const checker = createUpdateChecker({ currentVersion: "0.0.9", feedUrl: url + "/feed.json", log: () => undefined });
    await checker.checkNow({ reason: "auto" });
    assert.equal(checker.dismiss().ok, true);
    assert.equal(checker.getState().dismissed, true);
    await checker.checkNow({ reason: "manual" });
    assert.equal(checker.getState().dismissed, false);
  } finally {
    server.close();
  }
});

test("下载:进度/sha256 校验/半成品清理", async () => {
  const payload = Buffer.alloc(320 * 1024, 7);
  const expected = sha256(payload);
  const { server, url } = await startServer((req, res) => {
    if (req.url === "/feed.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        version: "0.0.10",
        url: url + "/LampGenie%20Setup.exe",
        sha256: expected,
        size: payload.length,
      }));
      return;
    }
    if (req.url === "/LampGenie%20Setup.exe") {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": payload.length });
      // 分块写出,确保进度回调有中间态
      res.write(payload.subarray(0, 64 * 1024));
      setTimeout(() => res.end(payload.subarray(64 * 1024)), 30);
      return;
    }
    res.writeHead(404).end("no");
  });
  try {
    const dir = tmpDir("genie-update-dl-");
    const progresses = [];
    const checker = createUpdateChecker({
      currentVersion: "0.0.9",
      feedUrl: url + "/feed.json",
      downloadDir: join(dir, "updates"),
      onState: (s) => {
        if (s.status === "downloading" && s.progress) progresses.push(s.progress.received);
      },
      log: () => undefined,
    });
    await checker.checkNow({ reason: "manual" });
    const r = await checker.download();
    assert.equal(r.ok, true);
    assert.equal(existsSync(r.downloadedPath), true);
    assert.equal(readFileSync(r.downloadedPath).length, payload.length);
    assert.equal(existsSync(r.downloadedPath + ".part"), false);
    assert.equal(checker.getState().status, "downloaded");
    assert.equal(checker.getState().verified, true);
    assert.equal(checker.getState().progress.percent, 100);
    assert.ok(progresses.length >= 1);
  } finally {
    server.close();
  }
});

test("下载失败:sha256 不符/大小不符时不落最终文件", async () => {
  const payload = Buffer.from("hello update");
  const { server, url } = await startServer((req, res) => {
    if (req.url === "/feed.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        version: "0.0.10",
        url: url + "/bad.exe",
        sha256: "b".repeat(64),
        size: payload.length,
      }));
      return;
    }
    res.writeHead(200, { "content-length": payload.length });
    res.end(payload);
  });
  try {
    const dir = tmpDir("genie-update-bad-");
    const checker = createUpdateChecker({
      currentVersion: "0.0.9",
      feedUrl: url + "/feed.json",
      downloadDir: join(dir, "updates"),
      log: () => undefined,
    });
    await checker.checkNow({ reason: "manual" });
    const r = await checker.download();
    assert.equal(r.ok, false);
    assert.match(r.error, /sha256/);
    assert.equal(existsSync(join(dir, "updates", "bad.exe")), false);
    assert.equal(existsSync(join(dir, "updates", "bad.exe.part")), false);
    // 下载失败回到 available(横幅留在面板上可重试),错误文案进 state.error
    assert.equal(checker.getState().status, "available");
    assert.match(checker.getState().error, /sha256/);
  } finally {
    server.close();
  }
});

test("检查器:更新源 500/超时归类为 error 且保留手动标记", async () => {
  const { server, url } = await startServer((req, res) => {
    res.writeHead(500).end("boom");
  });
  try {
    const checker = createUpdateChecker({ currentVersion: "0.0.9", feedUrl: url + "/feed.json", log: () => undefined });
    const r = await checker.checkNow({ reason: "manual" });
    assert.equal(r.ok, false);
    assert.match(r.error, /HTTP 500/);
    assert.equal(checker.getState().status, "error");
    assert.equal(checker.getState().manual, true);
  } finally {
    server.close();
  }
});

test("main.js 接线:初始化/手动检查/IPC 白名单/安装启动/托盘入口", () => {
  const src = readRepoFile(join(__dirname, "..", "main.js"), "utf8");
  assert.ok(src.includes("initUpdateChecker()"));
  assert.ok(src.includes('ipcMain.handle("genie:update"'));
  for (const act of ['act === "state"', 'act === "check"', 'act === "download"', 'act === "install"', 'act === "open-page"', 'act === "dismiss"', 'act === "configure"']) {
    assert.ok(src.includes(act), "缺少 IPC 动作 " + act);
  }
  assert.ok(src.includes("installLaunchSpec("));
  assert.ok(src.includes("writeUpdateConfig("));
  assert.ok(src.includes("updateChecker.pruneDownloads()"));
  assert.ok(src.includes("checkAuthenticode("));
  assert.ok(src.includes("sha256FileAsync("));
  assert.ok(src.includes("needsConfirm: true"));
  assert.ok(src.includes("readUpdateConfig(dataRoot, process.env)"));
  assert.ok(src.includes("updateChecker.start()"));
  assert.ok(src.includes('onCheckUpdate: () => manualUpdateCheck()'));
  // 安装器启动失败不能静默退出应用
  assert.ok(src.includes('child.once("error"'));
  assert.ok(src.includes("if (!launch.ok)"));
});