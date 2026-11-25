/**
 * ISO 3166-1 alpha-2 codes with Arabic display names, for the issuing-country
 * and nationality fields (docs/client-app-v1.md §2). The stored value is the
 * code; the name is presentation only. The programme is worldwide, so the
 * list is the whole standard and is sorted by Arabic name, not by any one
 * population.
 */

const RAW = `AD أندورا|AE الإمارات العربية المتحدة|AF أفغانستان|AG أنتيغوا وبربودا|AI أنغويلا|AL ألبانيا|AM أرمينيا|AO أنغولا|AQ أنتاركتيكا|AR الأرجنتين|AS ساموا الأمريكية|AT النمسا|AU أستراليا|AW أروبا|AX جزر أولاند|AZ أذربيجان|BA البوسنة والهرسك|BB باربادوس|BD بنغلاديش|BE بلجيكا|BF بوركينا فاسو|BG بلغاريا|BH البحرين|BI بوروندي|BJ بنين|BL سان بارتيلمي|BM برمودا|BN بروناي|BO بوليفيا|BQ الجزر الكاريبية الهولندية|BR البرازيل|BS جزر البهاما|BT بوتان|BV جزيرة بوفيه|BW بوتسوانا|BY بيلاروس|BZ بليز|CA كندا|CC جزر كوكوس|CD جمهورية الكونغو الديمقراطية|CF جمهورية أفريقيا الوسطى|CG جمهورية الكونغو|CH سويسرا|CI ساحل العاج|CK جزر كوك|CL تشيلي|CM الكاميرون|CN الصين|CO كولومبيا|CR كوستاريكا|CU كوبا|CV الرأس الأخضر|CW كوراساو|CX جزيرة عيد الميلاد|CY قبرص|CZ التشيك|DE ألمانيا|DJ جيبوتي|DK الدنمارك|DM دومينيكا|DO جمهورية الدومينيكان|DZ الجزائر|EC الإكوادور|EE إستونيا|EG مصر|EH الصحراء الغربية|ER إريتريا|ES إسبانيا|ET إثيوبيا|FI فنلندا|FJ فيجي|FK جزر فوكلاند|FM ميكرونيزيا|FO جزر فارو|FR فرنسا|GA الغابون|GB المملكة المتحدة|GD غرينادا|GE جورجيا|GF غويانا الفرنسية|GG غيرنزي|GH غانا|GI جبل طارق|GL غرينلاند|GM غامبيا|GN غينيا|GP غوادلوب|GQ غينيا الاستوائية|GR اليونان|GS جورجيا الجنوبية وجزر ساندويتش الجنوبية|GT غواتيمالا|GU غوام|GW غينيا بيساو|GY غيانا|HK هونغ كونغ|HM جزيرة هيرد وجزر ماكدونالد|HN هندوراس|HR كرواتيا|HT هايتي|HU المجر|ID إندونيسيا|IE أيرلندا|IL إسرائيل|IM جزيرة مان|IN الهند|IO إقليم المحيط الهندي البريطاني|IQ العراق|IR إيران|IS آيسلندا|IT إيطاليا|JE جيرسي|JM جامايكا|JO الأردن|JP اليابان|KE كينيا|KG قيرغيزستان|KH كمبوديا|KI كيريباتي|KM جزر القمر|KN سانت كيتس ونيفيس|KP كوريا الشمالية|KR كوريا الجنوبية|KW الكويت|KY جزر كايمان|KZ كازاخستان|LA لاوس|LB لبنان|LC سانت لوسيا|LI ليختنشتاين|LK سريلانكا|LR ليبيريا|LS ليسوتو|LT ليتوانيا|LU لوكسمبورغ|LV لاتفيا|LY ليبيا|MA المغرب|MC موناكو|MD مولدوفا|ME الجبل الأسود|MF سان مارتن|MG مدغشقر|MH جزر مارشال|MK مقدونيا الشمالية|ML مالي|MM ميانمار|MN منغوليا|MO ماكاو|MP جزر ماريانا الشمالية|MQ مارتينيك|MR موريتانيا|MS مونتسرات|MT مالطا|MU موريشيوس|MV جزر المالديف|MW ملاوي|MX المكسيك|MY ماليزيا|MZ موزمبيق|NA ناميبيا|NC كاليدونيا الجديدة|NE النيجر|NF جزيرة نورفولك|NG نيجيريا|NI نيكاراغوا|NL هولندا|NO النرويج|NP نيبال|NR ناورو|NU نيوي|NZ نيوزيلندا|OM عُمان|PA بنما|PE بيرو|PF بولينيزيا الفرنسية|PG بابوا غينيا الجديدة|PH الفلبين|PK باكستان|PL بولندا|PM سان بيير وميكلون|PN جزر بيتكيرن|PR بورتوريكو|PS فلسطين|PT البرتغال|PW بالاو|PY باراغواي|QA قطر|RE لا ريونيون|RO رومانيا|RS صربيا|RU روسيا|RW رواندا|SA السعودية|SB جزر سليمان|SC سيشل|SD السودان|SE السويد|SG سنغافورة|SH سانت هيلينا|SI سلوفينيا|SJ سفالبارد ويان ماين|SK سلوفاكيا|SL سيراليون|SM سان مارينو|SN السنغال|SO الصومال|SR سورينام|SS جنوب السودان|ST ساو تومي وبرينسيب|SV السلفادور|SX سينت مارتن|SY سوريا|SZ إسواتيني|TC جزر توركس وكايكوس|TD تشاد|TF الأقاليم الجنوبية الفرنسية|TG توغو|TH تايلاند|TJ طاجيكستان|TK توكيلاو|TL تيمور الشرقية|TM تركمانستان|TN تونس|TO تونغا|TR تركيا|TT ترينيداد وتوباغو|TV توفالو|TW تايوان|TZ تنزانيا|UA أوكرانيا|UG أوغندا|UM جزر الولايات المتحدة الصغيرة النائية|US الولايات المتحدة|UY الأوروغواي|UZ أوزبكستان|VA الفاتيكان|VC سانت فنسنت والغرينادين|VE فنزويلا|VG جزر العذراء البريطانية|VI جزر العذراء الأمريكية|VN فيتنام|VU فانواتو|WF واليس وفوتونا|WS ساموا|YE اليمن|YT مايوت|ZA جنوب أفريقيا|ZM زامبيا|ZW زيمبابوي`;

