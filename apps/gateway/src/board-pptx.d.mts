/** board-pptx.mjs 的类型声明(实现见同名 .mjs)。 */
export declare function deckToPptx(deck: unknown, outPath: string): Promise<{ file: string; slides: number }>;
export declare function parseDeckMd(md: string): unknown;
export declare function validateDeck(deck: unknown): { where: string; msg: string }[];
export declare function planDeck(deck: unknown): unknown[];
export declare function humanize(s: unknown): string;
export declare function boardToDeckTemplate(doc: unknown): string;
export declare function boardToCompositionTemplate(doc: unknown, opts?: { relations?: readonly string[] }): string;
export declare function regenSimilarity(deck: unknown, oldMd: string): { total: number; matched: number; twin: number; twins: string[] };

/** v4 主题名（editorial / technical / executive / warm）。 */
export declare const THEME_NAMES: string[];
export declare const DEFAULT_THEME: string;
