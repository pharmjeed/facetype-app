/**
 * The client app shell (docs/client-app-v1.md §4): wires the pure navigation
 * reducer (`clientFlow.ts`) to the four screens and owns every side effect —
 * sign-in, GET /me, profile + consent saves, account deletion, and the durable
 * upload spool that keeps running while the person is on the profile page.
 *
 * Mounted by `App.tsx` unless the field-study build flag is set. Arabic only,
 * right-to-left.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import {
  AppState,
  BackHandler,
  I18nManager,
  NativeModules,
  Platform,
  SafeAreaView,
  StatusBar,
  Text,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { Button } from '../components/Button.tsx';
import { styles } from '../theme.ts';
import { ApiConfigurationError, buildPolicy, resolveApiBaseUrl } from '../api/endpoint.ts';
import type { SecureValueStore } from '../api/sessionPersistence.ts';
import { createClientApi, isClientApiError, uuidV4, type ClientApi } from './api/clientApi.ts';
import { memoryTokenStore, secureTokenStore } from './api/tokens.ts';
import type { AttemptTelemetry } from './api/types.ts';
import { appleProvider } from './auth/appleProvider.ts';
import { authConfigFromEnv } from './auth/config.ts';
import { googleProvider } from './auth/googleProvider.ts';
import { mockProvider } from './auth/mockProvider.ts';
import type { AuthProvider, ProviderId, SignInOutcome } from './auth/types.ts';
import { initialClientState, reduceClient, type SignInError } from './clientFlow.ts';
import { apiErrorKey, profileFieldErrorKey } from './messages.ts';
import { CLIENT_BUILD_ENV } from './env.ts';
import { cameraBackend, type CameraBackend } from './native/clientCamera.tsx';
import type { BurstFrame, CameraCapabilities, FrameMeta } from './native/types.ts';
import { CaptureScreen } from './screens/CaptureScreen.tsx';
import { ProfileScreen } from './screens/ProfileScreen.tsx';
import { ProfileSetupScreen, type SetupServerError } from './screens/ProfileSetupScreen.tsx';
import { SignInScreen } from './screens/SignInScreen.tsx';
import { isTerminal } from './spool/manifest.ts';
import { nativeBackedMetaVault } from './spool/metaVault.ts';
import { nextRunInMs, SpoolRunner, type SpoolDeps, type SpoolOutcome } from './spool/spool.ts';
import { CONSENT_VERSION, s } from './strings.ts';
import type { PendingAttempt } from './telemetry.ts';
import type { ProfileForm, ProfileValues } from './validation.ts';

const POLICY = buildPolicy(process.env.FACETYPE_ALLOW_CLEARTEXT);

const API_ENDPOINT = ((): { url: string } | { error: string } => {
  try {
    return { url: resolveApiBaseUrl(process.env.FACETYPE_API_URL, POLICY) };
  } catch (error) {
    return { error: error instanceof ApiConfigurationError ? error.code : 'API_URL_INVALID' };
  }
})();

/** Dev bundle or explicitly flagged preview build; never a store release. */
const NON_RELEASE = POLICY.allowCleartext;
const AUTH_CONFIG = authConfigFromEnv(CLIENT_BUILD_ENV, Platform.OS, NON_RELEASE);
const MOCK_SUBJECT_KEY = '@facetype/client-mock-subject/v1';
const RETRY_AFTER_CRASH_MS = 10_000;

interface NativeSecureSession {
  loadSession(): Promise<string | null>;
  saveSession(value: string): Promise<void>;
  clearSession(): Promise<void>;
}

function secureValueStore(): SecureValueStore | null {
  const module = (NativeModules as Record<string, NativeSecureSession | undefined>).FaceTypeSecureSession;
  if (!module) return null;
  return {
    get: () => module.loadSession(),
    set: (value) => module.saveSession(value),
    remove: () => module.clearSession(),
  };
}

interface Services {
  api: ClientApi;
  providers: AuthProvider[];
  camera: CameraBackend;
  runner: SpoolRunner | null;
  spoolDeps: SpoolDeps | null;
  configError: string | null;
}