export interface Country {
  code: string;
  name: string;
}

export const COUNTRIES: readonly Country[] = RAW.split('|')
  .map((entry) => ({ code: entry.slice(0, 2), name: entry.slice(3) }))
  .sort((a, b) => a.name.localeCompare(b.name, 'ar'));

const BY_CODE = new Map(COUNTRIES.map((country) => [country.code, country]));

export function isCountryCode(code: string): boolean {
  return BY_CODE.has(code);
}

export function countryName(code: string | null | undefined): string {
  if (!code) return '';
  return BY_CODE.get(code)?.name ?? code;
}

/** Normalise Arabic letter variants so «الامارات» finds «الإمارات». */
function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/[آأإ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/^ال/, '')
    .trim();
}

/** Countries whose code or (folded) name contains the query. */
export function searchCountries(query: string, limit = 8): Country[] {
  const q = fold(query);
  if (!q) return [];
  const upper = query.trim().toUpperCase();
  const exact = BY_CODE.get(upper);
  const matches = COUNTRIES.filter(
    (country) => country !== exact && (fold(country.name).includes(q) || country.code.toLowerCase() === q),
  );
  return (exact ? [exact, ...matches] : matches).slice(0, limit);
}

/** The country wheel's list: every country when the query is empty, else the matches (no limit), exact code first. */
export function filterCountries(query: string): Country[] {
  if (!fold(query)) return [...COUNTRIES];
  return searchCountries(query, COUNTRIES.length);
}
