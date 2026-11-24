/**
 * The field-study orchestrator: the actual sequence of platform calls a
 * collecting device makes, in the one order the server accepts them in.
 *
 * THE DEFECT THIS CLOSES. Until now the field lane called `createScan`,
 * `createUpload` and `registerObservation` and nothing else. It never read the
 * policy, never joined a session, never allocated a participant and never
 * attached a capture — so every sample it collected was an ordinary anonymous
 * scan that the study console could not see, and a field-study dashboard
 * watching a room full of participants would have shown zero. The reference on
 * the receipt was minted on the handset, which meant two devices in the same
 * room both handed out `P-000001`, and the server had never heard of either.
 *
 * THE ORDER IS THE CONTRACT, NOT A PREFERENCE. Each step is a precondition of
 * the next one on the server:
 *
 *   1. `GET /field-study/policy` — the retention the consent screen must state.
 *      Without it there is no honest consent, so there is no session.
 *   2. `POST /field-study/sessions/join` — once per session, with the
 *      operator's one-time code. Nothing about the code is kept afterwards.
 *   3. `POST /sessions/{id}/participants` — the server mints `P-xxxxxx`. The
 *      request carries no identifier at all; there is nothing to type a name
 *      into.
 *   4. `POST .../consent` twice — research collection, then photographs. Both
 *      are recorded before the camera opens, because the photo-completion route
 *      refuses a frame whose consent is not already live, and because a consent
 *      obtained after the capture is not a consent.
 *   5. `POST /scans` — the ordinary scan.
 *   6. `POST /sessions/{id}/captures` — attaches that scan to the participant.
 *      Before any upload: the attachment is what tells the storage layer a raw
 *      frame may outlive processing, and a frame uploaded before it is dated
 *      under the ephemeral policy.
 *   7. per pose: geometry slot, PUT, `registerObservation`; then, only for a
 *      consented photograph, a RAW_FRAME slot, PUT and `completeRawUpload`.
 *
 * EVERY PRE-CAMERA STEP FAILS CLOSED. A refusal at 1–6 throws, and the caller
 * cannot reach `capturePose` at all: it checks the same state again rather than
 * trusting that the screen only rendered after a success. A device that cannot
 * bind a participant must not collect a face it cannot attribute.
 *
 * WHAT THIS DELIBERATELY CANNOT DO. It is typed against `FieldStudyApi`, which
 * has no `finalizeScan`, no `getJob`, no `getResult` and no `deleteScan`. The
 * quarantine is not a call site that was left out; it is a method that does not
 * exist on the dependency.
 *
 * Framework-free: no React, no react-native. It is driven end to end by
 * `orchestration.test.ts` against a recording double of the real port.
 */

import type {
  CaptureStateResponse,
  FieldSessionResponse,
  ParticipantSummary,
  RawUploadCompletionResponse,
} from '@facetype/contracts';

import type { FieldStudyApi } from '../api/fieldStudy.ts';
import { captureError } from '../capture/captureError.ts';
import { buildFieldConsentRecord, type FieldConsentRecord } from './consent.ts';
import type { FieldCaptureDeps } from './fieldCapture.ts';
import { isParticipantRef } from './participantRef.ts';
import {
  FIELD_POLICY_UNAVAILABLE,
  mayOfferPhotoConsent,
  narrowPolicyToSession,
  resolveFieldStudyPolicy,
  type FieldStudyPolicy,
} from './policy.ts';

