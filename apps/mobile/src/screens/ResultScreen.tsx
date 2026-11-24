/**
 * Result — FT-17 §6/§7/§8, FT-07 §6.
 *
 * Four genuinely different screens, not one screen with a spinner:
 *
 *  COMPLETED           top type, calibrated confidence, four dimension bars
 *  ABSTAINED           no type at all; the reason, and a rescan action
 *  MODEL_UNAVAILABLE   the scan worked; the model is not approved yet
 *  RETAKE_REQUIRED     the exact angle to redo
 *
 * `canDisplayType` from the contracts package is the single check that decides
 * whether a headline type may render. It is not a local UI opinion: FT-02 §2
 * permits a type only on a COMPLETED result that actually carries one.
 */

import { ScrollView, Text, View } from 'react-native';

import { canDisplayType, confidenceBucket, type ResultResponse } from '@facetype/contracts';
import { t } from '@facetype/design-system';

import { Button } from '../components/Button.tsx';
import { styles, theme } from '../theme.ts';

function DimensionBar({
  code,
  letters,
}: {
  code: string;
  letters: Record<string, number>;
}) {
  const entries = Object.entries(letters);
  const first = entries[0];
  const second = entries[1];
  if (!first || !second) return null;
  const percent = Math.round(first[1] * 100);

  return (
    <View style={{ gap: 4 }} accessibilityLabel={`${code}: ${first[0]} ${percent}%`}>
      <View style={styles.row}>
        <Text style={styles.caption}>{first[0]} {percent}%</Text>
        <View style={{ flex: 1 }} />
        <Text style={styles.caption}>{second[0]} {100 - percent}%</Text>
      </View>
      <View style={styles.bar}>
        <View style={[styles.barFill, { width: `${percent}%` }]} />
      </View>
    </View>
  );
}

export function ResultScreen({
  locale,
  result,
  onRescan,
  onDelete,
}: {
  locale: string;
  result: ResultResponse;
  onRescan: () => void;
  onDelete: () => void;
}) {
  const personality = result.personality ?? null;
  const showType = canDisplayType(result);

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      {showType && personality?.top_type ? (
        <>
          <Text style={styles.caption}>{t(locale, 'result.top_type')}</Text>
          <Text style={styles.display}>{personality.top_type}</Text>
          <Text style={styles.muted}>
            {t(locale, 'result.confidence')}:{' '}
            {t(locale, `confidence.${confidenceBucket(personality.confidence)}` as 'confidence.medium')}{' '}
            {personality.confidence ? `${Math.round(personality.confidence * 100)}%` : ''}
          </Text>

          <View style={styles.card}>
            {Object.entries(personality.dimensions ?? {}).map(([code, letters]) => (
              <DimensionBar key={code} code={code} letters={letters as Record<string, number>} />
            ))}
          </View>

          {personality.types && personality.types.length > 1 ? (
            <Text style={styles.caption}>
              {t(locale, 'result.alternatives')}:{' '}
              {personality.types
                .slice(1)
                .map((alt) => `${alt.type} ${Math.round(Number(alt.p) * 100)}%`)
                .join(' · ')}
            </Text>
          ) : null}

          <Text style={styles.muted}>{t(locale, 'result.non_causal')}</Text>
          {personality.research_watermark ? (
            <Text style={[styles.caption, { color: theme.colors.warning }]}>
              {t(locale, 'result.research_watermark')}
            </Text>
          ) : null}
        </>
      ) : result.status === 'ABSTAINED' ? (
        <>
          <Text style={styles.h1}>{t(locale, 'result.abstain')}</Text>
          <Text style={styles.body}>{t(locale, 'result.abstain.body')}</Text>
        </>
      ) : result.status === 'MODEL_UNAVAILABLE' ? (
        <>
          <Text style={styles.h1}>{t(locale, 'result.model_unavailable')}</Text>
          <Text style={styles.body}>{t(locale, 'result.model_unavailable.body')}</Text>
        </>
      ) : (
        <>
          <Text style={styles.h1}>{t(locale, 'result.failed')}</Text>
          <Text style={styles.muted}>{(result.error_codes ?? []).join(' · ')}</Text>
        </>
      )}

      <View style={styles.card}>
        <Text style={styles.caption}>
          {t(locale, 'processing.quality')}:{' '}
          {Math.round(Number(result.quality?.overall ?? 0) * 100)}%
        </Text>
        <Text style={styles.caption}>
          {t(locale, 'processing.genome')}: {result.morphology?.genome_schema ?? '—'}
        </Text>
      </View>

      <Text style={styles.caption}>{t(locale, 'result.method_note')}</Text>

      <Button label={t(locale, 'result.rescan')} onPress={onRescan} />
      <Button label={t(locale, 'privacy.delete')} variant="secondary" onPress={onDelete} />
    </ScrollView>
  );
}