function createServices(onSessionEnded: () => void): Services {
  const secure = secureValueStore();
  // Without Keychain/Keystore a release build must not hold a session at all.
  const tokens = secure ? secureTokenStore(secure) : memoryTokenStore();
  const configError = 'error' in API_ENDPOINT ? API_ENDPOINT.error : !secure && !NON_RELEASE ? 'SECURE_STORAGE_UNAVAILABLE' : null;
  const api = createClientApi({
    baseUrl: 'url' in API_ENDPOINT ? API_ENDPOINT.url : 'https://invalid.invalid',
    tokens,
    onSessionEnded,
  });
  const providers: AuthProvider[] = [appleProvider(AUTH_CONFIG.apple), googleProvider(AUTH_CONFIG.google)];
  if (AUTH_CONFIG.mockEnabled) {
    providers.push(
      mockProvider(true, async () => {
        const existing = await AsyncStorage.getItem(MOCK_SUBJECT_KEY);
        if (existing) return existing;
        const subject = `dev-${uuidV4()}`;
        await AsyncStorage.setItem(MOCK_SUBJECT_KEY, subject);
        return subject;
      }),
    );
  }
  const camera = cameraBackend();
  let runner: SpoolRunner | null = null;
  let spoolDeps: SpoolDeps | null = null;
  if (camera.kind !== 'unavailable') {
    const nativeGet = (camera.module as { getFrameMeta?: (id: string) => Promise<FrameMeta | null> }).getFrameMeta;
    spoolDeps = {
      api,
      camera: camera.module,
      storage: AsyncStorage,
      vault: nativeBackedMetaVault(typeof nativeGet === 'function' ? nativeGet.bind(camera.module) : null),
    };
    runner = new SpoolRunner(spoolDeps);
  }
  return { api, providers, camera, runner, spoolDeps, configError };
}

function signInErrorFrom(outcome: Extract<SignInOutcome, { kind: 'error' }>): SignInError {
  return outcome.reason === 'unconfigured' ? 'unconfigured' : outcome.reason === 'unsupported' ? 'unsupported' : 'failed';
}

function apiSignInError(error: unknown): SignInError {
  if (isClientApiError(error, 'network')) return 'network';
  if (isClientApiError(error, 'provider_unconfigured')) return 'server_unconfigured';
  if (isClientApiError(error, 'nonce_invalid')) return 'nonce_invalid';
  if (isClientApiError(error, 'account_withdrawing')) return 'account_withdrawing';
  return 'failed';
}

/** One Arabic sentence for a failed profile-page action. */
function actionErrorText(error: unknown): string {
  if (!isClientApiError(error)) return s('common.unexpected', { code: 'unexpected' });
  const key = apiErrorKey(error.code, error.kind);
  return key ? s(key) : s('common.unexpected', { code: error.code ?? error.kind });
}

