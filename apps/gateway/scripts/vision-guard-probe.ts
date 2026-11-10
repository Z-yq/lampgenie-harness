/**
 * 视觉尺寸守卫人工取证探针(step-1022):走**真实 view_image 工具**路径调一次,
 * 打印工具回执(超限 → [图片超限] 文案;合法 → [vision-image] 哨兵)。
 *
 * 用法:
 *   /home/zhongyuqi/.nvm/versions/node/v24.22.2/bin/node --experimental-strip-types \
 *     apps/gateway/scripts/vision-guard-probe.ts <图片路径>(仓库相对或绝对)
 *
 * 围栏根取该图片所在项目根(`<repo>/../<proj>` 或传入 `--root`),使 image 落在工具围栏内。
 */
import { createFileTools } from "../src/file-tools.js";
import { readImageSize } from "../src/image-size.js";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve, relative } from "node:path";

const args = process.argv.slice(2);
const rootIdx = args.indexOf("--root");
const root = rootIdx >= 0 ? resolve(args[rootIdx + 1]!) : process.cwd();
const target = args.filter((_, i) => i !== rootIdx && i !== rootIdx + 1)[0];
if (!target) {
  console.error("用法: vision-guard-probe.ts <图片路径> [--root <围栏根>]");
  process.exit(2);
}
// 相对路径按 --root 解析(图片在别的项目里时,repo cwd 下没有这个文件)
const abs = isAbsolute(target) ? target : resolve(root, target);
const rel = isAbsolute(target) ? relative(root, abs) : target;
const size = readImageSize(readFileSync(abs).subarray(0, 48 * 1024));
console.log("[探针] 文件:", rel, "实际尺寸:", size ? `${size.width}x${size.height}(${size.format})` : "解析失败(放行)");

const tools = createFileTools({ root, sessionId: "vision-guard-probe-" + Date.now() });
const tool = tools.find((t) => t.name === "view_image");
if (!tool) throw new Error("view_image 工具未装配");
const out = (await tool.execute({ paths: [rel] }, undefined, { callId: "probe" })) as string;
console.log("[探针] 工具回执:", out.startsWith("[vision-image]") ? out.slice(0, 160) + "…(已注入视觉通道)" : out);
