import { defineConfig } from "vitest/config";

// code-sense 套件是 ts-morph 重载面(9 个测试文件各自起 Project 重解析本仓)。
// 文件级并行下互相挤压,偶发解析空结果——负载抖动在 D1/D3/git 热点/跨包注入等用例间
// 轮换命中(step-031~034 五见,单文件恒绿)。关文件并行换确定性(套件时长 +~30%)。
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
