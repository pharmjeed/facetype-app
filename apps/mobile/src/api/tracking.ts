import type { FaceTypeClient } from '@facetype/contracts';

import { idempotencyKey } from './client.ts';

export const FT16_EVENTS = [
  'scan_started',
  'pose_requested',
  'pose_accepted',
  'pose_rejected',
  'scan_finalized',
  'processing_stage_started',
  'processing_stage_completed',
  'scan_terminal',
  'result_viewed',
  'rescan_started',
  'privacy_delete_requested',
  'privacy_delete_completed',
  'billing_limit_seen',
] as const;

export type ProductEventName = (typeof FT16_EVENTS)[number];

const FORBIDDEN_KEYS = [
  'mesh',
  'embedding',
  'genome',
  'raw_feature',
  'neighbor',
  'gold_anchor',
  'landmark',
  'coordinate',
  'principal_id',
  'user_id',
  'scan_id',
  'device_id',
  'session_id',
  'email',
] as const;

/** A fail-closed client: no consent means no request is created. */
export class ConsentGatedAnalytics {
  private analyticsConsent = false;
  private readonly api: FaceTypeClient;

  constructor(api: FaceTypeClient) {
    this.api = api;
  }

  async setConsent(granted: boolean): Promise<void> {
    if (!granted) this.analyticsConsent = false;
    await this.api.recordTrackingConsent({
      granted,
      policy_version: 'analytics-1.0.0',
    });
    this.analyticsConsent = granted;
  }

  disable(): void {
    this.analyticsConsent = false;
  }

  async trackEvent(
    eventName: ProductEventName,
    properties: Record<string, string | number | boolean> = {},
  ): Promise<boolean> {
    if (!this.analyticsConsent) return false;
    rejectSensitiveProperties(properties);
    await this.api.ingestProductEvent({
      event_id: idempotencyKey(),
      event_name: eventName,
      event_version: '1.0.0',
      occurred_at: new Date().toISOString(),
      properties,
    });
    return true;
  }
}

function rejectSensitiveProperties(properties: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(properties)) {
    const normalized = key.toLowerCase().replaceAll('-', '_').replaceAll('.', '_');
    if (FORBIDDEN_KEYS.some((forbidden) => normalized.includes(forbidden))) {
      throw new Error(`Forbidden analytics property: ${normalized}`);
    }
    if (value && typeof value === 'object') {
      rejectSensitiveProperties(value as Record<string, unknown>);
    }
  }
}
