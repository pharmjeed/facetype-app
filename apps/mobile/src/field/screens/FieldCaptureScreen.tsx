/**
 * The operator's capture screen.
 *
 * It shows five rows, one per pose, each carrying that pose's stage, its
 * verdict and — when it has one — the reason it failed. That is the whole
 * difference from the production `ScanScreen`, which shows the participant one
 * instruction at a time: an operator running a calibration session needs to see
 * what has been collected and what is still missing, and needs to be able to
 * repeat any pose immediately rather than restart a scan.
 *
 * A sample below the production gate is labelled as such, in the warning
 * colour, and stays in the list. It is not hidden and it is not shown as an
 * error, because it is neither: it is a kept calibration sample.
 */

import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { NativeFaceTypePreview } from '../../capture/NativeFaceTypePreview.tsx';
import { automaticCaptureHint, neutralCaptureGuidance } from '../../capture/neutralGuidance.ts';
import { POSES, type PoseLabel } from '../../capture/types.ts';
import { Button } from '../../components/Button.tsx';
import { FIELD_CAPTURE_CANCELLED } from '../fieldCapture.ts';
import { collectedSamples, COLLECTION_SAMPLES_PER_POSE } from '../photoCollection.ts';
import { styles, theme } from '../../theme.ts';
import { FIELD_DISPOSITION, latestAttempt, type FieldPoseRecord } from '../session.ts';
import { ft, type FieldStringKey } from '../strings.ts';
import { FieldBanner } from './FieldBanner.tsx';

const STAGE_KEY: Record<FieldPoseRecord['stage'], FieldStringKey> = {
  pending: 'field.capture.stage.pending',
  capturing: 'field.capture.stage.capturing',
  uploading: 'field.capture.stage.uploading',
  recorded: 'field.capture.stage.recorded',
  failed: 'field.capture.stage.failed',
};

// Friendly labels are presentation only; the protocol identifiers remain in
// the records and API unchanged.

function PoseRow({
  locale,
  record,
  active,
  onSelect,
}: {
  locale: string;
  record: FieldPoseRecord;
  active: boolean;
  onSelect: () => void;
}) {
  const attempt = latestAttempt(record);
  const belowGate = attempt?.outcome === 'recorded' && attempt.gatePassed === false;
  const guidance = neutralCaptureGuidance(locale, record.pose);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={`${guidance.label} ${ft(locale, STAGE_KEY[record.stage])}`}
      onPress={onSelect}
      style={[
        styles.card,
        { minHeight: theme.MIN_TAP_TARGET, gap: theme.spacing[1] },
        active && { borderColor: theme.colors.accent, borderWidth: 2 },
      ]}
    >
      <View style={styles.row}>
        <Text style={[styles.body, { flex: 1, fontWeight: '600' }]}>{guidance.label}</Text>
        <Text style={styles.caption}>{ft(locale, STAGE_KEY[record.stage])}</Text>
      </View>

      {attempt?.outcome === 'recorded' ? (
        <Text
          style={[styles.caption, belowGate ? { color: theme.colors.warning } : null]}
        >
          {belowGate
            ? ft(locale, 'field.capture.below_gate', {
                failures: attempt.gateFailures.join(', ') || '—',
              })
            : ft(locale, 'field.capture.at_gate')}
        </Text>
      ) : null}

      {attempt?.outcome === 'recorded' && attempt.serverAccepted === false ? (
        <Text style={[styles.caption, { color: theme.colors.warning }]}>
          {ft(locale, 'field.capture.server_rejected', {
            failures: attempt.serverFailures.join(', ') || '—',
          })}
        </Text>
      ) : null}

      {attempt?.outcome === 'failed' && attempt.errorCode ? (
        <Text style={[styles.caption, { color: theme.colors.warning }]}>
          {attempt.errorCode === FIELD_CAPTURE_CANCELLED ? guidance.cancelled : attempt.errorCode}
        </Text>
      ) : null}

      {/*
        * Two different facts, and the operator is told which one happened. A
        * photograph that never left the device and a photograph that left it
        * but was not acknowledged have opposite consequences for the
        * participant, so they must never share a line of copy.
        */}
      {attempt?.rawFrameErrorCode ? (
        <Text style={[styles.caption, { color: theme.colors.warning }]}>
          {ft(
            locale,
            attempt.rawFrameSent ? 'field.capture.raw_unconfirmed' : 'field.capture.raw_failed',
            { code: attempt.rawFrameErrorCode },
          )}
        </Text>
      ) : null}

      {record.attempts.length > 1 ? (
        <Text style={styles.caption}>{record.attempts.length}×</Text>
      ) : null}
    </Pressable>
  );
}

