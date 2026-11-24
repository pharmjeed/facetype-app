/**
 * Client app microcopy — Arabic only, right-to-left (docs/client-app-v1.md §1).
 *
 * RULES EVERY STRING HERE OBEYS.
 *  - No personality result is described, implied or promised. The profile
 *    says «النتيجة غير متاحة بعد» because no validated model exists
 *    (CLAUDE.md: MODEL_UNAVAILABLE), and nothing else in this file hints at one.
 *  - The only instruction about the face itself is «بدون ابتسامة» (capture
 *    spec v2 §1 row 1; natural-face capture: no expression coaching).
 *  - The notice under «حفظ ومتابعة» is `docs/client-notice-v1-ar.md`
 *    verbatim, version `client-notice-v1` (owner decision 2026-11-24: no
 *    consent checkboxes; continuing after this one line is the agreement).
 *    Editing it here without a new version is a notice the user never saw.
 *  - A distance is never presented as a measurement; guidance only says
 *    «اقترب» or «ابتعد».
 */

export const CONSENT_VERSION = 'client-notice-v1';

export const S = {
  'boot.loading': 'جارٍ التحميل…',
  'config.api_error': 'تعذّر تحديد عنوان الخادم في هذا الإصدار ({code}). لا يمكن المتابعة.',
  'common.retry': 'حاول مرة أخرى',
  'common.cancel': 'إلغاء',
  'common.back': 'رجوع',
  'common.network': 'تعذّر الاتصال بالخادم. تحقّق من الإنترنت ثم حاول مرة أخرى.',
  'common.unexpected': 'حدث خطأ غير متوقع. حاول مرة أخرى. ({code})',
  'common.session_expired': 'انتهت الجلسة. سجّل الدخول مرة أخرى.',

  // 1. Sign-in
  'signin.title': 'مرحبًا بك',
  'signin.subtitle': 'أنشئ حسابك أو ادخل إليه لتصوير وجهك وحفظ بياناتك في ملفك.',
  'signin.apple': 'المتابعة باستخدام Apple',
  'signin.google': 'المتابعة باستخدام Google',
  'signin.mock': 'دخول تجريبي',
  'signin.mock_note': 'دخول تجريبي لإصدار التطوير فقط.',
  'signin.unconfigured': 'غير مُعد بعد',
  'signin.unsupported': 'غير متاح على هذا الجهاز',
  'signin.cancelled': 'أُلغي تسجيل الدخول. يمكنك المحاولة مرة أخرى.',
  'signin.server_unconfigured': 'تسجيل الدخول بهذه الطريقة غير مُعد على الخادم بعد.',
  'signin.failed': 'تعذّر تسجيل الدخول. حاول مرة أخرى.',
  'signin.privacy_note': 'لا يصل التطبيق إلى Face ID ولا إلى بصمة جهازك.',

  // 2. Profile setup
  'setup.title': 'بياناتك',
  'setup.intro': 'تُحفظ بياناتك مشفّرة ومنفصلة عن الصور.',
  'setup.full_name': 'الاسم الكامل',
  'setup.id_country': 'دولة إصدار الوثيقة',
  'setup.id_type': 'نوع الوثيقة',
  'setup.id_number': 'رقم الوثيقة',
  'setup.phone': 'رقم الجوال',
  'setup.phone_hint': 'يُضاف ‎+966 تلقائيًا إن لم تكتب رمز الدولة.',
  'setup.sex': 'الجنس',
  'setup.birth_date': 'تاريخ الميلاد',
  'setup.birth_date_hint': 'بالصيغة سنة-شهر-يوم، مثل 1995-04-23',
  'setup.nationality': 'الجنسية',
  'setup.country_search': 'ابحث باسم الدولة أو رمزها',
  'setup.country_selected': 'المختارة: {name}',
  'setup.unverified_note': 'لم نتحقق من رقم هويتك أو جوالك؛ نستخدم رقم الهوية فقط لمنع تكرار الحساب.',
  'setup.save': 'حفظ ومتابعة',
  'setup.fix_fields': 'راجع الحقول المشار إليها.',
  'setup.id_taken': 'رقم الوثيقة هذا مسجّل في حساب آخر. إن كان رقمك فتواصل مع الدعم: {contact}',
  'setup.support_unconfigured': 'جهة الدعم غير مُعدة بعد في هذا الإصدار',
  'setup.saved_profile_consent_failed': 'حُفظت بياناتك لكن لم تكتمل الخطوة الأخيرة. اضغط «حفظ ومتابعة» مرة أخرى.',

  'doc.national_id': 'هوية وطنية',
  'doc.residence_id': 'إقامة',
  'doc.passport': 'جواز سفر',
  'sex.male': 'ذكر',
  'sex.female': 'أنثى',

  'err.full_name': 'اكتب الاسم بالحروف العربية أو اللاتينية (من 2 إلى 100 حرف)؛ يُسمح بالمسافة و\' و- و.',
  'err.country': 'اختر الدولة من القائمة.',
  'err.id_type': 'اختر نوع الوثيقة.',
  'err.sa_national_id': 'رقم الهوية الوطنية 10 أرقام ويبدأ بالرقم 1.',
  'err.sa_residence_id': 'رقم الإقامة 10 أرقام ويبدأ بالرقم 2.',
  'err.id_checksum': 'رقم الوثيقة غير صحيح؛ تأكّد من كتابته كما هو في الوثيقة.',
  'err.id_generic': 'رقم الوثيقة من 5 إلى 20 خانة من الأرقام أو الحروف الإنجليزية.',
  'err.phone': 'رقم الجوال غير صحيح. إن لم يكن الرقم سعوديًا فاكتب رمز الدولة، مثل ‎+20.',
  'err.sex': 'اختر الجنس.',
  'err.birth_date': 'اكتب تاريخ ميلاد صحيحًا بالصيغة سنة-شهر-يوم.',
  'err.underage': 'التطبيق متاح لمن أعمارهم 18 سنة فأكثر.',
  'err.nationality': 'اختر الجنسية من القائمة.',

  // The notice (docs/client-notice-v1-ar.md, version client-notice-v1) — verbatim.
  'consent.notice': 'بالمتابعة توافق على حفظ صورك وبياناتك واستخدامها في البحث العلمي غير التجاري.',

  // 3. Profile (home)
  'profile.title': 'ملفي',
  'profile.name': 'الاسم: {value}',
  'profile.id': 'الوثيقة: {type} ({country}) {number}',
  'profile.phone': 'الجوال: {value}',
  'profile.sex': 'الجنس: {value}',
  'profile.birth_date': 'تاريخ الميلاد: {value}',
  'profile.age': 'العمر: {value} سنة',
  'profile.nationality': 'الجنسية: {value}',
  'profile.capture_title': 'التصوير',
  'profile.last_capture': 'آخر تصوير: {date}',
  'profile.capture_count': 'عدد مرات التصوير: {count}',
  'profile.repeat_due': 'يمكنك تصوير مرة ثانية بعد {date} (اختياري) لقياس ثبات الصور.',
  'profile.repeat_now': 'يمكنك الآن تصوير مرة ثانية (اختياري) لقياس ثبات الصور.',
  'profile.personality_title': 'نتيجة الشخصية',
  'profile.personality_unavailable': 'النتيجة غير متاحة بعد',
  'profile.personality_note': 'لا يوجد حتى الآن نموذج مثبت علميًا، لذلك لا نعرض أي نتيجة.',
  'profile.capture': 'التصوير',
  'profile.refresh': 'تحديث',

  'status.none': 'لم تصوّر بعد',
  'status.uploading': 'جارٍ الرفع',
  'status.checking': 'جارٍ التحقق',
  // docs/client-app-v1.md §6, verbatim: integrity verified, quality checks still to run.
  'status.received': 'تم استلام الصور، والتحقق من الجودة سيكتمل لاحقًا',
  'status.stored': 'تم حفظ الصور',
  'status.needs_retake': 'تحتاج إلى إعادة التصوير',
  'status.measuring': 'جارٍ التحقق من صورك',
  'status.needs_more': 'نحتاج صورًا إضافية',
  'status.complete': 'اكتملت صورك',
  'status.queued_offline': 'بانتظار الاتصال لرفع الصور',
  'status.unknown': 'غير معروفة',

  // Server verdict reasons (capture spec v2 §4: specific retake reason).
  'reason.glasses': 'ظهرت نظارة في الصور. انزع النظارة وأعد التصوير.',
  'reason.face_covered': 'جزء من الوجه مغطّى. اكشف وجهك كاملًا وأعد التصوير.',
  'reason.too_few_frames': 'لم يكتمل عدد الصور المطلوب. أعد التصوير.',
  'reason.second_face': 'ظهر وجه آخر في الصور. صوّر وحدك وأعد التصوير.',
  'reason.quality': 'جودة الصور غير كافية. اجعل الضوء أمامك وأعد التصوير.',
  'reason.upload_integrity': 'لم تصل الصور إلى الخادم سليمة. أعد التصوير.',
  'reason.generic': 'تحتاج الصور إلى إعادة التصوير.',

  // Server error codes (FT-CLIENT-* and the shared codes a client route returns): one sentence each.
  'apierr.nonce_invalid': 'انتهت صلاحية محاولة الدخول. حاول مرة أخرى.',
  'apierr.account_withdrawing': 'هذا الحساب قيد الحذف.',
  'apierr.id_taken': 'رقم الوثيقة هذا مسجّل في حساب آخر.',
  'apierr.profile_required': 'أكمل بياناتك قبل التصوير.',
  'apierr.consent_required': 'الموافقة على حفظ الصور والبيانات مطلوبة قبل التصوير.',
  'apierr.capture_not_found': 'لم نجد هذا التصوير على الخادم. أعد التصوير.',
  'apierr.capture_conflict': 'تعارضت بيانات هذا التصوير مع تصوير سابق. أعد التصوير.',
  'apierr.capture_state': 'لا يمكن تنفيذ هذه الخطوة على التصوير الآن. حدّث الصفحة.',
  'apierr.frame_immutable': 'هذه الصورة محفوظة من قبل ولا يمكن تغييرها.',
  'apierr.upload_missing': 'لم تصل إحدى الصور إلى الخادم. أعد التصوير.',
  'apierr.upload_mismatch': 'وصلت إحدى الصور تالفة إلى الخادم. أعد التصوير.',
  'apierr.rate_limited': 'طلبات كثيرة في وقت قصير. انتظر قليلًا ثم حاول مرة أخرى.',
  'apierr.server': 'الخادم غير متاح الآن. حاول مرة أخرى لاحقًا.',

  // 4. Capture
  'tips.title': 'قبل التصوير',
  'tips.glasses': 'انزع النظارة',
  'tips.no_smile': 'بدون ابتسامة',
  'tips.light': 'اجعل الضوء أمامك وأبقِ وجهك كاملًا ظاهرًا',
  'tips.auto': 'يلتقط التطبيق الصور تلقائيًا عندما يكون كل شيء جاهزًا.',
  'tips.start': 'ابدأ',

  'guide.camera_starting': 'جارٍ تشغيل الكاميرا',
  'guide.no_face': 'ضع وجهك داخل الإطار',
  'guide.multiple_faces': 'وجه واحد فقط أمام الكاميرا',
  'guide.move_closer': 'اقترب قليلًا',
  'guide.move_back': 'ابتعد قليلًا',
  'guide.centre': 'توسّط داخل الإطار',
  'guide.look_straight': 'انظر إلى الشاشة مباشرة',
  'guide.light': 'اجعل الضوء أمامك',
  'guide.hold_still': 'اثبت…',
  'guide.no_smile': 'بدون ابتسامة',
  'guide.eyes': 'افتح عينيك بشكل طبيعي',

  'burst.progress': 'جارٍ الالتقاط {accepted} من {target}',
  'burst.partial': 'لم يكتمل التصوير. نعيد الالتقاط من البداية.',
  'burst.incomplete': 'لم يكتمل التصوير: {reason}. نعيد الالتقاط من البداية.',
  'burst.effects': 'أوقف تأثيرات الكاميرا',
  'burst.internal': 'تعذّر التقاط بعض الصور، نحاول مرة أخرى',
  'upload.title': 'جارٍ الرفع',
  'upload.progress': 'رُفعت {done} من {total}',
  'upload.offline': 'لا يوجد اتصال. الصور محفوظة على جهازك مشفّرة وتُرفع عند عودة الاتصال.',
  'upload.lost':
    'أُغلق التطبيق قبل اكتمال الرفع فلم تُحفظ هذه الصور. أعد التصوير من فضلك.',
  'upload.rejected': 'رفض الخادم هذه الصور. ({code})',
  'check.title': 'جارٍ التحقق',
  'check.slow': 'سيظهر الناتج في صفحة ملفك عند اكتماله.',
  'received.body': 'تم استلام الصور، والتحقق من الجودة سيكتمل لاحقًا',
  'done.title': 'تم',
  'done.body': 'حُفظت صورك.',
  'retake.title': 'تحتاج إلى إعادة التصوير',
  'retake.again': 'أعد التصوير',
  // ADR-016: the server measures the photos and decides.
  'check.measuring': 'جارٍ التحقق من صورك على الخادم، وقد يستغرق ذلك دقيقة أو دقيقتين.',
  'more.title': 'نحتاج صورًا إضافية',
  'more.continue': 'تابع التصوير',
  'more.remove_glasses': 'ظهرت نظارة في بعض الصور. انزع النظارة وتابع.',
  'more.face_camera': 'انظر إلى الكاميرا مباشرة وتابع.',
  'more.neutral_face': 'حافظ على ملامح هادئة بلا ابتسامة وتابع.',
  'more.open_eyes': 'أبقِ عينيك مفتوحتين وتابع.',
  'more.hold_still': 'ثبّت الجوال وتجنّب الحركة وتابع.',
  'more.one_face': 'يجب أن يظهر وجهك وحدك في الصور.',
  'more.same_person': 'يجب أن يصوّر صاحب الحساب نفسه.',
  'more.more_photos': 'نحتاج بضع صور أخرى ليكتمل القياس.',
  'complete.title': 'اكتملت صورك',
  'complete.body': 'وصلت صورك واكتمل فحصها. شكرًا لك.',
  'capture.back_profile': 'العودة إلى ملفي',

  'camera.permission_denied': 'لا يمكن التصوير دون إذن استخدام الكاميرا.',
  'camera.open_settings': 'فتح الإعدادات',
  'camera.interrupted': 'توقّفت الكاميرا مؤقتًا.',
  'camera.resume': 'متابعة',
  'camera.unavailable': 'الكاميرا الأمامية غير متاحة على هذا الجهاز.',
  'camera.model_unavailable': 'تعذّر تشغيل فحص الوجه على هذا الجهاز.',
  'camera.effects_active': 'أوقف تأثيرات الكاميرا (البورتريه أو إضاءة الاستوديو) ثم حاول مرة أخرى.',
  'camera.internal': 'حدث خطأ غير متوقع في الكاميرا.',
  'camera.simulator': 'وضع المحاكاة: لا تُستخدم كاميرا حقيقية ولا وجه حقيقي.',

  'help.title': 'تحتاج مساعدة؟',
  'help.eye_level': 'ضع الجوال أمام وجهك على مستوى عينيك.',
  'help.light': 'قف مقابل مصدر الضوء، لا تجعله خلفك.',
  'help.alone': 'تأكّد أن وجهك وحده داخل الإطار ومكشوف بالكامل.',
  'help.again': 'المحاولة مرة أخرى',
} as const;

export type StringKey = keyof typeof S;

/** The Arabic string for `key`, with `{token}` placeholders filled in. */
export function s(key: StringKey, vars: Record<string, string | number> = {}): string {
  return S[key].replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

/** Every user-facing string renders right-to-left. */
export const DIRECTION = 'rtl' as const;
