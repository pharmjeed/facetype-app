/**
 * Direction styles for the current interface language and this launch's native layout direction (see
 * `../i18n.ts` for why both are needed).
 */

import { I18nManager, type TextStyle, type ViewStyle } from 'react-native';

import { crossStart, rowDirection, startTextAlign, wantsRtl } from '../i18n.ts';

/** Text at the reading start of the current language. */
export function dirText(): TextStyle {
  return { textAlign: startTextAlign(I18nManager.isRTL), writingDirection: wantsRtl() ? 'rtl' : 'ltr' };
}

/** A row whose first child sits at the reading start. */
export function dirRow(): ViewStyle {
  return { flexDirection: rowDirection(I18nManager.isRTL) };
}

/** Column children aligned to the reading start. */
export function dirCrossStart(): ViewStyle {
  return { alignItems: crossStart(I18nManager.isRTL) };
}
