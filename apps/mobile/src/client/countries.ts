/**
 * ISO 3166-1 alpha-2 codes with Arabic display names, for the issuing-country
 * and nationality fields (docs/client-app-v1.md §2). The stored value is the
 * code; the name is presentation only. The programme is worldwide, so the
 * list is the whole standard and is sorted by Arabic name, not by any one
 * population.
 */

const RAW_AR = `AD أندورا|AE الإمارات العربية المتحدة|AF أفغانستان|AG أنتيغوا وبربودا|AI أنغويلا|AL ألبانيا|AM أرمينيا|AO أنغولا|AQ أنتاركتيكا|AR الأرجنتين|AS ساموا الأمريكية|AT النمسا|AU أستراليا|AW أروبا|AX جزر أولاند|AZ أذربيجان|BA البوسنة والهرسك|BB باربادوس|BD بنغلاديش|BE بلجيكا|BF بوركينا فاسو|BG بلغاريا|BH البحرين|BI بوروندي|BJ بنين|BL سان بارتيلمي|BM برمودا|BN بروناي|BO بوليفيا|BQ الجزر الكاريبية الهولندية|BR البرازيل|BS جزر البهاما|BT بوتان|BV جزيرة بوفيه|BW بوتسوانا|BY بيلاروس|BZ بليز|CA كندا|CC جزر كوكوس|CD جمهورية الكونغو الديمقراطية|CF جمهورية أفريقيا الوسطى|CG جمهورية الكونغو|CH سويسرا|CI ساحل العاج|CK جزر كوك|CL تشيلي|CM الكاميرون|CN الصين|CO كولومبيا|CR كوستاريكا|CU كوبا|CV الرأس الأخضر|CW كوراساو|CX جزيرة عيد الميلاد|CY قبرص|CZ التشيك|DE ألمانيا|DJ جيبوتي|DK الدنمارك|DM دومينيكا|DO جمهورية الدومينيكان|DZ الجزائر|EC الإكوادور|EE إستونيا|EG مصر|EH الصحراء الغربية|ER إريتريا|ES إسبانيا|ET إثيوبيا|FI فنلندا|FJ فيجي|FK جزر فوكلاند|FM ميكرونيزيا|FO جزر فارو|FR فرنسا|GA الغابون|GB المملكة المتحدة|GD غرينادا|GE جورجيا|GF غويانا الفرنسية|GG غيرنزي|GH غانا|GI جبل طارق|GL غرينلاند|GM غامبيا|GN غينيا|GP غوادلوب|GQ غينيا الاستوائية|GR اليونان|GS جورجيا الجنوبية وجزر ساندويتش الجنوبية|GT غواتيمالا|GU غوام|GW غينيا بيساو|GY غيانا|HK هونغ كونغ|HM جزيرة هيرد وجزر ماكدونالد|HN هندوراس|HR كرواتيا|HT هايتي|HU المجر|ID إندونيسيا|IE أيرلندا|IL إسرائيل|IM جزيرة مان|IN الهند|IO إقليم المحيط الهندي البريطاني|IQ العراق|IR إيران|IS آيسلندا|IT إيطاليا|JE جيرسي|JM جامايكا|JO الأردن|JP اليابان|KE كينيا|KG قيرغيزستان|KH كمبوديا|KI كيريباتي|KM جزر القمر|KN سانت كيتس ونيفيس|KP كوريا الشمالية|KR كوريا الجنوبية|KW الكويت|KY جزر كايمان|KZ كازاخستان|LA لاوس|LB لبنان|LC سانت لوسيا|LI ليختنشتاين|LK سريلانكا|LR ليبيريا|LS ليسوتو|LT ليتوانيا|LU لوكسمبورغ|LV لاتفيا|LY ليبيا|MA المغرب|MC موناكو|MD مولدوفا|ME الجبل الأسود|MF سان مارتن|MG مدغشقر|MH جزر مارشال|MK مقدونيا الشمالية|ML مالي|MM ميانمار|MN منغوليا|MO ماكاو|MP جزر ماريانا الشمالية|MQ مارتينيك|MR موريتانيا|MS مونتسرات|MT مالطا|MU موريشيوس|MV جزر المالديف|MW ملاوي|MX المكسيك|MY ماليزيا|MZ موزمبيق|NA ناميبيا|NC كاليدونيا الجديدة|NE النيجر|NF جزيرة نورفولك|NG نيجيريا|NI نيكاراغوا|NL هولندا|NO النرويج|NP نيبال|NR ناورو|NU نيوي|NZ نيوزيلندا|OM عُمان|PA بنما|PE بيرو|PF بولينيزيا الفرنسية|PG بابوا غينيا الجديدة|PH الفلبين|PK باكستان|PL بولندا|PM سان بيير وميكلون|PN جزر بيتكيرن|PR بورتوريكو|PS فلسطين|PT البرتغال|PW بالاو|PY باراغواي|QA قطر|RE لا ريونيون|RO رومانيا|RS صربيا|RU روسيا|RW رواندا|SA السعودية|SB جزر سليمان|SC سيشل|SD السودان|SE السويد|SG سنغافورة|SH سانت هيلينا|SI سلوفينيا|SJ سفالبارد ويان ماين|SK سلوفاكيا|SL سيراليون|SM سان مارينو|SN السنغال|SO الصومال|SR سورينام|SS جنوب السودان|ST ساو تومي وبرينسيب|SV السلفادور|SX سينت مارتن|SY سوريا|SZ إسواتيني|TC جزر توركس وكايكوس|TD تشاد|TF الأقاليم الجنوبية الفرنسية|TG توغو|TH تايلاند|TJ طاجيكستان|TK توكيلاو|TL تيمور الشرقية|TM تركمانستان|TN تونس|TO تونغا|TR تركيا|TT ترينيداد وتوباغو|TV توفالو|TW تايوان|TZ تنزانيا|UA أوكرانيا|UG أوغندا|UM جزر الولايات المتحدة الصغيرة النائية|US الولايات المتحدة|UY الأوروغواي|UZ أوزبكستان|VA الفاتيكان|VC سانت فنسنت والغرينادين|VE فنزويلا|VG جزر العذراء البريطانية|VI جزر العذراء الأمريكية|VN فيتنام|VU فانواتو|WF واليس وفوتونا|WS ساموا|YE اليمن|YT مايوت|ZA جنوب أفريقيا|ZM زامبيا|ZW زيمبابوي`;

