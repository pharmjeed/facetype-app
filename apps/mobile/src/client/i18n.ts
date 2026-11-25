/**
 * Interface language (owner 2026-11-25: Arabic by default, switchable to English) and the layout direction that
 * follows from it. Pure: no React Native import, so it is unit-tested in Node.
 *
 * Direction is computed, not left to `I18nManager`. React Native fixes its native layout direction when the
 * app starts (a `forceRTL` call only takes effect on the next launch), and in an RTL layout it swaps
 * `textAlign: 'left' | 'right'` (RCTTextAttributes.mm, ReactBaseTextShadowNode.getTextAlign). So the
 * wanted direction is combined with the native one of this launch: right after an install, after a language
 * switch and after the switch has reached the native side alike.
 */

export type Lang = 'ar' | 'en';

export const LANGS: readonly Lang[] = ['ar', 'en'];

let current: Lang = 'ar';

export function lang(): Lang {
  return current;
}

/** Sets the language for every later `s()` call and style helper; the screen re-renders through context. */
export function setLang(next: Lang): void {
  current = next;
}

export function isLang(value: unknown): value is Lang {
  return value === 'ar' || value === 'en';
}

export function wantsRtl(language: Lang = current): boolean {
  return language === 'ar';
}

/** `textAlign` that puts text at the reading start (right in Arabic, left in English). */
export function startTextAlign(nativeRtl: boolean, language: Lang = current): 'left' | 'right' {
  // In an RTL native layout React Native renders 'left' on the right, and the other way round.
  return wantsRtl(language) === nativeRtl ? 'left' : 'right';
}

/** `textAlign` that keeps text physically on the left (numbers typed left to right). */
export function leftTextAlign(nativeRtl: boolean): 'left' | 'right' {
  return nativeRtl ? 'right' : 'left';
}

/** `flexDirection` whose first child sits at the reading start. */
export function rowDirection(nativeRtl: boolean, language: Lang = current): 'row' | 'row-reverse' {
  return wantsRtl(language) === nativeRtl ? 'row' : 'row-reverse';
}

/** Cross-axis alignment to the reading start in a column. */
export function crossStart(nativeRtl: boolean, language: Lang = current): 'flex-start' | 'flex-end' {
  return wantsRtl(language) === nativeRtl ? 'flex-start' : 'flex-end';
}
