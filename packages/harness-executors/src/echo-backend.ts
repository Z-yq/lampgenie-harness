/**
 * 真实子进程 executor:跑一个「会说话的 NDJSON-RPC 子进程」验证全链路。
 * 这是契约验证器,不是生产 executor——生产 executor(dsh)在 P4 真机联调。
 */
import type { TaskSpec } from "./ndjson-backend";
import { NdjsonChildBackend } from "./ndjson-backend";
import type { ConfinementCapabilities, ConfinementRunner } from "./sandbox-confinement";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";

export class EchoChildBackend extends NdjsonChildBackend {
  readonly kind = "echo-child";

 // echo 只回放协议、不执行真实命令:归因 echo、四项能力全 false,等级恒为 none。
 // 不能继承基类的「ndjson 全能力」——那会把契约验证器标成 full,声明变假事实。
  protected override confinementKind(): ConfinementRunner {
    return "echo";
  }

  protected override confinementCapabilities(): ConfinementCapabilities {
    return { fsIsolation: false, networkIsolation: false, processIsolation: false, envScrub: false };
  }

  command(_spec: TaskSpec): { cmd: string; args: string[] } {
    // 双形态:源码运行(同目录)与 bundle 运行(dist/../src/)——探测取先
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [join(here, "echo-child.mjs"), join(here, "../src/echo-child.mjs")];
    const child = candidates.find((c) => existsSync(c)) ?? candidates[0]!;
    return { cmd: process.execPath, args: [child] };
  }
}
