/**
 * wire 子路径导出:`@lampgenie/code-sense/wire`
 * scanWire(root, opts) → WireScanResult;renderWire(result) → 人类可读表。
 */
export { scanWire, WIRE_PATHS } from "./scan.js";
export { renderWire } from "./render.js";
export type {
  WireChangedInfo, WireHandler, WireLocation, WireOrphanDeclared, WireOrphans, WireReceive,
  WireReceiveForm, WireScanOptions, WireScanResult, WireSend, WireStatus, WireTypeRow,
  WireUnion, WireUnionKind, WireUnionMember, WireUnresolvedMember,
} from "./types.js";