/** Client-local refusals. Deliberately not shaped like server FT codes. */
export const FIELD_JOIN_CODE_MALFORMED = 'FIELD_JOIN_CODE_MALFORMED';
export const FIELD_NOT_JOINED = 'FIELD_NOT_JOINED';
export const FIELD_ALREADY_JOINED = 'FIELD_ALREADY_JOINED';
export const FIELD_PARTICIPANT_NOT_ALLOCATED = 'FIELD_PARTICIPANT_NOT_ALLOCATED';
export const FIELD_PARTICIPANT_REF_UNUSABLE = 'FIELD_PARTICIPANT_REF_UNUSABLE';
export const FIELD_CONSENT_NOT_RECORDED = 'FIELD_CONSENT_NOT_RECORDED';
export const FIELD_PHOTO_CONSENT_UNAVAILABLE = 'FIELD_PHOTO_CONSENT_UNAVAILABLE';
export const FIELD_CAPTURE_NOT_ATTACHED = 'FIELD_CAPTURE_NOT_ATTACHED';
export const FIELD_RAW_COMPLETION_MISMATCH = 'FIELD_RAW_COMPLETION_MISMATCH';

/** `join_code` is `min_length=4, max_length=64` server-side. */
const JOIN_CODE_MIN = 4;
const JOIN_CODE_MAX = 64;

/** The two consent facts, named exactly as `FieldStudyConsentType` spells them. */
export const RESEARCH_CONSENT = 'field_study_research_data' as const;
export const PHOTO_CONSENT = 'field_study_raw_photo_retention' as const;

/** A session this device is collecting into. Holds no join code, ever. */
export interface JoinedFieldSession {
  sessionId: string;
  label: string;
  siteCode: string;
  /** Narrowed to this session: its wording version, its retention period. */
  policy: FieldStudyPolicy;
}

/**
 * One participant, as the server allocated and (afterwards) consented them.
 *
 * `consent` is nullable because allocation genuinely precedes consent: the
 * reference has to exist before the consent copy can quote it. A `null` here is
 * "allocated, not yet asked", which is exactly the state the platform models,
 * and it authorises nothing — `createAndAttachScan` refuses it.
 */
export interface ActiveParticipant {
  /** The server-minted `P-xxxxxx`. The only participant identifier there is. */
  participantRef: string;
  /** The server's opaque row id, kept for the operator's own reference. */
  participantId: string;
  consent: FieldConsentRecord | null;
}

/** A participant whose two consent facts are recorded on the server. */
export interface ConsentedParticipant extends ActiveParticipant {
  consent: FieldConsentRecord;
}

export interface FieldPoseTransport {
  /** PUT the bytes at a signed slot. Retries and URL resolution live here. */
  upload(
    slot: { upload_url: string; method: string; headers: Record<string, string> },
    payload: Uint8Array,
  ): Promise<void>;
  capture: FieldCaptureDeps['capture'];
  serialise: FieldCaptureDeps['serialise'];
  digest: FieldCaptureDeps['digest'];
  rawFrame: FieldCaptureDeps['rawFrame'];
  now: FieldCaptureDeps['now'];
  /** Told when the geometry slot has been requested, for the pose's stage row. */
  onUploading?: () => void;
}

/**
 * Confirm that a completion response actually confirms the photograph.
 *
 * A 200 is not the assertion this lane needs. What it needs is that the server
 * verified the stored bytes (`uploaded`), that it verified them as a
 * *photograph* rather than as geometry (`kind`), and that confirming them
 * created no observation row (`observation_registered`) — because the whole
 * reason this route exists is that the old way of marking a RAW_FRAME stored
 * was to register it as a captured pose, which filed a face in the geometry
 * ledger and counted it towards pose completeness.
 *
 * The digest and artifact id are checked too, so a response about a *different*
 * artifact cannot be read as confirmation of this one. Anything short of all
 * five is reported as a mismatch and leaves `rawFrameUploaded` false: the
 * bytes were sent, and the server has not said it kept them.
 */
