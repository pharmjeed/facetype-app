/**
 * Retake — FT-17 §4.
 *
 * Names the single angle that failed. The user repeats one step, not the whole
 * scan (FT-05 §2).
 */

import { Text, View } from 'react-native';

import { t } from '@facetype/design-system';

import type { PoseLabel } from '../capture/types.ts';
import { Button } from '../components/Button.tsx';
import { styles } from '../theme.ts';

export function RetakeScreen({
  locale,
  pose,
  onRetake,
  onLater,
}: {
  locale: string;
  pose: PoseLabel | null;
  onRetake: () => void;
  onLater: () => void;
}) {
  const poseLabel = pose ? t(locale, `pose.${pose}` as 'pose.front') : '';

  return (
    <View style={[styles.screen, styles.centered]}>
      <Text style={styles.h1}>{t(locale, 'result.retake.title')}</Text>
      <Text style={styles.body}>{t(locale, 'result.retake.body', { pose: poseLabel })}</Text>

      <Button label={t(locale, 'result.rescan')} onPress={onRetake} />
      <Button label={t(locale, 'common.later')} variant="secondary" onPress={onLater} />
    </View>
  );
}
