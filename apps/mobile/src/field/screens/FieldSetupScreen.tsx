/**
 * Allocate a reference, then take consent, before the camera opens.
 *
 * THE ORDER ON THIS SCREEN IS THE PROTOCOL, AND IT CHANGED. The reference is no
 * longer typed or proposed: the operator taps once, the server mints the next
 * `P-xxxxxx` for this session, and the consent copy is read to the participant
 * with that reference in it — the one they will quote if they later ask for
 * their data back. Nothing before that allocation can be consented to, because
 * a consent that cannot name whose it is cannot be honoured.
 *
 * There is no text input on this screen at all. That is the point: the field
 * where an operator would have typed a participant's name does not exist, so
 * the guarantee does not rest on a validator being strict enough.
 *
 * WHAT `onStart` MEANS. Not "advance the screen". It means: record the research
 * grant on the server, record the photograph answer on the server, and only if
 * both land, open the camera. The container does that work and this screen
 * shows the outcome; a failure leaves everybody here with a code, and nothing
 * has been captured.
 *
 * ONE AFFIRMATIVE ACTION, NOT A TICK AND THEN A BUTTON. The research grant used
 * to be a required checkbox that only enabled a neutrally-labelled "Start
 * capture", so the participant agreed twice to the same thing and the press
 * that mattered did not say what it meant. It is now a single button that says
 * what pressing it agrees to, read after the disclosure. The disclosure did
 * not move and did not shrink: everything the participant must be told is above
 * the button, and pressing it is the whole of the research grant.
 *
 * THE PHOTOGRAPH QUESTION IS NOT ALWAYS ASKED. A deployment that retains no
 * photograph has `raw_photo_retention_enabled = false`, and asking anyway would
 * obtain permission for something that cannot happen. The checkbox is replaced
 * by a sentence saying so.
 */

import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { Button } from '../../components/Button.tsx';
import { styles, theme } from '../../theme.ts';
import type { FieldStudyConfig } from '../config.ts';
import {
  consentActionsEnabled,
  photoOptInForParticipant,
  resolvePhotoOptIn,
  resolveStartAction,
} from '../consentAction.ts';
import { mayOfferPhotoConsent, type FieldStudyPolicy } from '../policy.ts';
import { FIELD_DISPOSITION } from '../session.ts';
import { ft } from '../strings.ts';
import { FieldBanner } from './FieldBanner.tsx';

function Checkbox({
  checked,
  label,
  disabled,
  onToggle,
}: {
  checked: boolean;
  label: string;
  /** Closed while a consent call is in flight, like every other control here. */
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled }}
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onToggle}
      style={[styles.row, { minHeight: theme.MIN_TAP_TARGET, opacity: disabled ? 0.5 : 1 }]}
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

