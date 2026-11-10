/**
 * roster yaml 受控子集(yaml-lite):只支持本系统产消的 roster 文件形态——
 * 扁平 key:value(字符串/布尔/数字)+ 块式字符串列表(- item)。
 * 不支持嵌套映射/流式列表/多行字符串/锚点——外部手编超集 yaml 会显式报错而不是静默错读。
 * 全仓零 yaml 依赖的权衡:roster 文件是本系统单一产消方,受控子集比引依赖更可控。
 */

export type YamlValue = string | boolean | number | string[];

/** 序列化:键序稳定(roster diff 可读),字符串不加引号(受控字符集:禁换行/冒号开头)。 */
export function stringifyYamlLite(obj: Record<string, YamlValue>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) {
      if (v.length === 0) {
        lines.push(`${k}: []`);
      } else {
        lines.push(`${k}:`);
        for (const item of v) lines.push(`  - ${yamlSafeString(item)}`);
      }
    } else if (typeof v === "boolean" || typeof v === "number") {
      lines.push(`${k}: ${v}`);
    } else {
      lines.push(`${k}: ${yamlSafeString(v)}`);
    }
  }
  return lines.join("\n") + "\n";
}

/** 解析:严格子集;越界形态抛错(带行号)。 */
export function parseYamlLite(text: string): Record<string, YamlValue> {
  const out: Record<string, YamlValue> = {};
  const lines = text.split("\n");
  let currentListKey: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    if (raw.startsWith("  - ")) {
      if (!currentListKey) throw new Error(`yaml-lite:${i + 1} 列表项无所属键`);
      (out[currentListKey] as string[]).push(raw.slice(4).trim());
      continue;
    }
    const m = /^([A-Za-z0-9_.-]+):(?: (.*))?$/.exec(raw);
    if (!m) throw new Error(`yaml-lite:${i + 1} 不受支持的形态:「${raw}」(只支持扁平 key:value 与块式列表)`);
    const key = m[1]!;
    const val = (m[2] ?? "").trim();
    currentListKey = null;
    if (val === "") {
      // 空值=块式列表容器(下一行起必须是 "  - ")或空;空列表在下一轮若非列表项则回填 []。
      out[key] = [];
      currentListKey = key;
    } else if (val === "[]") {
      out[key] = [];
    } else if (val === "true" || val === "false") {
      out[key] = val === "true";
    } else if (/^-?\d+(\.\d+)?$/.test(val)) {
      out[key] = Number(val);
    } else {
      out[key] = unquote(val);
    }
  }
  return out;
}

function yamlSafeString(s: string): string {
  if (/[\n\r]/.test(s)) throw new Error(`yaml-lite:字符串含换行,不受支持:「${s.slice(0, 20)}…」`);
  return s;
}

function unquote(s: string): string {
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) return s.slice(1, -1);
  return s;
}

/** roundtrip 校验(测试与防御性读:写出的必能读回)。 */
export function roundtripOk(obj: Record<string, YamlValue>): boolean {
  return JSON.stringify(obj) === JSON.stringify(parseYamlLite(stringifyYamlLite(obj)));
}
