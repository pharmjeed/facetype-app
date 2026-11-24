import type { PoseLabel } from './types.ts';

// Presentation only: protocol labels, angles and quality thresholds stay in
// their existing shared contracts. Moving the head is not making an expression.
const copy = {
  ar: {
    automaticStart: 'ابدأ الالتقاط التلقائي',
    automaticStop: 'أوقف الالتقاط التلقائي',
    automaticWaiting: 'اتبع وضعية الرأس المعروضة. يجري فحص الجودة؛ لا تحتاج للضغط لكل وضعية.',
    adjust: 'اضبط الوضعية والإضاءة؛ سيستمر الفحص تلقائيًا.',
    referencePhoto: 'الصورة مرجعية تُلتقط بعد القياس؛ درجات الجودة تخص إطار القياس، لا هذه الصورة.',
    cancelled: 'توقّف الالتقاط. أعد هذه الوضعية للمتابعة؛ الإلغاء لا يحذف ما رُفع سابقًا.',
    neutral: 'أرخِ وجهك وفكك، وأغلق شفتيك برفق. افتح عينيك طبيعيًا، دون ابتسام أو رفع الحاجبين.',
    preparation: 'اجعل الإضاءة أمامك، وأبعد ما يغطي الوجه. ثبّت الجهاز أثناء الالتقاط.',
    poses: {
      front: { label: 'أمام الكاميرا', instruction: 'وجّه رأسك إلى الكاميرا مباشرة.' },
      left_25: { label: 'يسار', instruction: 'أدر رأسك قليلًا إلى يسارك، مع إبقاء الوجه مرتاحًا.' },
      right_25: { label: 'يمين', instruction: 'أدر رأسك قليلًا إلى يمينك، مع إبقاء الوجه مرتاحًا.' },
      up_15: { label: 'أعلى قليلًا', instruction: 'ارفع ذقنك قليلًا بتحريك رأسك، لا حاجبيك.' },
      down_15: { label: 'أسفل قليلًا', instruction: 'اخفض ذقنك قليلًا بتحريك رأسك، دون شدّ الفك.' },
    },
  },
  en: {
    automaticStart: 'Start automatic capture',
    automaticStop: 'Stop automatic capture',
    automaticWaiting: 'Follow the displayed head position. Checking quality; no tap is needed for each pose.',
    adjust: 'Adjust your position and lighting; checking continues automatically.',
    referencePhoto: 'The reference photo is taken after measurement; quality scores describe the measured frame, not this photo.',
    cancelled: 'Capture stopped. Retry this pose to continue; cancellation does not delete earlier uploads.',
    neutral: 'Relax your face and jaw, with lips gently closed. Keep your eyes naturally open; do not smile or raise your eyebrows.',
    preparation: 'Face the light and keep your face uncovered. Hold the device steady during capture.',
    poses: {
      front: { label: 'Front', instruction: 'Face the camera directly.' },
      left_25: { label: 'Left', instruction: 'Turn your head slightly to your left, keeping your face relaxed.' },
      right_25: { label: 'Right', instruction: 'Turn your head slightly to your right, keeping your face relaxed.' },
      up_15: { label: 'Slightly up', instruction: 'Lift your chin slightly by moving your head, not your eyebrows.' },
      down_15: { label: 'Slightly down', instruction: 'Lower your chin slightly by moving your head, without clenching your jaw.' },
    },
  },
} as const;

export function neutralCaptureGuidance(locale: string, pose: PoseLabel) {
  const language = /^ar(?:[-_]|$)/i.test(locale) ? copy.ar : copy.en;
  return {
    ...language.poses[pose], neutral: language.neutral,
    preparation: language.preparation, cancelled: language.cancelled,
    automaticStart: language.automaticStart, automaticStop: language.automaticStop,
    automaticWaiting: language.automaticWaiting, adjust: language.adjust,
    referencePhoto: language.referencePhoto,
  };
}

/** Feedback is based on a real native measurement, never a fabricated score. */
export function automaticCaptureHint(locale: string, code: string | null): string {
  const ar = /^ar(?:[-_]|$)/i.test(locale);
  const hints: Record<string, [string, string]> = {
    'FIELD_COLLECTION_POSE_TIMEOUT': ['توقف الالتقاط بعد انتظار الوضعية. اضبط الوجه والإضاءة ثم استأنف.', 'Capture paused while waiting for the pose. Adjust your face and lighting, then resume.'],
    'FT-SCAN-004': ['يجب أن يظهر وجه واحد فقط.', 'Keep only one face in view.'],
    'FT-SCAN-005': ['ضع وجهك داخل إطار الكاميرا.', 'Place your face inside the camera frame.'],
    'FT-SCAN-006': ['اثبت قليلًا وثبّت الجهاز.', 'Hold your head and device steady.'],
    'FT-SCAN-007': ['زد الإضاءة أمام وجهك.', 'Add light in front of your face.'],
    'FT-SCAN-008': ['ابتعد عن الضوء الشديد.', 'Move away from harsh light.'],
    'FT-SCAN-009': ['أبعد ما يغطي وجهك.', 'Keep your face uncovered.'],
    'FT-SCAN-010': ['أرخِ وجهك دون ابتسام أو رفع الحاجبين.', 'Relax your face without smiling or raising your eyebrows.'],
    'FT-SCAN-011': ['حرّك رأسك قليلًا باتجاه الوضعية المطلوبة.', 'Adjust your head toward the requested pose.'],
    'FT-SCAN-014': ['قرّب وجهك قليلًا وحسّن الإضاءة.', 'Move a little closer and improve the light.'],
  };
  const hint = code ? hints[code] : undefined;
  return hint ? hint[ar ? 0 : 1] : ar ? 'اثبت للحظة؛ الالتقاط تلقائي.' : 'Hold still; capture is automatic.';
}
