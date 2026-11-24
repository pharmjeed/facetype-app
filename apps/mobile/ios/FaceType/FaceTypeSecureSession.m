#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE (FaceTypeSecureSession, NSObject)

RCT_EXTERN_METHOD(saveSession : (NSString *)value
                  resolver : (RCTPromiseResolveBlock)resolve
                  rejecter : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(loadSession : (RCTPromiseResolveBlock)resolve
                  rejecter : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(clearSession : (RCTPromiseResolveBlock)resolve
                  rejecter : (RCTPromiseRejectBlock)reject)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

@end
