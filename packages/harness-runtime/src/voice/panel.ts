/**
 * voice 包骨架:播报协议+分级+面板状态机+改写器。
 * 渲染/TTS 一期降级为文字;音频链路二期(需真实模型与设备)。
 */

/** 播报分级(静默规则机制化)。 */
export type SpeakLevel = "full" | "brief" | "silent";

export interface SpeakRequest {
  text: string;
  level: SpeakLevel;
  priority?: "normal" | "critical";
  /** 溯源(面板点击跳详情)。 */
  anchor?: { taskId?: string; event?: string };
}

/** 面板状态机( §3.4)。 */
export type PanelState = "idle" | "listening" | "thinking" | "speaking" | "interrupted";

/** 播报改写器:markdown/代码块→口语化→限长(规则先行;小模型兜底已接=server voice.tts 的 GENIE_VOICE_POLISH opt-in,失败回退本规则版)。 */
export function rewriteForSpeech(text: string, maxLen = 30): string {
  let s = text
    .replace(/```[\s\S]*?```/g, "代码已就绪")
    .replace(/`[^`]*`/g, "")
    .replace(/[#*>\-\[\]()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > maxLen) s = s.slice(0, maxLen - 1) + "…";
  return s;
}

/** 数字人面板状态机驱动。 */
export class VoicePanel {
  state: PanelState = "idle";
  private listeners = new Set<(s: PanelState) => void>();

  onChange(l: (s: PanelState) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private set(s: PanelState): void {
    this.state = s;
    for (const l of this.listeners) l(s);
  }

  /** 用户开始说话。 */
  listening(): void { this.set("listening"); }
  /** ASR final,等模型。 */
  thinking(): void { this.set("thinking"); }
  /** 播报开始。 */
  speak(req: SpeakRequest): void {
    if (req.level === "silent") return; // 静默级不出声
    this.set("speaking");
  }
  /** 打断(barge-in)。 */
  interrupt(): void {
    if (this.state === "speaking") this.set("interrupted");
  }
  /** 回到待机。 */
  idle(): void { this.set("idle"); }
}
