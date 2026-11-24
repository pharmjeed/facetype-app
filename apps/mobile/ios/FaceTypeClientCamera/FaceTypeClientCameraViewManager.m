//
//  FaceTypeClientCameraViewManager.m
//  Objective-C bridge registration for the Swift view manager: the
//  `FaceTypeClientCameraView` component's props and direct events
//  (docs/client-native-interface.md §2).
//

#import <React/RCTViewManager.h>

@interface RCT_EXTERN_MODULE (FaceTypeClientCameraViewManager, RCTViewManager)

RCT_EXPORT_VIEW_PROPERTY(active, BOOL)
RCT_EXPORT_VIEW_PROPERTY(gateConfig, NSString)
RCT_EXPORT_VIEW_PROPERTY(onFrameMeasure, RCTDirectEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onBurstProgress, RCTDirectEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onError, RCTDirectEventBlock)

@end