export function FieldCaptureScreen({
  locale,
  participantRef,
  poses,
  activePose,
  rawFramesConsented,
  recorded,
  qualified,
  collected,
  busy,
  previewReady,
  automatic,
  feedbackCode,
  onAutomatic,
  showNativePreview,
  errorCode,
  onSelectPose,
  onCapture,
  onFinish,
  onAbort,
  onPreviewReady,
  onPreviewError,
}: {
  locale: string;
  participantRef: string;
  poses: FieldPoseRecord[];
  activePose: PoseLabel;
  rawFramesConsented: boolean;
  recorded: number;
  qualified: number;
  collected: number;
  busy: boolean;
  previewReady: boolean;
  automatic: boolean;
  feedbackCode: string | null;
  onAutomatic: () => void;
  showNativePreview: boolean;
  errorCode: string | null;
  onSelectPose: (pose: PoseLabel) => void;
  onCapture: () => void;
  onFinish: () => void;
  onAbort: () => void;
  onPreviewReady: () => void;
  onPreviewError: (message: string) => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const active = poses.find((record) => record.pose === activePose);
  const repeat = active?.stage === 'recorded';
  const guidance = neutralCaptureGuidance(locale, activePose);
  const ar = /^ar(?:[-_]|$)/i.test(locale);
  const overlayStatus = collected === POSES.length
    ? ar ? 'اكتمل حفظ اللقطات. التحليل والمراجعة مرحلة منفصلة.' : 'Captures stored. Analysis and review are separate.'
    : active?.stage === 'uploading'
      ? ar ? 'جارٍ حفظ اللقطة؛ انتظر الوضعية التالية.' : 'Saving this capture; wait for the next pose.'
      : automatic ? automaticCaptureHint(locale, feedbackCode)
        : feedbackCode ? automaticCaptureHint(locale, feedbackCode)
          : ar ? 'الالتقاط التلقائي متوقف.' : 'Automatic capture paused.';

  return (
    <ScrollView
      style={previewStyles.scroll}
      contentContainerStyle={previewStyles.scrollContent}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator
    >
      <FieldBanner locale={locale} disposition={FIELD_DISPOSITION} />

      <View style={styles.row}>
        <Text style={[styles.h2, { flex: 1 }]}>
          {ft(locale, 'field.capture.title', { ref: participantRef })}
        </Text>
        <Text style={styles.caption}>
          {ar ? `حُفظت ${collected} من ${POSES.length} وضعيات` : `${collected} of ${POSES.length} poses stored`}
        </Text>
      </View>

      {/*
        * Named as the server's, not merely shown. An operator who has run the
        * previous build has seen a locally-generated reference in this slot,
        * and the difference is the whole point of the change: this one exists
        * on the platform and a deletion request quoting it can be honoured.
        */}
      <Text style={styles.caption}>
        {ft(locale, 'field.capture.participant', { ref: participantRef })}
      </Text>

      <Text style={[styles.caption, rawFramesConsented ? null : { color: theme.colors.muted }]}>
        {ft(locale, rawFramesConsented ? 'field.capture.raw_on' : 'field.capture.raw_off')}
      </Text>

      <View style={[styles.faceFrame, previewStyles.frame, previewStyles.clip]}>
        {showNativePreview ? (
          <NativeFaceTypePreview
            style={StyleSheet.absoluteFill}
            onPreviewReady={onPreviewReady}
            onPreviewError={(event) => onPreviewError(event.nativeEvent.message)}
          />
        ) : null}
        {!showNativePreview || !previewReady ? (
          <Text style={styles.muted}>{guidance.label}</Text>
        ) : null}
        <View pointerEvents="none" style={previewStyles.guideTop}>
          <Text style={previewStyles.guideProgress}>
            {POSES.indexOf(activePose) + 1} / {POSES.length} · {ar ? 'لقطات محفوظة' : 'Stored samples'} {active ? Math.min(collectedSamples(active, rawFramesConsented), COLLECTION_SAMPLES_PER_POSE) : 0} / {COLLECTION_SAMPLES_PER_POSE}
          </Text>
          <Text style={previewStyles.guideTitle} accessibilityLiveRegion="polite">{guidance.instruction}</Text>
        </View>
        <View pointerEvents="none" style={previewStyles.guideBottom}>
          <Text style={previewStyles.guideHint} accessibilityLiveRegion="polite">{overlayStatus}</Text>
        </View>
      </View>

      <Text style={styles.caption}>{guidance.neutral}</Text>
      <Button
        label={automatic ? guidance.automaticStop : guidance.automaticStart}
        onPress={onAutomatic}
        disabled={!automatic && (!previewReady || busy || collected === POSES.length)}
      />
      <Button
        label={ar ? (detailsOpen ? 'إخفاء التفاصيل' : 'تفاصيل القياس والتحكم اليدوي') : (detailsOpen ? 'Hide details' : 'Measurement details and manual controls')}
        variant="secondary"
        onPress={() => setDetailsOpen(!detailsOpen)}
      />
      {detailsOpen ? poses.map((record) => (
        <PoseRow
          key={record.pose}
          locale={locale}
          record={record}
          active={record.pose === activePose}
          onSelect={() => onSelectPose(record.pose)}
        />
      )) : null}

      {errorCode ? (
        <Text style={[styles.body, { color: theme.colors.warning }]}>
          {errorCode === FIELD_CAPTURE_CANCELLED ? guidance.cancelled : errorCode === 'FIELD_AUTOMATIC_QUALITY_TIMEOUT' ? guidance.adjust : errorCode}
        </Text>
      ) : null}

      {automatic ? <Text style={styles.body} accessibilityLiveRegion="polite">{guidance.automaticWaiting}</Text> : null}
      {rawFramesConsented ? <Text style={styles.caption}>{guidance.referencePhoto}</Text> : null}
      {detailsOpen ? <Button
        label={ft(locale, repeat ? 'field.capture.repeat' : 'field.capture.capture')}
        onPress={onCapture}
        loading={busy}
        disabled={!previewReady || automatic}
      /> : null}
      <Text style={styles.caption}>
        {ar ? `وضعيات مسجلة: ${recorded}؛ اجتازت شروط التحليل: ${qualified}. درجات الجودة للمراجعة وليست شرط اكتمال الجمع.` : `Recorded poses: ${recorded}; analysis-qualified: ${qualified}. Quality verdicts are retained separately from collection progress.`}
      </Text>
      {collected === POSES.length ? <Button
        label={ft(locale, 'field.capture.finish')}
        variant="secondary"
        onPress={onFinish}
        disabled={collected !== POSES.length || busy}
      /> : null}
      <Button label={ft(locale, 'field.capture.abort')} variant="secondary" onPress={onAbort} />
    </ScrollView>
  );
}

const previewStyles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: theme.colors.bg },
  scrollContent: { padding: theme.spacing[6], gap: theme.spacing[4] },
  // Shorter than the production frame: this screen has to fit five pose rows
  // and the operator's controls on the same phone.
  frame: { aspectRatio: 4 / 3 },
  clip: { overflow: 'hidden' },
  guideTop: { position: 'absolute', top: 12, left: 12, right: 12, padding: 12, borderRadius: 12, backgroundColor: 'rgba(0,0,0,0.72)' },
  guideBottom: { position: 'absolute', bottom: 12, left: 12, right: 12, padding: 12, borderRadius: 12, backgroundColor: 'rgba(0,0,0,0.72)' },
  guideProgress: { color: '#ffffff', textAlign: 'center', fontSize: 16 },
  guideTitle: { color: '#ffffff', textAlign: 'center', fontWeight: '700', fontSize: 22 },
  guideHint: { color: '#ffffff', textAlign: 'center', fontSize: 18 },
});
