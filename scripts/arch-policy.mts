#!/usr/bin/env tsx
/**
 * 架构策略门 CLI()。
 *   tsx scripts/arch-policy.mts                        # = --check
 *   tsx scripts/arch-policy.mts --check --json
 *   tsx scripts/arch-policy.mts --update               # 显式落 baseline(唯一写 baseline 的入口)
 *   tsx scripts/arch-policy.mts --changed              # 只查 merge-base 以来的变更文件
 *   tsx scripts/arch-policy.mts --policy path/to.json  # 显式指定 policy
 * exit 0 干净 / 2 有新增违规 / 3 policy 或 IO 错误。
 */
import { runCli } from "../apps/gateway/src/arch-policy.ts";

const result = runCli(process.argv.slice(2), process.cwd());
process.stdout.write(result.output);
process.exit(result.code);
