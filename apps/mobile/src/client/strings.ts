/**
 * Client app microcopy — Arabic only, right-to-left (docs/client-app-v1.md §1).
 *
 * RULES EVERY STRING HERE OBEYS.
 *  - No personality result is described, implied or promised. The profile
 *    says «النتيجة غير متاحة بعد» because no validated model exists
 *    (CLAUDE.md: MODEL_UNAVAILABLE), and nothing else in this file hints at one.
 *  - The only instruction about the face itself is «بدون ابتسامة» (capture
 *    spec v2 §1 row 1; natural-face capture: no expression coaching).
 *  - The consent wording is `docs/client-consent-v1-ar.md` verbatim, version
 *    `client-consent-v1`; editing it here without a new version is a consent
 *    the user never saw.
 *  - A distance is never presented as a measurement; guidance only says
 *    «اقترب» or «ابتعد».
 */

export const CONSENT_VERSION = 'client-consent-v1';

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
  'signin.deleted': 'استلمنا طلب حذف حسابك: توقفت كل معالجة، وتُحذف الصور والبيانات خلال 30 يومًا.',

  // 2. Profile setup
  'setup.title': 'بياناتك',
  'setup.edit_title': 'تعديل البيانات',
  'setup.intro': 'تُحفظ بياناتك مشفّرة ومنفصلة عن الصور، ولا تظهر كاملة في التطبيق.',
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
  'setup.reenter_hint':
    'لحماية بياناتك لا نعرض الاسم ورقم الوثيقة والجوال وتاريخ الميلاد كاملة؛ أعد إدخالها لحفظ التعديل.',
  'setup.unverified_note': 'لم نتحقق من رقم هويتك أو جوالك؛ نستخدم رقم الهوية فقط لمنع تكرار الحساب.',
  'setup.save': 'حفظ ومتابعة',
  'setup.save_edit': 'حفظ التعديل',
  'setup.fix_fields': 'راجع الحقول المشار إليها.',
  'setup.consent_required': 'الموافقة المطلوبة شرط للمتابعة.',
  'setup.id_taken': 'رقم الوثيقة هذا مسجّل في حساب آخر. إن كان رقمك فتواصل مع الدعم: {contact}',
  'setup.support_unconfigured': 'جهة الدعم غير مُعدة بعد في هذا الإصدار',
  'setup.saved_profile_consent_failed':
    'حُفظت بياناتك لكن لم تُسجَّل الموافقة. اضغط «حفظ ومتابعة» مرة أخرى.',

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

  // Consent (docs/client-consent-v1-ar.md, version client-consent-v1) — verbatim.
  'consent.required_label': 'أوافق على حفظ صوري وبياناتي لتحليل وجهي (مطلوب)',
  'consent.optional_label': 'أوافق على استخدام صوري وبياناتي في البحث العلمي (اختياري)',
  'consent.read_more': 'اقرأ التفاصيل',
  'consent.hide': 'إخفاء التفاصيل',
  'consent.version': 'الإصدار: client-consent-v1',
  'consent.required_title': 'الموافقة المطلوبة (لا يمكن المتابعة دونها)',
  'consent.required_heading': 'أوافق على حفظ صوري وبياناتي لتحليل وجهي.',
  'consent.required_1':
    'نحفظ صور وجهك التي تلتقطها في التطبيق، ومعلومات التصوير (نوع الجوال وإعدادات الكاميرا والوقت)، وبياناتك: الاسم ورقم الهوية والجوال والجنس وتاريخ الميلاد والجنسية.',
  'consent.required_2':
    'نستخدمها لتحليل شكل وجهك وعرض نتيجتك في ملفك. لا توجد نتيجة للشخصية الآن، وستظهر «النتيجة غير متاحة بعد» حتى يوجد نموذج مثبت علميًا.',
  'consent.required_3': 'لا تُستخدم لأي قرار في التوظيف أو التأمين أو الائتمان أو العلاج أو القضاء.',
  'consent.required_4': 'بياناتك الشخصية محفوظة مشفّرة ومنفصلة عن الصور، ولا تظهر كاملة في التطبيق.',
  'consent.required_5': 'لم نتحقق من رقم هويتك أو جوالك؛ نستخدم رقم الهوية فقط لمنع تكرار الحساب.',
  'consent.required_6':
    'تبقى صورك وبياناتك حتى تحذف حسابك. عند الحذف نوقف كل معالجة فورًا، ونحذف الصور والبيانات خلال 30 يومًا، وتنتهي النسخ الاحتياطية خلال 35 يومًا.',
  'consent.optional_title': 'الموافقة الاختيارية',
  'consent.optional_heading': 'أوافق على استخدام صوري وبياناتي في البحث العلمي.',
  'consent.optional_1': 'تُستخدم صورك مع صور آخرين لبناء معايير علمية لشكل الوجه ولأبحاث أكاديمية غير تجارية.',
  'consent.optional_2': 'يمكنك سحب هذه الموافقة في أي وقت من ملفك؛ بعدها لا تدخل صورك في أي بحث جديد.',
  'consent.optional_3':
    'البيانات التي سبق تسليمها لبحث قبل سحب الموافقة لا يمكن استرجاعها، لكنها لا تتضمن اسمك أو رقم هويتك أو جوالك.',

  // 3. Profile (home)
  'profile.title': 'ملفي',
  'profile.name': 'الاسم: {value}',
  'profile.id': 'الوثيقة: {type} ({country}) {masked}',
  'profile.phone': 'الجوال: {masked}',
  'profile.sex': 'الجنس: {value}',
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
  'profile.research_on': 'موافقة البحث العلمي: مفعّلة',
  'profile.research_off': 'موافقة البحث العلمي: غير مفعّلة',
  'profile.capture': 'التصوير',
  'profile.edit': 'تعديل البيانات',
  'profile.delete': 'حذف حسابي',
  'profile.sign_out': 'تسجيل الخروج',
  'profile.refresh': 'تحديث',
  'profile.withdraw_research': 'سحب موافقة البحث',
  'profile.withdraw_confirm':
    'بعد السحب لا تدخل صورك في أي بحث جديد. البيانات التي سبق تسليمها لبحث لا يمكن استرجاعها، لكنها لا تتضمن اسمك أو رقم هويتك أو جوالك.',
  'profile.withdraw_do': 'تأكيد سحب الموافقة',
  'profile.withdrawn': 'سُحبت موافقة البحث.',
  'profile.delete_confirm':
    'حذف الحساب يوقف كل معالجة فورًا، وتُحذف الصور والبيانات خلال 30 يومًا، وتنتهي النسخ الاحتياطية خلال 35 يومًا. لا يمكن التراجع.',
  'profile.delete_do': 'تأكيد حذف الحساب',

  'status.none': 'لم تصوّر بعد',
  'status.uploading': 'جارٍ الرفع',
  'status.checking': 'جارٍ التحقق',
  // docs/client-app-v1.md §6, verbatim: integrity verified, quality checks still to run.
  'status.received': 'تم استلام الصور، والتحقق من الجودة سيكتمل لاحقًا',
  'status.stored': 'تم حفظ الصور',
  'status.needs_retake': 'تحتاج إلى إعادة التصوير',
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
