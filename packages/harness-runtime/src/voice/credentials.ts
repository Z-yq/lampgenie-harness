/**
 * 双轨凭证( §4):persona 与 coding 命名空间硬隔离。
 * 交叉访问=启动报错。
 */

export type Track = "persona" | "coding";

export interface CredentialStore {
  /** 解析 keyRef 为真实值(只在进程内,不入日志)。 */
  resolve(track: Track, keyRef: string): string;
}

/** 内存实现(一期);生产接加密文件。 */
export class InMemoryCredentialStore implements CredentialStore {
  private byTrack: Record<Track, Map<string, string>> = {
    persona: new Map(),
    coding: new Map(),
  };

  set(track: Track, keyRef: string, value: string): void {
    this.byTrack[track].set(keyRef, value);
  }

  resolve(track: Track, keyRef: string): string {
    const v = this.byTrack[track].get(keyRef);
    if (!v) throw new Error(`凭证缺失:${track}/${keyRef}`);
    return v;
  }
}

/** 硬隔离:persona 轨的代码不能取 coding 轨,反之亦然。 */
export function assertTrackIsolation(requestTrack: Track, keyRefTrack: Track): void {
  if (requestTrack !== keyRefTrack) {
    throw new Error(`凭证轨道隔离违反:不能用 ${requestTrack} 轨取 ${keyRefTrack} 轨的凭证`);
  }
}

/** 安全解析:跨轨即抛。 */
export function resolveCredential(
  store: CredentialStore,
  requestTrack: Track,
  keyRef: string, // 形如 "persona.qwen" / "coding.qwen"
): string {
  const keyRefTrack = keyRef.split(".")[0] as Track;
  assertTrackIsolation(requestTrack, keyRefTrack);
  return store.resolve(requestTrack, keyRef);
}
