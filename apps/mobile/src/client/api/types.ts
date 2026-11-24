/**
 * Client API shapes for docs/client-app-v1.md §3 (prefix `/api/v1/client`),
 * aligned field-for-field with the server's schemas
 * (`services/api/src/facetype_api/schemas/client.py`, exported to
 * `services/api/openapi.json`). `tests/contract/test_client_mobile_api_contract.py`
 * fails if a field declared here is absent from the OpenAPI schema it maps to,
 * if a required request field is missing here, or if a nullable server field
 * is declared non-null here. Request bodies are `extra="forbid"` on the
 * server: an extra field here is a 422 there.
 *
 * Unknown enum values are tolerated where the server may add states later:
 * the UI degrades to «غير معروفة» instead of crashing (FT-04 §12).
 */

import type { IdDocumentType, Sex } from '../validation.ts';

export interface TokenPair {
  access_token: string;
  token_type: 'Bearer';
  /** Access-token lifetime in seconds (3600 in v1). */
  expires_in: number;
  access_expires_at: string;
  refresh_token: string;
  refresh_expires_at: string;
  account_id: string;
}

export interface NonceResponse {
  nonce: string;
  expires_at: string;
}

export interface GoogleSignInBody {
  id_token: string;
}

export interface AppleSignInBody {
  identity_token: string;
  nonce: string;
  full_name?: string | null;
}

/** Non-production only (`CLIENT_AUTH_MOCK_ENABLED`). */
export interface MockSignInBody {
  subject: string;
}

export interface RefreshBody {
  refresh_token: string;
}

/**
 * docs/client-app-v1.md §6. `received` = every frame is a verified JPEG
 * matching its manifest, but the quality checks that need research models
 * (glasses, cover) have not run: it never claims quality. `stored` = integrity
 * and quality checks passed; `needs_retake` = a check failed.
 */
export type CaptureStatus =
  | 'uploading'
  | 'checking'
  | 'received'
  | 'stored'
  | 'needs_retake'
  /** ADR-016: the server is measuring the burst (research mode). */
  | 'measuring'
  /** ADR-016: another round is needed; `reasons[0]` says why. */
  | 'needs_more'
  /** ADR-016: the series is complete. */
  | 'complete';

export interface AccountView {
  id: string;
  provider: 'google' | 'apple' | 'mock';
  state: 'active' | 'withdrawing';
  created_at: string;
}

/**
 * What the server returns after a profile save and in GET /me: the person's
 * own data as entered, unmasked (owner decision 2026-11-24). Only the signed-in
 * owner of the account receives it.
 */
export interface ProfileView {
  revision_id: string;
  revision: number;
  full_name: string;
  id_issuing_country: string;
  id_document_type: IdDocumentType;
  id_number: string;
  phone: string;
  sex: Sex;
  /** `YYYY-MM-DD`. */
  birth_date: string;
  nationality: string;
  age_years: number;
  /** Identifiers are self-declared and unverified (ADR-015 §4). */
  identity_verification?: 'self_declared';
  updated_at: string;
}

/** `phone` is full E.164 (`+9665…`): the server adds no default country code. */
export interface ProfileInput {
  full_name: string;
  id_issuing_country: string;
  id_document_type: IdDocumentType;
  id_number: string;
  phone: string;
  sex: Sex;
  birth_date: string;
  nationality: string;
}

export interface ConsentInput {
  version: string;
  store_accepted: true;
  research_use: boolean;
}

export interface ConsentView {
  id: string;
  version: string;
  store_accepted: boolean;
  research_use: boolean;
  created_at: string;
}

export interface CaptureSummary {
  count: number;
  last_at: string | null;
  latest_status: CaptureStatus | string | null;
  next_repeat_due_at: string | null;
}

export interface ClientMe {
  account: AccountView;
  profile: ProfileView | null;
  consent: ConsentView | null;
  captures: CaptureSummary;
  /** Always MODEL_UNAVAILABLE until a validated model exists; never rendered as a result. */
  personality: { status: 'MODEL_UNAVAILABLE' | string };
}

/** DELETE /me → 202. */
export interface DeletionAccepted {
  status: 'withdrawing' | 'deleted';
  deletion_due_by: string;
}

export interface CaptureFrameDeclaration {
  index: number;
  sha256: string;
  bytes: number;
  width: number;
  height: number;
}

export interface CaptureCreate {
  client_capture_id: string;
  protocol_version: string;
  gate_config_hash: string;
  device: Record<string, unknown>;
  camera: Record<string, unknown>;
  frames: CaptureFrameDeclaration[];
  /** Free-form attempt descriptor, e.g. `{attempts: 2}` (≤ 16 KB of JSON). */
  attempt?: Record<string, unknown> | null;
}

export interface FrameUploadTarget {
  index: number;
  /** Already stored and verified: there is nothing to upload (`upload_url` is null). */
  completed: boolean;
  /** Absolute (object store) or, with the local development backend, relative to the API origin. */
  upload_url: string | null;
  method: 'PUT';
  headers: Record<string, string>;
  expires_at: string | null;
}

export interface CaptureCreated {
  capture_id: string;
  status: CaptureStatus | string;
  frames: FrameUploadTarget[];
}

export interface FrameCompleteBody {
  meta: Record<string, unknown>;
}

export interface CaptureView {
  id: string;
  status: CaptureStatus | string;
  accepted_frames: number;
  /** Retake reasons, e.g. `upload_integrity`; mapped by `verdictReasonKey`. */
  reasons: string[];
  sequence?: number;
  frame_count?: number;
  server_checks?: Record<string, unknown>;
  research_eligible?: boolean;
  previous_capture_id?: string | null;
  created_at?: string;
  finalized_at?: string | null;
  checked_at?: string | null;
}

/**
 * How one capture attempt ended (docs/client-app-v1.md §6: sent after the
 * server verdict, or when the attempt is abandoned). `stored` / `received` /
 * `needs_retake` are the server's verdict on the uploaded burst; `abandoned`
 * = the burst was taken but never reached a verdict (app closed past 48 h,
 * frames lost, or the server refused it); the rest end before any upload.
 */
export type AttemptOutcome =
  | 'stored'
  | 'received'
  | 'needs_retake'
  | 'needs_more'
  | 'complete'
  | 'abandoned'
  | 'cancelled'
  | 'timed_out'
  | 'out_of_scope'
  | 'permission_denied';

/** POST /attempts. `reason_counts` keys are snake_case on the wire (native contract §5.17). */
export interface AttemptTelemetry {
  outcome: AttemptOutcome;
  duration_ms: number;
  attempts: number;
  reason_counts: Record<string, number>;
  device: Record<string, unknown>;
}

/** The FT error envelope (FT-04 §9), as far as the client reads it. */
export interface ProblemBody {
  status?: number;
  error_code?: string;
  detail?: string;
  retryable?: boolean;
  retry_after_seconds?: number;
  /** Request-contract failures (422 FT-SYS-003): one entry per failing field. */
  errors?: Array<{ field: string; message: string; type?: string }>;
  /** `FT-CLIENT-PROFILE-INVALID` puts `{field: reason}` in `action.fields`. */
  action?: { type?: string; fields?: Record<string, string>; missing_frames?: number[]; [key: string]: unknown };
}
