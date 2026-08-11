const DIGITS = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'];
const BIG_UNITS = ['', 'nghìn', 'triệu', 'tỷ', 'nghìn tỷ', 'triệu tỷ'];

function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function readTriplet(value, forceHundreds = false) {
  const number = Math.max(0, Math.min(999, Number(value) || 0));
  const hundreds = Math.floor(number / 100);
  const tens = Math.floor((number % 100) / 10);
  const ones = number % 10;
  const parts = [];

  if (hundreds > 0 || forceHundreds) {
    parts.push(`${DIGITS[hundreds]} trăm`);
  }

  if (tens === 0) {
    if (ones > 0) {
      if (hundreds > 0 || forceHundreds) parts.push('linh');
      parts.push(DIGITS[ones]);
    }
    return parts.join(' ');
  }

  if (tens === 1) {
    parts.push('mười');
  } else {
    parts.push(`${DIGITS[tens]} mươi`);
  }

  if (ones > 0) {
    if (tens >= 2 && ones === 1) parts.push('mốt');
    else if (tens >= 1 && ones === 5) parts.push('lăm');
    else parts.push(DIGITS[ones]);
  }

  return parts.join(' ');
}

function integerToVietnameseWords(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  const negative = raw.startsWith('-');
  const digits = raw.replace(/[^\d]/g, '').replace(/^0+(?=\d)/, '') || '0';
  if (digits === '0') return negative ? 'âm không' : 'không';

  const groups = [];
  for (let end = digits.length; end > 0; end -= 3) {
    groups.unshift(digits.slice(Math.max(0, end - 3), end));
  }

  const parts = [];
  groups.forEach((group, index) => {
    const value = Number(group);
    if (!value) return;
    const remainingGroups = groups.length - index - 1;
    const forceHundreds = index > 0 && group.length === 3 && value < 100;
    const words = readTriplet(value, forceHundreds);
    const unit = BIG_UNITS[remainingGroups] || '';
    parts.push(unit ? `${words} ${unit}` : words);
  });

  const output = parts.join(' ').replace(/\s+/g, ' ').trim();
  return negative ? `âm ${output}` : output;
}

function numberTokenToVietnameseWords(token = '') {
  const raw = String(token || '').trim();
  if (!raw) return '';
  const sign = raw.startsWith('-') ? '-' : '';
  const unsigned = raw.replace(/^[+-]/, '');

  if (/^\d{1,3}([.,]\d{3})+$/.test(unsigned)) {
    return integerToVietnameseWords(`${sign}${unsigned.replace(/[.,]/g, '')}`);
  }

  const decimalMatch = unsigned.match(/^(\d+)[,.](\d+)$/);
  if (decimalMatch) {
    const integerWords = integerToVietnameseWords(`${sign}${decimalMatch[1]}`);
    const decimalWords = decimalMatch[2].split('').map((digit) => DIGITS[Number(digit)]).join(' ');
    return `${integerWords} phẩy ${decimalWords}`.trim();
  }

  return integerToVietnameseWords(`${sign}${unsigned}`);
}

function yearTokenToVietnameseWords(token = '') {
  const digits = String(token || '').replace(/[^\d]/g, '');
  if (!/^(?:19|20)\d{2}$/.test(digits)) return '';
  return digits.split('').map((digit) => DIGITS[Number(digit)]).join(' ');
}

function timeTokenToVietnameseWords(hourToken = '', minuteToken = '') {
  const hourWords = numberTokenToVietnameseWords(String(Number(hourToken)));
  const minuteNumber = minuteToken === '' ? null : Number(minuteToken);
  if (minuteNumber === null || minuteNumber === 0) return `${hourWords} giờ`;
  if (minuteNumber === 30) return `${hourWords} rưỡi`;
  return `${hourWords} giờ ${numberTokenToVietnameseWords(String(minuteNumber))}`;
}

function dayPartForPeriod(hourToken = '', periodToken = '') {
  const hour = Number(hourToken);
  const period = String(periodToken || '').toLowerCase().replace(/\./g, '');
  if (period === 'am') return hour === 0 || hour === 12 ? 'đêm' : 'sáng';
  if (hour === 12) return 'trưa';
  if (hour >= 1 && hour <= 5) return 'chiều';
  return 'tối';
}

function ordinalToVietnameseWords(value = '') {
  const ordinals = {
    1: 'nhất',
    2: 'hai',
    3: 'ba',
    4: 'tư',
    5: 'năm',
    6: 'sáu',
    7: 'bảy',
    8: 'tám',
    9: 'chín',
    10: 'mười',
  };
  return ordinals[Number(value)] || numberTokenToVietnameseWords(value);
}

