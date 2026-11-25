/**
 * Screen 3 — profile (home) (docs/client-app-v1.md §1).
 *
 * Shows what GET /me returns, unmasked (owner decision 2026-11-24): name,
 * document, phone, sex, birth date and age, nationality; then the capture
 * status, last capture date and the optional 7-day repeat. The only actions
 * are «التصوير» and «تحديث»: edit, research withdrawal, account deletion and
 * sign-out were removed by the same decision. The personality
 * block always reads «النتيجة غير متاحة بعد»: there is no validated model, so
 * there is nothing else it could truthfully say (CLAUDE.md, ADR-008). It does
 * not read `personality` beyond that, on purpose.
 */

import type { ReactNode } from 'react';
import { ScrollView, Text, View } from 'react-native';

import { colors, spacing } from '@facetype/design-system';

import { Button } from '../../components/Button.tsx';
import { styles } from '../../theme.ts';
import type { ClientMe } from '../api/types.ts';
import { countryName } from '../countries.ts';
import { formatBirthDate } from '../datePicker.ts';
import type { SpoolOutcome } from '../spool/spool.ts';
import { isTerminal } from '../spool/manifest.ts';
import { s, type StringKey } from '../strings.ts';
import { LanguageSwitch, ui } from './ui.tsx';

const DOC: Record<string, StringKey> = {
  national_id: 'doc.national_id',
  residence_id: 'doc.residence_id',
  passport: 'doc.passport',
};

/** Numbers, `+` and dashes stay left-to-right inside an Arabic line (Unicode isolate). */
function ltr(value: string): string {
  return `⁦${value}⁩`;
}

/** `YYYY-MM-DD` of an ISO timestamp; never a locale-dependent long date. */
export function isoDay(value: string | null | undefined): string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : '';
}

/** The capture status line: the local spool wins while it is still working. */
export function captureStatusKey(me: ClientMe, spool: SpoolOutcome): StringKey {
  if (spool.kind === 'waiting' || spool.kind === 'terminal') {
    const stage = spool.manifest.stage;
    if (!isTerminal(stage)) {
      if (spool.kind === 'waiting' && spool.reason === 'offline') return 'status.queued_offline';
      return stage === 'checking' || stage === 'finalizing' ? 'status.checking' : 'status.uploading';
    }
  }
  const latest = me.captures?.latest_status ?? null;
  if (latest === null || (me.captures?.count ?? 0) === 0) return 'status.none';
  switch (latest) {
    case 'uploading':
      return 'status.uploading';
    case 'checking':
      return 'status.checking';
    case 'received':
      return 'status.received';
    case 'stored':
      return 'status.stored';
    case 'needs_retake':
      return 'status.needs_retake';
    case 'measuring':
      return 'status.measuring';
    case 'needs_more':
      return 'status.needs_more';
    case 'complete':
      return 'status.complete';
    default:
      return 'status.unknown';
  }
}

export function ProfileScreen({
  me,
  spool,
  refreshing,
  now,
  onCapture,
  onRefresh,
}: {
  me: ClientMe;
  spool: SpoolOutcome;
  refreshing: boolean;
  now: Date;
  onCapture: () => void;
  onRefresh: () => void;
}): ReactNode {
  const profile = me.profile;
  const captures = me.captures;
  const dueAt = captures?.next_repeat_due_at ? Date.parse(captures.next_repeat_due_at) : NaN;

  return (
    <ScrollView contentContainerStyle={[styles.screen, { paddingBottom: spacing[8] }]}>
      <LanguageSwitch />
      <Text style={ui.title} accessibilityRole="header">
        {s('profile.title')}
      </Text>

      {profile ? (
        <View style={ui.card}>
          <Text style={ui.text}>{s('profile.name', { value: profile.full_name })}</Text>
          <Text style={ui.text}>
            {s('profile.id', {
              type: s(DOC[profile.id_document_type] ?? 'doc.passport'),
              country: countryName(profile.id_issuing_country),
              number: ltr(profile.id_number),
            })}
          </Text>
          <Text style={ui.text}>{s('profile.phone', { value: ltr(profile.phone) })}</Text>
          <Text style={ui.text}>
            {s('profile.sex', { value: profile.sex === 'female' ? s('sex.female') : s('sex.male') })}
          </Text>
          <Text style={ui.text}>{s('profile.birth_date', { value: formatBirthDate(profile.birth_date) })}</Text>
          {Number.isInteger(profile.age_years) ? <Text style={ui.text}>{s('profile.age', { value: profile.age_years })}</Text> : null}
          <Text style={ui.text}>{s('profile.nationality', { value: countryName(profile.nationality) })}</Text>
        </View>
      ) : null}

      <View style={ui.card}>
        <Text style={ui.h2}>{s('profile.capture_title')}</Text>
        <Text style={ui.text} accessibilityLiveRegion="polite">
          {s(captureStatusKey(me, spool))}
        </Text>
        {captures?.count ? <Text style={ui.hint}>{s('profile.capture_count', { count: captures.count })}</Text> : null}
        {captures?.last_at ? <Text style={ui.hint}>{s('profile.last_capture', { date: isoDay(captures.last_at) })}</Text> : null}
        {Number.isFinite(dueAt) ? (
          <Text style={ui.hint}>
            {dueAt <= now.getTime()
              ? s('profile.repeat_now')
              : s('profile.repeat_due', { date: isoDay(captures?.next_repeat_due_at) })}
          </Text>
        ) : null}
        <Button label={s('profile.capture')} onPress={onCapture} />
      </View>

      <View style={ui.card}>
        <Text style={ui.h2}>{s('profile.personality_title')}</Text>
        <Text style={[ui.text, { color: colors.muted, fontWeight: '600' }]}>{s('profile.personality_unavailable')}</Text>
        <Text style={ui.hint}>{s('profile.personality_note')}</Text>
      </View>

      <Button label={s('profile.refresh')} onPress={onRefresh} variant="secondary" loading={refreshing} />
    </ScrollView>
  );
}
