import { readFileSync } from "node:fs";
const est = (chars: number, cjk: number) => Math.round(cjk * 0.789 + (chars - cjk) * 0.297);
function load(p: string) { return JSON.parse(readFileSync(p, "utf8")) as { name: string; descLen: number; paramLen: number; cjk: number }[]; }
const before = load("/tmp/before.json");
const after = load(process.argv[2] ?? "/tmp/after.json");
const sum = (rs: typeof before, f: "chars" | "cjk" | "tok") => rs.reduce((a, r) => a + (f === "chars" ? r.descLen + r.paramLen : f === "cjk" ? r.cjk : est(r.descLen + r.paramLen, r.cjk)), 0);
console.log(`before: ${sum(before,"chars")} chars, cjk ${sum(before,"cjk")}, est ${sum(before,"tok")} tok`);
console.log(`after : ${sum(after,"chars")} chars, cjk ${sum(after,"cjk")}, est ${sum(after,"tok")} tok`);
for (const b of before) {
  const a = after.find((x) => x.name === b.name)!;
  console.log(`${b.name}: chars ${b.descLen + b.paramLen}->${a.descLen + a.paramLen}, cjk ${b.cjk}->${a.cjk}, tok ${est(b.descLen + b.paramLen, b.cjk)}->${est(a.descLen + a.paramLen, a.cjk)}`);
}
