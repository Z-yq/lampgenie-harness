import { defineConfig } from "vitest/config";

// workflow 真跑用例(engine world glob/template vit 真执行/并发峰值计数)对调度资源敏感:
// 并行 worker 下计时与并发峰值漂移成假红。单 worker 串行,慢但确定性绿。
export default defineConfig({
  root: import.meta.dirname,
  test: {
    maxWorkers: 1,
    minWorkers: 1,
  },
});
