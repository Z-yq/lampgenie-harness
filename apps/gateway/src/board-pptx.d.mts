/** board-pptx.mjs 的类型声明(实现见同名 .mjs)。 */
export declare function deckToPptx(deck: unknown, outPath: string): Promise<{ file: string; slides: number }>;
export declare function parseDeckMd(md: string): unknown;
export declare function validateDeck(deck: unknown): { where: string; msg: string }[];
export declare function planDeck(deck: unknown): unknown[];
export declare function humanize(s: unknown): string;
export declare function boardToDeckTemplate(doc: unknown): string;
export declare function boardToCompositionTemplate(doc: unknown, opts?: { relations?: readonly string[] }): string;
