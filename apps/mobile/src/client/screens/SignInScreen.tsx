/**
 * Screen 1 — sign-in (docs/client-app-v1.md §1). Apple, Google and, in dev
 * builds with the flag, «دخول تجريبي». A provider whose build config is
 * missing is drawn disabled with «غير مُعد بعد» instead of failing on tap.
 */

import type { ReactNode } from 'react';
import { ScrollView, Text, View } from 'react-native';

import { spacing } from '@facetype/design-system';

import { Button } from '../../components/Button.tsx';
import { styles } from '../../theme.ts';
import type { AuthProvider, ProviderId } from '../auth/types.ts';
import type { SignInError, SignedOutNotice } from '../clientFlow.ts';
import { s, type StringKey } from '../strings.ts';
import { LanguageSwitch, ui } from './ui.tsx';

const LABEL: Record<ProviderId, StringKey> = {
  apple: 'signin.apple',
  google: 'signin.google',
  mock: 'signin.mock',
};

const ERROR: Record<SignInError, StringKey> = {
  cancelled: 'signin.cancelled',
  network: 'common.network',
  server_unconfigured: 'signin.server_unconfigured',
  unconfigured: 'signin.unconfigured',
  unsupported: 'signin.unsupported',
  nonce_invalid: 'apierr.nonce_invalid',
  account_withdrawing: 'apierr.account_withdrawing',
  failed: 'signin.failed',
};

export function SignInScreen({
  providers,
  busy,
  error,
  notice,
  configError,
  onSignIn,
}: {
  providers: AuthProvider[];
  busy: ProviderId | null;
  error: SignInError | null;
  notice: SignedOutNotice;
  configError: string | null;
  onSignIn: (provider: ProviderId) => void;
}): ReactNode {
  return (
    <ScrollView contentContainerStyle={[styles.screen, { justifyContent: 'center', flexGrow: 1 }]}>
      <LanguageSwitch />
      <View style={{ gap: spacing[2] }}>
        <Text style={ui.title} accessibilityRole="header">
          {s('signin.title')}
        </Text>
        <Text style={ui.text}>{s('signin.subtitle')}</Text>
      </View>

      {notice === 'session_expired' ? <Text style={ui.text}>{s('common.session_expired')}</Text> : null}
      {configError ? (
        <Text style={ui.error} accessibilityLiveRegion="polite">
          {s('config.api_error', { code: configError })}
        </Text>
      ) : null}

      <View style={{ gap: spacing[3] }}>
        {providers.map((provider) => {
          const availability = provider.availability();
          const ready = availability === 'ready' && !configError;
          const label = s(LABEL[provider.id]);
          const suffix =
            availability === 'unconfigured'
              ? s('signin.unconfigured')
              : availability === 'unsupported'
                ? s('signin.unsupported')
                : null;
          return (
            <View key={provider.id} style={{ gap: spacing[1] }}>
              <Button
                label={suffix ? `${label} — ${suffix}` : label}
                onPress={() => onSignIn(provider.id)}
                disabled={!ready || (busy !== null && busy !== provider.id)}
                loading={busy === provider.id}
                variant={provider.id === 'mock' ? 'secondary' : 'primary'}
              />
              {provider.id === 'mock' && ready ? <Text style={ui.hint}>{s('signin.mock_note')}</Text> : null}
            </View>
          );
        })}
      </View>

      {error ? (
        <Text style={ui.error} accessibilityLiveRegion="polite">
          {s(ERROR[error])}
        </Text>
      ) : null}
      <Text style={ui.hint}>{s('signin.privacy_note')}</Text>
    </ScrollView>
  );
}
