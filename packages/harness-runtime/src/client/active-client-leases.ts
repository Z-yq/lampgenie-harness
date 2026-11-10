// @ts-nocheck — 客户端租约池(本仓自有实现;同类「同 owner 单活客户端 + 代际号防错释放 +
// 受控接管」的租约语义参考 qwen-audio-agent,致谢)。

function ownerKey(ownerId) {
  return String(ownerId || '')
}

export class ClientLeasePool {
  constructor() {
    this.leases = new Map()
    this.generations = new Map()
  }

  // 客户端是否还活着:未实现 isAlive 的客户端视为永活(向后兼容)。
  static #alive(lease) {
    return lease?.client?.isAlive?.() !== false
  }

  claim(ownerId, client, { instanceId = null, takeover = false } = {}) {
    const key = ownerKey(ownerId)
    const current = this.leases.get(key)

    // 同一客户端重复 claim:幂等续持,不换代。
    if (current?.client === client) {
      return { granted: true, lease: current, previous: null, replaced: false }
    }

    const sameInstance = Boolean(instanceId && current?.instanceId && current.instanceId === instanceId)
    const blocked = current && ClientLeasePool.#alive(current) && !sameInstance && !takeover
    if (blocked) {
      return { granted: false, lease: null, previous: current, replaced: false }
    }

    const generation = (this.generations.get(key) || 0) + 1
    this.generations.set(key, generation)
    const lease = {
      ownerId: key,
      client,
      instanceId: instanceId || null,
      generation,
      acquiredAt: Date.now(),
    }
    this.leases.set(key, lease)
    // 换持时通知旧客户端让位;旧租约持有人据此停止本地活动。
    if (current && current.client !== client) current.client.deactivate?.(lease)

    return { granted: true, lease, previous: current || null, replaced: Boolean(current) }
  }

  release(ownerId, client, generation) {
    const current = this.leases.get(ownerKey(ownerId))
    const mine = current && current.client === client
    const generationOk = generation === undefined || current?.generation === generation
    if (!mine || !generationOk) return false
    this.leases.delete(ownerKey(ownerId))
    return true
  }

  isActive(ownerId, client, generation) {
    const current = this.leases.get(ownerKey(ownerId))
    if (!current || current.client !== client) return false
    return generation === undefined || current.generation === generation
  }

  active(ownerId) {
    return this.leases.get(ownerKey(ownerId)) || null
  }

  get size() {
    return this.leases.size
  }
}