function replaceUnits(text = '') {
  return String(text || '')
    .replace(/(?<![\p{L}\p{N}_?])cây\s*số\s*vuông(?![\p{L}\p{N}_?])/giu, 'ki lô mét vuông')
    .replace(/(?<![\p{L}\p{N}_?])cây\s*số(?![\p{L}\p{N}_?])/giu, 'cây số')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*cây(?!\s*số)(?![\p{L}\p{N}_?])/giu, '$1$2 cây số')
    .replace(/(?<![\p{L}\p{N}_?])km\s*\/\s*h(?![\p{L}\p{N}_?])/giu, 'cây số trên giờ')
    .replace(/(?<![\p{L}\p{N}_?])km\s*\/\s*s(?![\p{L}\p{N}_?])/giu, 'cây số trên giây')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*tbps(?![\p{L}\p{N}_?])/giu, '$1$2 tê ra bit trên giây')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*gbps(?![\p{L}\p{N}_?])/giu, '$1$2 ghi ga bit trên giây')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*mbps(?![\p{L}\p{N}_?])/giu, '$1$2 mê ga bit trên giây')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*kbps(?![\p{L}\p{N}_?])/giu, '$1$2 ki lô bit trên giây')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*tb\s*\/\s*s(?![\p{L}\p{N}_?])/giu, '$1$2 tê ra bai trên giây')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*gb\s*\/\s*s(?![\p{L}\p{N}_?])/giu, '$1$2 ghi ga bai trên giây')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*mb\s*\/\s*s(?![\p{L}\p{N}_?])/giu, '$1$2 mê ga bai trên giây')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*kb\s*\/\s*s(?![\p{L}\p{N}_?])/giu, '$1$2 ki lô bai trên giây')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*fps(?![\p{L}\p{N}_?])/giu, '$1$2 khung hình trên giây')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*rpm(?![\p{L}\p{N}_?])/giu, '$1$2 vòng trên phút')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*bpm(?![\p{L}\p{N}_?])/giu, '$1$2 nhịp mỗi phút')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*mph(?![\p{L}\p{N}_?])/giu, '$1$2 dặm trên giờ')
    .replace(/(?<![\p{L}\p{N}_?])m\s*\/\s*s\s*(?:2|²)(?![\p{L}\p{N}_?])/giu, 'mét trên giây bình phương')
    .replace(/(?<![\p{L}\p{N}_?])m\s*\/\s*s(?![\p{L}\p{N}_?])/giu, 'mét trên giây')
    .replace(/(?<![\p{L}\p{N}_?])l\s*\/\s*s(?![\p{L}\p{N}_?])/giu, 'lít trên giây')
    .replace(/(?<![\p{L}\p{N}_?])l\s*\/\s*min(?![\p{L}\p{N}_?])/giu, 'lít trên phút')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*ms(?![\p{L}\p{N}_?])/giu, '$1$2 mi li giây')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*(?:sec|secs|second|seconds)(?![\p{L}\p{N}_?])/giu, '$1$2 giây')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*s(?![\p{L}\p{N}_?])/giu, '$1$2 giây')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*(?:min|mins|minute|minutes)(?![\p{L}\p{N}_?])/giu, '$1$2 phút')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*(?:hr|hrs|hour|hours)(?![\p{L}\p{N}_?])/giu, '$1$2 giờ')
    .replace(/(?<![\p{L}\p{N}_?])ha\s*\/\s*km\s*(?:2|²|vuông)(?![\p{L}\p{N}_?])/giu, 'héc ta trên ki lô mét vuông')
    .replace(/(?<![\p{L}\p{N}_?])người\s*\/\s*km\s*(?:2|²|vuông)(?![\p{L}\p{N}_?])/giu, 'người trên ki lô mét vuông')
    .replace(/(?<![\p{L}\p{N}_?])kg\s*\/\s*m\s*(?:2|²|vuông)(?![\p{L}\p{N}_?])/giu, 'cân trên mét vuông')
    .replace(/(?<![\p{L}\p{N}_?])mg\s*\/\s*dl(?![\p{L}\p{N}_?])/giu, 'mi li gam trên đề xi lít')
    .replace(/(?<![\p{L}\p{N}_?])mg\s*\/\s*l(?![\p{L}\p{N}_?])/giu, 'mi li gam trên lít')
    .replace(/(?<![\p{L}\p{N}_?])km\s*(?:2|²|vuông)(?![\p{L}\p{N}_?])/giu, 'ki lô mét vuông')
    .replace(/(?<![\p{L}\p{N}_?])m\s*(?:2|²|vuông)(?![\p{L}\p{N}_?])/giu, 'mét vuông')
    .replace(/(?<![\p{L}\p{N}_?])cm\s*(?:2|²|vuông)(?![\p{L}\p{N}_?])/giu, 'phân vuông')
    .replace(/(?<![\p{L}\p{N}_?])km\s*(?:3|³|khối)(?![\p{L}\p{N}_?])/giu, 'ki lô mét khối')
    .replace(/(?<![\p{L}\p{N}_?])m\s*(?:3|³|khối)(?![\p{L}\p{N}_?])/giu, 'mét khối')
    .replace(/(?<![\p{L}\p{N}_?])cm\s*(?:3|³|khối)(?![\p{L}\p{N}_?])/giu, 'phân khối')
    .replace(/(?<![\p{L}\p{N}_?])cc(?![\p{L}\p{N}_?])/giu, 'xê xê')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*(?:miles|mile|mi(?!\s*li\b))(?![\p{L}\p{N}_?])/giu, '$1$2 dặm')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*(?:feet|foot|ft)(?![\p{L}\p{N}_?])/giu, '$1$2 feet')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*(?:yards|yard|yd)(?![\p{L}\p{N}_?])/giu, '$1$2 thước Anh')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*(?:inches|inch)(?![\p{L}\p{N}_?])/giu, '$1$2 inch')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*(?:lbs|lb|pounds|pound)(?![\p{L}\p{N}_?])/giu, '$1$2 pao')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*(?:ounces|ounce|oz)(?![\p{L}\p{N}_?])/giu, '$1$2 ao xơ')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*(?:acres|acre)(?![\p{L}\p{N}_?])/giu, '$1$2 mẫu Anh')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*(?:µg|mcg|ug)(?![\p{L}\p{N}_?])/giu, '$1$2 micro gam')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*mg(?![\p{L}\p{N}_?])/giu, '$1$2 mi li gam')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*ppm(?![\p{L}\p{N}_?])/giu, '$1$2 phần triệu')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*ppb(?![\p{L}\p{N}_?])/giu, '$1$2 phần tỷ')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*mmhg(?![\p{L}\p{N}_?])/giu, '$1$2 mi li mét thủy ngân')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*ghz(?![\p{L}\p{N}_?])/giu, '$1$2 ghi ga héc')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*mhz(?![\p{L}\p{N}_?])/giu, '$1$2 mê ga héc')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*khz(?![\p{L}\p{N}_?])/giu, '$1$2 ki lô héc')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*hz(?![\p{L}\p{N}_?])/giu, '$1$2 héc')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*mpa(?![\p{L}\p{N}_?])/giu, '$1$2 mê ga pascal')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*kpa(?![\p{L}\p{N}_?])/giu, '$1$2 ki lô pascal')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*pa(?![\p{L}\p{N}_?])/giu, '$1$2 pascal')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*psi(?![\p{L}\p{N}_?])/giu, '$1$2 psi')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*atm(?![\p{L}\p{N}_?])/giu, '$1$2 át mốt phe')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*bar(?![\p{L}\p{N}_?])/giu, '$1$2 bar')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*kwh(?![\p{L}\p{N}_?])/giu, '$1$2 ki lô oát giờ')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*wh(?![\p{L}\p{N}_?])/giu, '$1$2 oát giờ')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*mah(?![\p{L}\p{N}_?])/giu, '$1$2 mi li ampe giờ')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*ah(?![\p{L}\p{N}_?])/giu, '$1$2 ampe giờ')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*ma(?![\p{L}\p{N}_?])/giu, '$1$2 mi li ampe')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*a(?![\p{L}\p{N}_?])/giu, '$1$2 ampe')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*(?:ohm|Ω)(?![\p{L}\p{N}_?])/giu, '$1$2 ôm')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*kcal(?![\p{L}\p{N}_?])/giu, '$1$2 ki lô calo')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*cal(?![\p{L}\p{N}_?])/giu, '$1$2 calo')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*mw(?![\p{L}\p{N}_?])/giu, '$1$2 mê ga oát')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*kw(?![\p{L}\p{N}_?])/giu, '$1$2 ki lô oát')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*w(?![\p{L}\p{N}_?])/giu, '$1$2 oát')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*kv(?![\p{L}\p{N}_?])/giu, '$1$2 ki lô vôn')
    .replace(/(^|[^\p{L}\p{N}_?])([-+]?\d+(?:[.,]\d+)*)\s*v(?![\p{L}\p{N}_?])/giu, '$1$2 vôn')
    .replace(/(?<![\p{L}\p{N}_?])tb(?![\p{L}\p{N}_?])/giu, 'tê ra bai')
    .replace(/(?<![\p{L}\p{N}_?])gb(?![\p{L}\p{N}_?])/giu, 'ghi ga bai')
    .replace(/(?<![\p{L}\p{N}_?])mb(?![\p{L}\p{N}_?])/giu, 'mê ga bai')
    .replace(/(?<![\p{L}\p{N}_?])kb(?![\p{L}\p{N}_?])/giu, 'ki lô bai')
    .replace(/(?<![\p{L}\p{N}_?])kg(?![\p{L}\p{N}_?])/giu, 'cân')
    .replace(/(?<![\p{L}\p{N}_?])km(?![\p{L}\p{N}_?])/giu, 'cây số')
    .replace(/(?<![\p{L}\p{N}_?])cm(?![\p{L}\p{N}_?])/giu, 'phân')
    .replace(/(?<![\p{L}\p{N}_?])mm(?![\p{L}\p{N}_?])/giu, 'ly')
    .replace(/(?<![\p{L}\p{N}_?])ml(?![\p{L}\p{N}_?])/giu, 'mi li lít')
    .replace(/(?<![\p{L}\p{N}_?])l(?![\p{L}\p{N}_?])/giu, 'lít')
    .replace(/(?<![\p{L}\p{N}_?])g(?![\p{L}\p{N}_?])/giu, 'gam')
    .replace(/(?<![\p{L}\p{N}_?])ha(?![\p{L}\p{N}_?])/giu, 'héc ta')
    .replace(/(?<![\p{L}\p{N}_?])m(?![\p{L}\p{N}_?])/giu, 'mét')
    .replace(/(?<![\p{L}\p{N}_?])usd(?![\p{L}\p{N}_?])/giu, 'đô')
    .replace(/(?<![\p{L}\p{N}_?])eur(?![\p{L}\p{N}_?])/giu, 'euro')
    .replace(/(?<![\p{L}\p{N}_?])euro(?![\p{L}\p{N}_?])/giu, 'euro')
    .replace(/(?<![\p{L}\p{N}_?])cny(?![\p{L}\p{N}_?])/giu, 'tệ')
    .replace(/(?<![\p{L}\p{N}_?])rmb(?![\p{L}\p{N}_?])/giu, 'tệ')
    .replace(/(?<![\p{L}\p{N}_?])ndt(?![\p{L}\p{N}_?])/giu, 'tệ')
    .replace(/(?<![\p{L}\p{N}_?])jpy(?![\p{L}\p{N}_?])/giu, 'yên')
    .replace(/(?<![\p{L}\p{N}_?])gbp(?![\p{L}\p{N}_?])/giu, 'bảng Anh')
    .replace(/(?<![\p{L}\p{N}_?])aud(?![\p{L}\p{N}_?])/giu, 'đô Úc')
    .replace(/(?<![\p{L}\p{N}_?])cad(?![\p{L}\p{N}_?])/giu, 'đô Canada')
    .replace(/(?<![\p{L}\p{N}_?])sgd(?![\p{L}\p{N}_?])/giu, 'đô Singapore')
    .replace(/(?<![\p{L}\p{N}_?])hkd(?![\p{L}\p{N}_?])/giu, 'đô Hồng Kông')
    .replace(/(?<![\p{L}\p{N}_?])krw(?![\p{L}\p{N}_?])/giu, 'won')
    .replace(/(?<![\p{L}\p{N}_?])btc(?![\p{L}\p{N}_?])/giu, 'bitcoin')
    .replace(/(?<![\p{L}\p{N}_?])eth(?![\p{L}\p{N}_?])/giu, 'ethereum')
    .replace(/(?<![\p{L}\p{N}_?])vnđ(?![\p{L}\p{N}_?])/giu, 'đồng')
    .replace(/(?<![\p{L}\p{N}_?])vnd(?![\p{L}\p{N}_?])/giu, 'đồng')
    .replace(/°\s*c\b/giu, ' độ')
    .replace(/\bđộ\s*c\b/giu, ' độ')
    .replace(/°\s*f\b/giu, ' độ F')
    .replace(/\bđộ\s*f\b/giu, ' độ F')
    .replace(/°/gu, ' độ');
}

