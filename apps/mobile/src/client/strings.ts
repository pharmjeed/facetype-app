/**
 * Client app microcopy — Arabic (default, right to left) and English (owner 2026-11-25), docs/client-app-v1.md §1.
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

import { lang } from './i18n.ts';

export const CONSENT_VERSION = 'client-notice-v1';
export const CONSENT_VERSION_EN = 'client-notice-v1-en';

export const S = {
  'boot.loading': 'جارٍ التحميل…',
  'config.api_error': 'تعذّر تحديد عنوان الخادم في هذا الإصدار ({code}). لا يمكن المتابعة.',
  'common.retry': 'حاول مرة أخرى',
  'common.cancel': 'إلغاء',
  'common.back': 'رجوع',
  'common.network': 'تعذّر الاتصال بالخادم. تحقّق من الإنترنت ثم حاول مرة أخرى.',
  'common.unexpected': 'حدث خطأ غير متوقع. حاول مرة أخرى. ({code})',
  'common.session_expired': 'انتهت الجلسة. سجّل الدخول مرة أخرى.',

  // The language switch shows the other language's name, in that language.
  'lang.switch': 'English',

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
  'picker.done': 'تم',
  'picker.choose_date': 'اختر اليوم والشهر والسنة',
  'picker.choose_country': 'اختر الدولة',
  'picker.no_country': 'لا توجد دولة بهذا الاسم أو الرمز.',
  'picker.day': 'اليوم',
  'picker.month': 'الشهر',
  'picker.year': 'السنة',
  'setup.nationality': 'الجنسية',
  'setup.country_search': 'ابحث باسم الدولة أو رمزها',
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
  'err.birth_date': 'اختر تاريخ ميلاد صحيحًا.',
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

/** The string for `key` in the current interface language, with `{token}` placeholders filled in. */
export function s(key: StringKey, vars: Record<string, string | number> = {}): string {
  const table = lang() === 'en' ? EN : S;
  return table[key].replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

/** The notice version recorded with the agreement: the Arabic and English lines are separate texts. */
export function consentVersion(): string {
  return lang() === 'en' ? CONSENT_VERSION_EN : CONSENT_VERSION;
}

/**
 * English (owner 2026-11-25: the interface can be switched between Arabic and English). Same rules as the
 * Arabic table; the English notice is `docs/client-notice-v1-ar.md` §English, version `client-notice-v1-en`.
 */
export const EN: { readonly [K in StringKey]: string } = {
  'boot.loading': 'Loading…',
  'config.api_error': 'The server address is not set in this version ({code}). The app cannot continue.',
  'common.retry': 'Try again',
  'common.cancel': 'Cancel',
  'common.back': 'Back',
  'common.network': 'Could not reach the server. Check your internet connection and try again.',
  'common.unexpected': 'Something unexpected went wrong. Please try again. ({code})',
  'common.session_expired': 'Your session has ended. Please sign in again.',

  'lang.switch': 'العربية',

  'signin.title': 'Welcome',
  'signin.subtitle': 'Create your account or sign in to photograph your face and keep your details in your profile.',
  'signin.apple': 'Continue with Apple',
  'signin.google': 'Continue with Google',
  'signin.mock': 'Test sign-in',
  'signin.mock_note': 'Test sign-in for the development version only.',
  'signin.unconfigured': 'Not set up yet',
  'signin.unsupported': 'Not available on this device',
  'signin.cancelled': 'Sign-in was cancelled. You can try again.',
  'signin.server_unconfigured': 'This sign-in method is not set up on the server yet.',
  'signin.failed': 'Could not sign in. Please try again.',
  'signin.privacy_note': 'The app does not access Face ID or your device fingerprint.',

  'setup.title': 'Your details',
  'setup.intro': 'Your details are stored encrypted and separately from your photos.',
  'setup.full_name': 'Full name',
  'setup.id_country': 'Document issuing country',
  'setup.id_type': 'Document type',
  'setup.id_number': 'Document number',
  'setup.phone': 'Mobile number',
  'setup.phone_hint': '+966 is added automatically if you do not type a country code.',
  'setup.sex': 'Sex',
  'setup.birth_date': 'Date of birth',
  'picker.done': 'Done',
  'picker.choose_date': 'Choose day, month and year',
  'picker.choose_country': 'Choose a country',
  'picker.no_country': 'No country has this name or code.',
  'picker.day': 'Day',
  'picker.month': 'Month',
  'picker.year': 'Year',
  'setup.nationality': 'Nationality',
  'setup.country_search': 'Search by country name or code',
  'setup.unverified_note':
    'We have not verified your ID or mobile number; the ID number is used only to prevent duplicate accounts.',
  'setup.save': 'Save and continue',
  'setup.fix_fields': 'Please check the highlighted fields.',
  'setup.id_taken': 'This document number is registered to another account. If it is yours, contact support: {contact}',
  'setup.support_unconfigured': 'Support contact is not set up in this version yet',
  'setup.saved_profile_consent_failed':
    'Your details were saved but the last step did not finish. Press “Save and continue” again.',

  'doc.national_id': 'National ID',
  'doc.residence_id': 'Residence permit',
  'doc.passport': 'Passport',
  'sex.male': 'Male',
  'sex.female': 'Female',

  'err.full_name': 'Write the name in Arabic or Latin letters (2 to 100 characters); spaces, apostrophes, hyphens and dots are allowed.',
  'err.country': 'Choose the country from the list.',
  'err.id_type': 'Choose the document type.',
  'err.sa_national_id': 'A national ID number has 10 digits and starts with 1.',
  'err.sa_residence_id': 'A residence permit number has 10 digits and starts with 2.',
  'err.id_checksum': 'The document number is not valid; type it exactly as it appears on the document.',
  'err.id_generic': 'The document number has 5 to 20 digits or English letters.',
  'err.phone': 'The mobile number is not valid. If it is not a Saudi number, type the country code, e.g. +20.',
  'err.sex': 'Choose the sex.',
  'err.birth_date': 'Choose a valid date of birth.',
  'err.underage': 'The app is for people aged 18 or over.',
  'err.nationality': 'Choose the nationality from the list.',

  'consent.notice':
    'By continuing you agree that your photos and details are stored and used for non-commercial scientific research.',

  'profile.title': 'My profile',
  'profile.name': 'Name: {value}',
  'profile.id': 'Document: {type} ({country}) {number}',
  'profile.phone': 'Mobile: {value}',
  'profile.sex': 'Sex: {value}',
  'profile.birth_date': 'Date of birth: {value}',
  'profile.age': 'Age: {value} years',
  'profile.nationality': 'Nationality: {value}',
  'profile.capture_title': 'Photos',
  'profile.last_capture': 'Last photos: {date}',
  'profile.capture_count': 'Number of sessions: {count}',
  'profile.repeat_due': 'You can take photos a second time after {date} (optional) to measure how stable they are.',
  'profile.repeat_now': 'You can now take photos a second time (optional) to measure how stable they are.',
  'profile.personality_title': 'Personality result',
  'profile.personality_unavailable': 'The result is not available yet',
  'profile.personality_note': 'There is no scientifically validated model yet, so no result is shown.',
  'profile.capture': 'Take photos',
  'profile.refresh': 'Refresh',

  'status.none': 'No photos yet',
  'status.uploading': 'Uploading',
  'status.checking': 'Checking',
  'status.received': 'Photos received; the quality check will finish later',
  'status.stored': 'Photos saved',
  'status.needs_retake': 'Photos need to be retaken',
  'status.measuring': 'Checking your photos',
  'status.needs_more': 'We need more photos',
  'status.complete': 'Your photos are complete',
  'status.queued_offline': 'Waiting for a connection to upload the photos',
  'status.unknown': 'Unknown',

  'reason.glasses': 'Glasses appeared in the photos. Take them off and retake the photos.',
  'reason.face_covered': 'Part of the face is covered. Uncover your whole face and retake the photos.',
  'reason.too_few_frames': 'Not enough photos were taken. Please retake them.',
  'reason.second_face': 'Another face appeared in the photos. Take them alone and retake.',
  'reason.quality': 'The photo quality is not good enough. Face the light and retake the photos.',
  'reason.upload_integrity': 'The photos did not reach the server intact. Please retake them.',
  'reason.generic': 'The photos need to be retaken.',

  'apierr.nonce_invalid': 'The sign-in attempt has expired. Please try again.',
  'apierr.account_withdrawing': 'This account is being deleted.',
  'apierr.id_taken': 'This document number is registered to another account.',
  'apierr.profile_required': 'Complete your details before taking photos.',
  'apierr.consent_required': 'Agreement to store photos and details is needed before taking photos.',
  'apierr.capture_not_found': 'This photo session was not found on the server. Please retake the photos.',
  'apierr.capture_conflict': 'This photo session conflicts with an earlier one. Please retake the photos.',
  'apierr.capture_state': 'This step cannot be done on the photo session now. Refresh the page.',
  'apierr.frame_immutable': 'This photo was already saved and cannot be changed.',
  'apierr.upload_missing': 'One of the photos did not reach the server. Please retake the photos.',
  'apierr.upload_mismatch': 'One of the photos reached the server damaged. Please retake the photos.',
  'apierr.rate_limited': 'Too many requests in a short time. Wait a moment and try again.',
  'apierr.server': 'The server is not available now. Please try again later.',

  'tips.title': 'Before you start',
  'tips.glasses': 'Take off your glasses',
  'tips.no_smile': 'No smile',
  'tips.light': 'Face the light and keep your whole face visible',
  'tips.auto': 'The app takes the photos automatically when everything is ready.',
  'tips.start': 'Start',

  'guide.camera_starting': 'Starting the camera',
  'guide.no_face': 'Place your face inside the frame',
  'guide.multiple_faces': 'Only one face in front of the camera',
  'guide.move_closer': 'Move a little closer',
  'guide.move_back': 'Move a little back',
  'guide.centre': 'Centre yourself in the frame',
  'guide.look_straight': 'Look straight at the screen',
  'guide.light': 'Face the light',
  'guide.hold_still': 'Hold still…',
  'guide.no_smile': 'No smile',
  'guide.eyes': 'Open your eyes naturally',

  'burst.progress': 'Taking photos {accepted} of {target}',
  'burst.partial': 'The photos were not completed. Starting again from the beginning.',
  'burst.incomplete': 'The photos were not completed: {reason}. Starting again from the beginning.',
  'burst.effects': 'Turn off camera effects',
  'burst.internal': 'Some photos could not be taken; trying again',
  'upload.title': 'Uploading',
  'upload.progress': '{done} of {total} uploaded',
  'upload.offline':
    'No connection. The photos are kept encrypted on your device and upload when the connection returns.',
  'upload.lost': 'The app closed before the upload finished, so these photos were not saved. Please retake them.',
  'upload.rejected': 'The server refused these photos. ({code})',
  'check.title': 'Checking',
  'check.slow': 'The outcome will appear on your profile page when it is ready.',
  'received.body': 'Photos received; the quality check will finish later',
  'done.title': 'Done',
  'done.body': 'Your photos were saved.',
  'retake.title': 'Photos need to be retaken',
  'retake.again': 'Retake photos',
  'check.measuring': 'Your photos are being checked on the server; this can take a minute or two.',
  'more.title': 'We need more photos',
  'more.continue': 'Continue taking photos',
  'more.remove_glasses': 'Glasses appeared in some photos. Take them off and continue.',
  'more.face_camera': 'Look straight at the camera and continue.',
  'more.neutral_face': 'Keep a relaxed face without a smile and continue.',
  'more.open_eyes': 'Keep your eyes open and continue.',
  'more.hold_still': 'Hold the phone steady, avoid moving, and continue.',
  'more.one_face': 'Only your face must appear in the photos.',
  'more.same_person': 'The account holder must take the photos themselves.',
  'more.more_photos': 'We need a few more photos to complete the measurement.',
  'complete.title': 'Your photos are complete',
  'complete.body': 'Your photos arrived and their check is complete. Thank you.',
  'capture.back_profile': 'Back to my profile',

  'camera.permission_denied': 'Photos cannot be taken without camera permission.',
  'camera.open_settings': 'Open Settings',
  'camera.interrupted': 'The camera paused.',
  'camera.resume': 'Continue',
  'camera.unavailable': 'The front camera is not available on this device.',
  'camera.model_unavailable': 'The face check cannot run on this device.',
  'camera.effects_active': 'Turn off camera effects (Portrait or Studio Light), then try again.',
  'camera.internal': 'An unexpected camera error occurred.',
  'camera.simulator': 'Simulation mode: no real camera and no real face are used.',

  'help.title': 'Need help?',
  'help.eye_level': 'Hold the phone in front of your face at eye level.',
  'help.light': 'Stand facing the light source, not with it behind you.',
  'help.alone': 'Make sure only your face is in the frame and fully uncovered.',
  'help.again': 'Try again',
};

