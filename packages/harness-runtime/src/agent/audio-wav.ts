/**
 * 音频容器小件(音频链路优化,omni-query/realtime-plus 两形态共用)。
 * PCM16 裸流(浏览器 PTT/realtime 直出)浏览器 <audio> 播不了——进 HTTP query 或出面板前
 * 包 44 字节 RIFF/WAV 头。与 gateway factory 的 repairRiff 同族(那边修假头,这边造真头)。

 * 采样率口径:输入侧=16000(浏览器 PCM16 PTT 标准);realtime 输出侧=24000(OpenAI Realtime
 * 语义,pipecat OPENAI_SAMPLE_RATE 同口径)。调用方显式传 rate,不猜。
 */

/** PCM16 裸流 → WAV 容器(小端 16bit 单声道)。 */
export function pcm16ToWav(pcm: Buffer, rate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4); // RIFF 块总长
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // PCM fmt 块长
  header.writeUInt16LE(1, 20); // PCM 编码
  header.writeUInt16LE(1, 22); // 单声道
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28); // 字节率(rate × 2 bytes/sample)
  header.writeUInt16LE(2, 32); // 块对齐
  header.writeUInt16LE(16, 34); // 位深
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** base64 PCM16 裸流 → data URL(omni HTTP input_audio.data 形态,实测验证口径)。 */
export function pcm16B64ToWavDataUrl(b64: string, rate: number): string {
  return "data:audio/wav;base64," + pcm16ToWav(Buffer.from(b64, "base64"), rate).toString("base64");
}