function verbalizeVietnameseDubbingText(text = '') {
  let output = normalizeText(text);
  if (!output) return output;

  output = output
    .replace(/\b([01]?\d|2[0-3]):([0-5]\d)\s*(a\.?m\.?|p\.?m\.?)\b/giu, (_, hour, minute, period) => {
      return `${timeTokenToVietnameseWords(hour, minute)} ${dayPartForPeriod(hour, period)}`;
    })
    .replace(/\b([01]?\d|2[0-3])\s*(a\.?m\.?|p\.?m\.?)\b/giu, (_, hour, period) => {
      return `${timeTokenToVietnameseWords(hour)} ${dayPartForPeriod(hour, period)}`;
    })
    .replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g, (_, hour, minute) => {
      return timeTokenToVietnameseWords(hour, minute);
    })
    .replace(/\b([01]?\d|2[0-3])h([0-5]\d)?\b/giu, (_, hour, minute = '') => {
      return timeTokenToVietnameseWords(hour, minute);
    })
    .replace(/\bthứ\s+([1-9]|10)\b/giu, (_, ordinal) => `thứ ${ordinalToVietnameseWords(ordinal)}`)
    .replace(/\bnăm\s+((?:19|20)\d{2})\b/giu, (match, year) => {
      const yearWords = yearTokenToVietnameseWords(year);
      const label = match.slice(0, match.length - String(year).length).trimEnd();
      return yearWords ? `${label} ${yearWords}` : `${label} ${year}`;
    })
    .replace(/\b1[,.]5\s*(kg|km|l)\b(?!\s*\/\s*(?:h|s|min)\b)/giu, (_, unit) => {
      const spokenUnit = String(unit).toLowerCase() === 'kg'
        ? 'cân'
        : String(unit).toLowerCase() === 'km'
          ? 'cây số'
          : 'lít';
      return String(unit).toLowerCase() === 'km'
        ? `một phẩy năm ${spokenUnit}`
        : `một ${spokenUnit} rưỡi`;
    })
    .replace(/([-+]?\d+(?:[.,]\d+)*)\s*%/g, (_, number) => `${numberTokenToVietnameseWords(number)} phần trăm`)
    .replace(/\$\s*([-+]?\d+(?:[.,]\d+)*)/g, (_, number) => `${numberTokenToVietnameseWords(number)} đô`)
    .replace(/([-+]?\d+(?:[.,]\d+)*)\s*\$/g, (_, number) => `${numberTokenToVietnameseWords(number)} đô`)
    .replace(/€\s*([-+]?\d+(?:[.,]\d+)*)/g, (_, number) => `${numberTokenToVietnameseWords(number)} euro`)
    .replace(/([-+]?\d+(?:[.,]\d+)*)\s*€/g, (_, number) => `${numberTokenToVietnameseWords(number)} euro`)
    .replace(/¥\s*([-+]?\d+(?:[.,]\d+)*)/g, (_, number) => `${numberTokenToVietnameseWords(number)} tệ`)
    .replace(/([-+]?\d+(?:[.,]\d+)*)\s*¥/g, (_, number) => `${numberTokenToVietnameseWords(number)} tệ`)
    .replace(/£\s*([-+]?\d+(?:[.,]\d+)*)/g, (_, number) => `${numberTokenToVietnameseWords(number)} bảng Anh`)
    .replace(/([-+]?\d+(?:[.,]\d+)*)\s*£/g, (_, number) => `${numberTokenToVietnameseWords(number)} bảng Anh`);

  output = replaceUnits(output);

  output = output.replace(/(^|[^\p{L}\p{N}_])([-+]?\d+(?:[.,]\d+)*)(?=$|[^\p{L}\p{N}_])/gu, (match, prefix, number) => (
    `${prefix}${numberTokenToVietnameseWords(number)}`
  ));

  return normalizeText(output)
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function translatedTextContainsSourceNumber(translatedText = '', sourceNumber = '') {
  const translated = normalizeText(translatedText).toLowerCase();
  const raw = String(sourceNumber || '').trim();
  if (!raw) return true;
  if (translated.includes(raw.toLowerCase())) return true;
  const dotted = raw.replace(/,/g, '.');
  const comma = raw.replace(/\./g, ',');
  if (translated.includes(dotted.toLowerCase()) || translated.includes(comma.toLowerCase())) return true;
  const words = numberTokenToVietnameseWords(raw);
  return words ? translated.includes(words.toLowerCase()) : false;
}

module.exports = {
  integerToVietnameseWords,
  numberTokenToVietnameseWords,
  verbalizeVietnameseDubbingText,
  translatedTextContainsSourceNumber,
};
