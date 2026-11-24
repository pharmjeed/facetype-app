/**
 * Screen 2 — profile setup (first time) and «تعديل البيانات»
 * (docs/client-app-v1.md §1–§2), with the consent of
 * docs/client-consent-v1-ar.md inline the first time.
 *
 * The raw identity number and phone exist only in this component's state.
 * After a save the server returns masked values and this screen unmounts, so
 * the full values are gone; editing asks for them again rather than showing
 * them.
 */

import { useState, type ReactNode } from 'react';
import { ScrollView, Text, View } from 'react-native';

import { spacing } from '@facetype/design-system';

import { Button } from '../../components/Button.tsx';
import { styles } from '../../theme.ts';
import type { ProfileView } from '../api/types.ts';
import { apiErrorKey } from '../messages.ts';
import { s, type StringKey } from '../strings.ts';
import {
  validateProfile,
  type IdDocumentType,
  type ProfileErrors,
  type ProfileForm,
  type ProfileValues,
  type Sex,
} from '../validation.ts';
import { Checkbox, Choices, CountryField, Field, LinkButton, ui } from './ui.tsx';

export type SetupServerError =
  | { kind: 'identifier_taken' }
  | { kind: 'network' }
  | { kind: 'consent_failed' }
  | { kind: 'validation'; fields: Partial<Record<keyof ProfileForm, string>> }
  | { kind: 'other'; code: string };

const CONSENT_DETAIL: StringKey[] = [
  'consent.required_1',
  'consent.required_2',
  'consent.required_3',
  'consent.required_4',
  'consent.required_5',
  'consent.required_6',
];
const OPTIONAL_DETAIL: StringKey[] = ['consent.optional_1', 'consent.optional_2', 'consent.optional_3'];

/**
 * The server returns the name as initials and an age instead of the birth
 * date, so — like the ID number and phone — they are entered again on edit;
 * only the plain fields are prefilled.
 */
function initialForm(profile: ProfileView | null, prefillName: string | null): ProfileForm {
  return {
    full_name: profile ? '' : (prefillName ?? ''),
    id_issuing_country: profile?.id_issuing_country ?? '',
    id_document_type: profile?.id_document_type ?? null,
    id_number: '',
    phone: '',
    sex: profile?.sex ?? null,
    birth_date: '',
    nationality: profile?.nationality ?? '',
  };
}

function otherErrorText(code: string): string {
  const key = apiErrorKey(code);
  return key ? s(key) : s('common.unexpected', { code });
}