export function assertRawUploadConfirmed(
  response: RawUploadCompletionResponse | null | undefined,
  expected: { artifactId: string; sha256: string },
): void {
  if (typeof response !== 'object' || response === null) {
    throw mismatch('the raw-upload completion returned no document');
  }
  if (response.artifact_id !== expected.artifactId) {
    throw mismatch('the raw-upload completion is for a different artifact');
  }
  if (response.kind !== 'RAW_FRAME') {
    throw mismatch('the raw-upload completion confirmed geometry, not a photograph');
  }
  if (response.uploaded !== true) {
    throw mismatch('the server did not confirm the photograph as stored');
  }
  // `false` and nothing else. A server that omitted the field has not told us
  // an observation was avoided, and this is the one claim the lane cannot
  // afford to assume: a photograph registered as a pose is a photograph on the
  // geometry path, counted towards pose completeness.
  if (response.observation_registered !== false) {
    throw mismatch('the raw-upload completion registered an observation');
  }
  if (String(response.sha256).toLowerCase() !== expected.sha256.toLowerCase()) {
    throw mismatch('the confirmed photograph does not match the digest that was sent');
  }
}

function mismatch(detail: string): Error {
  return captureError(FIELD_RAW_COMPLETION_MISMATCH, detail);
}

/**
 * The device's side of one field-study session.
 *
 * Two lifetimes are kept deliberately separate, because the operating protocol
 * depends on the difference: the *session* is joined once and survives every
 * participant, and the *participant* is rebuilt from nothing each time. There is
 * no method that clears one without the other being explicit about it.
 */
export class FieldStudyOrchestrator {
  private readonly api: FieldStudyApi;
  private deploymentPolicy: FieldStudyPolicy | null = null;
  private session: JoinedFieldSession | null = null;
  private participant: ActiveParticipant | null = null;
  private scanId: string | null = null;
  private attached = false;
  /**
   * One key per logical allocation and one per logical scan, reused across
   * retries of that same operation.
   *
   * A fresh key per attempt is how a lost response becomes a second `P-000002`
   * for the person already holding `P-000001`, or a second scan for the same
   * participant. They are cleared when the operation has definitively
   * succeeded, and when the participant is released.
   */
  private participantKey: string | null = null;
  private scanKey: string | null = null;

  private readonly newIdempotencyKey: () => string;

  constructor(api: FieldStudyApi, newIdempotencyKey: () => string) {
    this.api = api;
    this.newIdempotencyKey = newIdempotencyKey;
  }

  /** The policy this deployment stated, or `null` before it has been read. */
  get policy(): FieldStudyPolicy | null {
    return this.session?.policy ?? this.deploymentPolicy;
  }

  get joined(): JoinedFieldSession | null {
    return this.session;
  }

  get activeParticipant(): ActiveParticipant | null {
    return this.participant;
  }

  get activeScanId(): string | null {
    return this.scanId;
  }

  /**
   * Step 1. Read what this deployment will really do.
   *
   * Throws on a transport failure, a refusal, or a document that does not hold
   * together. There is no cached, configured or assumed answer to fall back to,
   * which is the point: the previous implementation had one, and it was wrong.
   */
  async loadPolicy(): Promise<FieldStudyPolicy> {
    let response;
    try {
      response = await this.api.fieldStudyPolicy();
    } catch (error) {
      throw captureError(
        FIELD_POLICY_UNAVAILABLE,
        'the deployment did not answer for its field-study policy',
        { cause: error },
      );
    }
    const resolved = resolveFieldStudyPolicy(response);
    if (!resolved.ok) {
      throw captureError(resolved.reason, 'the field-study policy cannot be stated to a participant');
    }
    this.deploymentPolicy = resolved.policy;
    return resolved.policy;
  }

