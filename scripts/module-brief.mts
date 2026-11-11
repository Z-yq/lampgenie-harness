#!/usr/bin/env node
/**
 * module-brief CLI 薄壳:只做 argv 切片 + 调 store 里的 runModuleBriefCli + 打 stdout + 定 exit 码。
 * 参数解析 / 采集 / 渲染 / --out 写盘全部在 apps/gateway/src/module-brief-store.ts(便于单测)。
 * 用法:tsx scripts/module-brief.mts --module <path|pkg> [--root <dir>] [--json] [--out <file>] [--max-chars n]
 * 退出码:0 成功 / 1 参数错 / 2 模块不在 root 内或包名无法解析
 */
import { runModuleBriefCli } from "../apps/gateway/src/module-brief-store.ts";

const argv = process.argv.slice(2);
const result = await runModuleBriefCli(argv, process.cwd());

if (result.output.length > 0) process.stdout.write(`${result.output}\n`);
process.exit(result.code);
