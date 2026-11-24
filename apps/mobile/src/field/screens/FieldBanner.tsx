/**
 * The CALIBRATION / PROVISIONAL label.
 *
 * Rendered at the top of every field-study screen, including the receipt.
 * It reads `state.disposition` rather than a literal, so there is no screen in
 * this lane that can be shown without the disposition being displayed with it —
 * and no way to render a field screen that looks like the production result
 * flow.
 */

import { Text, View } from 'react-native';

import { ft } from '../strings.ts';
import type { FieldDisposition } from '../session.ts';
import { styles, theme } from '../../theme.ts';

export function FieldBanner({
  locale,
  disposition,
}: {
  locale: string;
  disposition: FieldDisposition;
}) {
  return (
    <View
      accessibilityRole="header"
      accessibilityLabel={ft(locale, 'field.banner.title')}
      style={[
        styles.card,
        { borderColor: theme.colors.warning, borderWidth: 2, gap: theme.spacing[2] },
      ]}
    >
      <Text style={[styles.h2, { color: theme.colors.warning }]}>
        {ft(locale, 'field.banner.title')}
      </Text>
      <Text style={styles.body}>{ft(locale, 'field.banner.body')}</Text>
      <Text style={styles.caption}>{disposition}</Text>
    </View>
  );
}