  /**
   * Step 2. Exchange the operator's one-time code for a session.
   *
   * The code is a parameter and never a field: it is not stored on this object,
   * not written to state, not persisted and not carried into any later request.
   * What survives the call is the session id and the narrowed policy. Joining
   * twice is refused rather than silently re-joined — an operator who has
   * already joined and types a second code is doing something the protocol does
   * not have, and quietly moving the device to another session mid-collection
   * would attribute the next participant to the wrong study.
   */
  async join(joinCode: string): Promise<JoinedFieldSession> {
    const policy = this.deploymentPolicy;
    if (policy === null) {
      throw captureError(
        FIELD_POLICY_UNAVAILABLE,
        'the field-study policy must be read before a session is joined',
      );
    }
    if (this.session !== null) {
      throw captureError(
        FIELD_ALREADY_JOINED,
        'this device is already collecting into a field-study session',
      );
    }
    const code = typeof joinCode === 'string' ? joinCode.trim() : '';
    if (code.length < JOIN_CODE_MIN || code.length > JOIN_CODE_MAX) {
      throw captureError(FIELD_JOIN_CODE_MALFORMED, 'the join code is not a usable session code');
    }

    const session: FieldSessionResponse = await this.api.joinFieldSession(code);
    const narrowed = narrowPolicyToSession(policy, session);
    if (!narrowed.ok) {
      throw captureError(narrowed.reason, 'the joined session cannot be collected into');
    }
    this.session = {
      sessionId: session.session_id,
      label: session.label,
      siteCode: session.site_code,
      policy: narrowed.policy,
    };
    return this.session;
  }

  /**
   * Step 3. Ask the server for this participant's reference.
   *
   * Separate from `recordConsent` on purpose, and in this order. The consent
   * copy has to quote the reference the participant will use to ask for their
   * data back, and there is no such reference until the server has minted one —
   * so the allocation happens first, and the consent is read afterwards against
   * a real identifier rather than a dash.
   *
   * An allocated participant with no consent fact is a state the platform
   * models explicitly ("never asked is not the same as refused, and neither is
   * a grant"), and it grants nothing: no scan can be attached and no photograph
   * can be confirmed against it.
   */
  async allocateParticipant(): Promise<string> {
    const session = this.requireSession();
    // Already allocated: hand back the same reference rather than minting a
    // second one. A double tap on the allocate button, or a re-render that
    // fires the effect twice, must not enrol two participants for one person —
    // and the idempotency key that would have protected against a *retry* has
    // already been retired by the successful first call.
    if (this.participant !== null) return this.participant.participantRef;
    const key = this.participantKey ?? this.newIdempotencyKey();
    this.participantKey = key;

    const summary: ParticipantSummary = await this.api.addParticipant(session.sessionId, key);
    // The server is the authority on the reference, and this is a check that
    // it produced the opaque shape rather than a repair of one that did not:
    // a reference that had to be edited to become opaque was not opaque.
    if (!isParticipantRef(summary.participant_ref)) {
      throw captureError(
        FIELD_PARTICIPANT_REF_UNUSABLE,
        'the allocated participant reference is not a pseudonymous study reference',
      );
    }
    this.participant = {
      participantRef: summary.participant_ref,
      participantId: summary.participant_id,
      // Allocated, not yet asked. `recordConsent` is what fills this in.
      consent: null,
    };
    // Allocation is done; a later retry of *consent* must not re-mint a ref.
    this.participantKey = null;
    return summary.participant_ref;
  }