import { lang, type Lang } from './i18n.ts';

export interface Country {
  code: string;
  name: string;
}

// English short names: CLDR region names (Intl.DisplayNames 'en'), generated once for the same 249 codes.
const RAW_EN = `AD Andorra|AE United Arab Emirates|AF Afghanistan|AG Antigua & Barbuda|AI Anguilla|AL Albania|AM Armenia|AO Angola|AQ Antarctica|AR Argentina|AS American Samoa|AT Austria|AU Australia|AW Aruba|AX Åland Islands|AZ Azerbaijan|BA Bosnia & Herzegovina|BB Barbados|BD Bangladesh|BE Belgium|BF Burkina Faso|BG Bulgaria|BH Bahrain|BI Burundi|BJ Benin|BL St. Barthélemy|BM Bermuda|BN Brunei|BO Bolivia|BQ Caribbean Netherlands|BR Brazil|BS Bahamas|BT Bhutan|BV Bouvet Island|BW Botswana|BY Belarus|BZ Belize|CA Canada|CC Cocos (Keeling) Islands|CD Congo - Kinshasa|CF Central African Republic|CG Congo - Brazzaville|CH Switzerland|CI Côte d’Ivoire|CK Cook Islands|CL Chile|CM Cameroon|CN China|CO Colombia|CR Costa Rica|CU Cuba|CV Cape Verde|CW Curaçao|CX Christmas Island|CY Cyprus|CZ Czechia|DE Germany|DJ Djibouti|DK Denmark|DM Dominica|DO Dominican Republic|DZ Algeria|EC Ecuador|EE Estonia|EG Egypt|EH Western Sahara|ER Eritrea|ES Spain|ET Ethiopia|FI Finland|FJ Fiji|FK Falkland Islands|FM Micronesia|FO Faroe Islands|FR France|GA Gabon|GB United Kingdom|GD Grenada|GE Georgia|GF French Guiana|GG Guernsey|GH Ghana|GI Gibraltar|GL Greenland|GM Gambia|GN Guinea|GP Guadeloupe|GQ Equatorial Guinea|GR Greece|GS South Georgia & South Sandwich Islands|GT Guatemala|GU Guam|GW Guinea-Bissau|GY Guyana|HK Hong Kong SAR China|HM Heard & McDonald Islands|HN Honduras|HR Croatia|HT Haiti|HU Hungary|ID Indonesia|IE Ireland|IL Israel|IM Isle of Man|IN India|IO British Indian Ocean Territory|IQ Iraq|IR Iran|IS Iceland|IT Italy|JE Jersey|JM Jamaica|JO Jordan|JP Japan|KE Kenya|KG Kyrgyzstan|KH Cambodia|KI Kiribati|KM Comoros|KN St. Kitts & Nevis|KP North Korea|KR South Korea|KW Kuwait|KY Cayman Islands|KZ Kazakhstan|LA Laos|LB Lebanon|LC St. Lucia|LI Liechtenstein|LK Sri Lanka|LR Liberia|LS Lesotho|LT Lithuania|LU Luxembourg|LV Latvia|LY Libya|MA Morocco|MC Monaco|MD Moldova|ME Montenegro|MF St. Martin|MG Madagascar|MH Marshall Islands|MK North Macedonia|ML Mali|MM Myanmar (Burma)|MN Mongolia|MO Macao SAR China|MP Northern Mariana Islands|MQ Martinique|MR Mauritania|MS Montserrat|MT Malta|MU Mauritius|MV Maldives|MW Malawi|MX Mexico|MY Malaysia|MZ Mozambique|NA Namibia|NC New Caledonia|NE Niger|NF Norfolk Island|NG Nigeria|NI Nicaragua|NL Netherlands|NO Norway|NP Nepal|NR Nauru|NU Niue|NZ New Zealand|OM Oman|PA Panama|PE Peru|PF French Polynesia|PG Papua New Guinea|PH Philippines|PK Pakistan|PL Poland|PM St. Pierre & Miquelon|PN Pitcairn Islands|PR Puerto Rico|PS Palestinian Territories|PT Portugal|PW Palau|PY Paraguay|QA Qatar|RE Réunion|RO Romania|RS Serbia|RU Russia|RW Rwanda|SA Saudi Arabia|SB Solomon Islands|SC Seychelles|SD Sudan|SE Sweden|SG Singapore|SH St. Helena|SI Slovenia|SJ Svalbard & Jan Mayen|SK Slovakia|SL Sierra Leone|SM San Marino|SN Senegal|SO Somalia|SR Suriname|SS South Sudan|ST São Tomé & Príncipe|SV El Salvador|SX Sint Maarten|SY Syria|SZ Eswatini|TC Turks & Caicos Islands|TD Chad|TF French Southern Territories|TG Togo|TH Thailand|TJ Tajikistan|TK Tokelau|TL Timor-Leste|TM Turkmenistan|TN Tunisia|TO Tonga|TR Türkiye|TT Trinidad & Tobago|TV Tuvalu|TW Taiwan|TZ Tanzania|UA Ukraine|UG Uganda|UM U.S. Outlying Islands|US United States|UY Uruguay|UZ Uzbekistan|VA Vatican City|VC St. Vincent & Grenadines|VE Venezuela|VG British Virgin Islands|VI U.S. Virgin Islands|VN Vietnam|VU Vanuatu|WF Wallis & Futuna|WS Samoa|YE Yemen|YT Mayotte|ZA South Africa|ZM Zambia|ZW Zimbabwe`;

