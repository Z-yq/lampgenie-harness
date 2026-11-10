/**
 * CLI 后端测试夹具:以 process.execPath 顶替真 CLI(cli-backends.test.ts 用 buildCommand/bin 注入)。
 * 形态:node fake-cli.mjs <mode> [args...]
 *   print <text...>  打印其余参数(验证指令经 argv 到达且回流)
 *   stdin            打印 stdin 全文(验证 zcode 缺省的 stdin 策略)
 *   fail             stderr 写 boom 后 exit 3(非零退出裁决)
 *   sleep <ms>       睡 ms 后打印 done-after-sleep(超时/取消用)
 *   stubborn         忽略 SIGTERM,30s 后自退(graceful 升级 SIGKILL 用)
 *   envdump <NAME>   打印 env[NAME](spec.env 透传验证)
 */
const args = process.argv.slice(2);
const mode = args[0];
const rest = args.slice(1);
const write = (s) => process.stdout.write(s);

switch (mode) {
  case "print":
    write(rest.join(" ") + "\n");
    break;
  case "stdin": {
    let data = "";
    process.stdin.on("data", (d) => { data += d.toString(); });
    process.stdin.on("end", () => { write(data); process.exit(0); });
    setTimeout(() => { write(data); process.exit(0); }, 5000).unref();
    break;
  }
  case "fail":
    process.stderr.write("boom: fake failure\n");
    process.exit(3);
    break;
  case "sleep": {
    const ms = Number(rest[0] ?? 5000);
    setTimeout(() => { write("done-after-sleep\n"); process.exit(0); }, ms);
    break;
  }
  case "stubborn": {
    process.on("SIGTERM", () => { /* 故意忽略,等升级 SIGKILL */ });
    setTimeout(() => process.exit(0), 30000);
    break;
  }
  case "envdump":
    write(String(process.env[rest[0] ?? ""] ?? "") + "\n");
    break;
  default:
    process.stderr.write("fake-cli: unknown mode " + String(mode) + "\n");
    process.exit(2);
}