  /**
   * Step 4. Record the two consent answers, research first.
   *
   * Two calls, always both, always in this order, always before the camera. The
   * photograph answer is recorded even when it is `false`: "asked and declined"
   * and "never asked" are different facts about a person, the server stores them
   * differently, and only one of them is evidence that the question was put.
   *
   * A photograph grant is refused outright on a deployment that retains no
   * photograph. Recording it would obtain permission for something that cannot
   * happen and would leave the receipt explaining why the photographs somebody
   * agreed to do not exist.
   */
  async recordConsent(input: {
    researchGranted: boolean;
    photoGranted: boolean;
    locale: string;
    nowMs: number;
  }): Promise<ConsentedParticipant> {
    const session = this.requireSession();
    const allocated = this.participant;
    if (allocated === null) {
      throw captureError(
        FIELD_PARTICIPANT_NOT_ALLOCATED,
        'no participant reference has been allocated for this consent',
      );
    }
    if (input.researchGranted !== true) {
      throw captureError(
        FIELD_CONSENT_NOT_RECORDED,
        'a field capture requires an explicit research-collection grant',
      );
    }
    if (input.photoGranted === true && !mayOfferPhotoConsent(session.policy)) {
      throw captureError(
        FIELD_PHOTO_CONSENT_UNAVAILABLE,
        'this deployment retains no photograph, so a photograph grant cannot be recorded',
      );
    }

    await this.api.recordConsent(session.sessionId, allocated.participantRef, {
      consent_type: RESEARCH_CONSENT,
      granted: true,
      locale: input.locale,
    });
    await this.api.recordConsent(session.sessionId, allocated.participantRef, {
      consent_type: PHOTO_CONSENT,
      granted: input.photoGranted === true,
      locale: input.locale,
    });

    const consent = buildFieldConsentRecord({
      participantRef: allocated.participantRef,
      researchCollection: true,
      rawFrameRetention: input.photoGranted === true,
      policyVersion: session.policy.consentPolicyVersion,
      rawPhotoRetentionDays: session.policy.rawPhotoRetentionDays,
      grantedAtMs: input.nowMs,
    });
    if (consent === null) {
      // Both facts are on the server and neither is retracted by this: what
      // failed is the device's ability to represent them, which must stop the
      // camera rather than be papered over with a record that fails its own
      // gate later, deeper in.
      throw captureError(
        FIELD_CONSENT_NOT_RECORDED,
        'the recorded consent could not be represented as a usable consent record',
      );
    }
    const consented: ConsentedParticipant = { ...allocated, consent };
    this.participant = consented;
    return consented;
  }

  /**
   * A participant who declines, recorded as declining.
   *
   * The refusal is written to the server as `research_data granted=false`
   * rather than discarded locally, because a reference was already allocated
   * and an allocated row with no consent fact reads as "not asked yet". This
   * lane asked. Nothing else is recorded: a photograph grant is meaningless
   * without the collection grant it stands on, and the participant is not made
   * to answer a second question they have already opted out of.
   */
  async declineParticipant(locale: string): Promise<void> {
    const session = this.requireSession();
    const allocated = this.participant;
    if (allocated === null) return;
    await this.api.recordConsent(session.sessionId, allocated.participantRef, {
      consent_type: RESEARCH_CONSENT,
      granted: false,
      locale,
    });
  }

  /**
   * Steps 5 and 6, as one operation, because they are one fact.
   *
   * A scan that is created and not attached is an ordinary anonymous scan that
   * the study cannot see and that a raw frame must not be uploaded against, so
   * there is no method that produces one and stops. `attached` is set only by
   * the attach response, and `capturePose` refuses without it.
   */
  async createAndAttachScan(input: {
    platform: 'ios' | 'android' | 'web';
    deviceModel: string;
    appVersion: string;
    providerCapability: string;
    locale: string;
  }): Promise<string> {
    const session = this.requireSession();
    const participant = this.requireConsentedParticipant();

    if (this.scanId === null) {
      const key = this.scanKey ?? this.newIdempotencyKey();
      this.scanKey = key;
      const scan = await this.api.createScan(
        {
          capture_protocol: session.policy.captureProtocol,
          capture_mode: 'geometry_preferred',
          device: {
            platform: input.platform,
            model: input.deviceModel,
            app_version: input.appVersion,
            provider_capabilities: [input.providerCapability],
          },
          privacy: {
            // The participant's own answer, carried as the retention class the
            // server decides from it. `false` means a RAW_FRAME upload would be
            // refused a persistent class, and this lane never creates one.
            retain_raw_frames: participant.consent.rawFrameRetention === true,
            research_opt_in: true,
          },
          // Operator-guided, with the participant's face uncovered on the
          // operator's instruction. Recorded as the self-attestation it is,
          // never as an occlusion measurement.
          obstruction_self_attested: true,
          locale: input.locale,
          consent_granted: true,
          consent_policy_version: session.policy.consentPolicyVersion,
        },
        key,
      );
      this.scanId = scan.scan_id;
      this.scanKey = null;
    }

    if (!this.attached) {
      await this.api.attachCapture(session.sessionId, {
        participant_ref: participant.participantRef,
        scan_id: this.scanId,
      });
      this.attached = true;
    }
    return this.scanId;
  }

