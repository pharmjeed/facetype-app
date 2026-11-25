/**
 * Screen 2 — profile setup, shown once after the first sign-in
 * (docs/client-app-v1.md §1–§2).
 *
 * No consent checkboxes (owner decision 2026-11-24): one notice line,
 * docs/client-notice-v1-ar.md, sits above «حفظ ومتابعة», and pressing it is
 * the agreement. There is no edit mode any more: the profile page has no
 * «تعديل البيانات».
 */

import { useState, type ReactNode } from 'react';
import { ScrollView, Text } from 'react-native';

import { spacing } from '@facetype/design-system';

import { Button } from '../../components/Button.tsx';
import { styles } from '../../theme.ts';
import type { ProfileView } from '../api/types.ts';
import { apiErrorKey } from '../messages.ts';
import { s } from '../strings.ts';
import {
  validateProfile,
  type IdDocumentType,
  type ProfileErrors,
  type ProfileForm,
  type ProfileValues,
  type Sex,
} from '../validation.ts';
import { Choices, CountryField, DateField, Field, LanguageSwitch, ui } from './ui.tsx';

export type SetupServerError =
  | { kind: 'identifier_taken' }
  | { kind: 'network' }
  | { kind: 'consent_failed' }
  | { kind: 'validation'; fields: Partial<Record<keyof ProfileForm, string>> }
  | { kind: 'other'; code: string };

/** A profile the server already holds (e.g. the notice was not recorded yet) is prefilled as entered. */
function initialForm(profile: ProfileView | null, prefillName: string | null): ProfileForm {
  return {
    full_name: profile?.full_name ?? prefillName ?? '',
    id_issuing_country: profile?.id_issuing_country ?? '',
    id_document_type: profile?.id_document_type ?? null,
    id_number: profile?.id_number ?? '',
    phone: profile?.phone ?? '',
    sex: profile?.sex ?? null,
    birth_date: profile?.birth_date ?? '',
    nationality: profile?.nationality ?? '',
  };
}

function otherErrorText(code: string): string {
  const key = apiErrorKey(code);
  return key ? s(key) : s('common.unexpected', { code });
}

export function ProfileSetupScreen({
  profile,
  prefillName,
  saving,
  serverError,
  supportContact,
  onSave,
}: {
  profile: ProfileView | null;
  prefillName: string | null;
  saving: boolean;
  serverError: SetupServerError | null;
  supportContact: string | null;
  onSave: (values: ProfileValues) => void;
}): ReactNode {
  const [form, setForm] = useState<ProfileForm>(() => initialForm(profile, prefillName));
  const [errors, setErrors] = useState<ProfileErrors>({});

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
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    onSave(result.value);
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
      <LanguageSwitch />
      <Text style={ui.title} accessibilityRole="header">
        {s('setup.title')}
      </Text>
      <Text style={ui.hint}>{s('setup.intro')}</Text>

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
      <DateField label={s('setup.birth_date')} value={form.birth_date} onChange={set('birth_date')} error={fieldError('birth_date')} />
      <CountryField label={s('setup.nationality')} value={form.nationality} onChange={set('nationality')} error={fieldError('nationality')} />
      <Text style={ui.hint}>{s('setup.unverified_note')}</Text>

      {Object.values(errors).some(Boolean) ? <Text style={ui.error}>{s('setup.fix_fields')}</Text> : null}
      {serverError?.kind === 'network' ? <Text style={ui.error}>{s('common.network')}</Text> : null}
      {serverError?.kind === 'consent_failed' ? <Text style={ui.error}>{s('setup.saved_profile_consent_failed')}</Text> : null}
      {serverError?.kind === 'other' ? <Text style={ui.error}>{otherErrorText(serverError.code)}</Text> : null}

      <Text style={ui.text}>{s('consent.notice')}</Text>
      <Button label={s('setup.save')} onPress={submit} loading={saving} />
    </ScrollView>
  );
}
