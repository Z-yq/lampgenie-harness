import { defineConfig } from "vitest/config";

// 合并两轮裁定(2026-10-13 冗余收敛轮:工作树与 HEAD 各持一半,此处合流):
// ① test/ui/*.spec.cjs 排除出收集(f7b8148:独立直跑的 chromium 探针,自带 PASS/FAIL,
//    vitest 收集会「No test suite found」恒红);
// ② maxWorkers=2(R2 审计:满并行资源饥饿造成 5-100s 假超时,单跑全绿;保留每文件隔离);
// ③ 不关 fileParallelism(串行单 worker 下 permissionMode 等进程级全局态跨文件泄漏=新假红)。
export default defineConfig({
  test: {
    env: { GENIE_CHECKPOINT: "off" },
    // r2(2026-10-23):test/ui/** 里现在有 vitest 化的 slash.spec.test.ts(需被收集),
    // 只排除「独立直跑的 chromium 探针 .spec.cjs」——它们自带 PASS/FAIL,vitest 收集恒红。
    exclude: ["**/node_modules/**", "**/dist/**", "test/ui/**/*.spec.cjs"],
    maxWorkers: 2,
    minWorkers: 1,
  },
});
