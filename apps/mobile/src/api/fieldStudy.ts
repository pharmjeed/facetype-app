/**
 * The field-study surface of the platform API, as a port the lane owns.
 *
 * WHY A PORT AND NOT `FaceTypeClient` DIRECTLY. `FaceTypeClient` has ninety-odd
 * methods, five of which finalize a scan, poll a job or fetch a result. The
 * field lane's whole quarantine claim is that it never calls those, and the
 * strongest way to hold that is a dependency that does not have them: the
 * orchestrator is typed against `FieldStudyApi`, so `finalizeScan` is not a
 * call it declines to make, it is a call it cannot express.
 *
 * WHY THE SHAPES ARE THE GENERATED ONES. Every request and response type below
 * is imported from `@facetype/contracts`, not restated. A hand-written mirror
 * of `RecordConsentRequest` would compile happily against a server that had
 * since renamed a field, and the failure would land on a handset in a room with
 * a participant in it. `make contracts` regenerates the types; this file breaks
 * the build if the shapes moved.
 *
 * The methods are thin on purpose — each is one generated call and nothing else
 * — so that "the app calls the API" is checkable by reading twelve lines rather
 * than by reasoning about a component.
 */

import type {
  AttachCaptureRequest,
  CaptureStateResponse,
  ConsentFact,
  CreateScanRequest,
  FaceTypeClient,
  FieldSessionResponse,
  FieldStudyPolicyResponse,
  ObservationRequest,
  ObservationResponse,
  ParticipantSummary,
  RawUploadCompletionRequest,
  RawUploadCompletionResponse,
  RecordConsentRequest,
  ScanResponse,
  UploadRequest,
  UploadResponse,
} from '@facetype/contracts';

/**
 * Everything the collecting device is allowed to do, in the order it does it.
 *
 * There is no `finalizeScan`, no `getJob`, no `getResult` and no `retake`: a
 * field capture is calibration evidence, it never becomes a processing job, and
 * this interface is where that is enforced rather than remembered.
 *
 * There is also no `deleteScan`. A collector standing in the room cannot erase
 * a participant — that is `field_study:admin`, held by the operator console —
 * and a device method that deleted a scan would let the receipt claim an
 * erasure the server had not performed.
 */
export interface FieldStudyApi {
  /** What this deployment will actually do, read before anything is joined. */
  fieldStudyPolicy(): Promise<FieldStudyPolicyResponse>;
  /** Exchange the operator's one-time code for a session id. */
  joinFieldSession(joinCode: string): Promise<FieldSessionResponse>;
  /** Mint the next `P-xxxxxx`. Takes no identifier, by design. */
  addParticipant(sessionId: string, idempotencyKey: string): Promise<ParticipantSummary>;
  /** Append one consent answer. Nothing already recorded is modified. */
  recordConsent(
    sessionId: string,
    participantRef: string,
    body: RecordConsentRequest,
  ): Promise<ConsentFact[]>;
  /** The ordinary scan this lane collects into. Never finalized. */
  createScan(body: CreateScanRequest, idempotencyKey: string): Promise<ScanResponse>;
  /** Attribute that scan to the participant, before a single byte is uploaded. */
  attachCapture(sessionId: string, body: AttachCaptureRequest): Promise<CaptureStateResponse>;
  /** Poll only this collector's active capture; no roster or result access. */
  getOwnCapture(sessionId: string, scanId: string): Promise<CaptureStateResponse>;
  /** A signed slot for one artifact. */
  createUpload(scanId: string, body: UploadRequest): Promise<UploadResponse>;
  /** Register one measured pose. Never a photograph — that is refused here. */
  registerObservation(scanId: string, body: ObservationRequest): Promise<ObservationResponse>;
  /** The only route that marks a `RAW_FRAME` stored, and never an observation. */
  completeRawUpload(
    scanId: string,
    artifactId: string,
    body: RawUploadCompletionRequest,
  ): Promise<RawUploadCompletionResponse>;
}

/**
 * Bind the generated client to the port.
 *
 * The `idempotencyKey` arguments are required rather than optional. The
 * generated client accepts them as options and works without them; a
 * participant allocation retried without one mints a second `P-xxxxxx` for a
 * person who is still sitting in the chair, and a create-scan retried without
 * one mints a second scan for the same participant. Making the caller pass one
 * means the omission is a compile error rather than a duplicate row.
 */
export function fieldStudyApi(client: FaceTypeClient): FieldStudyApi {
  return {
    fieldStudyPolicy: () => client.fieldStudyPolicy(),
    // The code is passed straight through and never stored on the way: it is
    // the operator's one-time secret, and this closure is the last place in the
    // app that sees it.
    joinFieldSession: (joinCode) => client.joinFieldSession({ join_code: joinCode }),
    addParticipant: (sessionId, idempotencyKey) =>
      client.addParticipant(sessionId, { idempotencyKey }),
    recordConsent: (sessionId, participantRef, body) =>
      client.recordConsent(sessionId, participantRef, body),
    createScan: (body, idempotencyKey) => client.createScan(body, { idempotencyKey }),
    attachCapture: (sessionId, body) => client.attachCapture(sessionId, body),
    getOwnCapture: (sessionId, scanId) => client.getOwnCapture(sessionId, scanId),
    createUpload: (scanId, body) => client.createUpload(scanId, body),
    registerObservation: (scanId, body) => client.registerObservation(scanId, body),
    completeRawUpload: (scanId, artifactId, body) =>
      client.completeRawUpload(scanId, artifactId, body),
  };
}
