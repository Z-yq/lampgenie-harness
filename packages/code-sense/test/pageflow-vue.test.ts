/**
 * Vue Router pageflow 剖面(step-019 二期收口):createRouter 路由表/router-link 边/
 * router.push 编程式;与 React/HTML 组合同跑不串。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseVueRoutes, pageFlow } from "../src/pageflow/index.js";

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "pf-vue-")); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("parseVueRoutes", () => {
  it("createRouter 路由表 + router-link + router.push 三面齐", async () => {
    writeFileSync(join(dir, "router.ts"), [
      'import { createRouter, createWebHistory } from "vue-router"',
      "export const router = createRouter({",
      '  history: createWebHistory(),',
      "  routes: [",
      '    { path: "/", component: Home },',
      '    { path: "/users/:id", component: UserDetail },',
      '    { path: "/about", component: About },',
      "  ],",
      "})",
    ].join("\n"));
    writeFileSync(join(dir, "nav.vue"), [
      "<template>",
      '  <router-link to="/about">关于</router-link>',
      '  <router-link :to="userLink">用户</router-link>',
      "</template>",
      '<script setup lang="ts">',
      "function go() {",
      '  router.push("/users/42");',
      "}",
      "</script>",
    ].join("\n"));
    const r = await parseVueRoutes(dir, ["router.ts", "nav.vue"]);
    const routes = r.pages.map((p) => p.route).sort();
    expect(routes).toEqual(["/", "/about", "/users/:id"]);
    expect(r.routerDetected).toBe(true);
    const link = r.edges.find((e) => e.trigger.includes("router-link") && e.to === "/about");
    expect(link).toBeTruthy();
    expect(link!.tier).toBe("semantic");
    const push = r.edges.find((e) => e.trigger.includes("router.push") && e.to === "/users/42");
    expect(push).toBeTruthy();
  });

  it("pageFlow 组合:Vue 边与 React/HTML 同跑;目标入路由表解析", async () => {
    writeFileSync(join(dir, "app.tsx"), 'navigate("/about");');
    const r = await pageFlow(dir, ["router.ts", "nav.vue", "app.tsx"]);
    // /about 在路由表 → 两处 navigates 边都解析成页面文件
    const about = r.edges.filter((e) => e.to.includes("router.ts"));
    expect(about.length).toBeGreaterThanOrEqual(2);
    expect(r.routerDetected).toBe(true);
  });

  it("无 Vue 项目:routerDetected=false 不误报", async () => {
    const d2 = mkdtempSync(join(tmpdir(), "pf-novue-"));
    try {
      writeFileSync(join(d2, "plain.ts"), 'const x = { path: "/not-a-router" };');
      const r = await parseVueRoutes(d2, ["plain.ts"]);
      // path: 存在但无 createRouter 上下文 → 不建页(防 React 对象误判)
      expect(r.pages.filter((p) => p.route === "/not-a-router")).toHaveLength(0);
      expect(r.routerDetected).toBe(false);
    } finally {
      rmSync(d2, { recursive: true, force: true });
    }
  });
});
