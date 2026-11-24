/** Welcome — FT-17 §1. */

import { Text, View } from 'react-native';

import { t } from '@facetype/design-system';

import { Button } from '../components/Button.tsx';
import { styles, theme } from '../theme.ts';

export function WelcomeScreen({
  locale,
  busy,
  errorCode,
  onStart,
  /**
   * Entry to the field-study calibration lane, or `null` in every build that
   * does not run one.
   *
   * `null` rather than a disabled button: an ordinary consumer build must not
   * show that a research collection mode exists, and a component that renders
   * nothing when it is absent cannot be made to show one by a state change.
   */
  fieldStudy = null,
}: {
  locale: string;
  busy: boolean;
  errorCode: string | null;
  onStart: () => void;
  fieldStudy?: { label: string; onEnter: () => void } | null;
}) {
  return (
    <View style={[styles.screen, styles.centered]}>
      <View style={styles.faceFrame}>
        <Text style={styles.muted} accessibilityElementsHidden>
          ◯
        </Text>
      </View>

      <Text style={styles.display}>{t(locale, 'app.name')}</Text>
      <Text style={styles.body}>{t(locale, 'app.tagline')}</Text>

      {errorCode ? (
        <Text style={[styles.body, { color: theme.colors.warning }]}>{errorCode}</Text>
      ) : null}
      <Button label={t(locale, 'scan.start')} onPress={onStart} loading={busy} />

      <Text style={styles.caption}>{t(locale, 'result.method_note')}</Text>

      {fieldStudy ? (
        <Button
          label={fieldStudy.label}
          variant="secondary"
          onPress={fieldStudy.onEnter}
          loading={busy}
        />
      ) : null}
    </View>
  );
}
