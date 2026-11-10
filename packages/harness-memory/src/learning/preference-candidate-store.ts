// @ts-nocheck — 领域模型与行为语义设计参考 qwen-audio-agent(Apache-2.0,致谢);导出接口、类型与命名为本仓自有;strict 类型化列入 backlog。
// 候选池的持久化 store。
// 晋升要求「跨 ≥2 个会话」的证据，纯内存实现会在进程重启时清零，跨会话证据
// 永远攒不满 —— 晋升机制事实上不生效。这个 store 让候选池能穿越重启。
// 落盘细节（原子写、损坏隔离、mtime + 哈希双重检测）全部在 JsonCheckpointStore
// 里，这里只声明「我是哪份数据、什么版本、快照该长什么样」。
// v2：槽位模型（field/value/confirm）取代了 v1 的自由文本 trait + 计数模型。
// 版本号必须跟着升，否则 v1 文件会被当成 v2 解析、逐条校验失败、静默变成空池。

import { JsonCheckpointStore } from '@lampgenie/runtime/src/core/json-snapshot-store'

// 快照格式版本:槽位模型(field/value/confirm)取代 v1 自由文本 trait + 计数模型。
// 版本必须随数据模型变更递增,否则 v1 文件会被当 v2 解析、逐条校验失败、静默变空池。
const SNAPSHOT_VERSION = 2
const DEFAULT_MAX_OWNERS = 200

export class PreferenceDraftStore extends JsonCheckpointStore {
  // 候选池只需要 store 提供 load/save/health/警告回调这四件事。内部数据模型对
  // store 不透明:serialise/deserialise 由候选池自理。约定快照形状:
  //   { version, owners: { [ownerId]: [slot, ...] }, blocklist: { [ownerId]: [key, ...] } }
  constructor({
    filePath = null,
    now = () => Date.now(),
    onWarning = warning => console.warn(warning.message),
    maxOwners = DEFAULT_MAX_OWNERS,
  } = {}) {
    super({
      filePath,
      fileVersion: SNAPSHOT_VERSION,
      label: '候选池',
      requiredKeys: ['owners'],
      now,
      onWarning,
    })
    this.maxOwners = maxOwners
  }
}
