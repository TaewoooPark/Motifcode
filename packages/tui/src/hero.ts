/**
 * The splash.
 *
 * Three widths, because a hero that wraps is worse than no hero. Width is
 * measured in characters and every glyph used here is East-Asian *narrow*, so
 * the art aligns in any monospace terminal rather than only in the one it was
 * drawn in.
 */

export const HERO_LARGE = String.raw`
 ██████   ██████    ███████    ███████████ █████ ███████████   █████████     ███████    ██████████   ██████████
▒▒██████ ██████   ███▒▒▒▒▒███ ▒█▒▒▒███▒▒▒█▒▒███ ▒▒███▒▒▒▒▒▒█  ███▒▒▒▒▒███  ███▒▒▒▒▒███ ▒▒███▒▒▒▒███ ▒▒███▒▒▒▒▒█
 ▒███▒█████▒███  ███     ▒▒███▒   ▒███  ▒  ▒███  ▒███   █ ▒  ███     ▒▒▒  ███     ▒▒███ ▒███   ▒▒███ ▒███  █ ▒
 ▒███▒▒███ ▒███ ▒███      ▒███    ▒███     ▒███  ▒███████   ▒███         ▒███      ▒███ ▒███    ▒███ ▒██████
 ▒███ ▒▒▒  ▒███ ▒███      ▒███    ▒███     ▒███  ▒███▒▒▒█   ▒███         ▒███      ▒███ ▒███    ▒███ ▒███▒▒█
 ▒███      ▒███ ▒▒███     ███     ▒███     ▒███  ▒███  ▒    ▒▒███     ███▒▒███     ███  ▒███    ███  ▒███ ▒   █
 █████     █████ ▒▒▒███████▒      █████    █████ █████       ▒▒█████████  ▒▒▒███████▒   ██████████   ██████████
▒▒▒▒▒     ▒▒▒▒▒    ▒▒▒▒▒▒▒       ▒▒▒▒▒    ▒▒▒▒▒ ▒▒▒▒▒         ▒▒▒▒▒▒▒▒▒     ▒▒▒▒▒▒▒    ▒▒▒▒▒▒▒▒▒▒   ▒▒▒▒▒▒▒▒▒▒ `.slice(1);

export const HERO_SMALL = String.raw`
░█▄█░█▀█░▀█▀░▀█▀░█▀▀░█▀▀░█▀█░█▀▄░█▀▀
░█░█░█░█░░█░░░█░░█▀▀░█░░░█░█░█░█░█▀▀
░▀░▀░▀▀▀░░▀░░▀▀▀░▀░░░▀▀▀░▀▀▀░▀▀░░▀▀▀`.slice(1);

export const HERO_SHADED = String.raw`
█▀█▀█ █▀█ ▀█▀ ▀█▀ █▀▀ █▀▀ █▀█ █▀▄ █▀▀
█   ▓ █ ▓  ▓░  ▓░ ▓▀  ▓░  █ ▓ █ ▓ ▓▀
▀   ▀ ▀▀▀  ▀  ▀▀▀ ▀   ▀▀▀ ▀▀▀ ▀▀  ▀▀▀`.slice(1);

import { padToWidth, truncateToWidth } from "./width.js";

export const HERO_WIDTH = { large: 111, small: 36, shaded: 37 } as const;

export type HeroVariant = "large" | "small" | "shaded" | "none";

export function pickHero(columns: number, shaded = false): HeroVariant {
  if (columns >= HERO_WIDTH.large) return "large";
  if (columns >= HERO_WIDTH.shaded) return shaded ? "shaded" : "small";
  return "none";
}

export function heroLines(variant: HeroVariant): string[] {
  switch (variant) {
    case "large":
      return HERO_LARGE.split("\n");
    case "small":
      return HERO_SMALL.split("\n");
    case "shaded":
      return HERO_SHADED.split("\n");
    default:
      return [];
  }
}

export interface HeroContext {
  model: string;
  endpoint: string;
  channel: string;
  contextTokens?: number;
  maxTokens?: number;
}

export function heroSubtitle(ctx: HeroContext): string[] {
  const ctxLine =
    ctx.maxTokens !== undefined
      ? `${fmtTokens(ctx.contextTokens ?? 0)}/${fmtTokens(ctx.maxTokens)} ctx`
      : "";
  return [
    `${ctx.model}  ·  ${ctx.endpoint}`,
    [ctxLine, `ch ${ctx.channel}`, "ready"].filter(Boolean).join("  ·  "),
  ];
}

export function fmtTokens(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

export interface WelcomeContext {
  version: string;
  model: string;
  cwd: string;
}

/**
 * The box under the hero when a session opens.
 *
 * Claude Code greets with a small bordered card — what to type for help, and
 * where it is working — and that is the right amount: the hero says what this
 * is, the card says what to do next.
 */
export function welcomeLines(ctx: WelcomeContext, width: number): string[] {
  const inner = Math.max(24, Math.min(width, 78) - 4);
  const fit = (s: string): string => padToWidth(truncateToWidth(s, inner), inner);
  const body = [
    `✻ Welcome to motif ${ctx.version}`,
    "",
    "  /help for commands · /status for your setup",
    "  esc interrupts a task · ctrl-c twice quits",
    "",
    `  model  ${ctx.model}`,
    `  cwd    ${ctx.cwd}`,
  ];
  return [
    `╭${"─".repeat(inner + 2)}╮`,
    ...body.map((l) => `│ ${fit(l)} │`),
    `╰${"─".repeat(inner + 2)}╯`,
  ];
}
