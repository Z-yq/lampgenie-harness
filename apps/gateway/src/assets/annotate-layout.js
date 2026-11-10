/*
 * GenieAnnotateLayout — 截图标注「组件拆移」几何引擎(本仓自研实现)。
 * 问题设定:把一张截图切成互不重叠的「源切片」(每个原图像素恰好属于一个切片),
 * 用户圈选区域成组(组 = 若干切片),拖动/缩放组时按仿射变换搬运行源切片;
 * 引擎全程记录「源区域 → 目标区域」的位移账本,供导出与批注重映射。
 * 「切片分区 + 仿射搬运 + 位移账本」的交互设计参考 EditHere 项目(致谢);
 * 本文件的几何推导、数据结构组织与命名均为 lampgenie-harness 独立实现,不包含其代码。
 * 纯几何计算,无 DOM;浏览器经 <script> 挂 GenieAnnotateLayout,测试经 module.exports。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.GenieAnnotateLayout = api;
})(typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const TOL = 1e-7;
  const SLAB_LIMIT = 4096;
  const ZONE_LIMIT = 512;
  const LEDGER_LIMIT = 8192;
  const COORD_LIMIT = 1000000;

  let uid = 0;

  // ——— 矩形代数(坐标约定:x2/y2 为开界,即 [x1,x2) × [y1,y2)) ———
  const spanW = (r) => r.x2 - r.x1;
  const spanH = (r) => r.y2 - r.y1;
  const areaOf = (r) => spanW(r) * spanH(r);
  const isLive = (r) => !!r && spanW(r) > TOL && spanH(r) > TOL;
  const cloneRect = (r) => ({ x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2 });
  const nearlyEq = (a, b) => Math.abs(a - b) <= TOL;
  const sameRect = (a, b) => nearlyEq(a.x1, b.x1) && nearlyEq(a.y1, b.y1) && nearlyEq(a.x2, b.x2) && nearlyEq(a.y2, b.y2);
  const inside = (r, x, y) => x >= r.x1 && x < r.x2 && y >= r.y1 && y < r.y2;
  const canvasRect = (state) => ({ x1: 0, y1: 0, x2: state.width, y2: state.height });

  function ensure(ok, why) { if (!ok) throw new Error(why); }

  function overlap(a, b) {
    const box = { x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), x2: Math.min(a.x2, b.x2), y2: Math.min(a.y2, b.y2) };
    return isLive(box) ? box : null;
  }

  function unionOf(a, b) {
    if (!a) return cloneRect(b);
    return { x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1), x2: Math.max(a.x2, b.x2), y2: Math.max(a.y2, b.y2) };
  }

  // r 中挖去 hole 后剩下的至多四个条带(左右上下的顺序自定;调用方只关心覆盖完整)。
  function minus(r, hole) {
    return [
      { x1: r.x1, y1: r.y1, x2: hole.x1, y2: r.y2 },
      { x1: hole.x2, y1: r.y1, x2: r.x2, y2: r.y2 },
      { x1: hole.x1, y1: r.y1, x2: hole.x2, y2: hole.y1 },
      { x1: hole.x1, y1: hole.y2, x2: hole.x2, y2: r.y2 },
    ].filter(isLive);
  }

  function within(r, w, h) {
    return isLive(r) && r.x1 >= -TOL && r.y1 >= -TOL && r.x2 <= w + TOL && r.y2 <= h + TOL;
  }

  // 把 from 坐标系里的矩形按「from→to」仿射映到 to 坐标系(两轴各自缩放)。
  function rescale(r, from, to) {
    const kx = spanW(to) / spanW(from), ky = spanH(to) / spanH(from);
    return {
      x1: to.x1 + (r.x1 - from.x1) * kx,
      y1: to.y1 + (r.y1 - from.y1) * ky,
      x2: to.x1 + (r.x2 - from.x1) * kx,
      y2: to.y1 + (r.y2 - from.y1) * ky,
    };
  }

  function checkRect(value, allowEmpty) {
    ensure(value && typeof value === "object", "布局坐标格式不正确");
    const r = cloneRect(value);
    ensure(
      Object.values(r).every((v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= COORD_LIMIT),
      "布局坐标必须是有限数值",
    );
    if (!allowEmpty) ensure(isLive(r), "布局区域尺寸必须为正");
    return r;
  }

  function freshId(state, prefix) {
    let id;
    do { id = prefix + "-" + (++uid); }
    while (state.pieces.some((p) => p.id === id) || state.groups.some((g) => g.id === id));
    return id;
  }

  // 绘制次序:未搬动切片恒为背景,搬动过的按原相对顺序置顶(对齐反馈重建)。
  function layering(state) {
    const moved = state.pieces.filter((p) => !sameRect(p.source, p.to));
    return state.pieces.filter((p) => sameRect(p.source, p.to)).concat(moved);
  }

  function topSlab(order, x, y) {
    for (let i = order.length - 1; i >= 0; --i) if (inside(order[i].to, x, y)) return order[i];
    return null;
  }

  // piece 在 region 内、且不被 order 中排在其后的切片遮挡的可见部分。
  function visibleFragments(piece, region, later) {
    const head = overlap(piece.to, region);
    if (!head) return [];
    let parts = [head];
    for (const cover of later) {
      const next = [];
      for (const part of parts) {
        const covered = overlap(part, cover.to);
        if (covered) next.push(...minus(part, covered));
        else next.push(part);
      }
      parts = next;
      ensure(parts.length <= SLAB_LIMIT, "区域过于复杂,请减少手动切分");
      if (!parts.length) break;
    }
    return parts;
  }

  /**
   * 核心剖切:在 region 内圈选可见像素。每个切片被选中处裂成新切片(源坐标按仿射回溯),
   * 完整选中且未变形的切片原样保留。返回 {pieces, groups, selectedIds}。
   */
  function carveCore(state, region) {
    const order = layering(state);
    const visible = new Map();
    for (let i = 0; i < order.length; ++i) {
      visible.set(order[i].id, visibleFragments(order[i], region, order.slice(i + 1)));
    }
    const pieces = [], heirIds = new Map(), selectedIds = [];
    for (const piece of state.pieces) {
      const fragments = visible.get(piece.id) || [];
      if (!fragments.length) { pieces.push(piece); continue; }
      let todo = [{ box: cloneRect(piece.to), hit: false }];
      for (const sel of fragments) {
        const split = [];
        for (const frag of todo) {
          if (frag.hit) { split.push(frag); continue; }
          const take = overlap(frag.box, sel);
          if (!take) { split.push(frag); continue; }
          split.push(...minus(frag.box, take).map((box) => ({ box, hit: false })));
          split.push({ box: take, hit: true });
        }
        todo = split;
        ensure(pieces.length + todo.length <= SLAB_LIMIT, "区域过于复杂,请减少手动切分");
      }
      if (todo.length === 1 && sameRect(todo[0].box, piece.to)) {
        pieces.push(piece);
        selectedIds.push(piece.id);
        continue;
      }
      const heirs = [];
      for (const frag of todo) {
        const id = freshId(state, "slab");
        pieces.push({ id, source: rescale(frag.box, piece.to, piece.source), to: cloneRect(frag.box) });
        heirs.push(id);
        if (frag.hit) selectedIds.push(id);
      }
      heirIds.set(piece.id, heirs);
      ensure(pieces.length <= SLAB_LIMIT, "区域过于复杂,请减少手动切分");
    }
    const groups = state.groups.map((group) => ({
      ...group,
      ...(group.originalBounds ? { originalBounds: cloneRect(group.originalBounds) } : {}),
      pieces: group.pieces.flatMap((id) => heirIds.get(id) || [id]),
    }));
    return { pieces, groups, selectedIds };
  }

  // ——— 公共 API ———

  /** 建初始画布:一整张背景切片 + 检测候选细分(背景大块/重复块不成组)。 */
  function build(w, h, candidates) {
    ensure(
      Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 && w <= COORD_LIMIT && h <= COORD_LIMIT && w * h <= 100000000,
      "图片尺寸不正确",
    );
    const state = { width: w, height: h, pieces: [], groups: [], movements: [] };
    const canvas = canvasRect(state);
    state.pieces.push({ id: freshId(state, "slab"), source: cloneRect(canvas), to: cloneRect(canvas) });
    const sorted = (Array.isArray(candidates) ? candidates : []).slice().sort((a, b) => {
      const ba = a && a.bounds, bb = b && b.bounds;
      return ba && bb ? areaOf(ba) - areaOf(bb) : 0;
    });
    const taken = [];
    for (const candidate of sorted) {
      if (state.groups.length >= ZONE_LIMIT) break;
      let box;
      try { box = overlap(checkRect(candidate.bounds, true), canvas); } catch (_) { continue; }
      // 检测器给出的背景大块不能变成可拖动的整图组件。
      if (!box || areaOf(box) >= w * h * 0.85 || taken.some((other) => sameRect(other, box))) continue;
      let id;
      try { id = carve(state, box); } catch (_) { continue; }
      if (id) {
        const label = candidate.label || (candidate.target && candidate.target.label) || "检测区域 " + state.groups.length;
        state.groups[state.groups.length - 1].label = String(label).slice(0, 1000);
        taken.push(box);
      }
    }
    return state;
  }

  /** 圈选一块区域成组;与既有组无交集或全被遮挡时返回 null。 */
  function carve(state, rectangle) {
    ensure(state.groups.length < ZONE_LIMIT, "最多支持 512 个可选区域");
    const asked = checkRect(rectangle, true);
    const box = overlap(
      {
        x1: Math.min(asked.x1, asked.x2), y1: Math.min(asked.y1, asked.y2),
        x2: Math.max(asked.x1, asked.x2), y2: Math.max(asked.y1, asked.y2),
      },
      canvasRect(state),
    );
    if (!box) return null;
    const result = carveCore(state, box);
    if (!result.selectedIds.length) return null;
    const id = freshId(state, "zone");
    const chosen = new Set(result.selectedIds);
    const origin = result.pieces
      .filter((piece) => chosen.has(piece.id))
      .reduce((acc, piece) => unionOf(acc, piece.source), null);
    result.groups.push({ id, label: "手动区域 " + (state.groups.length + 1), originalBounds: origin, pieces: result.selectedIds });
    state.pieces = result.pieces;
    state.groups = result.groups;
    return id;
  }

  /** 组当前占用的画布范围。 */
  function extentOf(state, groupId) {
    const group = state.groups.find((g) => g.id === groupId);
    if (!group) return null;
    const members = new Set(group.pieces);
    let out = null;
    for (const piece of state.pieces) if (members.has(piece.id)) out = unionOf(out, piece.to);
    return out;
  }

  /** 组的源区域(首次圈选时的原图范围);入参可为组对象或组 id。 */
  function originOf(state, groupOrId) {
    const group = typeof groupOrId === "string" ? state.groups.find((g) => g.id === groupOrId) : groupOrId;
    if (!group) return null;
    if (group.originalBounds) return cloneRect(group.originalBounds);
    const members = new Set(group.pieces);
    return state.pieces
      .filter((piece) => members.has(piece.id))
      .reduce((acc, piece) => unionOf(acc, piece.source), null);
  }

  /** 位移账本:优先读状态里已沉淀的;没有则从切片形态推导。 */
  function ledgerOf(state) {
    if (state.movements !== undefined) return state.movements;
    return moves(state).map((entry) => {
      const destination = entry.movements[entry.movements.length - 1].to;
      const group = state.groups.find(
        (item) => sameRect(originOf(state, item), entry.source) && sameRect(extentOf(state, item.id), destination),
      );
      return { groupId: group ? group.id : null, source: entry.source, destination };
    });
  }

  // 目标落点:保持尺寸、钳进画布。
  function clamped(r, state) {
    const w = Math.min(spanW(r), state.width), h = Math.min(spanH(r), state.height);
    const x = Math.max(0, Math.min(r.x1, state.width - w));
    const y = Math.max(0, Math.min(r.y1, state.height - h));
    return { x1: x, y1: y, x2: x + w, y2: y + h };
  }

  /**
   * 搬动一组:成员切片按 old→new 仿射映射,位移账本随之更新(已有该组条目则演化其
   * destination,否则追加)。非法目标先抛错,状态保持原样。
   */
  function moveGroup(state, groupId, destination) {
    const group = state.groups.find((g) => g.id === groupId);
    const before = extentOf(state, groupId);
    if (!group || !before) return null;
    const target = clamped(checkRect(destination, false), state);
    if (sameRect(before, target)) return target;
    const chosen = new Set(group.pieces);
    const background = [], lifted = [];
    for (const piece of state.pieces) {
      if (!chosen.has(piece.id)) { background.push(piece); continue; }
      const to = rescale(piece.to, before, target);
      ensure(isLive(to) && within(to, state.width, state.height), "缩放后的区域过小");
      lifted.push({ id: piece.id, source: cloneRect(piece.source), to });
    }
    const groups = state.groups.map((item) => ({ ...item, originalBounds: originOf(state, item), pieces: item.pieces.slice() }));
    let selfTracked = false;
    const ledger = ledgerOf(state).map((entry) => {
      const owner = entry.groupId && state.groups.find((item) => item.id === entry.groupId);
      const follows = owner
        ? owner.pieces.every((id) => chosen.has(id))
        : state.pieces.every((piece) => !overlap(piece.source, entry.source) || chosen.has(piece.id));
      selfTracked = selfTracked || entry.groupId === groupId;
      return {
        ...entry,
        source: cloneRect(entry.source),
        destination: follows ? clamped(rescale(entry.destination, before, target), state) : cloneRect(entry.destination),
      };
    });
    if (!selfTracked) {
      ensure(ledger.length < LEDGER_LIMIT, "布局轨迹数量超出限制");
      ledger.push({ groupId, source: originOf(state, group), destination: cloneRect(target) });
    }
    state.pieces = background.concat(lifted);
    state.groups = groups;
    state.movements = ledger;
    // 已独立搬动过的子组件从严格包含它的父组里移除;部分重叠的组保持各自引用。
    for (const parent of state.groups) {
      if (parent.id === groupId || parent.pieces.length <= chosen.size) continue;
      const members = new Set(parent.pieces);
      if (Array.from(chosen).every((id) => members.has(id))) {
        parent.pieces = parent.pieces.filter((id) => !chosen.has(id));
      }
    }
    return extentOf(state, groupId);
  }

  /** 把布局画回画布:清屏后按层次逐切片 drawImage。 */
  function render(ctx, image, state) {
    ctx.save();
    try {
      if (typeof ctx.setTransform === "function") ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, state.width, state.height);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      ctx.beginPath();
      ctx.rect(0, 0, state.width, state.height);
      ctx.clip();
      for (const piece of layering(state)) {
        const s = piece.source, d = piece.to;
        ctx.drawImage(image, s.x1, s.y1, spanW(s), spanH(s), d.x1, d.y1, spanW(d), spanH(d));
      }
    } finally { ctx.restore(); }
  }

  // 两处搬动共仿射:b 的源矩形经 a 的映射落到 b 的目标。
  function sharesTransform(a, b) {
    return sameRect(rescale(b.source, a.source, a.to), b.to);
  }

  function edgeToEdge(a, b, horizontal) {
    return horizontal
      ? nearlyEq(a.y1, b.y1) && nearlyEq(a.y2, b.y2) && nearlyEq(a.x2, b.x1)
      : nearlyEq(a.x1, b.x1) && nearlyEq(a.x2, b.x2) && nearlyEq(a.y2, b.y1);
  }

  // 合并两处搬动,要求两者之间没有别的活动搬动横插一手(避免把不相邻的视觉变化并成一条)。
  function nothingBetween(regions, a, b) {
    const first = a.layer < b.layer ? a : b, second = a.layer < b.layer ? b : a;
    return !regions.some(
      (other) => other !== a && other !== b && other.active && other.layer > first.layer && other.layer < second.layer && overlap(first.to, other.to),
    );
  }

  /**
   * 汇出位移清单:每条 {source, movements: [{to}], annotations}。同一变换下源侧相邻
   * (水平或垂直贴边)且批注一致的多次搬动会逐轮合并成一条;批注回调逐切片提供文案。
   */
  function moves(state, notesForPiece) {
    ensure(notesForPiece === undefined || typeof notesForPiece === "function", "切片批注回调格式不正确");
    const entries = layering(state).map((piece, layer) => {
      if (sameRect(piece.source, piece.to)) return null;
      const notes = notesForPiece ? notesForPiece(piece) : [];
      ensure(Array.isArray(notes) && notes.every((text) => typeof text === "string"), "切片批注格式不正确");
      return { source: cloneRect(piece.source), to: cloneRect(piece.to), layer, active: true, annotations: notes.slice() };
    }).filter(Boolean);
    let merged;
    do {
      merged = false;
      for (const horizontal of [true, false]) {
        const ordered = entries.filter((e) => e.active).sort((a, b) => horizontal
          ? a.source.y1 - b.source.y1 || spanH(a.source) - spanH(b.source) || a.source.x1 - b.source.x1
          : a.source.x1 - b.source.x1 || spanW(a.source) - spanW(b.source) || a.source.y1 - b.source.y1);
        let prev = null;
        for (const curr of ordered) {
          const canMerge =
            prev &&
            edgeToEdge(prev.source, curr.source, horizontal) &&
            sharesTransform(prev, curr) &&
            prev.annotations.length === curr.annotations.length &&
            prev.annotations.every((text, i) => text === curr.annotations[i]) &&
            nothingBetween(entries, prev, curr);
          if (canMerge) {
            prev.source = unionOf(prev.source, curr.source);
            prev.to = unionOf(prev.to, curr.to);
            prev.layer = Math.max(prev.layer, curr.layer);
            curr.active = false;
            merged = true;
          } else prev = curr;
        }
      }
    } while (merged);
    return entries
      .filter((e) => e.active)
      .sort((a, b) => a.layer - b.layer)
      .map((e) => ({ source: e.source, movements: [{ to: e.to }], annotations: e.annotations.slice() }));
  }

  /** 命中测试:返回覆盖该点的组(按占用面积升序,小组优先)。 */
  function pick(state, x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
    const top = topSlab(layering(state), x, y);
    if (!top) return [];
    return state.groups
      .filter((group) => group.pieces.includes(top.id))
      .map((group) => ({ id: group.id, label: group.label, bounds: extentOf(state, group.id) }))
      .filter((choice) => choice.bounds)
      .sort((a, b) => areaOf(a.bounds) - areaOf(b.bounds));
  }

  // ——— 批注重映射 ———

  function pieceShift(before, afterPiece) {
    const kx = spanW(afterPiece.to) / spanW(before.to), ky = spanH(afterPiece.to) / spanH(before.to);
    return { kx, ky, dx: afterPiece.to.x1 - before.to.x1 * kx, dy: afterPiece.to.y1 - before.to.y1 * ky };
  }

  function applyShift(r, shift) {
    return {
      x1: r.x1 * shift.kx + shift.dx, y1: r.y1 * shift.ky + shift.dy,
      x2: r.x2 * shift.kx + shift.dx, y2: r.y2 * shift.ky + shift.dy,
    };
  }

  /**
   * 布局变化后重映射批注锚:整矩形落在「同一条仿射」覆盖内才搬,点批注跟随所在切片;
   * 跨空洞或跨不同变换的锚保持原位(没有唯一有意义的落点)。
   */
  function reflowNotes(notes, before, after) {
    ensure(Array.isArray(notes), "批注格式不正确");
    const result = JSON.parse(JSON.stringify(notes));
    const order = layering(before);
    const destinations = new Map(after.pieces.map((piece) => [piece.id, piece]));
    for (const note of result) {
      // 组件批注保留成员关系,由界面解析实时边界。
      if (note.source === null || note.groupId) continue;
      const anchor = checkRect(note.source, true);
      if (anchor.x1 === anchor.x2 && anchor.y1 === anchor.y2) {
        const slab = topSlab(order, anchor.x1, anchor.y1);
        const next = slab && destinations.get(slab.id);
        if (!next) continue;
        const shifted = applyShift(anchor, pieceShift(slab, next));
        const x = Math.max(0, Math.min(shifted.x1, after.width - TOL));
        const y = Math.max(0, Math.min(shifted.y1, after.height - TOL));
        note.source = { x1: x, y1: y, x2: x, y2: y };
        continue;
      }
      if (!(anchor.x2 > anchor.x1 && anchor.y2 > anchor.y1)) continue;
      let uncovered = [anchor], shared = null, consistent = true;
      // 自顶向下逐层吃掉覆盖;每个可见部分只计一次,层次与 render() 一致。
      for (let i = order.length - 1; i >= 0 && uncovered.length; --i) {
        const slab = order[i], next = destinations.get(slab.id), rest = [];
        for (const part of uncovered) {
          const covered = overlap(part, slab.to);
          if (!covered) { rest.push(part); continue; }
          if (!next) { consistent = false; break; }
          const shift = pieceShift(slab, next);
          if (shared && !sameRect(applyShift(anchor, shared), applyShift(anchor, shift))) { consistent = false; break; }
          if (!shared) shared = shift;
          rest.push(...minus(part, covered));
        }
        if (!consistent) break;
        uncovered = rest;
      }
      if (!consistent || uncovered.length || !shared) continue;
      const shifted = applyShift(anchor, shared);
      shifted.x1 = Math.max(0, Math.min(after.width, shifted.x1));
      shifted.y1 = Math.max(0, Math.min(after.height, shifted.y1));
      shifted.x2 = Math.max(0, Math.min(after.width, shifted.x2));
      shifted.y2 = Math.max(0, Math.min(after.height, shifted.y2));
      // 保留小数坐标:取整可能塌掉某一维。
      if (shifted.x2 > shifted.x1 && shifted.y2 > shifted.y1) note.source = shifted;
    }
    return result;
  }

  /** 完整性校验:切片恰好铺满原图、无重复源像素、组引用闭合、账本与组对齐。 */
  function verify(state, w, h) {
    ensure(
      state && Number.isInteger(state.width) && Number.isInteger(state.height) && state.width > 0 && state.height > 0,
      "布局大小不正确",
    );
    if (w === undefined) w = state.width;
    if (h === undefined) h = state.height;
    ensure(
      state.width === w && state.height === h && Array.isArray(state.pieces) && state.pieces.length > 0 &&
      state.pieces.length <= SLAB_LIMIT && Array.isArray(state.groups) && state.groups.length <= ZONE_LIMIT,
      "布局大小或数量不正确",
    );
    const seenIds = new Set(), sources = [];
    let covered = 0;
    for (const piece of state.pieces) {
      const source = checkRect(piece.source, false), to = checkRect(piece.to, false);
      ensure(
        typeof piece.id === "string" && piece.id.length > 0 && !seenIds.has(piece.id) && within(source, w, h) && within(to, w, h),
        "布局切片坐标或编号不正确",
      );
      seenIds.add(piece.id);
      covered += areaOf(source);
      sources.push(source);
    }
    sources.sort((a, b) => a.x1 - b.x1);
    for (let i = 0; i < sources.length; ++i) {
      for (let j = i + 1; j < sources.length && sources[j].x1 < sources[i].x2 - TOL; ++j) {
        ensure(!overlap(sources[i], sources[j]), "布局切片重复使用原图像素");
      }
    }
    ensure(Math.abs(covered - w * h) < Math.max(0.001, w * h * 1e-8), "布局切片未完整覆盖原图");
    const zoneIds = new Set();
    for (const group of state.groups) {
      ensure(
        typeof group.id === "string" && group.id.length > 0 && !zoneIds.has(group.id) &&
        typeof group.label === "string" && group.label.length <= 1000 &&
        Array.isArray(group.pieces) && group.pieces.length > 0 && group.pieces.length <= SLAB_LIMIT,
        "布局区域格式不正确",
      );
      zoneIds.add(group.id);
      if (group.originalBounds !== undefined && group.originalBounds !== null) {
        ensure(within(checkRect(group.originalBounds, false), w, h), "布局原始区域不正确");
      }
      const members = new Set();
      for (const id of group.pieces) {
        ensure(seenIds.has(id) && !members.has(id), "布局区域引用无效");
        members.add(id);
      }
    }
    if (state.movements !== undefined) {
      ensure(Array.isArray(state.movements) && state.movements.length <= LEDGER_LIMIT, "布局轨迹数量超出限制");
      const tracked = new Set();
      for (const entry of state.movements) {
        ensure(entry && within(checkRect(entry.source, false), w, h) && within(checkRect(entry.destination, false), w, h), "布局轨迹坐标不正确");
        if (entry.groupId !== null && entry.groupId !== undefined) {
          ensure(typeof entry.groupId === "string" && zoneIds.has(entry.groupId) && !tracked.has(entry.groupId), "布局轨迹区域引用无效或重复");
          tracked.add(entry.groupId);
          ensure(sameRect(entry.source, originOf(state, entry.groupId)), "布局轨迹原始区域不正确");
        }
      }
    }
    return true;
  }

  return { build, carve, extentOf, originOf, ledgerOf, moveGroup, render, moves, pick, verify, reflowNotes };
});
