/** Tokenize invocation arguments without executing or expanding shell syntax. */
export function splitSkillArguments(input: string): string[] {
  const out: string[] = [];
  let word = "", quote = "", started = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (ch === "\\" && quote !== "'" && i + 1 < input.length) { word += input[++i]; started = true; }
    else if (quote) { if (ch === quote) quote = ""; else word += ch; started = true; }
    else if (ch === '"' || ch === "'") { quote = ch; started = true; }
    else if (/\s/.test(ch)) { if (started) { out.push(word); word = ""; started = false; } }
    else { word += ch; started = true; }
  }
  if (quote) throw new Error("skill arguments contain an unterminated quote");
  if (started) out.push(word);
  return out;
}

/** One replacement pass: user input containing placeholders stays literal. */
export function substituteSkillArguments(body: string, input: string, names: readonly string[] = []): string {
  const args = splitSkillArguments(input);
  const named = new Map(names.map((name, index) => [name, args[index] ?? ""]));
  let received = false;
  const expanded = body.replace(/(\\*)\$(ARGUMENTS(?:\[(\d+)\])?|\d+|[A-Za-z_][\w-]*)(?![\w-])/g, (match, slashes: string, token: string, index: string | undefined) => {
    const supported = token === "ARGUMENTS" || index !== undefined || /^\d+$/.test(token) || named.has(token);
    if (!supported) return match;
    if (slashes.length % 2 === 1) return `${slashes.slice(1)}$${token}`;
    let replacement: string | undefined;
    if (token === "ARGUMENTS") replacement = input;
    else if (named.has(token)) replacement = named.get(token);
    else replacement = args[Number(index ?? token)];
    if (replacement === undefined) return match;
    received = true;
    return `${slashes}${replacement}`;
  });
  return input && !received ? `${expanded}\n\nInput from the person:\n${input}` : expanded;
}
