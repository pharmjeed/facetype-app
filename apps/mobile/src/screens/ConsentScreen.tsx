/**
 * Consent — FT-17 §2.
 *
 * Consent is captured *before* the camera opens and is stored as an immutable
 * snapshot server-side. The research opt-in is separate and defaults to off:
 * FT-01 §12 requires research retention to be explicitly granted, never
 * inferred from the fact that someone agreed to a scan.
 */

import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { t } from '@facetype/design-system';

import { Button } from '../components/Button.tsx';
import { styles, theme } from '../theme.ts';

function Checkbox({
  checked,
  label,
  onToggle,
}: {
  checked: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={label}
      onPress={onToggle}
      style={[styles.row, { minHeight: theme.MIN_TAP_TARGET }]}
    >
      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: 6,
          borderWidth: 2,
          borderColor: checked ? theme.colors.primary : theme.colors.border,
          backgroundColor: checked ? theme.colors.primary : 'transparent',
        }}
      />
      <Text style={[styles.body, { flex: 1 }]}>{label}</Text>
    </Pressable>
  );
}

export function ConsentScreen({
  locale,
  busy,
  errorCode,
  /**
   * FT-03 §3 signals this device cannot measure (ADR-011).
   *
   * When it contains `occlusion`, the app cannot tell whether anything is
   * covering the user's face, so it asks — and this screen is the last moment
   * before the camera opens at which asking is still "pre-capture". The answer
   * is a statement by a person and is stored as one; it is never an occlusion
   * measurement, never a quality signal, and cannot satisfy a gate.
   */
  unmeasuredSignals = [],
  onContinue,
}: {
  locale: string;
  busy: boolean;
  errorCode: string | null;
  unmeasuredSignals?: readonly string[];
  onContinue: (
    granted: boolean,
    researchOptIn: boolean,
    analyticsConsent: boolean,
    obstructionSelfAttested: boolean,
  ) => void;
}) {
  const [agreed, setAgreed] = useState(false);
  const [research, setResearch] = useState(false);
  const [analyticsConsent, setAnalyticsConsent] = useState(false);
  const [uncovered, setUncovered] = useState(false);

  const mustConfirmUncovered = unmeasuredSignals.includes('occlusion');
  // Required, not optional: on a device that cannot assess occlusion this is
  // the only thing standing between a scan and an obstructed face nobody
  // noticed. It is a weak guarantee -- a person can tick a box and be wrong --
  // which is exactly why it is recorded as an attestation rather than folded
  // into the quality score as though it were evidence.
  const canContinue = agreed && (!mustConfirmUncovered || uncovered);

  return (
    <View style={styles.screen}>
      <Text style={styles.h1}>{t(locale, 'consent.title')}</Text>

      <View style={styles.card}>
        <Text style={styles.body}>• {t(locale, 'consent.geometry')}</Text>
        <Text style={styles.body}>• {t(locale, 'consent.raw_frames')}</Text>
        <Text style={styles.body}>• {t(locale, 'consent.no_questions')}</Text>
      </View>

      {mustConfirmUncovered ? (
        <View style={styles.card}>
          <Text style={styles.h2}>{t(locale, 'obstruction.title')}</Text>
          <Text style={styles.body}>{t(locale, 'obstruction.body')}</Text>
          <Text style={[styles.body, { opacity: 0.75 }]}>{t(locale, 'obstruction.note')}</Text>
        </View>
      ) : null}

      <Checkbox checked={agreed} label={t(locale, 'consent.agree')} onToggle={() => setAgreed(!agreed)} />
      {mustConfirmUncovered ? (
        <Checkbox
          checked={uncovered}
          label={t(locale, 'obstruction.confirm')}
          onToggle={() => setUncovered(!uncovered)}
        />
      ) : null}
      <Checkbox
        checked={research}
        label={t(locale, 'consent.research_opt_in')}
        onToggle={() => setResearch(!research)}
      />
      <Checkbox
        checked={analyticsConsent}
        label={t(locale, 'consent.analytics_opt_in')}
        onToggle={() => setAnalyticsConsent(!analyticsConsent)}
      />

      <Button
        label={t(locale, 'consent.continue')}
        disabled={!canContinue}
        loading={busy}
        onPress={() => onContinue(agreed, research, analyticsConsent, uncovered)}
        accessibilityHint={t(locale, 'consent.agree')}
      />
      {errorCode ? (
        <Text style={[styles.body, { color: theme.colors.warning }]}>{errorCode}</Text>
      ) : null}
    </View>
  );
}
