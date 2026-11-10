/**
 * typed/ts(step-089 P1 / designs/26 §2.2):TS/JS 逐文件 typed 提取(ts-morph 纯语法档,
 * 不触 typechecker——编译器初始化 3.1s 是已知固定成本,语法查询不受影响)。
 * 与 engine.ts 语义档的关系:索引档收模块级注解变量+类属性;本档补字面量推断(lexical)与
 * 泛型/联合注解的 span 面(designs/26 §2.2「TS 原生+泛型+联合」)。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Project, SyntaxKind, type SourceFile, type Node, type ParameterDeclaration, type VariableDeclaration } from "ts-morph";
import { readFailReason, type TypedFileResult, type TypedSymbol } from "./types";

let project: Project | undefined;

function syntaxOnlyProject(): Project {
  if (!project) {
    project = new Project({
      skipAddingFilesFromTsConfig: true,
      skipFileDependencyResolution: true,
      useInMemoryFileSystem: true,
      compilerOptions: { noResolve: true, allowJs: true },
    });
  }
  return project;
}

function annotationText(n: Node & { getTypeNode?: () => Node | undefined }): string | undefined {
  try {
    const tn = n.getTypeNode?.();
    if (!tn) return undefined;
    const text = String(tn.getText()).replace(/\s+/g, " ").trim();
    return text ? text.slice(0, 120) : undefined;
  } catch {
    return undefined;
  }
}

/** 字面量推断(诚实词法档;直接字面量形态)。 */
export function inferTsLiteral(value: string): string | undefined {
  const t = value.trim();
  if (!t) return undefined;
  if (/^-?\d+$/.test(t)) return "number";
  if (/^-?\d*\.\d+(e[+-]?\d+)?$/i.test(t)) return "number";
  if (/^["'`]/.test(t)) return "string";
  if (/^(true|false)$/.test(t)) return "boolean";
  if (/^\/.*\/[a-z]*$/.test(t)) return "RegExp";
  if (t.startsWith("[")) return "array";
  if (t.startsWith("{")) return "object";
  return undefined;
}

export async function extractTsTyped(root: string, relFile: string): Promise<TypedFileResult> {
  let text: string;
  try {
    text = await readFile(join(root, relFile), "utf-8");
  } catch (err) {
    return { file: relFile, language: "typescript", symbols: [], degraded: { reason: `读取失败: ${readFailReason(err)}` } };
  }
  // overwrite+用后即删(step-093 真发现):模块级 syntax-only Project 常驻,首版 createSourceFile
  // 无 overwrite——同一路径第二次提取直接抛 InvalidOperationError(CLI 一次性进程掩盖,长驻
  // gateway 进程必踩);且不同路径只增不删=无界累积。改为 overwrite 创建+提取完即 removeSourceFile。
  const proj = syntaxOnlyProject();
  const sf: SourceFile = proj.createSourceFile(relFile, text, { overwrite: true });
  const symbols: TypedSymbol[] = [];
  const push = (s: TypedSymbol): void => {
    if (symbols.length >= 2000) return;
    symbols.push(s);
  };
  const lineOf = (n: Node): number => n.getStartLineNumber();
  // 名标识符在声明文本内的首个独立词出现位(step-093 真发现②修正):getStart() 返回的是
  // 声明起点(export/function/class/const 等关键字位),不是名字位——首版 span 对关键字前缀
  // 声明全部偏移(query.ts 实测 32 token 错 23;C/Py 提取器各自从名字定位无此问题)。
  // 修=声明文本内做词边界搜索取名的首个独立出现(变量名先于类型注解出现,首中即名)。
  const isWordCh = (ch: string): boolean => /[A-Za-z0-9_$]/.test(ch);
  const nameOffsetIn = (declText: string, name: string): number => {
    let i = declText.indexOf(name);
    while (i >= 0) {
      const before = i === 0 ? " " : declText.charAt(i - 1);
      const after = i + name.length >= declText.length ? " " : declText.charAt(i + name.length);
      if (!isWordCh(before) && !isWordCh(after)) return i;
      i = declText.indexOf(name, i + 1);
    }
    return 0; // 兜底=声明起点(与旧形态一致,不更差)
  };
  const spanOf = (n: Node, name: string): { character: number; length: number } => {
    // character=名标识符行内 0-based 列(ts-morph 版本间 getLineStartAtPos 有无不定,直接文本定位)
    const pos = n.getStart();
    const text = sf.getFullText();
    const lastNl = text.lastIndexOf("\n", Math.max(0, pos - 1));
    const nameOff = nameOffsetIn(n.getText(), name);
    return { character: pos + nameOff - (lastNl + 1), length: name.length };
  };

  /** 最近函数祖先的名字(形参/局部的 container;箭头函数/匿名=undefined,如实)。 */
  const nearestFunctionName = (n: Node): string | undefined => {
    const fn = n.getFirstAncestorByKind(SyntaxKind.FunctionDeclaration)
      ?? n.getFirstAncestorByKind(SyntaxKind.MethodDeclaration)
      ?? n.getFirstAncestorByKind(SyntaxKind.FunctionExpression)
      ?? n.getFirstAncestorByKind(SyntaxKind.ArrowFunction);
    if (!fn) return undefined;
    const nm = (fn as { getName?: () => string | undefined }).getName?.();
    return nm || undefined;
  };

  for (const fn of sf.getFunctions()) {
    const name = fn.getName();
    if (!name) continue;
    push({ name, kind: "function", file: relFile, line: lineOf(fn), span: spanOf(fn, name), tier: "structural" });
  }
  for (const cls of sf.getClasses()) {
    const name = cls.getName();
    if (name) push({ name, kind: "class", file: relFile, line: lineOf(cls), span: spanOf(cls, name), tier: "structural" });
    for (const prop of cls.getProperties()) {
      const pname = prop.getName();
      if (!/^[$_\w][$\w]*$/.test(pname)) continue;
      const t = annotationText(prop);
      if (!t) continue; // 无注解不猜(字面量推断不做类属性——初始化器形态复杂,如实缺)
      push({ name: pname, kind: "property", dataType: t, file: relFile, line: lineOf(prop), span: spanOf(prop, pname), container: name, tier: "structural" });
    }
    // G 批(tokens 深度):类方法符号(此前缺位——server.ts 2670 行 methods 全部不可见)
    for (const m of cls.getMethods()) {
      const mname = m.getName();
      push({ name: mname, kind: "method", file: relFile, line: lineOf(m), span: spanOf(m, mname), container: name, tier: "structural" });
    }
  }
  for (const inf of sf.getInterfaces()) {
    const name = inf.getName();
    push({ name, kind: "interface", file: relFile, line: lineOf(inf), span: spanOf(inf, name), tier: "structural" });
    for (const prop of inf.getProperties()) {
      const pname = prop.getName().replace(/^["']|["']$/g, "");
      const t = annotationText(prop);
      if (!t || !/^[$_\w][$\w]*$/.test(pname)) continue;
      push({ name: pname, kind: "property", dataType: t, file: relFile, line: lineOf(prop), span: spanOf(prop, pname), container: name, tier: "structural" });
    }
  }
  for (const ta of sf.getTypeAliases()) {
    const name = ta.getName();
    const t = annotationText(ta);
    push({ name, kind: "type", ...(t ? { dataType: t } : {}), file: relFile, line: lineOf(ta), span: spanOf(ta, name), tier: "structural" });
  }
  for (const en of sf.getEnums()) {
    const name = en.getName();
    push({ name, kind: "enum", file: relFile, line: lineOf(en), span: spanOf(en, name), tier: "structural" });
    for (const m of en.getMembers()) {
      const mname = m.getName().replace(/^["']|["']$/g, "");
      if (!/^[$_\w][$\w]*$/.test(mname)) continue;
      push({ name: mname, kind: "enumMember", dataType: name, file: relFile, line: lineOf(m), span: spanOf(m, mname), container: name, tier: "structural" });
    }
  }
  // 语句级变量声明:注解=structural;无注解+直接字面量=lexical 推断如实
  for (const decl of sf.getVariableDeclarations()) {
    const nameNode = decl.getNameNode();
    if (nameNode.getKind() !== SyntaxKind.Identifier) continue; // 解构形态不猜
    const name = nameNode.getText().trim();
    if (!/^[$_\w][$\w]*$/.test(name)) continue;
    const t = annotationText(decl);
    if (t) {
      push({ name, kind: "variable", dataType: t, file: relFile, line: lineOf(decl), span: spanOf(decl, name), tier: "structural" });
      continue;
    }
    const init = decl.getInitializer();
    const t2 = init ? inferTsLiteral(init.getText()) : undefined;
    if (t2) {
      push({ name, kind: "variable", dataType: t2, file: relFile, line: lineOf(decl), span: spanOf(decl, name), tier: "lexical" });
    }
  }
  // F/G 批(2026-10-21 收尾批):函数内形参与局部变量——tokens 默认可见(span 面),
  // vars 面 --locals 扩入(varsOf 过滤)。单遍 descendant 收集,有界:
  //  - ParameterDeclaration:带类型注解 → kind=parameter/structural;无注解不猜。
  //  - VariableDeclaration:函数体内(非顶层 const/let——上面语句级循环已收顶层)带注解 →
  //    kind=local/structural;无注解+字面量 → 不收(推断型局部=旧噪声源)。
  // 性能纪律:span 用 nameNode.getStart() 直接定位(循环外取一次全文),不走
  // spanOf/getText(每节点整子树拷贝——server.ts 实测 2670 行 O(节点×文件) 退化 2.8s)。
  const fullText = sf.getFullText();
  const colOf = (pos: number): number => pos - (fullText.lastIndexOf("\n", Math.max(0, pos - 1)) + 1);
  sf.forEachDescendant((node) => {
    if (symbols.length >= 4000) return;
    if (node.getKind() === SyntaxKind.Parameter) {
      const prm = node as ParameterDeclaration;
      if (prm.isRestParameter() || prm.isParameterProperty()) return;
      const nameNode = prm.getNameNode();
      if (nameNode.getKind() !== SyntaxKind.Identifier) return; // 解构/模式形参不猜
      const pname = nameNode.getText().trim();
      if (!/^[$_\w][$\w]*$/.test(pname)) return;
      const t = annotationText(prm);
      if (!t) return;
      const fn = nearestFunctionName(prm);
      push({
        name: pname, kind: "parameter", dataType: t, file: relFile, line: lineOf(prm),
        span: { character: colOf(nameNode.getStart()), length: pname.length },
        ...(fn ? { container: fn } : {}), tier: "structural",
      });
      return;
    }
    if (node.getKind() === SyntaxKind.VariableDeclaration) {
      const decl = node as VariableDeclaration;
      const nameNode = decl.getNameNode();
      if (nameNode.getKind() !== SyntaxKind.Identifier) return;
      const vname = nameNode.getText().trim();
      if (!/^[$_\w][$\w]*$/.test(vname)) return;
      const t = annotationText(decl);
      if (!t) return; // 函数内推断型局部不收(旧噪声源);顶层无注解已由语句级循环处理
      // 顶层(模块级)声明已在上方语句级循环收过(kind=variable)——此处跳过,防重复
      const parentStmt = decl.getFirstAncestorByKind(SyntaxKind.VariableStatement);
      if (parentStmt && parentStmt.getParentIfKind(SyntaxKind.SourceFile)) return;
      const fn = nearestFunctionName(decl);
      push({
        name: vname, kind: "local", dataType: t, file: relFile, line: lineOf(decl),
        span: { character: colOf(nameNode.getStart()), length: vname.length },
        ...(fn ? { container: fn } : {}), tier: "structural",
      });
    }
  });
  const result: TypedFileResult = { file: relFile, language: "typescript", symbols };
  try { proj.removeSourceFile(sf); } catch { /* 清理失败不影响结果(下次 overwrite 兜底) */ }
  return result;
}
