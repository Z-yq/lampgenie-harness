/**
 * 办公文案「人话 / 关键词」检测(office-voice)。
 * 办公产出的文案不能像 agent 报告——人要的是关键词,受众会自动联想;
 * 「首先…其次…」「综上所述」「这意味着」「赋能/闭环」这类脚手架把判断埋进了连接词里,
 * 读起来像模型在解释自己,而不是一个工程师在下结论。
 * 本模块只做确定性检测:给标题与要点,返回稳定码 + 命中片段 + 一句改法。
 * 不调模型、不读文件、不抛异常;同一输入同输出,可作为 board_pptx 质量门与 office-deai 的共同底座。
 * 判据分五类:
 * - connector:序数/总结连接词(首先…其次、综上、由此可见)
 * - meta:报告框架语(本页/本节/接下来/让我们)
 * - explain:解释性脚手架(这意味着/换句话说/具体来说/通过…实现)
 * - puffery:空泛大词(赋能/闭环/抓手/全面提升/系统性)
 * - long:单条要点超过一行上限(默认 64 字,lead+text 合计)
 * 规则故意不追求「全」:只收高置信、删掉几乎不损失信息的词。宁可漏报,不可把正常业务词误杀
 * (例如「维度配置」「有效期」是正常名词,不在此表)。新增规则必须同步 VOICE_RULES_VERSION。
 */

export const VOICE_RULES_VERSION = "1.0.0";

/** 单条要点(lead+text)允许的最大字符数;超过就不是关键词,是段落。 */
export const VOICE_MAX_BULLET_CHARS = 64;

/** 稳定码:调用方按码分流,不解析中文文案。 */
export const VOICE_CODES = [
  "VOICE_OK",
  "VOICE_INVALID",
  "VOICE_CONNECTOR",
  "VOICE_META",
  "VOICE_EXPLAIN",
  "VOICE_PUFFERY",
  "VOICE_LONG",
];

/** 一条规则:code + 正则 + 改法提示。 */
export const VOICE_RULES = [
  {
    code: "VOICE_CONNECTOR",
    severity: "high",
    pattern: /首先[\s\S]{0,80}?其次|其次[\s\S]{0,80}?最后|综上所述|总的来说|总体而言|由此可见|不难看出|一方面[\s\S]{0,50}?另一方面|不仅[\s\S]{0,40}?而且/g,
    hint: "删掉序数/总结连接词，直接给判断；关系用「→ / 因为 / 但」或换行表达。",
  },
  {
    code: "VOICE_META",
    severity: "medium",
    pattern: /本页|本节|本次(?:分享|汇报|培训)|接下来(?:我们)?|下面(?:我们)?(?:来看|开始|进入)|如上所述|让我们(?:一起)?/g,
    hint: "删掉「本页/接下来」这类报告框架语；页面自己说话，不预告自己。",
  },
  {
    code: "VOICE_EXPLAIN",
    severity: "medium",
    pattern: /这意味着|也就是说|换句话说|具体来说|需要注意的是|值得注意的是|可以看出|原因在于|这是因为|其本质是|本质上是|从根本上|背后的逻辑|通过[\s\S]{0,40}?实现/g,
    hint: "受众会自己联想；删掉解释性从句，只留主张 + 证据 + 数字。",
  },
  {
    code: "VOICE_PUFFERY",
    severity: "high",
    pattern: /赋能|闭环|抓手|护城河|组合拳|全面提升|显著提升|有效提升|系统性|结构性|生态化|范式|全方位|多维度|深度融合|顶层设计|降本增效/g,
    hint: "换成具体动作、对象、量级；大词本身不携带信息。",
  },
];


const CLIP = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** 空/非法输入:给稳定码,不抛。 */
function invalidResult() {
  return {
    ok: false,
    version: VOICE_RULES_VERSION,
    issues: [{ where: "输入", code: "VOICE_INVALID", severity: "high", excerpt: "", msg: "标题/要点不是可读文本" }],
    codes: ["VOICE_INVALID"],
  };
}

/**
 * 检测一页/一段的文案。
 * @param input `{title, bullets}`;bullets 每项 `{lead?,text?}`。
 */
export function analyzeVoice(input) {
  if (!input || typeof input !== "object") return invalidResult();
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const rawBullets = Array.isArray(input.bullets) ? input.bullets : [];
  if (!title && rawBullets.length === 0) return invalidResult();

  const issues = [];
  const codes = new Set();

  const examine = (where, text, maxChars) => {
    const body = String(text ?? "").replace(/\s+/g, " ").trim();
    if (!body) return;
    for (const rule of VOICE_RULES) {
      const re = new RegExp(rule.pattern.source, rule.pattern.flags);
      const m = re.exec(body);
      if (!m) continue;
      codes.add(rule.code);
      issues.push({
        where,
        code: rule.code,
        severity: rule.severity,
        excerpt: CLIP(body, 40),
        msg: `命中报告腔「${CLIP(m[0], 24)}」——${rule.hint}`,
      });
    }
    if (maxChars !== undefined && [...body].length > maxChars) {
      codes.add("VOICE_LONG");
      issues.push({
        where,
        code: "VOICE_LONG",
        severity: "medium",
        excerpt: CLIP(body, 48),
        msg: `这条 ${[...body].length} 字 > ${maxChars}：删成关键词/数字，受众会自己联想。`,
      });
    }
  };

  examine("页标题", title, 40);
  rawBullets.forEach((raw, i) => {
    const b = raw && typeof raw === "object" ? raw : { text: String(raw ?? "") };
    const lead = typeof b.lead === "string" ? b.lead : "";
    const text = typeof b.text === "string" ? b.text : "";
    const joined = lead && text ? `${lead} ${text}` : lead || text;
    examine(`要点 ${i + 1}`, joined, VOICE_MAX_BULLET_CHARS);
  });

  const unique = [...new Set(codes)];
  return {
    ok: issues.length === 0,
    version: VOICE_RULES_VERSION,
    issues,
    codes: issues.length === 0 ? ["VOICE_OK"] : unique,
  };
}

/** 规则目录(测试/面板可读;不含正则实例,避免全局 lastIndex 状态)。 */
export function voiceRuleCatalog() {
  return VOICE_RULES.map((r) => ({ code: r.code, severity: r.severity, hint: r.hint }));
}