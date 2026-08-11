const test = require('node:test');
const assert = require('node:assert/strict');

const {
  numberTokenToVietnameseWords,
  verbalizeVietnameseDubbingText,
  translatedTextContainsSourceNumber,
} = require('../services/vietnameseNumberText');

test('Vietnamese number text reads integers and decimals for dubbing', () => {
  assert.equal(numberTokenToVietnameseWords('6'), 'sáu');
  assert.equal(numberTokenToVietnameseWords('52'), 'năm mươi hai');
  assert.equal(numberTokenToVietnameseWords('9,32'), 'chín phẩy ba hai');
  assert.equal(numberTokenToVietnameseWords('1.000.000'), 'một triệu');
});

test('Vietnamese dubbing text verbalizes numbers and units', () => {
  assert.equal(
    verbalizeVietnameseDubbingText('Sahara rộng khoảng 9,32 triệu km vuông.'),
    'Sahara rộng khoảng chín phẩy ba hai triệu ki lô mét vuông.'
  );
  assert.equal(
    verbalizeVietnameseDubbingText('Trên xe có 52 người, còn cách Assamaka 80 km.'),
    'Trên xe có năm mươi hai người, còn cách Assamaka tám mươi cây số.'
  );
  assert.equal(
    verbalizeVietnameseDubbingText('Xe chạy 80 km/h.'),
    'Xe chạy tám mươi cây số trên giờ.'
  );
  assert.equal(
    verbalizeVietnameseDubbingText('Họ đi thêm 1,5 km.'),
    'Họ đi thêm một phẩy năm cây số.'
  );
  assert.equal(
    verbalizeVietnameseDubbingText('Xe chạy 1,5 km/h.'),
    'Xe chạy một phẩy năm cây số trên giờ.'
  );
  assert.equal(
    verbalizeVietnameseDubbingText('Tăng từ 15% lúc 10:30.'),
    'Tăng từ mười lăm phần trăm lúc mười rưỡi.'
  );
  assert.equal(
    verbalizeVietnameseDubbingText('Năm 2026, họ quay lại khu vực này.'),
    'Năm hai không hai sáu, họ quay lại khu vực này.'
  );
  assert.equal(
    verbalizeVietnameseDubbingText('Có 2026 người tham gia.'),
    'Có hai nghìn không trăm hai mươi sáu người tham gia.'
  );
  assert.equal(
    verbalizeVietnameseDubbingText('Sahara rộng 9,32 triệu cây số vuông, họ đi thêm 80 cây số.'),
    'Sahara rộng chín phẩy ba hai triệu ki lô mét vuông, họ đi thêm tám mươi cây số.'
  );
  assert.equal(
    verbalizeVietnameseDubbingText('Gió đạt 3 m/s và bơm 1,5 l/s.'),
    'Gió đạt ba mét trên giây và bơm một phẩy năm lít trên giây.'
  );
  assert.equal(
    verbalizeVietnameseDubbingText('Mật độ 120 người/km2, BMI 22 kg/m2.'),
    'Mật độ một trăm hai mươi người trên ki lô mét vuông, BMI hai mươi hai cân trên mét vuông.'
  );
  assert.equal(
    verbalizeVietnameseDubbingText('Ổ có 8 GB và 512 MB.'),
    'Ổ có tám ghi ga bai và năm trăm mười hai mê ga bai.'
  );
  assert.equal(
    verbalizeVietnameseDubbingText('Công suất 3 kW, điện áp 220 V.'),
    'Công suất ba ki lô oát, điện áp hai trăm hai mươi vôn.'
  );
  assert.equal(
    verbalizeVietnameseDubbingText('Giá 100 EUR, 50 NDT và £20.'),
    'Giá một trăm euro, năm mươi tệ và hai mươi bảng Anh.'
  );
  assert.equal(
    verbalizeVietnameseDubbingText('Hẹn lúc 7h30 và 3 PM.'),
    'Hẹn lúc bảy rưỡi và ba giờ chiều.'
  );
  assert.equal(
    verbalizeVietnameseDubbingText('Họ về thứ 2, top 3 có 12 tuổi.'),
    'Họ về thứ hai, top ba có mười hai tuổi.'
  );
  assert.equal(
    verbalizeVietnameseDubbingText('Nhiệt độ 50°F.'),
    'Nhiệt độ năm mươi độ F.'
  );
  assert.equal(
    verbalizeVietnameseDubbingText('Tốc độ mạng 100 Mbps, tải 20 MB/s.'),
    'Tốc độ mạng một trăm mê ga bit trên giây, tải hai mươi mê ga bai trên giây.'
  );
  assert.equal(
    verbalizeVietnameseDubbingText('Camera quay 60 fps, động cơ 3000 rpm.'),
    'Camera quay sáu mươi khung hình trên giây, động cơ ba nghìn vòng trên phút.'
  );
  assert.equal(
    verbalizeVietnameseDubbingText('Cách 5 miles, chạy 60 mph, cao 6 ft, nặng 150 lb.'),
    'Cách năm dặm, chạy sáu mươi dặm trên giờ, cao sáu feet, nặng một trăm năm mươi pao.'
  );
  assert.equal(
    verbalizeVietnameseDubbingText('Áp suất 120 mmHg, tần số 2,4 GHz.'),
    'Áp suất một trăm hai mươi mi li mét thủy ngân, tần số hai phẩy bốn ghi ga héc.'
  );
  assert.equal(
    verbalizeVietnameseDubbingText('Liều 500 mg, nồng độ 5 ppm.'),
    'Liều năm trăm mi li gam, nồng độ năm phần triệu.'
  );
  assert.equal(
    verbalizeVietnameseDubbingText('Pin 5000 mAh, điện trở 10 ohm, dùng 2 kWh.'),
    'Pin năm nghìn mi li ampe giờ, điện trở mười ôm, dùng hai ki lô oát giờ.'
  );
  assert.equal(
    verbalizeVietnameseDubbingText('Mất 500 ms và 30 sec.'),
    'Mất năm trăm mi li giây và ba mươi giây.'
  );
  assert.equal(
    verbalizeVietnameseDubbingText('Diện tích 3 acres, thể tích 250 cc, góc 45°.'),
    'Diện tích ba mẫu Anh, thể tích hai trăm năm mươi xê xê, góc bốn mươi lăm độ.'
  );
  assert.equal(
    verbalizeVietnameseDubbingText('Nhận 5 AUD và 0,5 BTC.'),
    'Nhận năm đô Úc và không phẩy năm bitcoin.'
  );
});

