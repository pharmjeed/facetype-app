import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeManifestSha256,
  TOPOLOGY_MAPPING_MANIFEST,
  TOPOLOGY_MAPPING_MANIFEST_JSON,
  TOPOLOGY_MAPPING_MANIFEST_SHA256,
  verifyTopologyMappingManifestIntegrity,
} from './topologyManifest.ts';
import { TOPOLOGY_MAPPING_SHA256, TOPOLOGY_MAPPING_VERSION } from './topology.ts';

test('manifest matches its pinned checksum', () => {
  assert.equal(computeManifestSha256(), TOPOLOGY_MAPPING_MANIFEST_SHA256);
  assert.match(TOPOLOGY_MAPPING_MANIFEST_SHA256, /^[a-f0-9]{64}$/);
  assert.doesNotThrow(verifyTopologyMappingManifestIntegrity);
});

test('an edited manifest is caught by the checksum', () => {
  const tampered = TOPOLOGY_MAPPING_MANIFEST_JSON.replace('"point_count":468', '"point_count":999');
  assert.notEqual(tampered, TOPOLOGY_MAPPING_MANIFEST_JSON);
  assert.notEqual(computeManifestSha256(tampered), TOPOLOGY_MAPPING_MANIFEST_SHA256);
});

test('manifest agrees with the frozen mapping-version constant', () => {
  assert.equal(TOPOLOGY_MAPPING_MANIFEST.mapping_version, TOPOLOGY_MAPPING_VERSION);
  assert.equal(TOPOLOGY_MAPPING_MANIFEST.target_uv.checksum_sha256, TOPOLOGY_MAPPING_SHA256);
  assert.equal(TOPOLOGY_MAPPING_MANIFEST.target_uv.point_count, 468);
});

test('manifest states iris and fallback policy without claiming accuracy', () => {
  const iris = TOPOLOGY_MAPPING_MANIFEST.iris_policy.toLowerCase();
  assert.ok(iris.includes('never') && iris.includes('iris') && iris.includes('confidence 0.0'));

  const fallback = TOPOLOGY_MAPPING_MANIFEST.coverage_fallback_policy.toLowerCase();
  assert.ok(fallback.includes('fail-closed'));
  assert.ok(fallback.includes('nearest'));
});

test('manifest pins the upstream asset, not only its own text (audit P0-02, review of b3f4b29)', () => {
  const targetUv = TOPOLOGY_MAPPING_MANIFEST.target_uv;
  assert.match(targetUv.source_revision, /^[a-f0-9]{40}$/, 'must be a full git commit sha');
  assert.match(targetUv.source_file_sha256, /^[a-f0-9]{64}$/);
  assert.ok(targetUv.source_url.startsWith('https://github.com/google-ai-edge/mediapipe/'));
  assert.ok(
    targetUv.source_url.includes(targetUv.source_revision),
    'the URL must pin the same commit as source_revision, not a moving branch',
  );
  assert.ok(targetUv.source_url.endsWith('canonical_face_model.obj'));
});
