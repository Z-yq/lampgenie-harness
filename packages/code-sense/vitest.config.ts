import { defineConfig } from "vitest/config";

// 套件里有多个自引用重型用例(对本仓全量建索引/建图):并行下 ts-morph 资源饥饿
// 会产出部分引用(假红)。单 worker 串行跑,慢但确定性绿;堆走脚本 NODE_OPTIONS(4GB)。
export default defineConfig({
  root: import.meta.dirname,
  test: {
    maxWorkers: 1,
    minWorkers: 1,
 // 重型自引用套件(literal-refs/c2f 对本仓全量建图)需要 >2GB 堆:
 // NODE_OPTIONS 不进 fork worker(被 vitest 过滤),必须走 execArgv。
    poolOptions: { forks: { execArgv: ["--max-old-space-size=4096"] } },
  },
});
