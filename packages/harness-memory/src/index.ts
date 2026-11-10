// Public surface of @lampgenie/memory.
//
// The package previously had no entry point ("exports" pointed at this file
// before it existed), which made the whole port un-importable. Everything a
// gateway caller needs is here: the two-document memory context renderer, the
// session-end learning pipeline (extractor + profile observer + preference
// pool/promoter), the provider contracts, and the gateway-facing integration
// glue from ./wiring (createMemoryWiring).
//
// Note: ProfileWatcher is re-exported from ./wiring, not from
// ./learning/profile-observer — the original module cannot be imported at all
// (its `@lampgenie/runtime/src/core/sensitive-content` specifier resolves
// to src/src/... under the runtime exports map, which does not exist). wiring
// carries a behavior-preserving typed port; see the note there.

export {
  buildMemoryBriefing,
} from './context'

export {
  SCOPE_ALL,
  MEMORY_DOC_KINDS,
  MEMORY_SCOPE_SET,
  scopeKey,
  isPolicyScope,
  isMemoryDocFile,
} from './scopes'

export {
  MEMORY_PROVIDER_API_VERSION,
  guardMemoryProvider,
  summarizeMemoryProvider,
  tidyProviderHealth,
} from './provider'

export { MarkdownMemoryStore } from './providers/markdown/provider'

export { MemoryMiner } from './learning/extractor'

export {
  DRAFT_DEFAULTS,
  PROFILE_KEYS,
  PreferenceDraftPool,
  scoreSlot,
  sameFieldLabel,
  formatFieldLabel,
} from './learning/preference-candidates'

export {
  PROMOTION_MARKERS,
  PreferenceAdvancer,
  formatObservedBlock,
  splitObservedBlock,
} from './learning/preference-promoter'

export * from './wiring'
