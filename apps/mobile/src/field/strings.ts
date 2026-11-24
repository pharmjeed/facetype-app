/**
 * Field-study microcopy.
 *
 * WHY IT IS HERE AND NOT IN `@facetype/design-system`. That package is shared
 * with the research console and is the canonical product wording; this is
 * operator-and-participant copy for a research collection that only the mobile
 * app runs. Adding it there would put study-specific consent language into a
 * package the web app also ships, for a flow the web app does not have. The
 * shape is deliberately identical (`ar` first, `en` mirroring it, `{token}`
 * interpolation) so it can be lifted across unchanged if the study ever
 * outgrows this app.
 *
 * THE RULE EVERY STRING HERE OBEYS. Nothing in this file may describe, imply or
 * promise a personality result. A field capture produces calibration evidence
 * and a receipt; there is no analysis to report, and copy that hinted at one
 * would be the product making a claim the pipeline has not earned. The consent
 * text states purpose, retention period, who can reach the data and how to ask
 * for its deletion, because those four are what makes a consent informed.
 */

export type FieldLocale = 'ar' | 'en';

export const fieldStrings = {
  ar: {
    'field.mode.enter': 'وضع جمع بيانات المعايرة (للباحثين)',
    'field.mode.exit': 'خروج من وضع المعايرة',
    'field.banner.title': 'وضع معايرة — بيانات مبدئية غير معتمدة',
    'field.banner.body':
      'هذه الجلسة لجمع عينات معايرة فقط. لا يُنتج فيها أي تحليل شخصية ولا يُعرض أي نتيجة، والعينات محجوزة ولا تُستخدم في أي استنتاج.',

    'field.join.title': 'الانضمام إلى جلسة الدراسة',
    'field.join.code_label': 'رمز الانضمام لمرة واحدة',
    'field.join.code_hint':
      'مثال: 7K3M — أربع خانات فقط. لا يُخزَّن في الجهاز ولا يظهر في أي سجل.',
    'field.join.submit': 'انضمام إلى الجلسة',
    'field.join.joined': 'الجلسة: {label} — الموقع: {site}',
    'field.join.policy_version': 'نسخة نص الموافقة من الخادم: {version}',
    'field.join.protocol': 'بروتوكول الالتقاط: {protocol}',
    'field.join.retention_on': 'هذا الخادم يحتفظ بالصور الموافَق عليها لمدة {days} يومًا.',
    'field.join.retention_off':
      'هذا الخادم لا يحتفظ بأي صورة، لذلك لن يُطرح سؤال الصور ولن تُلتقط أي صورة.',
    'field.join.policy_blocked':
      'تعذّر قراءة سياسة الدراسة من الخادم، فلا يمكن عرض نص موافقة صحيح ولا فتح الكاميرا: {code}',
    'field.join.retry': 'إعادة قراءة سياسة الدراسة',

    'field.setup.title': 'مشارك جديد',
    'field.setup.participant_label': 'المعرّف المستعار للمشارك',
    'field.setup.allocate': 'طلب المعرّف التالي من الخادم',
    'field.setup.ref_pending':
      'لم يُخصَّص معرّف بعد. يخصّص الخادم المعرّف، ولا يُدخل يدويًا ولا يُولَّد على الجهاز.',
    'field.setup.ref_allocated': 'المعرّف المخصَّص من الخادم: {ref}',
    'field.setup.decline': 'المشارك رفض المشاركة',
    'field.setup.count': 'مشاركون مكتملون في هذه الجلسة: {count}',

    'field.consent.title': 'موافقة المشارك',
    'field.consent.purpose':
      'الغرض: معايرة قياسات جودة التصوير وهندسة الوجه على أجهزة حقيقية. لا يُجرى أي تحليل للشخصية ولا يُعطى أي نتيجة.',
    'field.consent.geometry':
      'تُحفظ هندسة الوجه وقياسات الجودة لأغراض هذه الدراسة تحت نسخة الموافقة {version}، وتُحذف عند طلبك عبر مشرف الدراسة.',
    'field.consent.raw_retention': 'إن وافقت على حفظ الصور: تُحذف الصورة بعد {days} يومًا.',
    'field.consent.raw_unavailable':
      'هذا الخادم لا يحتفظ بأي صورة، فلن تُلتقط صورة لوجهك ولن تُرسل، ولن يُطرح عليك هذا السؤال.',
    'field.consent.access': 'من يمكنه الاطلاع: {access}. الجهة المسؤولة: {custodian}.',
    'field.consent.deletion':
      'لطلب حذف بياناتك: راجع مشرف الدراسة المخوّل عبر {contact} واذكر المعرّف {ref} فقط. المشرف وحده ينفّذ الحذف على الخادم.',
    'field.consent.research_statement': 'أوافق على جمع هندسة وجهي وقياسات الجودة لأغراض المعايرة.',
    'field.consent.raw_checkbox': 'أوافق أيضًا على حفظ صور وجهي (اختياري ومنفصل).',
    'field.consent.raw_optional_note':
      'رفض حفظ الصور لا يمنع المشاركة: تُجمع الهندسة وقياسات الجودة فقط ولا تُلتقط أي صورة ولا تُرسل.',
    'field.consent.policy_version': 'نسخة نص الموافقة: {version}',
    'field.consent.agree_start': 'أوافق وأبدأ التصوير',
    'field.consent.await_ref': 'يبدأ التصوير بعد تخصيص معرّف لهذا المشارك.',

    'field.capture.title': 'الالتقاط — {ref}',
    'field.capture.progress': 'صالحة للمعالجة {done}/{total} — محاولات محفوظة {recorded}',
    'field.capture.capture': 'التقاط هذه الوضعية',
    'field.capture.repeat': 'إعادة التقاط',
    'field.capture.finish': 'إنهاء المشارك',
    'field.capture.raw_on': 'حفظ الصور: مفعّل',
    'field.capture.raw_off': 'حفظ الصور: غير مفعّل — لا تُلتقط أي صورة',
    'field.capture.participant': 'المعرّف المخصَّص من الخادم: {ref}',
    'field.capture.stage.pending': 'لم تُلتقط بعد',
    'field.capture.stage.capturing': 'جارٍ الالتقاط…',
    'field.capture.stage.uploading': 'جارٍ الرفع…',
    'field.capture.stage.recorded': 'مسجّلة',
    'field.capture.stage.failed': 'أخفقت',
    'field.capture.below_gate': 'دون عتبة الإنتاج — محفوظة للمعايرة ({failures})',
    'field.capture.at_gate': 'ضمن عتبة الإنتاج',
    'field.capture.server_rejected': 'الخادم سجّلها مع ملاحظات: {failures}',
    'field.capture.raw_failed': 'تعذّر حفظ الصورة لهذه الوضعية: {code}',
    'field.capture.raw_unconfirmed':
      'أُرسلت الصورة لهذه الوضعية، ولم يؤكّد الخادم استلامها: {code}',
    'field.capture.abort': 'إلغاء هذا المشارك',

    'field.receipt.title': 'إيصال المشارك',
    'field.receipt.ref': 'المعرّف: {ref}',
    'field.receipt.disposition': 'الحالة: عينة معايرة مبدئية محجوزة — لا نتيجة ولا تحليل.',
    'field.receipt.poses': 'وضعيات مسجّلة: {recorded}/{total} من {attempts} محاولة.',
    'field.receipt.below_gate': 'عينات دون عتبة الإنتاج (محفوظة للمعايرة): {count}',
    'field.receipt.raw': 'صور أُرسلت من الجهاز: {count} — تُحذف بعد {days} يومًا.',
    'field.receipt.raw_unconfirmed': 'صور لم يؤكّد الخادم استلامها بعد: {count}',
    'field.receipt.raw_none': 'لم تُرسل أي صورة لهذا المشارك.',
    'field.receipt.retention':
      'تُحفظ الهندسة وقياسات الجودة لهذه الدراسة تحت نسخة الموافقة {version}.',
    'field.receipt.deletion_title': 'كيف تطلب حذف بياناتك',
    'field.receipt.deletion_steps':
      'راجع مشرف الدراسة المخوّل عبر {contact} واذكر المعرّف {ref}. المشرف وحده يستطيع تنفيذ الحذف على الخادم؛ هذا الجهاز لا يملك هذه الصلاحية ولا يستطيع تأكيد الحذف لك.',
    'field.receipt.no_delete_here':
      'لا يوجد زر حذف في هذا الجهاز: حذف المشارك يتم على الخادم بصلاحية المشرف، وأي زر هنا سيدّعي حذفًا لم يحدث.',
    'field.receipt.next': 'المشارك التالي',
    'field.receipt.incomplete': 'تنبيه: لم تكتمل الوضعيات الخمس لهذا المشارك.',

    'field.error.unavailable': 'تعذّر تشغيل وضع المعايرة على هذا الجهاز.',
  },
  en: {
    'field.mode.enter': 'Calibration collection mode (researchers)',
    'field.mode.exit': 'Leave calibration mode',
    'field.banner.title': 'CALIBRATION — PROVISIONAL, NOT VALIDATED',
    'field.banner.body':
      'This session collects calibration samples only. It produces no personality analysis and shows no result; the samples are quarantined and are not used for any inference.',

    'field.join.title': 'Join the study session',
    'field.join.code_label': 'One-time join code',
    'field.join.code_hint':
      'Example: 7K3M — only four characters. It is not stored on the device or in logs.',
    'field.join.submit': 'Join session',
    'field.join.joined': 'Session: {label} — site: {site}',
    'field.join.policy_version': 'Consent wording version from the server: {version}',
    'field.join.protocol': 'Capture protocol: {protocol}',
    'field.join.retention_on': 'This server keeps consented photographs for {days} days.',
    'field.join.retention_off':
      'This server keeps no photograph, so the photograph question is not asked and no image is taken.',
    'field.join.policy_blocked':
      'The study policy could not be read from the server, so no accurate consent can be shown and the camera cannot open: {code}',
    'field.join.retry': 'Read the study policy again',

    'field.setup.title': 'New participant',
    'field.setup.participant_label': 'Pseudonymous participant reference',
    'field.setup.allocate': 'Ask the server for the next reference',
    'field.setup.ref_pending':
      'No reference allocated yet. The server allocates it; it is never typed in and never generated on this device.',
    'field.setup.ref_allocated': 'Reference allocated by the server: {ref}',
    'field.setup.decline': 'Participant declined to take part',
    'field.setup.count': 'Participants completed this session: {count}',

    'field.consent.title': 'Participant consent',
    'field.consent.purpose':
      'Purpose: calibrating capture-quality and face-geometry measurements on real devices. No personality analysis is performed and no result is produced.',
    'field.consent.geometry':
      'Your face geometry and quality metrics are kept for this study under consent wording {version}, and are deleted when you ask the study operator to delete them.',
    'field.consent.raw_retention':
      'If you agree to photographs: each photo is deleted after {days} days.',
    'field.consent.raw_unavailable':
      'This server keeps no photograph, so no image of your face is taken or sent, and you are not asked this question.',
    'field.consent.access': 'Who can see it: {access}. Accountable body: {custodian}.',
    'field.consent.deletion':
      'To have your records deleted: ask the authorized study operator via {contact} and quote the reference {ref}. Only the operator can carry the deletion out on the server.',
    'field.consent.research_statement':
      'I agree to my face geometry and quality metrics being collected for calibration.',
    'field.consent.raw_checkbox': 'I also agree to photographs of my face being kept (optional, separate).',
    'field.consent.raw_optional_note':
      'Declining photographs does not stop you taking part: only geometry and quality metrics are collected, and no image is taken or sent.',
    'field.consent.policy_version': 'Consent wording version: {version}',
    'field.consent.agree_start': 'I agree and start capture',
    'field.consent.await_ref': 'Capture starts once the server has allocated this participant a reference.',

    'field.capture.title': 'Capture — {ref}',
    'field.capture.progress': 'Ready for processing {done}/{total} — poses with evidence {recorded}',
    'field.capture.capture': 'Capture this pose',
    'field.capture.repeat': 'Capture again',
    'field.capture.finish': 'Finish participant',
    'field.capture.raw_on': 'Photographs: on',
    'field.capture.raw_off': 'Photographs: off — no image is taken',
    'field.capture.participant': 'Reference allocated by the server: {ref}',
    'field.capture.stage.pending': 'Not captured',
    'field.capture.stage.capturing': 'Capturing…',
    'field.capture.stage.uploading': 'Uploading…',
    'field.capture.stage.recorded': 'Recorded',
    'field.capture.stage.failed': 'Failed',
    'field.capture.below_gate': 'Below the production gate — kept for calibration ({failures})',
    'field.capture.at_gate': 'Within the production gate',
    'field.capture.server_rejected': 'Server recorded it with findings: {failures}',
    'field.capture.raw_failed': 'No photograph was stored for this pose: {code}',
    'field.capture.raw_unconfirmed':
      'The photograph for this pose was sent but the server did not confirm it: {code}',
    'field.capture.abort': 'Discard this participant',

    'field.receipt.title': 'Participant receipt',
    'field.receipt.ref': 'Reference: {ref}',
    'field.receipt.disposition':
      'Status: provisional quarantined calibration sample — no result, no analysis.',
    'field.receipt.poses': 'Poses recorded: {recorded}/{total} from {attempts} attempts.',
    'field.receipt.below_gate': 'Samples below the production gate (kept for calibration): {count}',
    'field.receipt.raw': 'Photographs sent from the device: {count} — deleted after {days} days.',
    'field.receipt.raw_unconfirmed': 'Photographs the server has not yet confirmed: {count}',
    'field.receipt.raw_none': 'No photograph was sent for this participant.',
    'field.receipt.retention':
      'Geometry and quality metrics are kept for this study under consent wording {version}.',
    'field.receipt.deletion_title': 'How to ask for your data to be deleted',
    'field.receipt.deletion_steps':
      'Ask the authorized study operator via {contact} and quote the reference {ref}. Only the operator can carry the deletion out on the server; this device does not hold that permission and cannot confirm a deletion to you.',
    'field.receipt.no_delete_here':
      'There is no delete button on this device: erasing a participant happens on the server under an operator permission, and a button here would claim a deletion that did not happen.',
    'field.receipt.next': 'Next participant',
    'field.receipt.incomplete': 'Note: the five poses were not all recorded for this participant.',

    'field.error.unavailable': 'Calibration mode cannot run on this device.',
  },
} as const;

export type FieldStringKey = keyof (typeof fieldStrings)['ar'];

/** Translate a field-study key, interpolating `{placeholders}`. */
export function ft(
  locale: FieldLocale | string,
  key: FieldStringKey,
  params: Record<string, string | number> = {},
): string {
  const language: FieldLocale = String(locale).toLowerCase().startsWith('ar') ? 'ar' : 'en';
  const template: string = fieldStrings[language][key] ?? fieldStrings.en[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}
