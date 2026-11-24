/**
 * Design tokens — FT-07 §2/§3/§4.
 *
 * One source of truth for both apps. The mobile app consumes these as plain
 * objects; the web app emits them as CSS custom properties via `cssVariables()`.
 *
 * The palette is deliberately calm and clinical. FT-07 §1: the product must not
 * look like fortune-telling, because it is a research instrument that abstains
 * more often than it answers.
 */

export const colors = {
  bg: '#F7F9FC',
  surface: '#FFFFFF',
  text: '#162033',
  muted: '#667085',
  primary: '#245C8A',
  accent: '#2C7A7B',
  success: '#2E7D5B',
  warning: '#B7791F',
  danger: '#B54343',
  border: '#D8E1EA',
} as const;

export const spacing = {
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  6: 24,
  8: 32,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 20,
} as const;

export const motion = {
  fast: 120,
  normal: 220,
} as const;

export const typography = {
  display: { size: 30, lineHeight: 38, weight: '700' },
  h1: { size: 24, lineHeight: 32, weight: '700' },
  h2: { size: 20, lineHeight: 28, weight: '600' },
  body: { size: 16, lineHeight: 24, weight: '400' },
  bodyWeb: { size: 14, lineHeight: 22, weight: '400' },
  caption: { size: 13, lineHeight: 18, weight: '400' },
  code: { size: 13, lineHeight: 20, weight: '400' },
} as const;

/**
 * Arabic first, then a Latin fallback — FT-07 §3 and §7.
 * The UI is Arabic RTL by default with full English support.
 */
export const fontStacks = {
  arabic: "'Noto Sans Arabic', 'Segoe UI', system-ui, sans-serif",
  latin: "system-ui, -apple-system, 'Segoe UI', sans-serif",
  mono: "ui-monospace, SFMono-Regular, 'Cascadia Mono', monospace",
} as const;

/** Minimum tap target in points (FT-07 §7, WCAG 2.2 AA). */
export const MIN_TAP_TARGET = 44;

/**
 * Semantic colours for result states.
 *
 * `MODEL_UNAVAILABLE` is neutral, not an error colour: nothing went wrong. The
 * scan worked; the research programme has simply not produced an approved model
 * (ADR-008). Colouring it red would be a lie about the system's state.
 */
export const statusColors = {
  COMPLETED: colors.success,
  ABSTAINED: colors.warning,
  RETAKE_REQUIRED: colors.warning,
  MODEL_UNAVAILABLE: colors.muted,
  FAILED: colors.danger,
  DELETED: colors.muted,
} as const;

export type StatusKey = keyof typeof statusColors;

/** Render the tokens as CSS custom properties for the web app. */
export function cssVariables(): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(colors)) lines.push(`  --${key}: ${value};`);
  for (const [key, value] of Object.entries(spacing)) lines.push(`  --space-${key}: ${value}px;`);
  for (const [key, value] of Object.entries(radius)) lines.push(`  --radius-${key}: ${value}px;`);
  for (const [key, value] of Object.entries(motion)) lines.push(`  --motion-${key}: ${value}ms;`);
  lines.push(`  --font-arabic: ${fontStacks.arabic};`);
  lines.push(`  --font-latin: ${fontStacks.latin};`);
  lines.push(`  --font-mono: ${fontStacks.mono};`);
  return `:root {\n${lines.join('\n')}\n}`;
}
