//
//  Bridging header — makes the React Native Objective-C API visible to Swift.
//
//  Deliberately minimal. LocalAuthentication is NOT imported and must not be:
//  FT-00 §3 forbids any path to Face ID or the Secure Enclave, and
//  `make security-scan` fails the build if such an import appears.
//
#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>
// RCTInvalidating is what makes FaceTypeCapture.invalidate() reachable at
// all: React Native dispatches bridge teardown on conformsToProtocol:, so a
// module that does not declare this protocol never has invalidate() called
// and leaks its ARSession (and the front camera) across a bridge reload.
#import <React/RCTInvalidating.h>
#import <React/RCTUtils.h>
