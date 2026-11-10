import { defineConfig } from "vitest/config";

// 与 code-sense 同款:ts-morph 重载面,关文件并行换确定性(慢盘+大仓解析互相挤压会抖)。
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
