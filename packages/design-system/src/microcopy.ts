/**
 * Canonical microcopy — FT-07 §8, FT-10 §4.
 *
 * Arabic is the primary language (RTL first-class); English mirrors it exactly.
 * Both apps read from here so a wording decision is made once.
 *
 * Two rules govern every string in this file (FT-02 §7, FT-07 §6):
 *
 *  - geometric similarity, never causation. "قريب من أنماط هندسية", not
 *    "وجهك يسبب شخصيتك".
 *  - no result state may imply a type it does not have. `MODEL_UNAVAILABLE` says
 *    the model is not approved; it does not hint at what the answer might be.
 */

export type Locale = 'ar' | 'en';

export const strings = {
  ar: {
    'app.name': 'FaceType AI',
    'app.tagline': 'تحليل تجريبي من مسح الوجه — بدون أسئلة أو استبيانات',

    'scan.start': 'ابدأ مسح الوجه',
    'scan.front': 'انظر مباشرة إلى الكاميرا',
    'scan.neutral': 'أرخِ ملامح وجهك للحظة',
    'scan.left': 'حرّك رأسك قليلًا إلى اليسار',
    'scan.right': 'حرّك رأسك قليلًا إلى اليمين',
    'scan.up': 'ارفع ذقنك قليلًا',
    'scan.down': 'اخفض ذقنك قليلًا',
    'scan.light': 'نحتاج إضاءة أوضح',
    'scan.blur': 'اثبت للحظة',
    'scan.occlusion': 'أزل ما يغطي وجهك',
    'scan.one_face': 'يجب أن يظهر وجه واحد فقط',
    // FT-SCAN-014: the frame could not be assessed at all. It must not fall
    // back to the neutral pose line, which reads as "everything is fine,
    // carry on" while nothing was captured.
    'scan.unmeasurable': 'تعذّر قياس هذه اللقطة — اقترب من الكاميرا وواجهها بإضاءة متساوية ثم أعد المحاولة',
    // FT-SCAN-011: the head was measured, and it was not at the angle this
    // step asked for. The angle itself is the line above; this says what to
    // do about it, and must not fall back to the neutral pose line either.
    'scan.pose_off': 'الزاوية ليست كما طلبنا — اتبع التعليمة أعلاه وحافظ على وضعك حتى نلتقط اللقطة',
    // Any other coded failure. Never the neutral pose line, which is what the
    // screen says when nothing has gone wrong.
    'scan.retry_pose': 'لم تنجح هذه اللقطة — أعد المحاولة لهذه الخطوة',
    'scan.step': 'الخطوة {current}/{total}',

    'consent.title': 'الخصوصية قبل المسح',
    'consent.geometry': 'نستخدم هندسة الوجه للتحليل، لا الصور',
    'consent.raw_frames': 'الصور الخام تُحذف بعد المعالجة افتراضيًا',
    'consent.no_questions': 'لا نسألك أي سؤال عن شخصيتك',
    'consent.agree': 'أفهم وأوافق',
    'consent.research_opt_in': 'مشاركة اختيارية للبحث',
    'consent.analytics_opt_in': 'السماح بقياسات استخدام مجهولة لتحسين مسار التطبيق',
    'consent.continue': 'متابعة',

    // Reduced quality control (ADR-011). The obstruction step is a REQUEST the
    // user confirms, never evidence: this device cannot measure what is
    // covering a face, so the app asks, records that it asked, and says so.
    'obstruction.title': 'قبل أن نبدأ',
    'obstruction.body':
      'هذا الجهاز لا يستطيع قياس ما يغطي الوجه. أزل النظارة والقبعة والكمامة، وأبعد الشعر عن الجبهة والحاجبين.',
    'obstruction.confirm': 'وجهي مكشوف بالكامل',
    'obstruction.note': 'نسجّل تأكيدك كإقرار منك، لا كقياس أجراه الجهاز.',

    'quality.reduced.title': 'جودة تحكّم مخفّضة',
    'quality.reduced.body':
      'حُلّلت هندسة وجهك بجودة تحكّم مخفّضة: لم يُقَس الانسداد على هذا الجهاز.',
    'quality.reduced.no_claim': 'لا يتضمن هذا المسح أي استنتاج عن الشخصية.',
    'quality.reduced.badge': 'مخفّضة',

    'processing.title': 'جاري بناء بصمة الوجه',
    'processing.quality': 'جودة المسح',
    'processing.geometry': 'النموذج ثلاثي الأبعاد',
    'processing.genome': 'القياسات الهندسية',
    'processing.atlas': 'المقارنة مع الأطلس',
    'processing.leave': 'يمكنك مغادرة الشاشة',

    'result.top_type': 'النمط الأعلى',
    'result.confidence': 'ثقة معايرة',
    'result.alternatives': 'بدائل',
    'result.details': 'التفاصيل',
    'result.rescan': 'أعد المسح',
    'result.abstain': 'النتيجة غير حاسمة بما يكفي لعرض نمط واحد',
    'result.abstain.body': 'المسح صالح، لكن الثقة ليست كافية لعرض نمط واحد دون مبالغة.',
    'result.model_unavailable': 'تم تحليل بنية الوجه، لكن نموذج الشخصية لم يُعتمد للإصدار بعد',
    'result.model_unavailable.body': 'لن نعرض نتيجة تقديرية غير موثقة.',
    'result.retake.title': 'نحتاج زاوية واحدة إضافية',
    'result.retake.body': 'لم تكن زاوية {pose} واضحة بما يكفي. أعد هذه الخطوة فقط.',
    'result.failed': 'تعذّر إكمال المعالجة',
    'result.method_note': 'طريقة تجريبية قيد التحقق: تعتمد على هندسة الوجه فقط.',
    'result.non_causal': 'يقع شكل وجهك قريبًا من أنماط هندسية معينة. هذا تشابه تشريحي وليس سببًا.',
    'result.research_watermark': 'نتيجة بحثية غير معتمدة',

    'privacy.delete': 'حذف المسح وبياناته',
    'privacy.delete_confirm': 'سيتم حذف الصور والقياسات والنتيجة نهائيًا.',
    'privacy.deleted': 'تم حذف بيانات المسح',

    'pose.front': 'المواجهة',
    'pose.left_25': 'اليسار',
    'pose.right_25': 'اليمين',
    'pose.up_15': 'الأعلى',
    'pose.down_15': 'الأسفل',

    'confidence.low': 'منخفضة',
    'confidence.medium': 'متوسطة',
    'confidence.high': 'مرتفعة',

    'common.retry': 'إعادة المحاولة',
    'common.cancel': 'إلغاء',
    'common.later': 'لاحقًا',
  },

  en: {
    'app.name': 'FaceType AI',
    'app.tagline': 'Experimental analysis from a face scan — no questions, no questionnaires',

    'scan.start': 'Start face scan',
    'scan.front': 'Look straight at the camera',
    'scan.neutral': 'Relax your face for a moment',
    'scan.left': 'Turn your head slightly left',
    'scan.right': 'Turn your head slightly right',
    'scan.up': 'Raise your chin slightly',
    'scan.down': 'Lower your chin slightly',
    'scan.light': 'We need brighter light',
    'scan.blur': 'Hold still for a moment',
    'scan.occlusion': 'Remove anything covering your face',
    'scan.one_face': 'Only one face should be visible',
    'scan.unmeasurable':
      'We could not measure that frame — move closer, face the camera in even light, and try again',
    'scan.pose_off':
      'Not quite the angle we asked for — follow the instruction above and hold it steady',
    'scan.retry_pose': 'That capture did not work — try this step again',
    'scan.step': 'Step {current}/{total}',

    'consent.title': 'Privacy before you scan',
    'consent.geometry': 'We analyse face geometry, not photographs',
    'consent.raw_frames': 'Raw frames are deleted after processing by default',
    'consent.no_questions': 'We never ask you anything about your personality',
    'consent.agree': 'I understand and agree',
    'consent.research_opt_in': 'Optional: share for research',
    'consent.analytics_opt_in': 'Allow anonymous usage metrics to improve the app flow',
    'consent.continue': 'Continue',

    'obstruction.title': 'Before we start',
    'obstruction.body':
      'This device cannot measure what is covering a face. Please remove glasses, hats and masks, and move hair off your forehead and eyebrows.',
    'obstruction.confirm': 'My face is fully uncovered',
    'obstruction.note': 'We record your confirmation as your statement, not as a measurement the device made.',

    'quality.reduced.title': 'Reduced quality control',
    'quality.reduced.body':
      'Your face geometry was analysed with reduced quality control: occlusion was not assessed on this device.',
    'quality.reduced.no_claim': 'This scan carries no personality claim.',
    'quality.reduced.badge': 'Reduced',

    'processing.title': 'Building your face signature',
    'processing.quality': 'Scan quality',
    'processing.geometry': '3-D model',
    'processing.genome': 'Geometric measurements',
    'processing.atlas': 'Atlas comparison',
    'processing.leave': 'You can leave this screen',

    'result.top_type': 'Top type',
    'result.confidence': 'Calibrated confidence',
    'result.alternatives': 'Alternatives',
    'result.details': 'Details',
    'result.rescan': 'Scan again',
    'result.abstain': 'The result is not conclusive enough to show a single type',
    'result.abstain.body':
      'The scan is valid, but confidence is not high enough to name one type without overstating it.',
    'result.model_unavailable':
      'Your face structure was analysed, but the personality model is not approved for release yet',
    'result.model_unavailable.body': 'We will not show an undocumented estimate.',
    'result.retake.title': 'One more angle needed',
    'result.retake.body': 'The {pose} angle was not clear enough. Please repeat only that step.',
    'result.failed': 'Processing could not be completed',
    'result.method_note': 'Experimental method under validation: face geometry only.',
    'result.non_causal':
      'Your face shape sits close to certain geometric patterns. This is anatomical similarity, not a cause.',
    'result.research_watermark': 'Research output — not approved',

    'privacy.delete': 'Delete this scan and its data',
    'privacy.delete_confirm': 'Frames, measurements and the result will be permanently deleted.',
    'privacy.deleted': 'Scan data deleted',

    'pose.front': 'Front',
    'pose.left_25': 'Left',
    'pose.right_25': 'Right',
    'pose.up_15': 'Up',
    'pose.down_15': 'Down',

    'confidence.low': 'low',
    'confidence.medium': 'medium',
    'confidence.high': 'high',

    'common.retry': 'Try again',
    'common.cancel': 'Cancel',
    'common.later': 'Later',
  },
} as const;

export type StringKey = keyof (typeof strings)['ar'];

/** Translate a key, interpolating `{placeholders}`. */
export function t(
  locale: Locale | string,
  key: StringKey,
  params: Record<string, string | number> = {},
): string {
  const language: Locale = String(locale).toLowerCase().startsWith('ar') ? 'ar' : 'en';
  const template: string = strings[language][key] ?? strings.en[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

/** Text direction for a locale (FT-07 §7: RTL is first-class, not a retrofit). */
export function direction(locale: Locale | string): 'rtl' | 'ltr' {
  return String(locale).toLowerCase().startsWith('ar') ? 'rtl' : 'ltr';
}
