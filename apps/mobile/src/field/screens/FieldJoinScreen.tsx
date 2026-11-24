/**
 * The first screen of a field session: read the policy, then join with the
 * operator's one-time code.
 *
 * WHY THE CODE IS TYPED IN RATHER THAN BUILT IN. A join code compiled into the
 * APK is a credential shipped to every handset that ever installs the build,
 * recoverable from the bundle by anyone who unzips it, and unrevocable without
 * a release. It is typed in once per session, held in this component's state
 * for the length of one request, and then it is gone: `onJoin` does not return
 * it, the orchestrator does not store it, no reducer holds it, nothing is
 * persisted and it is never interpolated into a message or an error. The same
 * goes for the bearer token and the organisation id, which this screen never
 * sees at all.
 *
 * WHY JOINING IS BLOCKED UNTIL THE POLICY LOADS. The retention period a
 * participant is read has to be the deployment's own, and the only place that
 * states it is `GET /field-study/policy`. A build that joined first and read the
 * policy later would have an operator standing in front of somebody with a
 * consent screen it could not fill in — so the failure is shown here, before
 * anyone has been asked anything, with the code that says which failure it was
 * and a retry that is a retry rather than a bypass.
 */

import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';

import { Button } from '../../components/Button.tsx';
import { styles, theme } from '../../theme.ts';
import { FIELD_DISPOSITION } from '../session.ts';
import { mayOfferPhotoConsent, type FieldStudyPolicy } from '../policy.ts';
import { ft } from '../strings.ts';
import { FieldBanner } from './FieldBanner.tsx';

/** `join_code` is `min_length=4, max_length=64` server-side. */
const JOIN_CODE_MIN = 4;
const JOIN_CODE_MAX = 64;

export function FieldJoinScreen({
  locale,
  policy,
  busy,
  errorCode,
  onJoin,
  onReloadPolicy,
  onExit,
}: {
  locale: string;
  /** `null` until the deployment has answered. Nothing may be joined before. */
  policy: FieldStudyPolicy | null;
  busy: boolean;
  errorCode: string | null;
  onJoin: (joinCode: string) => void;
  onReloadPolicy: () => void;
  onExit: () => void;
}) {
  const [code, setCode] = useState('');
  const trimmed = code.trim();
  const usable =
    policy !== null && trimmed.length >= JOIN_CODE_MIN && trimmed.length <= JOIN_CODE_MAX;

  return (
    <View style={styles.screen}>
      <FieldBanner locale={locale} disposition={FIELD_DISPOSITION} />

      <Text style={styles.h1}>{ft(locale, 'field.join.title')}</Text>

      {policy === null ? (
        <View style={styles.card}>
          <Text style={[styles.body, { color: theme.colors.warning }]}>
            {ft(locale, 'field.join.policy_blocked', { code: errorCode ?? '—' })}
          </Text>
          <Button
            label={ft(locale, 'field.join.retry')}
            variant="secondary"
            loading={busy}
            onPress={onReloadPolicy}
          />
        </View>
      ) : (
        <View style={styles.card}>
          {/*
            * Read from the response, never from a build constant. What is on
            * this card is what the deployment will actually do.
            */}
          <Text style={styles.body}>
            {mayOfferPhotoConsent(policy)
              ? ft(locale, 'field.join.retention_on', { days: policy.rawPhotoRetentionDays })
              : ft(locale, 'field.join.retention_off')}
          </Text>
          <Text style={styles.caption}>
            {ft(locale, 'field.join.policy_version', { version: policy.consentPolicyVersion })}
          </Text>
          <Text style={styles.caption}>
            {ft(locale, 'field.join.protocol', { protocol: policy.captureProtocol })}
          </Text>
        </View>
      )}

      <View style={styles.card}>
        <Text style={styles.h2}>{ft(locale, 'field.join.code_label')}</Text>
        <TextInput
          accessibilityLabel={ft(locale, 'field.join.code_label')}
          value={code}
          onChangeText={setCode}
          autoCapitalize="characters"
          autoCorrect={false}
          autoComplete="off"
          // The code is a session secret read aloud in a room. It is not
          // offered to the keyboard's learning dictionary and not to autofill.
          spellCheck={false}
          maxLength={JOIN_CODE_MAX}
          editable={policy !== null && !busy}
          style={[
            styles.body,
            {
              borderWidth: 1,
              borderColor: usable ? theme.colors.border : theme.colors.warning,
              borderRadius: theme.radius.sm,
              padding: theme.spacing[3],
              minHeight: theme.MIN_TAP_TARGET,
            },
          ]}
        />
        <Text style={styles.muted}>{ft(locale, 'field.join.code_hint')}</Text>
      </View>

      {errorCode && policy !== null ? (
        <Text style={[styles.body, { color: theme.colors.warning }]}>{errorCode}</Text>
      ) : null}

      <Button
        label={ft(locale, 'field.join.submit')}
        disabled={!usable}
        loading={busy}
        onPress={() => {
          if (!usable) return;
          onJoin(trimmed);
          // Cleared the moment it is handed over: the operator has read it out,
          // the request carries it, and nothing on this device needs it again.
          setCode('');
        }}
      />
      <Button label={ft(locale, 'field.mode.exit')} variant="secondary" onPress={onExit} />
    </View>
  );
}