export function FieldSetupScreen({
  locale,
  config,
  policy,
  session,
  participantRef,
  participantsCompleted,
  busy,
  errorCode,
  onAllocate,
  onStart,
  onDecline,
  onExit,
}: {
  locale: string;
  config: FieldStudyConfig;
  /** Narrowed to the joined session. Every number below is the server's. */
  policy: FieldStudyPolicy;
  /** Which session this participant is being enrolled into. */
  session: { label: string; siteCode: string };
  /** The server-allocated reference, or `null` before it has been asked for. */
  participantRef: string | null;
  participantsCompleted: number;
  busy: boolean;
  errorCode: string | null;
  onAllocate: () => void;
  /** Records both consent facts on the server, then opens the camera. */
  onStart: (photoGranted: boolean) => void;
  /** A participant who declines, recorded on the server as declining. */
  onDecline: () => void;
  onExit: () => void;
}) {
  const [photos, setPhotos] = useState(false);
  /**
   * Which reference the photograph answer belongs to.
   *
   * The container remounts this screen per participant, so this is a second
   * lock on the same door rather than the only one: if the reference on the
   * props ever changes under a mounted screen, the previous participant's
   * photograph answer is dropped in that same render instead of being carried
   * into somebody else's consent.
   */
  const [photoRef, setPhotoRef] = useState<string | null>(participantRef);
  if (photoRef !== participantRef) {
    setPhotos(photoOptInForParticipant(photoRef, participantRef, photos));
    setPhotoRef(participantRef);
  }

  const photosOfferable = mayOfferPhotoConsent(policy);
  // The gate is the server-allocated reference and the absence of a call
  // already in flight: without a reference there is nothing to record a consent
  // against, and a second press would record a second consent for one person.
  const action = { participantRef, busy, photosOfferable, photoOptIn: photos };
  const canAct = consentActionsEnabled(action);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.bg }}
      contentContainerStyle={{ padding: theme.spacing[6], gap: theme.spacing[4], flexGrow: 1 }}
      showsVerticalScrollIndicator
    >
      <FieldBanner locale={locale} disposition={FIELD_DISPOSITION} />

      <Text style={styles.h1}>{ft(locale, 'field.setup.title')}</Text>
      <Text style={styles.caption}>
        {ft(locale, 'field.join.joined', { label: session.label, site: session.siteCode })}
      </Text>
      <Text style={styles.caption}>
        {ft(locale, 'field.setup.count', { count: participantsCompleted })}
      </Text>

      <View style={styles.card}>
        <Text style={styles.h2}>{ft(locale, 'field.setup.participant_label')}</Text>
        {participantRef === null ? (
          <>
            <Text style={styles.muted}>{ft(locale, 'field.setup.ref_pending')}</Text>
            <Button
              label={ft(locale, 'field.setup.allocate')}
              disabled={busy}
              loading={busy}
              onPress={() => {
                if (busy) return;
                onAllocate();
              }}
            />
          </>
        ) : (
          <Text style={[styles.body, { fontWeight: '600' }]}>
            {ft(locale, 'field.setup.ref_allocated', { ref: participantRef })}
          </Text>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.h2}>{ft(locale, 'field.consent.title')}</Text>
        <Text style={styles.body}>{ft(locale, 'field.consent.purpose')}</Text>
        {/*
          * No geometry retention *period* is stated, because the platform
          * contract defines none and a figure invented here would be the app
          * promising a duration on the deployment's behalf. What is stated is
          * what is true: the wording version it is kept under, and the route to
          * having it deleted.
          */}
        <Text style={styles.body}>
          {ft(locale, 'field.consent.geometry', { version: policy.consentPolicyVersion })}
        </Text>
        <Text style={styles.body}>
          {photosOfferable
            ? ft(locale, 'field.consent.raw_retention', { days: policy.rawPhotoRetentionDays })
            : ft(locale, 'field.consent.raw_unavailable')}
        </Text>
        <Text style={styles.body}>
          {ft(locale, 'field.consent.access', {
            access: config.accessRestriction,
            custodian: config.custodian,
          })}
        </Text>
        <Text style={styles.body}>
          {ft(locale, 'field.consent.deletion', {
            contact: config.deletionContact,
            // A dash until the server has allocated one. The consent is not
            // startable in that state, so nobody is asked to agree to a
            // deletion route that names nothing.
            ref: participantRef ?? '—',
          })}
        </Text>
        <Text style={styles.caption}>
          {ft(locale, 'field.consent.policy_version', { version: policy.consentPolicyVersion })}
        </Text>
      </View>

      {/*
        * The photograph question stays a question of its own, below the
        * disclosure and above the button, and starts unticked. Pressing the
        * affirmative button never ticks it: `resolveStartAction` reads it, it
        * does not set it.
        */}
      {photosOfferable ? (
        <>
          <Checkbox
            checked={photos}
            label={ft(locale, 'field.consent.raw_checkbox')}
            disabled={!canAct}
            onToggle={() => setPhotos(resolvePhotoOptIn(action, !photos))}
          />
          <Text style={styles.muted}>{ft(locale, 'field.consent.raw_optional_note')}</Text>
        </>
      ) : null}

      <Text style={styles.body}>{ft(locale, 'field.consent.research_statement')}</Text>
      <Button
        label={ft(locale, 'field.consent.agree_start')}
        disabled={!canAct}
        loading={busy}
        onPress={() => {
          const decision = resolveStartAction(action);
          if (!decision.start) return;
          onStart(decision.photoGranted);
        }}
      />
      {participantRef === null ? (
        <Text style={styles.muted}>{ft(locale, 'field.consent.await_ref')}</Text>
      ) : null}
      {errorCode ? (
        <Text style={[styles.body, { color: theme.colors.warning }]}>{errorCode}</Text>
      ) : null}

      {/*
        * A refusal is an outcome, not an absence of one. It is recorded on the
        * server against the reference already allocated, so "asked and
        * declined" is distinguishable from "never asked".
        */}
      {participantRef === null ? null : (
        <Button
          label={ft(locale, 'field.setup.decline')}
          variant="secondary"
          disabled={!canAct}
          loading={busy}
          onPress={() => {
            if (!canAct) return;
            onDecline();
          }}
        />
      )}
      <Button
        label={ft(locale, 'field.mode.exit')}
        variant="secondary"
        disabled={busy}
        onPress={() => {
          if (busy) return;
          onExit();
        }}
      />
    </ScrollView>
  );
}
