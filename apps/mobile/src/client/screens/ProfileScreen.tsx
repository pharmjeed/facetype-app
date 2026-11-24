/**
 * Screen 3 — profile (home) (docs/client-app-v1.md §1).
 *
 * Shows only what GET /me returns: masked identifiers («•••• 1234»), name
 * initials and an age (never the birth date), capture
 * status, last capture date and the optional 7-day repeat. The personality
 * block always reads «النتيجة غير متاحة بعد»: there is no validated model, so
 * there is nothing else it could truthfully say (CLAUDE.md, ADR-008). It does
 * not read `personality` beyond that, on purpose.
 */

import { useState, type ReactNode } from 'react';
import { ScrollView, Text, View } from 'react-native';

import { colors, spacing } from '@facetype/design-system';

import { Button } from '../../components/Button.tsx';
import { styles } from '../../theme.ts';
import type { ClientMe } from '../api/types.ts';
import { countryName } from '../countries.ts';
import type { SpoolOutcome } from '../spool/spool.ts';
import { isTerminal } from '../spool/manifest.ts';
import { s, type StringKey } from '../strings.ts';
import { LinkButton, ui } from './ui.tsx';

const DOC: Record<string, StringKey> = {
  national_id: 'doc.national_id',
  residence_id: 'doc.residence_id',
  passport: 'doc.passport',
};

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
    default:
      return 'status.unknown';
  }
}

export function ProfileScreen({
  me,
  spool,
  busy,
  notice,
  error,
  now,
  onCapture,
  onEdit,
  onRefresh,
  onWithdrawResearch,
  onDelete,
  onSignOut,
}: {
  me: ClientMe;
  spool: SpoolOutcome;
  busy: 'withdraw' | 'delete' | 'signout' | 'refresh' | null;
  notice: string | null;
  error: string | null;
  now: Date;
  onCapture: () => void;
  onEdit: () => void;
  onRefresh: () => void;
  onWithdrawResearch: () => void;
  onDelete: () => void;
  onSignOut: () => void;
}): ReactNode {
  const [confirm, setConfirm] = useState<'withdraw' | 'delete' | null>(null);
  const profile = me.profile;
  const captures = me.captures;
  const dueAt = captures?.next_repeat_due_at ? Date.parse(captures.next_repeat_due_at) : NaN;

  return (
    <ScrollView contentContainerStyle={[styles.screen, { paddingBottom: spacing[8] }]}>
      <Text style={ui.title} accessibilityRole="header">
        {s('profile.title')}
      </Text>

      {profile ? (
        <View style={ui.card}>
          <Text style={ui.text}>{s('profile.name', { value: profile.full_name_masked })}</Text>
          <Text style={ui.text}>
            {s('profile.id', {
              type: s(DOC[profile.id_document_type] ?? 'doc.passport'),
              country: countryName(profile.id_issuing_country),
              masked: profile.id_number_masked,
            })}
          </Text>
          <Text style={ui.text}>{s('profile.phone', { masked: profile.phone_masked })}</Text>
          <Text style={ui.text}>
            {s('profile.sex', { value: profile.sex === 'female' ? s('sex.female') : s('sex.male') })}
          </Text>
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

      <View style={ui.card}>
        <Text style={ui.text}>{me.consent?.research_use ? s('profile.research_on') : s('profile.research_off')}</Text>
        {me.consent?.research_use ? (
          confirm === 'withdraw' ? (
            <View style={{ gap: spacing[2] }}>
              <Text style={ui.text}>{s('profile.withdraw_confirm')}</Text>
              <Button
                label={s('profile.withdraw_do')}
                onPress={() => {
                  setConfirm(null);
                  onWithdrawResearch();
                }}
                loading={busy === 'withdraw'}
              />
              <Button label={s('common.cancel')} onPress={() => setConfirm(null)} variant="secondary" />
            </View>
          ) : (
            <LinkButton label={s('profile.withdraw_research')} onPress={() => setConfirm('withdraw')} />
          )
        ) : null}
      </View>

      {notice ? <Text style={ui.text} accessibilityLiveRegion="polite">{notice}</Text> : null}
      {error ? <Text style={ui.error} accessibilityLiveRegion="polite">{error}</Text> : null}

      <Button label={s('profile.edit')} onPress={onEdit} variant="secondary" />
      <Button label={s('profile.refresh')} onPress={onRefresh} variant="secondary" loading={busy === 'refresh'} />
      <Button label={s('profile.sign_out')} onPress={onSignOut} variant="secondary" loading={busy === 'signout'} />
      {confirm === 'delete' ? (
        <View style={ui.card}>
          <Text style={ui.text}>{s('profile.delete_confirm')}</Text>
          <Button
            label={s('profile.delete_do')}
            onPress={() => {
              setConfirm(null);
              onDelete();
            }}
            loading={busy === 'delete'}
          />
          <Button label={s('common.cancel')} onPress={() => setConfirm(null)} variant="secondary" />
        </View>
      ) : (
        <LinkButton label={s('profile.delete')} onPress={() => setConfirm('delete')} />
      )}
    </ScrollView>
  );
}
