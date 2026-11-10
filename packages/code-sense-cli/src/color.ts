/** 终端着色(最小 ANSI 面):--no-color / NO_COLOR / 非 TTY 自动关闭。跨平台无依赖。 */

export interface Palette {
  enabled: boolean;
  dim(s: string): string;
  bold(s: string): string;
  green(s: string): string;
  red(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
}

function wrap(code: string): (s: string) => string {
  return (s) => `\u001b[${code}m${s}\u001b[0m`;
}

export function makePalette(noColor: boolean, stream: { isTTY?: boolean } = process.stdout): Palette {
  const enabled = !noColor && !process.env.NO_COLOR && stream.isTTY === true;
  const off = (s: string): string => s;
  if (!enabled) return { enabled, dim: off, bold: off, green: off, red: off, yellow: off, cyan: off };
  return {
    enabled,
    dim: wrap("2"),
    bold: wrap("1"),
    green: wrap("32"),
    red: wrap("31"),
    yellow: wrap("33"),
    cyan: wrap("36"),
  };
}