  /**
   * Step 7. The dependencies one pose capture runs against.
   *
   * Built here rather than in the component so the ordering rules above are
   * enforced by the same object that established them: this throws unless a
   * session is joined, a participant is consented, a scan exists and it is
   * attached — the exact four preconditions the platform checks on the other
   * side, restated on this one so a failure is a refusal in the room rather
   * than a rejected upload.
   */
  poseDeps(transport: FieldPoseTransport): FieldCaptureDeps {
    const scanId = this.requireAttachedScan();
    const api = this.api;
    return {
      capture: transport.capture,
      serialise: transport.serialise,
      digest: transport.digest,
      createUpload: async (request) => {
        transport.onUploading?.();
        const slot = await api.createUpload(scanId, request);
        return {
          artifact_id: slot.artifact_id,
          upload_url: slot.upload_url,
          method: slot.method,
          headers: slot.headers,
        };
      },
      upload: (slot, payload) => transport.upload(slot, payload),
      registerObservation: async (request) => {
        const registered = await api.registerObservation(scanId, request);
        return {
          accepted: registered.accepted,
          failures: [...(registered.failures ?? [])],
        };
      },
      completeRawUpload: async (request) => {
        const response = await api.completeRawUpload(scanId, request.artifact_id, {
          sha256: request.sha256,
          content_length: request.content_length,
          content_type: request.content_type,
        });
        assertRawUploadConfirmed(response, {
          artifactId: request.artifact_id,
          sha256: request.sha256,
        });
      },
      rawFrame: transport.rawFrame,
      now: transport.now,
    };
  }

  /** Read the morphology-only state for this device's attached capture. */
  captureState(): Promise<CaptureStateResponse> {
    const session = this.requireSession();
    const scanId = this.requireAttachedScan();
    return this.api.getOwnCapture(session.sessionId, scanId);
  }

  /**
   * Everything about this participant, gone; the session, kept.
   *
   * This is the fast path the lane exists for: the operator taps once and the
   * next person's reference is allocated by the server against the same
   * session. Nothing here re-joins, and nothing here mints a reference.
   */
  releaseParticipant(): void {
    this.participant = null;
    this.scanId = null;
    this.attached = false;
    this.participantKey = null;
    this.scanKey = null;
  }

  /**
   * Leave the session entirely.
   *
   * The policy is kept because it is a property of the deployment rather than
   * of the session, and re-reading it is a fresh `loadPolicy` away in any case.
   */
  leaveSession(): void {
    this.releaseParticipant();
    this.session = null;
  }

  private requireSession(): JoinedFieldSession {
    if (this.session === null) {
      throw captureError(FIELD_NOT_JOINED, 'no field-study session has been joined on this device');
    }
    return this.session;
  }

  private requireConsentedParticipant(): ConsentedParticipant {
    const participant = this.participant;
    if (participant === null) {
      throw captureError(
        FIELD_PARTICIPANT_NOT_ALLOCATED,
        'no participant reference has been allocated by the server',
      );
    }
    const consent = participant.consent;
    if (consent === null) {
      throw captureError(
        FIELD_CONSENT_NOT_RECORDED,
        'the participant has no consent recorded on the server',
      );
    }
    return { ...participant, consent };
  }

  private requireAttachedScan(): string {
    this.requireSession();
    this.requireConsentedParticipant();
    if (this.scanId === null || !this.attached) {
      throw captureError(
        FIELD_CAPTURE_NOT_ATTACHED,
        'the scan is not attributed to a study participant, so nothing may be uploaded',
      );
    }
    return this.scanId;
  }
}
