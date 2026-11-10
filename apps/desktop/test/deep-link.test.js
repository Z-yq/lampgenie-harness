const test = require("node:test");
const assert = require("node:assert/strict");
const {
  extractDeepLinkUrlFromArgs,
  extractDeepLinkUrlFromSingleInstanceData,
  parseDeepLink,
} = require("../deep-link");

test("从 argv 提取深链:裸参数/引号包裹/大小写/首个匹配", () => {
  assert.equal(extractDeepLinkUrlFromArgs(["electron", "app", "genie://settings"]), "genie://settings");
  assert.equal(extractDeepLinkUrlFromArgs(['"C:\\x\\LampGenie.exe"', '"genie://task/abc"']), "genie://task/abc");
  assert.equal(extractDeepLinkUrlFromArgs(["GENIE://New-Task"]), "GENIE://New-Task");
  assert.equal(extractDeepLinkUrlFromArgs(["genie:/settings"]), "genie:/settings");
  assert.equal(extractDeepLinkUrlFromArgs(["genie:settings"]), "genie:settings");
  assert.equal(extractDeepLinkUrlFromArgs(["https://example.com", "--flag"]), null);
  assert.equal(extractDeepLinkUrlFromArgs([]), null);
  assert.equal(extractDeepLinkUrlFromArgs(null), null);
});

test("second-instance additionalData 优先解析", () => {
  assert.equal(extractDeepLinkUrlFromSingleInstanceData({ deepLinkUrl: "genie://settings" }), "genie://settings");
  assert.equal(extractDeepLinkUrlFromSingleInstanceData({ deepLinkUrl: 42 }), null);
  assert.equal(extractDeepLinkUrlFromSingleInstanceData(null), null);
  assert.equal(extractDeepLinkUrlFromSingleInstanceData({}), null);
});

test("parseDeepLink:settings/new-task/session/project/open", () => {
  assert.deepEqual(parseDeepLink("genie://settings"), { raw: "genie://settings", action: "settings", params: {} });
  assert.equal(parseDeepLink("genie://new-task").action, "new-task");
  assert.equal(parseDeepLink("genie://new").action, "new-task");
  const task = parseDeepLink("genie://task/abc-123");
  assert.equal(task.action, "session");
  assert.equal(task.sessionId, "abc-123");
  const session = parseDeepLink("genie://session/web-1793");
  assert.equal(session.action, "session");
  assert.equal(session.sessionId, "web-1793");
  const project = parseDeepLink("genie://project?path=C%3A%5Cwork%5Cdemo&label=Demo");
  assert.equal(project.action, "project");
  assert.equal(project.path, "C:\\work\\demo");
  assert.equal(project.label, "Demo");
  const open = parseDeepLink("genie://whatever/x");
  assert.equal(open.action, "open");
  assert.equal(open.path, "whatever/x");
});

test("parseDeepLink:非法 scheme/超长/空值返回 null", () => {
  assert.equal(parseDeepLink("https://example.com"), null);
  assert.equal(parseDeepLink(""), null);
  assert.equal(parseDeepLink(null), null);
  assert.equal(parseDeepLink("genie://" + "a".repeat(3000)), null);
  // project 缺 path → 落 open,不伪造路径
  const p = parseDeepLink("genie://project?label=x");
  assert.equal(p.action, "open");
});