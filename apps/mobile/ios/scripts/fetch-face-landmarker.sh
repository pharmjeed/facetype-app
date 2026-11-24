#!/bin/sh
#
# Fetches and checksum-verifies the MediaPipe face-landmarker model bundle for
# the iOS client camera, then copies the verified file into the app bundle.
#
#   fetch-face-landmarker.sh <cache-path> [bundle-resources-dir]
#
# WHY IT IS NOT IN GIT. 3.7 MB of weights in a diff is a binary nobody reads.
# What gets reviewed is the pin -- a URL and a SHA-256 -- and the build refuses
# to package anything that does not hash to it. The pin is the same one
# Android's `fetchFaceLandmarkerModel` Gradle task uses
# (apps/mobile/android/app/build.gradle), so both platforms run one model;
# tests/contract/test_ios_client_camera.py fails if the two drift apart, or if
# FaceTypeClientFrameAnalyzer.pinnedModelSha256 does.
#
# OFFLINE. A correct file already at <cache-path> is reused and no request is
# made, so only the first build on a machine needs the network.
#
# Run by the "Bundle the pinned MediaPipe face-landmarker model" build phase
# declared in ios/project.yml. Lines starting with "error:" are what Xcode
# shows as build errors.

set -eu

MODEL_URL="https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"
MODEL_SHA256="64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff"

cache="${1:?usage: fetch-face-landmarker.sh <cache-path> [bundle-resources-dir]}"
bundle_dir="${2:-}"

sha_of() {
  shasum -a 256 "$1" | cut -d ' ' -f 1
}

if [ ! -f "$cache" ] || [ "$(sha_of "$cache")" != "$MODEL_SHA256" ]; then
  mkdir -p "$(dirname "$cache")"
  # Download beside the target, verify, and only then move into place, so an
  # interrupted or substituted fetch never leaves a file the next build would
  # treat as cached.
  part="$cache.part"
  rm -f "$part"
  if ! curl -fsSL --retry 3 -o "$part" "$MODEL_URL"; then
    rm -f "$part"
    echo "error: could not fetch the face-landmarker model from $MODEL_URL. The first build on a machine needs network access; later builds reuse the verified copy at $cache." >&2
    exit 1
  fi
  actual="$(sha_of "$part")"
  if [ "$actual" != "$MODEL_SHA256" ]; then
    rm -f "$part"
    echo "error: the face-landmarker model from $MODEL_URL hashes to $actual, not the pinned $MODEL_SHA256. Refusing to bundle it." >&2
    exit 1
  fi
  mv "$part" "$cache"
fi

if [ -n "$bundle_dir" ]; then
  mkdir -p "$bundle_dir"
  cp "$cache" "$bundle_dir/face_landmarker.task"
fi
