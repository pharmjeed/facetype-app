/** Privacy and deletion — FT-17 §14 (Result → Details → Privacy/Delete). */

import { Text, View } from 'react-native';

import { t } from '@facetype/design-system';

import { Button } from '../components/Button.tsx';
import { styles } from '../theme.ts';

export function PrivacyScreen({
  locale,
  deleting,
  onDelete,
  onCancel,
}: {
  locale: string;
  deleting: boolean;
  onDelete: () => void;
  onCancel: () => void;
}) {
  return (
    <View style={[styles.screen, styles.centered]}>
      <Text style={styles.h1}>{t(locale, 'privacy.delete')}</Text>
      <Text style={styles.body}>{t(locale, 'privacy.delete_confirm')}</Text>

      <View style={styles.card}>
        <Text style={styles.muted}>• {t(locale, 'consent.geometry')}</Text>
        <Text style={styles.muted}>• {t(locale, 'consent.raw_frames')}</Text>
      </View>

      <Button label={t(locale, 'privacy.delete')} onPress={onDelete} loading={deleting} />
      <Button label={t(locale, 'common.cancel')} variant="secondary" onPress={onCancel} />
    </View>
  );
}
