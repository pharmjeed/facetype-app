import { captureError } from './captureError.ts';
/** Fail-closed access to the optional React Native geometry bridge. */
export function requireNativeCaptureModule<T>(module: T | undefined): T {
  if (module === undefined) {
    throw captureError('FT-REC-005', 'native capture module is unavailable');
  }
  return module;
}