function parse(raw: string, locale: Lang): readonly Country[] {
  return raw
    .split('|')
    .map((entry) => ({ code: entry.slice(0, 2), name: entry.slice(3) }))
    .sort((a, b) => a.name.localeCompare(b.name, locale));
}

const LISTS: Record<Lang, readonly Country[]> = { ar: parse(RAW_AR, 'ar'), en: parse(RAW_EN, 'en') };

/** Arabic list (the default interface language). */
export const COUNTRIES: readonly Country[] = LISTS.ar;

/** The list in the current interface language, sorted by its names. */
export function countries(language: Lang = lang()): readonly Country[] {
  return LISTS[language];
}

const BY_CODE: Record<Lang, Map<string, Country>> = {
  ar: new Map(LISTS.ar.map((country) => [country.code, country])),
  en: new Map(LISTS.en.map((country) => [country.code, country])),
};

export function isCountryCode(code: string): boolean {
  return BY_CODE.ar.has(code);
}

export function countryName(code: string | null | undefined): string {
  if (!code) return '';
  return BY_CODE[lang()].get(code)?.name ?? code;
}

/** Normalise Arabic letter variants («الامارات» finds «الإمارات») and Latin accents («aland» finds «Åland»). */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .normalize('NFC')
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
  const exact = BY_CODE[lang()].get(upper);
  const matches = countries().filter(
    (country) => country !== exact && (fold(country.name).includes(q) || country.code.toLowerCase() === q),
  );
  return (exact ? [exact, ...matches] : matches).slice(0, limit);
}

/** The country wheel's list: every country when the query is empty, else the matches (no limit), exact code first. */
export function filterCountries(query: string): Country[] {
  if (!fold(query)) return [...countries()];
  return searchCountries(query, countries().length);
}
