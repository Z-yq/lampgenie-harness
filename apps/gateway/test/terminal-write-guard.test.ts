/**
 * terminal 绕写检测(plan-gate):v2 shell 词法解析。
 * 背景:经验证 6 会话 31 次把 `ls ... | grep ... 2>/dev/null` 误判为绕写(v1 正则误伤);
 * v2 升级为 tokenizer——引号目标/变量目标/heredoc 正文/fd 重定向都按真实 shell 语义判。
 */
import { describe, expect, it } from "vitest";
import { stripHarmlessRedirects, terminalLooksLikeWrite } from "../src/terminal-write-guard.js";

describe("terminalLooksLikeWrite(v2 shell 解析)", () => {
  it("只读命令与无害重定向 → false", () => {
    for (const cmd of [
      "ls tasks/designs/ && ls tasks/ | grep -i rsi | head -30",
      "ls tasks 2>/dev/null",
      "cat foo 2>&1 | head",
      "grep -rn 'foo' src 1>/dev/null",
      "git log --oneline -10",
      "git status --short",
      "find . -name '*.ts' | head",
      "echo 'a > b'",
      "grep -e 'x > y' file.txt",
      "wc -l < input.txt",
      "diff <(sort a) <(sort b)",
      "dd if=disk.img of=/dev/null",
      "sed 's/a/b/' f.txt",
      "env VAR=1 sed 's/a/b/' f.txt",
      "command grep -c 'foo' bar",
      "echo done | tee",
    ]) {
      expect(terminalLooksLikeWrite(cmd), cmd).toBe(false);
    }
  });

  it("heredoc 正文里的 > / rm 不误判;heredoc 前有真实重定向仍拦", () => {
    expect(terminalLooksLikeWrite("cat <<EOF\nline with > inside\nrm -rf something\nEOF")).toBe(false);
    expect(terminalLooksLikeWrite("cat <<-EOF\n\tindented > body\nEOF")).toBe(false);
    expect(terminalLooksLikeWrite("cat > out.txt <<EOF\nhello\nEOF")).toBe(true);
  });

  it("真实写文件 → true(v1 全量回归)", () => {
    for (const cmd of [
      "echo hi > /tmp/x",
      "echo hi 2>/dev/null > out.txt",
      "cat a > b",
      "sed -i 's/a/b/' f.txt",
      "echo hi | tee out.txt",
      "dd if=/dev/zero of=/tmp/x bs=1 count=1",
      "cp a b",
      "patch -p0 < x.diff",
    ]) {
      expect(terminalLooksLikeWrite(cmd), cmd).toBe(true);
    }
  });

  it("v2 新增:引号/变量/fd 目标不再漏判(旧正则会把引号剥掉后放走)", () => {
    for (const cmd of [
      'echo hi > "out.txt"',
      "echo hi > 'out.txt'",
      "echo hi > $OUT",
      'echo hi >"$OUT"',
      "cmd 2>err.log",
      "sort <in >out",
      "cmd >> append.log",
      "cmd &> all.log",
      "cmd &>> all.log",
      "cmd >| force.txt",
      "nohup tee out.log",
      "sudo tee /etc/hosts",
      "tee -a log.txt",
      "truncate -s 0 f.log",
      "install -m 644 a b",
      "sed --in-place 's/a/b/' f.txt",
      "cp -r src dst",
    ]) {
      expect(terminalLooksLikeWrite(cmd), cmd).toBe(true);
    }
  });

  it("恶形输入不抛不死循环;未闭合引号里的重定向 fail-closed", () => {
    for (const cmd of [">", "<<", "<<<", "'unclosed", 'echo "unclosed', "$((", "`unclosed", "echo >", "cat <<", "a ; ; ;", "&&&", "(("]) {
      expect(() => terminalLooksLikeWrite(cmd), cmd).not.toThrow();
    }
    expect(terminalLooksLikeWrite("echo hi > 'unclosed")).toBe(true);
    expect(terminalLooksLikeWrite("")).toBe(false);
    expect(terminalLooksLikeWrite(undefined as unknown as string)).toBe(false);
  });

  it("stripHarmlessRedirects(v1 兼容导出)语义不变", () => {
    expect(stripHarmlessRedirects("ls 2>/dev/null | grep x 2>&1")).not.toContain("/dev/null");
    expect(stripHarmlessRedirects("echo hi > out")).toContain("> out");
  });
});
