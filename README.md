# FaceType — client app (iOS / Android)

This repository holds only the mobile client of FaceType, an academic, non-commercial research project. It exists
so the iPhone app can be built on GitHub's macOS runners. All rights reserved: see `LICENSE`. No licence to use,
copy, modify or distribute is granted.

هذا المستودع فيه تطبيق الجوال فقط من مشروع FaceType، وهو مشروع بحث أكاديمي غير تجاري. وُجد ليُبنى تطبيق الآيفون على
أجهزة GitHub. جميع الحقوق محفوظة، ولا يُمنح أي ترخيص للاستخدام أو النسخ أو التعديل أو التوزيع.

- `apps/mobile`: the React Native app (Android: CameraX + MediaPipe; iOS: AVFoundation + MediaPipe).
- `packages/contracts`, `packages/design-system`: shared TypeScript used by the app.
- `.github/workflows/ios.yml`: simulator build, no credentials.
- `.github/workflows/testflight.yml`: signed build uploaded to TestFlight (manual; needs the repository secret
  `ASC_KEY_P8` and the variables `APPLE_TEAM_ID`, `ASC_KEY_ID`, `ASC_ISSUER_ID`).

The app never decides anything consequential about a person (no hiring, credit, insurance, medical or legal use).