export function ClientApp(): ReactNode {
  const [state, dispatch] = useReducer(reduceClient, initialClientState);
  const sessionEnded = useRef<() => void>(() => undefined);
  const services = useMemo(() => createServices(() => sessionEnded.current()), []);
  const { api, runner } = services;

  const [spool, setSpool] = useState<SpoolOutcome>({ kind: 'idle' });
  const [bootFailed, setBootFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [setupError, setSetupError] = useState<SetupServerError | null>(null);
  const [prefillName, setPrefillName] = useState<string | null>(null);
  const [busy, setBusy] = useState<'withdraw' | 'delete' | 'signout' | 'refresh' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const signedIn = useRef(false);
  const lastStage = useRef<string | null>(null);

  const stopPump = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const refreshMe = useCallback(async () => {
    try {
      const me = await api.me();
      dispatch({ type: 'ME_REFRESHED', me });
    } catch {
      // The profile keeps the last known state; the next refresh retries.
    }
  }, [api]);

  const pump = useCallback(async () => {
    if (!runner || !signedIn.current) return;
    stopPump();
    let outcome: SpoolOutcome;
    try {
      outcome = await runner.runOnce();
    } catch {
      timer.current = setTimeout(() => void pump(), RETRY_AFTER_CRASH_MS);
      return;
    }
    if (!signedIn.current) return;
    setSpool(outcome);
    const stage = outcome.kind === 'waiting' || outcome.kind === 'terminal' ? outcome.manifest.stage : null;
    if (stage && stage !== lastStage.current && isTerminal(stage)) void refreshMe();
    lastStage.current = stage;
    // The capture's own retry/poll, or the owed attempt telemetry's backoff
    // (Codex round 3: a terminal outcome still owing telemetry is retried too).
    const next = nextRunInMs(outcome);
    if (next !== null) timer.current = setTimeout(() => void pump(), next);
  }, [refreshMe, runner, stopPump]);

  const endLocalSession = useCallback(
    async (reason: 'user' | 'deleted' | 'session_expired') => {
      signedIn.current = false;
      stopPump();
      setSpool({ kind: 'idle' });
      // A queued capture belongs to the account that made it; never upload it
      // under another. discard() aborts the request in flight, waits for the
      // saves already started and deletes manifest and frames (a process death
      // midway is finished at the next boot). Owed attempt telemetry survives a
      // sign-out for the same account only; a deletion drops it.
      await runner?.discard({ telemetry: reason === 'deleted' ? 'drop' : 'keep' }).catch(() => undefined);
      runner?.bindAccount(null);
      for (const provider of services.providers) await provider.signOut?.().catch(() => undefined);
    },
    [runner, services.providers, stopPump],
  );

  sessionEnded.current = () => {
    void endLocalSession('session_expired').then(() => dispatch({ type: 'SIGNED_OUT', reason: 'session_expired' }));
  };

  const enterSession = useCallback(async () => {
    const me = await api.me();
    // The spool only ever advances this account's capture; another account's
    // manifest left on the device is deleted, never resumed (Codex round 2, A9).
    runner?.bindAccount(me.account.id);
    signedIn.current = true;
    dispatch({ type: 'SESSION_READY', me });
    await runner?.cleanupOrphans().catch(() => 0);
    void pump();
  }, [api, pump, runner]);

  const boot = useCallback(async () => {
    setBootFailed(false);
    if (services.configError) {
      dispatch({ type: 'CONFIG_ERROR', code: services.configError });
      return;
    }
    try {
      // A discard the previous process did not live to finish is finished first.
      await runner?.recoverDiscarded().catch(() => undefined);
      if (!(await api.restore())) {
        await runner?.discard({ telemetry: 'keep' }).catch(() => undefined);
        dispatch({ type: 'BOOT_NO_SESSION' });
        return;
      }
      await enterSession();
    } catch (error) {
      if (isClientApiError(error, 'session_expired')) dispatch({ type: 'BOOT_NO_SESSION' });
      else setBootFailed(true);
    }
  }, [api, enterSession, runner, services.configError]);

  useEffect(() => {
    I18nManager.allowRTL(true);
    I18nManager.forceRTL(true);
    void boot();
    return stopPump;
  }, [boot, stopPump]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active' && signedIn.current) void pump();
    });
    return () => subscription.remove();
  }, [pump]);

  // Android back inside «تعديل البيانات» returns to the profile (capture handles its own).
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (state.screen === 'profileSetup' && state.setupMode === 'edit') {
        setSetupError(null);
        dispatch({ type: 'CANCEL_EDIT' });
        return true;
      }
      return false;
    });
    return () => subscription.remove();
  }, [state.screen, state.setupMode]);

  const signIn = useCallback(
    async (id: ProviderId) => {
      const provider = services.providers.find((candidate) => candidate.id === id);
      if (!provider) return;
      dispatch({ type: 'SIGN_IN_STARTED', provider: id });
      try {
        const outcome = await provider.signIn({ getNonce: async () => (await api.nonce()).nonce });
        if (outcome.kind === 'cancelled') {
          dispatch({ type: 'SIGN_IN_FAILED', error: 'cancelled' });
          return;
        }
        if (outcome.kind === 'error') {
          dispatch({ type: 'SIGN_IN_FAILED', error: signInErrorFrom(outcome) });
          return;
        }
        const credential = outcome.credential;
        if (credential.provider === 'google') await api.signInGoogle(credential.idToken);
        else if (credential.provider === 'apple') {
          await api.signInApple({
            identity_token: credential.identityToken,
            nonce: credential.nonce,
            ...(credential.fullName ? { full_name: credential.fullName } : {}),
          });
          setPrefillName(credential.fullName);
        } else await api.signInMock(credential.subject);
        await enterSession();
      } catch (error) {
        dispatch({ type: 'SIGN_IN_FAILED', error: apiSignInError(error) });
      }
    },
    [api, enterSession, services.providers],
  );

  const showConsent = state.setupMode === 'first' && state.me?.consent?.store_accepted !== true;

  const saveProfile = useCallback(
    async (values: ProfileValues, researchUse: boolean) => {
      setSaving(true);
      setSetupError(null);
      try {
        await api.putProfile(values);
        if (showConsent) {
          try {
            await api.postConsent({ version: CONSENT_VERSION, store_accepted: true, research_use: researchUse });
          } catch (error) {
            setSetupError(isClientApiError(error, 'network') ? { kind: 'network' } : { kind: 'consent_failed' });
            return;
          }
        }
        dispatch({ type: 'PROFILE_SAVED', me: await api.me() });
      } catch (error) {
        if (isClientApiError(error, 'identifier_taken')) setSetupError({ kind: 'identifier_taken' });
        else if (isClientApiError(error, 'network')) setSetupError({ kind: 'network' });
        else if (isClientApiError(error, 'validation')) {
          const fields: Partial<Record<keyof ProfileForm, string>> = {};
          for (const [field, reason] of Object.entries(error.fieldErrors)) {
            const key = profileFieldErrorKey(field, reason);
            if (key) fields[field as keyof ProfileForm] = s(key);
          }
          setSetupError({ kind: 'validation', fields });
        } else if (!isClientApiError(error, 'session_expired')) {
          setSetupError({ kind: 'other', code: isClientApiError(error) ? (error.code ?? error.kind) : 'unexpected' });
        }
      } finally {
        setSaving(false);
      }
    },
    [api, showConsent],
  );

  const withdrawResearch = useCallback(async () => {
    setBusy('withdraw');
    setNotice(null);
    setProfileError(null);
    try {
      await api.postConsent({ version: CONSENT_VERSION, store_accepted: true, research_use: false });
      await refreshMe();
      setNotice(s('profile.withdrawn'));
    } catch (error) {
      setProfileError(actionErrorText(error));
    } finally {
      setBusy(null);
    }
  }, [api, refreshMe]);

  const deleteAccount = useCallback(async () => {
    setBusy('delete');
    setProfileError(null);
    try {
      await api.deleteAccount();
      await endLocalSession('deleted');
      dispatch({ type: 'SIGNED_OUT', reason: 'deleted' });
    } catch (error) {
      setProfileError(actionErrorText(error));
    } finally {
      setBusy(null);
    }
  }, [api, endLocalSession]);

  const signOut = useCallback(async () => {
    setBusy('signout');
    try {
      await api.logout();
      await endLocalSession('user');
      dispatch({ type: 'SIGNED_OUT', reason: 'user' });
    } finally {
      setBusy(null);
    }
  }, [api, endLocalSession]);

  const onEnqueue = useCallback(
    async (frames: BurstFrame[], attempts: number, capabilities: CameraCapabilities | null, telemetry: PendingAttempt) => {
      if (!runner) throw new Error('camera unavailable');
      // Telemetry rides in the manifest and is posted after the verdict.
      await runner.enqueue({ frames, attempt: attempts, capabilities, telemetry });
      void pump();
    },
    [pump, runner],
  );

  const onAcknowledge = useCallback(() => {
    void runner
      ?.acknowledge()
      .then(() => {
        setSpool({ kind: 'idle' });
        // Telemetry the verdict still owed now waits in its own queue.
        void pump();
      })
      .catch(() => undefined);
  }, [pump, runner]);

  const onTelemetry = useCallback(
    (telemetry: AttemptTelemetry) => {
      // Attempts that end before the spool (cancel, time-out, permission) are
      // owed through the same durable queue, so offline does not lose them.
      if (runner?.accountId) {
        void runner
          .recordAttempt(telemetry)
          .then((queued) => {
            if (queued) void pump();
          })
          .catch(() => undefined);
        return;
      }
      void api.postAttempt(telemetry).catch(() => undefined);
    },
    [api, pump, runner],
  );

  let body: ReactNode;
  if (state.screen === 'boot') {
    body = (
      <View style={[styles.screen, styles.centered]}>
        <Text style={styles.body}>{bootFailed ? s('common.network') : s('boot.loading')}</Text>
        {bootFailed ? <Button label={s('common.retry')} onPress={() => void boot()} /> : null}
      </View>
    );
  } else if (state.screen === 'signedOut') {
    body = (
      <SignInScreen
        providers={services.providers}
        busy={state.signInBusy}
        error={state.signInError}
        notice={state.notice}
        configError={state.configError}
        onSignIn={(id) => void signIn(id)}
      />
    );
  } else if (state.screen === 'profileSetup') {
    body = (
      <ProfileSetupScreen
        key={state.setupMode}
        mode={state.setupMode}
        profile={state.me?.profile ?? null}
        prefillName={prefillName}
        showConsent={showConsent}
        saving={saving}
        serverError={setupError}
        supportContact={AUTH_CONFIG.supportContact}
        onSave={(values, researchUse) => void saveProfile(values, researchUse)}
        onCancel={
          state.setupMode === 'edit'
            ? () => {
                setSetupError(null);
                dispatch({ type: 'CANCEL_EDIT' });
              }
            : undefined
        }
      />
    );
  } else if (state.screen === 'capture') {
    body = (
      <CaptureScreen
        camera={services.camera}
        spool={spool}
        onEnqueue={onEnqueue}
        onAcknowledge={onAcknowledge}
        onClose={() => {
          dispatch({ type: 'CLOSE_CAPTURE' });
          void refreshMe();
        }}
        onTelemetry={onTelemetry}
      />
    );
  } else if (state.me) {
    body = (
      <ProfileScreen
        me={state.me}
        spool={spool}
        busy={busy}
        notice={notice}
        error={profileError}
        now={new Date()}
        onCapture={() => {
          setNotice(null);
          dispatch({ type: 'OPEN_CAPTURE' });
        }}
        onEdit={() => {
          setSetupError(null);
          dispatch({ type: 'EDIT_PROFILE' });
        }}
        onRefresh={() => {
          setBusy('refresh');
          void refreshMe().finally(() => setBusy(null));
          void pump();
        }}
        onWithdrawResearch={() => void withdrawResearch()}
        onDelete={() => void deleteAccount()}
        onSignOut={() => void signOut()}
      />
    );
  } else {
    body = null;
  }

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <StatusBar barStyle={state.screen === 'capture' ? 'light-content' : 'dark-content'} />
      {body}
    </SafeAreaView>
  );
}
