/**
 * Reproducible provenance manifest for the ARKit/ARCore -> MediaPipe-478
 * topology mapping (audit P0-02 item 8; hardened after independent review of
 * 15d1fab).
 *
 * TypeScript mirror of `packages/python-facetype-core/src/facetype_core/
 * geometry/topology_manifest.py` — the exact same JSON text and the exact
 * same pinned checksum, duplicated the same way `TOPOLOGY_MAPPING_VERSION`/
 * `TOPOLOGY_MAPPING_SHA256` already are between `wire.py` and `topology.ts`.
 * `topologyManifest.test.ts` and the Python `test_topology_manifest.py` each
 * check their own side is internally consistent; nothing currently automates
 * checking the two files against each other, so keep them in sync by hand
 * when either changes.
 *
 * **Integrity is not accuracy.** `MANIFEST_SHA256` proves that
 * `TOPOLOGY_MAPPING_MANIFEST_JSON` has not silently drifted from what it was
 * frozen with — nothing more. It does not verify, and cannot verify, that the
 * mapping is anatomically correct on any real ARKit or ARCore device: that
 * would need a physical calibrated capture, which this repository does not
 * have (P0-02 stays PARTIAL for exactly this reason).
 *
 * `MANIFEST_SHA256` is a literal, typed once from a checksum computed
 * offline — never `verifyManifestIntegrity()`'s own recomputation assigned
 * back to this constant. An earlier version of the Python module made that
 * mistake: binding the "pinned" value to a fresh hash of the live content at
 * import time made the check vacuous, since any edit recomputed a matching
 * value on every load. See that module's docstring for the full account.
 *
 * `target_uv.source_url`/`source_revision`/`source_file_sha256` (audit
 * P0-02, independent review of b3f4b29) pin the *upstream* asset the 468
 * target UVs were extracted from, not only this manifest's own text: without
 * them, "integrity" only proved the manifest agreed with itself, never that
 * it traces back to a specific, fetchable Apache-2.0 file. These were
 * independently reproduced while fixing this finding: fetching
 * `https://raw.githubusercontent.com/google-ai-edge/mediapipe/<source_revision>
 * /mediapipe/modules/face_geometry/data/canonical_face_model.obj` yields a
 * file whose SHA-256 is `source_file_sha256`, and re-extracting its 468 `vt`
 * lines as little-endian float32 pairs and hashing them reproduces
 * `target_uv.checksum_sha256` (and therefore `TOPOLOGY_MAPPING_SHA256` in
 * `wire.ts`) exactly. Neither this module nor its tests re-fetch that URL at
 * import or test time — this repository has no network access at test time
 * by design — so this is a recorded, human-reproducible pin, not a
 * live-verified one.
 */

import { fallbackSha256 } from '../api/client.ts';
import { captureError } from './captureError.ts';

/** Keep this identical, byte for byte, to `TOPOLOGY_MAPPING_MANIFEST_JSON` in
 * `topology_manifest.py`. */
