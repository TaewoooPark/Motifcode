const MAX_INPUT_CHARS = 32_768;
const MAX_TERM_CHARS = 80;
const MAX_TERMS = 6;

interface Candidate { term: string; priority: number; offset: number }

/**
 * Literal hints for finding excerpts, not a query rewrite or an evidence verdict.
 * Only the original user task should be passed here, never model/server output.
 * Every returned value is an unchanged substring of the bounded input.
 */
export function extractFocusTerms(query: string): string[] {
  const input = query.slice(0, MAX_INPUT_CHARS);
  const candidates: Candidate[] = [];
  const add = (raw: string, priority: number, offset: number) => {
    const term = raw.trim();
    if (term.length < 2 || term.length > MAX_TERM_CHARS || /[\r\n\0]/.test(term)) return;
    candidates.push({ term, priority, offset: offset + raw.indexOf(term) });
  };

  // Negated classes and bounded input keep even unterminated quotes inexpensive.
  // Long quoted queries are skipped here; their technical tokens are still found
  // by the independent scans below.
  for (const match of input.matchAll(/`([^`\r\n]+)`/g)) add(match[1]!, 0, match.index + 1);
  for (const pattern of [/"([^"\r\n]+)"/g, /“([^”\r\n]+)”/g, /‘([^’\r\n]+)’/g, /(?:^|[^A-Za-z0-9])'([^'\r\n]+)'/g]) {
    for (const match of input.matchAll(pattern)) add(match[1]!, 1, match.index + match[0].indexOf(match[1]!));
  }

  // Consume each complete ASCII code token before testing its length. In
  // particular, never truncate an overlong path or identifier into a false ID.
  // Korean particles next to an ASCII identifier are not part of that identifier.
  for (const match of input.matchAll(/[A-Za-z0-9_~./:@%+#-]+/g)) {
    const token = match[0];
    if (/[A-Za-z0-9]/.test(token) && /[_/]|[A-Za-z0-9]-[A-Za-z0-9]|[A-Za-z0-9]\.[A-Za-z0-9]/.test(token)) {
      add(token, 2, match.index);
    }
  }

  // Adjacent pairs avoid treating "Title ACRONYM OTHER" as one exact phrase.
  // A pair needs at least one title-case word: adjacent bare acronyms are useful
  // independently. Preserve original whitespace for literal ResultStore.find.
  const phraseWordOffsets = new Set<number>();
  const words = [...input.matchAll(/\b[A-Z][A-Za-z0-9]{0,39}\b/g)];
  for (let index = 1; index < words.length; index++) {
    const left = words[index - 1]!; const right = words[index]!;
    const leftEnd = left.index + left[0].length;
    if (!/^[ \t]{1,4}$/.test(input.slice(leftEnd, right.index))) continue;
    if (!/[a-z]/.test(left[0] + right[0])) continue;
    const end = right.index + right[0].length;
    add(input.slice(left.index, end), 3, left.index);
    phraseWordOffsets.add(left.index);
    phraseWordOffsets.add(right.index);
  }
  for (const match of input.matchAll(/\b[A-Z][A-Z0-9]{2,}\b/g)) {
    // Do not spend another slot on an acronym already covered by a specific
    // two-word phrase. Long quoted queries deliberately do not count as coverage.
    if (!phraseWordOffsets.has(match.index)) add(match[0], 4, match.index);
  }

  candidates.sort((a, b) => a.priority - b.priority || b.term.length - a.term.length || a.offset - b.offset);
  const seen = new Set<string>();
  for (const { term } of candidates) {
    seen.add(term);
    if (seen.size === MAX_TERMS) break;
  }
  return [...seen];
}