export function ProfileSetupScreen({
  mode,
  profile,
  prefillName,
  showConsent,
  saving,
  serverError,
  supportContact,
  onSave,
  onCancel,
}: {
  mode: 'first' | 'edit';
  profile: ProfileView | null;
  prefillName: string | null;
  showConsent: boolean;
  saving: boolean;
  serverError: SetupServerError | null;
  supportContact: string | null;
  onSave: (values: ProfileValues, researchUse: boolean) => void;
  onCancel?: () => void;
}): ReactNode {
  const [form, setForm] = useState<ProfileForm>(() => initialForm(profile, prefillName));
  const [errors, setErrors] = useState<ProfileErrors>({});
  const [storeAccepted, setStoreAccepted] = useState(false);
  const [researchUse, setResearchUse] = useState(false);
  const [consentMissing, setConsentMissing] = useState(false);
  const [details, setDetails] = useState(false);

  const set = <K extends keyof ProfileForm>(key: K) => (value: ProfileForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
  };

  const fieldError = (key: keyof ProfileForm): string | null => {
    const local = errors[key];
    if (local) return s(local);
    if (serverError?.kind === 'validation') return serverError.fields[key] ?? null;
    if (serverError?.kind === 'identifier_taken' && key === 'id_number') {
      return s('setup.id_taken', { contact: supportContact ?? s('setup.support_unconfigured') });
    }
    return null;
  };

  const submit = () => {
    const result = validateProfile(form);
    const needConsent = showConsent && !storeAccepted;
    setConsentMissing(needConsent);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    if (needConsent) return;
    onSave(result.value, researchUse);
  };

  const docOptions: Array<{ value: IdDocumentType; label: string }> = [
    { value: 'national_id', label: s('doc.national_id') },
    { value: 'residence_id', label: s('doc.residence_id') },
    { value: 'passport', label: s('doc.passport') },
  ];
  const sexOptions: Array<{ value: Sex; label: string }> = [
    { value: 'male', label: s('sex.male') },
    { value: 'female', label: s('sex.female') },
  ];

  return (
    <ScrollView contentContainerStyle={[styles.screen, { paddingBottom: spacing[8] }]} keyboardShouldPersistTaps="handled">
      <Text style={ui.title} accessibilityRole="header">
        {mode === 'edit' ? s('setup.edit_title') : s('setup.title')}
      </Text>
      <Text style={ui.hint}>{s('setup.intro')}</Text>
      {mode === 'edit' ? <Text style={ui.hint}>{s('setup.reenter_hint')}</Text> : null}

      <Field label={s('setup.full_name')} value={form.full_name} onChange={set('full_name')} error={fieldError('full_name')} autoCapitalize="words" />
      <CountryField
        label={s('setup.id_country')}
        value={form.id_issuing_country}
        onChange={set('id_issuing_country')}
        error={fieldError('id_issuing_country')}
      />
      <Choices label={s('setup.id_type')} options={docOptions} value={form.id_document_type} onChange={set('id_document_type')} error={fieldError('id_document_type')} />
      <Field
        label={s('setup.id_number')}
        value={form.id_number}
        onChange={set('id_number')}
        error={fieldError('id_number')}
        autoCapitalize="characters"
        ltr
      />
      <Field
        label={s('setup.phone')}
        value={form.phone}
        onChange={set('phone')}
        error={fieldError('phone')}
        hint={s('setup.phone_hint')}
        keyboardType="phone-pad"
        ltr
      />
      <Choices label={s('setup.sex')} options={sexOptions} value={form.sex} onChange={set('sex')} error={fieldError('sex')} />
      <Field
        label={s('setup.birth_date')}
        value={form.birth_date}
        onChange={set('birth_date')}
        error={fieldError('birth_date')}
        hint={s('setup.birth_date_hint')}
        placeholder="1995-04-23"
        keyboardType="numbers-and-punctuation"
        ltr
      />
      <CountryField label={s('setup.nationality')} value={form.nationality} onChange={set('nationality')} error={fieldError('nationality')} />
      <Text style={ui.hint}>{s('setup.unverified_note')}</Text>

      {showConsent ? (
        <View style={ui.card}>
          <Checkbox label={s('consent.required_label')} checked={storeAccepted} onChange={(on) => { setStoreAccepted(on); setConsentMissing(false); }} />
          <Checkbox label={s('consent.optional_label')} checked={researchUse} onChange={setResearchUse} />
          <LinkButton label={details ? s('consent.hide') : s('consent.read_more')} onPress={() => setDetails((v) => !v)} />
          {details ? (
            <View style={{ gap: spacing[2] }}>
              <Text style={ui.hint}>{s('consent.version')}</Text>
              <Text style={ui.h2}>{s('consent.required_title')}</Text>
              <Text style={[ui.text, { fontWeight: '700' }]}>{s('consent.required_heading')}</Text>
              {CONSENT_DETAIL.map((key) => (
                <Text key={key} style={ui.text}>{`• ${s(key)}`}</Text>
              ))}
              <Text style={ui.h2}>{s('consent.optional_title')}</Text>
              <Text style={[ui.text, { fontWeight: '700' }]}>{s('consent.optional_heading')}</Text>
              {OPTIONAL_DETAIL.map((key) => (
                <Text key={key} style={ui.text}>{`• ${s(key)}`}</Text>
              ))}
            </View>
          ) : null}
          {consentMissing ? (
            <Text style={ui.error} accessibilityLiveRegion="polite">
              {s('setup.consent_required')}
            </Text>
          ) : null}
        </View>
      ) : null}

      {Object.values(errors).some(Boolean) ? <Text style={ui.error}>{s('setup.fix_fields')}</Text> : null}
      {serverError?.kind === 'network' ? <Text style={ui.error}>{s('common.network')}</Text> : null}
      {serverError?.kind === 'consent_failed' ? <Text style={ui.error}>{s('setup.saved_profile_consent_failed')}</Text> : null}
      {serverError?.kind === 'other' ? <Text style={ui.error}>{otherErrorText(serverError.code)}</Text> : null}

      <Button label={mode === 'edit' ? s('setup.save_edit') : s('setup.save')} onPress={submit} loading={saving} />
      {onCancel ? <Button label={s('common.cancel')} onPress={onCancel} variant="secondary" disabled={saving} /> : null}
    </ScrollView>
  );
}