export const TOPOLOGY_MAPPING_MANIFEST_JSON =
  '{"coverage_fallback_policy":"Fail-closed (audit P0-02 item 1): a target UV not covered by any triang' +
  "le in the provider's own mesh is NOT approximated by the nearest source vertex. It receives a zero-v" +
  "ector placeholder, confidence 0.0, and is listed in unavailable_landmark_indices, together with diag" +
  "nostic (never positional) coverage/residual evidence -- coveredCount, uncoveredTargetIndices, maxUnc" +
  'overedUvGap.","fixture_identities":["apps/mobile/src/capture/topology.test.ts::cross-provider mappin' +
  'g matches the analytic surface despite different vertex counts, order and triangulation","apps/mobil' +
  "e/src/capture/topology.test.ts::a target UV outside every provider triangle is reported unavailable," +
  ' never guessed","apps/mobile/src/capture/topology.test.ts::ARCore 468 becomes 478 while ten unmeasur' +
  'ed iris points stay unavailable","tests/contract/test_native_topology_acceptance.py::test_ftob_rejec' +
  'ts_canonical_topology_missing_mapping_provenance","packages/python-facetype-core/tests/test_topology' +
  '_obj_parser.py::test_parser_reproduces_the_pinned_target_uv_checksum","packages/python-facetype-core' +
  "/tests/test_topology_obj_parser.py::test_naive_vt_line_order_reproduces_the_known_v2_regression_not_" +
  'the_pinned_checksum","apps/mobile/src/capture/topologyObjParser.test.ts::the face-association parser' +
  ' reproduces the pinned target UV checksum from the fixture .obj","apps/mobile/src/capture/topologyOb' +
  "jParser.test.ts::naive vt-line-order parsing reproduces the known v2 regression, not the pinned chec" +
  'ksum","packages/python-facetype-core/tests/test_capture_providers.py::test_mediapipe_capture_provide' +
  'r_populates_canonical_topology_provenance"],"iris_policy":"Canonical indices 468-477 (the ten MediaP' +
  "ipe refined-landmark iris points) are never measured by ARKit or ARCore. Each receives a finite eye-" +
  "centre placeholder (the mean of its eye-ring landmarks) with confidence 0.0 and is listed in unavail" +
  'able_landmark_indices. They must never be treated as a measurement.","mapping_algorithm":{"descripti' +
  "on\":\"Each of the 468 target UVs is located inside the provider's own UV-triangulated mesh; the corre" +
  "sponding XYZ is the barycentric combination of that triangle's three vertices. No axis remap, sign f" +
  "lip, or UV V-flip is applied (see apps/mobile/src/capture/topology.ts). Version 2 replaced a silent " +
  "nearest-source-vertex fallback for an uncovered target UV with the fail-closed coverage policy below" +
  " (audit P0-02 item 1). Version 3 fixed the target UV table itself (audit P0-02, re-review of 6748fef" +
  "): v2 built it from canonical_face_model.obj's `vt` lines in raw file order, not each vertex's UV vi" +
  "a its face v/vt association -- a vertex's v-index and vt-index are independent numbering, so the tab" +
  "le was internally self-consistent but not the semantic per-landmark UV the algorithm needs. It is no" +
  "w re-extracted by walking every face's v/vt pairs.\",\"name\":\"uv-barycentric-interpolation\",\"version\":" +
  '"uv-barycentric-3"},"mapping_version":"mp478-v1.uv-barycentric-3","target_uv":{"checksum_covers":"th' +
  'e raw target UV float32 bytes only, not this manifest","checksum_sha256":"3c26dbea4f3a00a93ba6245c90' +
  '0779c4bc6fe8078c68b59b37e89a77c56fc6f4","license":"Apache-2.0","point_count":468,"source":"MediaPipe' +
  ' Face Landmarker canonical_face_model.obj","source_file_sha256":"8bac80443397e113f41a8b565ea72c59390' +
  'bc031d9defab289dba7bc0c54e618","source_revision":"a908d668c730da128dfa8d9f6bd25d519d006692","source_' +
  'url":"https://github.com/google-ai-edge/mediapipe/blob/a908d668c730da128dfa8d9f6bd25d519d006692/medi' +
  'apipe/modules/face_geometry/data/canonical_face_model.obj"}}';

export interface TopologyMappingManifest {
  coverage_fallback_policy: string;
  fixture_identities: readonly string[];
  iris_policy: string;
  mapping_algorithm: { description: string; name: string; version: string };
  mapping_version: string;
  target_uv: {
    checksum_covers: string;
    checksum_sha256: string;
    license: string;
    point_count: number;
    source: string;
    // Pin of the actual upstream asset (audit P0-02, independent review of
    // b3f4b29): which commit of the upstream repo, what its raw file hashes
    // to, and where to fetch it — not only this manifest's own checksum of
    // itself. See the module docstring for how these were reproduced.
    source_file_sha256: string;
    source_revision: string;
    source_url: string;
  };
}

export const TOPOLOGY_MAPPING_MANIFEST: TopologyMappingManifest = JSON.parse(
  TOPOLOGY_MAPPING_MANIFEST_JSON,
);

/** Pinned literal — computed once, offline, from `TOPOLOGY_MAPPING_MANIFEST_JSON`
 * exactly as written above. Must match the Python mirror's `MANIFEST_SHA256`. */
export const TOPOLOGY_MAPPING_MANIFEST_SHA256 =
  '6fc3d5d676f1b0cc4849c4d6823e161ae244fb2be88303633e4a9cf984545887';

export function computeManifestSha256(manifestJson: string = TOPOLOGY_MAPPING_MANIFEST_JSON): string {
  return fallbackSha256(new TextEncoder().encode(manifestJson));
}

/** Raises if the manifest body no longer matches its pinned checksum. See
 * the module docstring: passing proves only that this is still the manifest
 * that was reviewed and frozen, never that the mapping is anatomically
 * accurate on any real device. */
export function verifyTopologyMappingManifestIntegrity(): void {
  const actual = computeManifestSha256();
  if (actual !== TOPOLOGY_MAPPING_MANIFEST_SHA256) {
    throw captureError('FT-REC-006', 'topology mapping manifest checksum does not match');
  }
}
