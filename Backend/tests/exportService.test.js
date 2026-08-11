const test = require('node:test');
const assert = require('node:assert/strict');

const { _private } = require('../services/exportService');

test('display subtitles keep each cue on one line', () => {
  const text = 'Trong hang động tối tăm ẩm ướt, nhóm thầy trò kinh hãi nhìn về phía trước vì lối thoát đã bị nước lũ chặn đứng.';
  const wrapped = _private.wrapSubtitleText(text, 37);
  const lines = wrapped.split('\n');

  assert.equal(lines.length, 1);
  assert.equal(wrapped, text);
});

test('display subtitle optimization splits merged cues without losing text', () => {
  const text = 'Trong hang động tối tăm ẩm ướt, nhóm thầy trò kinh hãi nhìn về phía trước vì lối thoát đã bị nước lũ chặn đứng. Thầy giáo dẫn đầu quyết định nối thành hàng người để học sinh lội qua từng người một.';
  const output = _private.buildDisplaySubtitleSegments([
    { id: 'row-1', start: 0, end: 6.9, text },
  ], {
    maxChars: 74,
    maxLineLength: 37,
  });

  assert.ok(output.length > 1);
  assert.equal(output.map((segment) => segment.text.replace(/\n/g, ' ')).join(' '), text);
  assert.equal(output[0].start, 0);
  assert.equal(output.at(-1).end, 6.9);
  assert.ok(output.every((segment, index) => index === 0 || segment.start >= output[index - 1].end));
  assert.ok(output.every((segment) => !segment.text.includes('\n')));
});

test('display subtitle optimization supports portrait cue lengths below 24 chars', () => {
  const text = 'abcdefghijklmnopqrstuvwxyz1234567890';
  const output = _private.buildDisplaySubtitleSegments([
    { id: 'row-1', start: 0, end: 4, text },
  ], {
    maxChars: 18,
    maxLineLength: 18,
  });

  assert.ok(output.length > 1);
  assert.equal(output.map((segment) => segment.text.replace(/\n/g, '')).join(''), text);
  assert.ok(output.every((segment) => segment.text.length <= 18));
});

test('subtitle cover rebuilds the full band from both neighboring strips and feathers the join', () => {
  const cover = _private.normalizeSubtitleCover({
    subtitleCoverEnabled: true,
    subtitleCoverMode: 'blur',
    subtitleCoverBlur: 18,
    subtitleCoverFeather: 14,
    subtitleCoverX: 20,
    subtitleCoverY: 80,
    subtitleCoverW: 60,
    subtitleCoverH: 8,
  });
  const filters = [];
  const outputLabel = _private.appendSubtitleCoverFilter(filters, '0:v:0', cover, 0);
  const graph = filters.join(';');

  assert.equal(outputLabel, 'vcover0');
  assert.match(graph, /split=5/);
  assert.match(graph, /crop=w='max\(2\\,iw\*0\.6000\)'/);
  assert.match(graph, /y='ih\*0\.7160'/);
  assert.match(graph, /y='ih\*0\.8840'/);
  assert.match(graph, /blend=all_expr='A\*\(1-Y\/H\)\+B\*\(Y\/H\)'/);
  assert.match(graph, /gblur=sigma=1\.13:steps=1/);
  assert.match(graph, /overlay=x='main_w\*0\.2000':y='main_h\*0\.8000':shortest=1/);
  assert.match(graph, /geq=lum=/);
  assert.match(graph, /hypot\(max\(abs\(X-\(W\*0\.2000\+W\*0\.8000\)\/2\)-max\(\(W\*0\.8000-W\*0\.2000\)\/2-min\(/);
  assert.match(graph, /:cb=/);
  assert.match(graph, /:cr=/);
  assert.doesNotMatch(graph, /format=gray/);
  assert.match(graph, /gblur=sigma=14\.00:steps=2/);
  assert.match(graph, /maskedmerge\[vcover0\]/);
  assert.doesNotMatch(graph, /boxblur=/);
});

test('output aspect ratio adds fit-to-canvas padding filter', () => {
  const filters = [];
  const outputLabel = _private.appendOutputAspectFilter(filters, '0:v:0', '9:16');
  const graph = filters.join(';');

  assert.equal(outputLabel, 'vaspect0');
  assert.match(graph, /scale=w='if\(gt\(a\\,0\.56250000\)/);
  assert.match(graph, /pad=w='if\(gt\(a\\,0\.56250000\)/);
  assert.match(graph, /color=black,setsar=1\[vaspect0\]/);
  assert.equal(_private.normalizeOutputAspectRatio('4:3'), '4:3');
  assert.equal(_private.normalizeOutputAspectRatio('bad'), 'source');
});

test('logo overlay scales against the main video dimensions', () => {
  const filters = [];
  const outputLabel = _private.appendLogoOverlayFilter(filters, '0:v:0', '2:v', {
    logoSize: 18,
    logoOpacity: 75,
    logoPosition: 'custom',
    logoX: 88,
    logoY: 12,
  });
  const graph = filters.join(';');

  assert.equal(outputLabel, 'vlogoout0');
  assert.match(graph, /\[2:v\]format=rgba,colorchannelmixer=aa=0\.75\[logo0rgba\]/);
  assert.match(graph, /\[logo0rgba\]\[0:v:0\]scale2ref=w='main_w\*0\.1800':h='ow\/mdar'\[logo0\]\[vlogo0\]/);
  assert.match(graph, /\[vlogo0\]\[logo0\]overlay=main_w\*0\.8800-overlay_w\/2:main_h\*0\.1200-overlay_h\/2\[vlogoout0\]/);
  assert.doesNotMatch(graph, /scale=iw\*0\.180/);
});

test('soft subtitle codec matches the export container', () => {
  assert.equal(_private.softSubtitleCodecForOutput('clip.mp4'), 'mov_text');
  assert.equal(_private.softSubtitleCodecForOutput('clip.mkv'), 'srt');
  assert.equal(_private.softSubtitleCodecForOutput('clip.avi'), '');
});
