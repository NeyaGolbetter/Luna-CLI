declare module 'marked-terminal' {
  import type { MarkedExtension } from 'marked';

  /** Flat style options: any subset of {code, blockquote, heading, firstHeading,
   *  hr, listitem, list, table, paragraph, strong, em, codespan, del, link, href, text,
   *  unescape, emoji, width, tab, tableOptions}. */
  export interface MarkedTerminalOptions {
    code?: (s: string) => string;
    blockquote?: (s: string) => string;
    heading?: (s: string) => string;
    firstHeading?: (s: string) => string;
    hr?: (s: string) => string;
    listitem?: (s: string) => string;
    list?: (s: string) => string;
    table?: (s: string) => string;
    paragraph?: (s: string) => string;
    strong?: (s: string) => string;
    em?: (s: string) => string;
    codespan?: (s: string) => string;
    del?: (s: string) => string;
    link?: (s: string) => string;
    href?: (s: string) => string;
    text?: (s: string) => string;
    unescape?: boolean;
    emoji?: boolean;
    width?: number;
    tab?: number;
    [key: string]: unknown;
  }

  export interface HighlightOptions {
    ignoreLanguage?: boolean;
    noErrorColor?: boolean;
    theme?: string;
    [key: string]: unknown;
  }

  export function markedTerminal(
    options?: MarkedTerminalOptions,
    highlightOptions?: HighlightOptions,
  ): MarkedExtension;
}
