/**
 * Processing — FT-17 §5.
 *
 * The stage list is the actual pipeline, not a decorative animation: a user who
 * sees "المقارنة مع الأطلس" knows what the system is doing with their scan.
 */

import { Text, View } from 'react-native';

import { t } from '@facetype/design-system';

import { Button } from '../components/Button.tsx';
import { styles, theme } from '../theme.ts';

const STAGES = [
  { key: 'processing.quality', stage: 'P03_SERVER_QUALITY' },
  { key: 'processing.geometry', stage: 'P05_RECONSTRUCTION' },
  { key: 'processing.genome', stage: 'P07_GENOME' },
  { key: 'processing.atlas', stage: 'P09_ATLAS' },
] as const;

const ORDER = [
  'P03_SERVER_QUALITY', 'P04_LANDMARK_GEOMETRY', 'P05_RECONSTRUCTION', 'P06_CANONICALIZATION',
  'P07_GENOME', 'P08_ENCODER', 'P09_ATLAS', 'P10_PERSONALITY', 'P11_CALIBRATION', 'P12_RETENTION',
];

export function ProcessingScreen({
  locale,
  stage,
  progress,
  errorCode,
  onRetry,
}: {
  locale: string;
  stage: string | null;
  progress: number;
  errorCode: string | null;
  onRetry: () => void;
}) {
  const reached = stage ? ORDER.indexOf(stage) : -1;

  return (
    <View style={[styles.screen, styles.centered]}>
      <Text style={styles.h1}>{t(locale, 'processing.title')}</Text>

      <View style={styles.bar} accessibilityRole="progressbar">
        <View style={[styles.barFill, { width: `${Math.round(progress * 100)}%` }]} />
      </View>

      <View style={styles.card}>
        {STAGES.map((item) => {
          const done = reached >= ORDER.indexOf(item.stage);
          return (
            <Text
              key={item.stage}
              style={[styles.body, { color: done ? theme.colors.success : theme.colors.muted }]}
            >
              {done ? '✓' : '…'} {t(locale, item.key)}
            </Text>
          );
        })}
      </View>

      {errorCode ? (
        <View style={styles.card}>
          <Text style={[styles.body, { color: theme.colors.warning }]}>{errorCode}</Text>
          <Button label={t(locale, 'common.retry')} onPress={onRetry} />
        </View>
      ) : (
        <Text style={styles.caption}>{t(locale, 'processing.leave')}</Text>
      )}
    </View>
  );
}