test('Vietnamese unit verbalizer does not replace letters inside words or corrupt fragments', () => {
  const unchanged = [
    'này',
    'ngày',
    'mấy',
    'ấy',
    'hay',
    'Sau mấy ngày xuất phát.',
    'Vì vậy, những chiếc xe kiểu này rất hay hỏng giữa sa mạc.',
    'Phần lớn số nước ấy đã gần như cạn sạch.',
    'Ông George W. Bush phát biểu.',
  ];
  for (const sample of unchanged) {
    assert.equal(verbalizeVietnameseDubbingText(sample), sample);
  }
  assert.equal(verbalizeVietnameseDubbingText('m?t'), 'm?t');
  assert.equal(verbalizeVietnameseDubbingText('l?'), 'l?');
  assert.equal(verbalizeVietnameseDubbingText('Còn cách Assamaka 80 km.'), 'Còn cách Assamaka tám mươi cây số.');
});

test('number QC accepts Vietnamese words as preserving source numbers', () => {
  assert.equal(translatedTextContainsSourceNumber('có năm mươi hai người', '52'), true);
  assert.equal(translatedTextContainsSourceNumber('rộng chín phẩy ba hai triệu ki lô mét vuông', '9,32'), true);
  assert.equal(translatedTextContainsSourceNumber('không nhắc số nào', '52'), false);
});
