/**
 * The participant receipt.
 *
 * It is the last thing a participant sees, and it is deliberately dull: what
 * was collected, under which consent wording, for how long a photograph lives,
 * and how to have it deleted. There is no outcome, no score and nothing that
 * could be read as one — `FieldReceipt` has no field that could hold one, so
 * this screen has nothing to render even if somebody tried.
 *
 * THERE IS NO DELETE BUTTON, AND THAT IS THE HONEST STATE.
 *
 * There used to be one, labelled "Delete this participant's data now", and it
 * called `DELETE /scans/{id}`. That deletes a scan. It does not delete the
 * participant: the reference stays allocated, the consent facts stay recorded,
 * and — before this branch — the server had never been told the two were
 * related at all. A participant who tapped it was told their data was gone
 * while records about them remained, which is the worst possible thing for a
 * privacy control to do, because it also stops them asking again.
 *
 * The platform does have a real participant erasure —
 * `DELETE /field-study/sessions/{id}/participants/{ref}` — and it is
 * deliberately held by `field_study:admin`, not by the collecting device. That
 * is the correct division: erasing somebody is an accountable act performed by a
 * named operator and audited as one, not a button in a room. So this screen
 * gives the participant the two things that actually make the request
 * actionable — the reference the server allocated them, and the route to the
 * operator — and says plainly that the device cannot do it.
 *
 * "Next participant" is the fast path the whole lane exists for. It clears the
 * reference, the consent, the scan and every recorded sample in one action, and
 * keeps the joined session.
 */

import { Text, View } from 'react-native';

import { Button } from '../../components/Button.tsx';
import { styles, theme } from '../../theme.ts';
import { FIELD_DISPOSITION, type FieldReceipt } from '../session.ts';
import { ft } from '../strings.ts';
import { FieldBanner } from './FieldBanner.tsx';

export function FieldReceiptScreen({
  locale,
  receipt,
  deletionContact,
  onNextParticipant,
  onExit,
}: {
  locale: string;
  receipt: FieldReceipt;
  /** The authorized operator a deletion request goes through. */
  deletionContact: string;
  onNextParticipant: () => void;
  onExit: () => void;
}) {
  const complete = receipt.posesRecorded === receipt.posesTotal;
  const unconfirmed = receipt.rawFramesUploaded - receipt.rawFramesConfirmed;

  return (
    <View style={styles.screen}>
      <FieldBanner locale={locale} disposition={FIELD_DISPOSITION} />

      <Text style={styles.h1}>{ft(locale, 'field.receipt.title')}</Text>

      <View style={styles.card}>
        <Text style={styles.h2}>
          {ft(locale, 'field.receipt.ref', { ref: receipt.participantRef })}
        </Text>
        <Text style={styles.body}>{ft(locale, 'field.receipt.disposition')}</Text>
        <Text style={styles.body}>
          {ft(locale, 'field.receipt.poses', {
            recorded: receipt.posesRecorded,
            total: receipt.posesTotal,
            attempts: receipt.totalAttempts,
          })}
        </Text>
        <Text style={styles.body}>
          {ft(locale, 'field.receipt.below_gate', { count: receipt.samplesBelowProductionGate })}
        </Text>
        {complete ? null : (
          <Text style={[styles.body, { color: theme.colors.warning }]}>
            {ft(locale, 'field.receipt.incomplete')}
          </Text>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.body}>
          {ft(locale, 'field.receipt.retention', { version: receipt.policyVersion })}
        </Text>
        <Text style={styles.body}>
          {receipt.rawFramesUploaded > 0
            ? ft(locale, 'field.receipt.raw', {
                count: receipt.rawFramesUploaded,
                days: receipt.rawPhotoRetentionDays,
              })
            : ft(locale, 'field.receipt.raw_none')}
        </Text>
        {/*
          * Shown only when the two counts genuinely disagree: a photograph that
          * left the device and that the server has not confirmed holding is a
          * real, different state, and neither number alone describes it.
          */}
        {unconfirmed > 0 ? (
          <Text style={[styles.caption, { color: theme.colors.warning }]}>
            {ft(locale, 'field.receipt.raw_unconfirmed', { count: unconfirmed })}
          </Text>
        ) : null}
      </View>

      <View style={styles.card}>
        <Text style={styles.h2}>{ft(locale, 'field.receipt.deletion_title')}</Text>
        <Text style={styles.body}>
          {ft(locale, 'field.receipt.deletion_steps', {
            contact: deletionContact,
            ref: receipt.participantRef,
          })}
        </Text>
        <Text style={styles.muted}>{ft(locale, 'field.receipt.no_delete_here')}</Text>
        <Text style={styles.caption}>
          {ft(locale, 'field.consent.policy_version', { version: receipt.policyVersion })}
        </Text>
      </View>

      <Button label={ft(locale, 'field.receipt.next')} onPress={onNextParticipant} />
      <Button label={ft(locale, 'field.mode.exit')} variant="secondary" onPress={onExit} />
    </View>
  );
}
