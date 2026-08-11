const fs = require('fs').promises;
const fsNative = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

function resolveBundledTool(command) {
  const exeName = process.platform === 'win32' ? `${command}.exe` : command;
  const candidates = [
    path.resolve(__dirname, '..', '..', 'tools', 'ffmpeg', 'dist', 'bin', exeName),
    path.resolve(process.cwd(), 'tools', 'ffmpeg', 'dist', 'bin', exeName),
  ];
  return candidates.find((candidate) => fsNative.existsSync(candidate)) || command;
}

function formatSrtTime(seconds) {
  const totalMs = Math.max(0, Math.round(Number(seconds || 0) * 1000));
  const hours = String(Math.floor(totalMs / 3600000)).padStart(2, '0');
  const minutes = String(Math.floor((totalMs % 3600000) / 60000)).padStart(2, '0');
  const secs = String(Math.floor((totalMs % 60000) / 1000)).padStart(2, '0');
  const ms = String(totalMs % 1000).padStart(3, '0');
  return `${hours}:${minutes}:${secs},${ms}`;
}

function formatVttTime(seconds) {
  return formatSrtTime(seconds).replace(',', '.');
}

function formatAssTime(seconds) {
  const totalCs = Math.max(0, Math.round(Number(seconds || 0) * 100));
  const hours = Math.floor(totalCs / 360000);
  const minutes = Math.floor((totalCs % 360000) / 6000);
  const secs = Math.floor((totalCs % 6000) / 100);
  const cs = totalCs % 100;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function normalizeSubtitleText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function splitLongSubtitleText(text, maxChars = 74) {
  let rest = normalizeSubtitleText(text);
  const chunks = [];

  while (rest.length > maxChars) {
    let cut = -1;
    // Prefer a punctuation boundary just after the nominal limit over splitting
    // a Vietnamese phrase in the middle. The allowance still fits one line.
    const punctuationSearchArea = rest.slice(0, Math.ceil(maxChars * 1.3) + 1);
    for (const pattern of [/[.!?;:。！？；：,，]\s/g]) {
      let match;
      while ((match = pattern.exec(punctuationSearchArea))) {
        cut = match.index + match[0].length;
      }
    }

    if (cut < Math.floor(maxChars * 0.45)) {
      cut = -1;
      const searchArea = rest.slice(0, maxChars + 1);
      const pattern = /\s/g;
      let match;
      while ((match = pattern.exec(searchArea))) {
        cut = match.index + match[0].length;
      }
    }

    if (cut < 1) cut = maxChars;
    chunks.push(normalizeSubtitleText(rest.slice(0, cut)));
    rest = normalizeSubtitleText(rest.slice(cut));
  }

  if (rest) chunks.push(rest);
  return chunks;
}

function wrapSubtitleText(text, maxLineLength = 34) {
  return normalizeSubtitleText(text);
}

function subtitleRenderScale(subtitleStyle = {}) {
  const scale = Number(subtitleStyle.renderScale ?? subtitleStyle.exportScale ?? 1);
  return Math.max(0.1, Math.min(10, Number.isFinite(scale) ? scale : 1));
}

function exportSubtitleFontSize(subtitleStyle = {}, lineCount = 1) {
  const base = Math.max(10, Math.min(96, Number(subtitleStyle.fontSize || 32)));
  const scale = lineCount > 3 ? 0.74 : lineCount > 2 ? 0.86 : 1;
  return Math.max(10, base * scale * subtitleRenderScale(subtitleStyle));
}

function startsWithDependentWord(text) {
  return /^(này|đó|ấy|kia|rằng|và|hoặc|nhưng|mà|của|cho|với|tại|ở|để|là|mét|km|kilomet|ki-lô-mét|centimet|cm|milimét|mm|độ|phút|giây|năm|tuổi|ngày|tháng|đô|đồng|%|,|\.|;|:|\)|\])/i.test(normalizeSubtitleText(text));
}

function endsWithDanglingNumber(text) {
  return /(?:^|\s)(\d+|một|hai|ba|bốn|năm|sáu|bảy|tám|chín|mười)$/i.test(normalizeSubtitleText(text));
}

function repairSubtitleChunks(chunks, maxChars) {
  const repaired = [];
  const minChunkChars = Math.max(12, Math.floor(maxChars * 0.26));

  for (const rawChunk of chunks) {
    const chunk = normalizeSubtitleText(rawChunk);
    if (!chunk) continue;

    const previous = repaired[repaired.length - 1];
    const shouldAttachToPrevious = previous && (
      chunk.length < minChunkChars
      || startsWithDependentWord(chunk)
      || endsWithDanglingNumber(previous)
    );

    if (shouldAttachToPrevious && `${previous} ${chunk}`.length <= Math.round(maxChars * 1.35)) {
      repaired[repaired.length - 1] = normalizeSubtitleText(`${previous} ${chunk}`);
    } else {
      repaired.push(chunk);
    }
  }

  return repaired;
}

function buildDisplaySubtitleSegments(segments, options = {}) {
  const maxLineLength = Number(options.maxLineLength || 32);
  // A display cue is a timed, single-line beat.  Do not treat this as a
  // two-line wrapping limit: long narration must become consecutive cues.
  const maxChars = Math.max(18, Number(options.maxChars || maxLineLength));
  return segments
    .flatMap((segment) => {
      const text = normalizeSubtitleText(segment.text);
      if (!text) return [];

      const chunks = repairSubtitleChunks(splitLongSubtitleText(text, maxChars), maxChars);
      if (chunks.length <= 1) {
        return [{ ...segment, text }];
      }

      const start = Number(segment.start) || 0;
      const end = Math.max(start + 0.01, Number(segment.end) || start + Number(segment.duration) || start + 1);
      const duration = Math.max(0.01, end - start);
      const totalWeight = chunks.reduce((sum, chunk) => sum + Math.max(1, chunk.length), 0);
      let cursor = start;

      return chunks.map((chunk, index) => {
        const isLast = index === chunks.length - 1;
        const chunkDuration = isLast ? end - cursor : duration * (Math.max(1, chunk.length) / totalWeight);
        const chunkEnd = isLast ? end : Math.min(end, cursor + Math.max(0.01, chunkDuration));
        const output = {
          ...segment,
          start: cursor,
          end: chunkEnd,
          duration: Math.max(0.01, chunkEnd - cursor),
          // Keep each generated cue on one line, exactly as the editor preview.
          text: chunk,
        };
        cursor = chunkEnd;
        return output;
      });
    })
    .filter((segment) => normalizeSubtitleText(segment.text));
}

function parseSrtForAss(content) {
  return String(content || '')
    .replace(/\r/g, '')
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split('\n').filter((line) => line.trim());
      const timingIndex = lines.findIndex((line) => /-->\s*/.test(line));
      if (timingIndex < 0) return null;
      const timing = lines[timingIndex];
      const match = timing.match(/(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/);
      if (!match) return null;
      const toSeconds = (value) => {
        const [hh, mm, rest] = value.replace(',', '.').split(':');
        const [ss, ms = '0'] = rest.split('.');
        return Number(hh) * 3600 + Number(mm) * 60 + Number(ss) + Number(ms.padEnd(3, '0').slice(0, 3)) / 1000;
      };
      const text = lines.slice(timingIndex + 1).join('\\N');
      return { start: toSeconds(match[1]), end: toSeconds(match[2]), text };
    })
    .filter(Boolean);
}

function hexToAssColor(hex, alpha = 0) {
  const clean = String(hex || '#ffffff').replace('#', '').padEnd(6, '0').slice(0, 6);
  const red = clean.slice(0, 2);
  const green = clean.slice(2, 4);
  const blue = clean.slice(4, 6);
  const assAlpha = Math.round(Math.min(1, Math.max(0, Number(alpha) || 0)) * 255).toString(16).padStart(2, '0');
  return `&H${assAlpha}${blue}${green}${red}`;
}

function assEscapeText(text) {
  return String(text || '')
    .replace(/\{/g, '')
    .replace(/\}/g, '')
    .replace(/\\n/g, '\\N')
    .replace(/\n/g, '\\N')
    .trim();
}

function subtitleTextWidth(text, fontSize) {
  return Array.from(String(text || '')).reduce((width, char) => {
    if (/\s/.test(char)) return width + fontSize * 0.32;
    if (/[\u3000-\u9fff\uff00-\uffef]/.test(char)) return width + fontSize;
    if (/[A-Z]/.test(char)) return width + fontSize * 0.68;
    if (/[.,;:!?'"()[\]{}]/.test(char)) return width + fontSize * 0.36;
    if (/[0-9]/.test(char)) return width + fontSize * 0.55;
    if (char.charCodeAt(0) > 127) return width + fontSize * 0.62;
    return width + fontSize * 0.56;
  }, 0);
}

function subtitleAssBoxTextWidth(text, fontSize) {
  return Array.from(String(text || '')).reduce((width, char) => {
    if (/\s/.test(char)) return width + fontSize * 0.28;
    if (/[\u3000-\u9fff\uff00-\uffef]/.test(char)) return width + fontSize;
    if (/[A-Z]/.test(char)) return width + fontSize * 0.64;
    if (/[.,;:!?'"()[\]{}]/.test(char)) return width + fontSize * 0.3;
    if (/[0-9]/.test(char)) return width + fontSize * 0.52;
    if (char.charCodeAt(0) > 127) return width + fontSize * 0.54;
    return width + fontSize * 0.52;
  }, 0);
}

function roundedRectPath(width, height, radius) {
  const halfWidth = Math.round(width / 2);
  const halfHeight = Math.round(height / 2);
  const r = Math.round(Math.min(radius, halfWidth, halfHeight));
  if (r <= 0) {
    return `m ${-halfWidth} ${-halfHeight} l ${halfWidth} ${-halfHeight} l ${halfWidth} ${halfHeight} l ${-halfWidth} ${halfHeight}`;
  }
  return [
    `m ${-halfWidth + r} ${-halfHeight}`,
    `l ${halfWidth - r} ${-halfHeight}`,
    `b ${halfWidth - Math.round(r / 2)} ${-halfHeight} ${halfWidth} ${-halfHeight + Math.round(r / 2)} ${halfWidth} ${-halfHeight + r}`,
    `l ${halfWidth} ${halfHeight - r}`,
    `b ${halfWidth} ${halfHeight - Math.round(r / 2)} ${halfWidth - Math.round(r / 2)} ${halfHeight} ${halfWidth - r} ${halfHeight}`,
    `l ${-halfWidth + r} ${halfHeight}`,
    `b ${-halfWidth + Math.round(r / 2)} ${halfHeight} ${-halfWidth} ${halfHeight - Math.round(r / 2)} ${-halfWidth} ${halfHeight - r}`,
    `l ${-halfWidth} ${-halfHeight + r}`,
    `b ${-halfWidth} ${-halfHeight + Math.round(r / 2)} ${-halfWidth + Math.round(r / 2)} ${-halfHeight} ${-halfWidth + r} ${-halfHeight}`,
  ].join(' ');
}

function roundedRectPathFromOrigin(width, height, radius) {
  const safeWidth = Math.max(1, Math.round(width));
  const safeHeight = Math.max(1, Math.round(height));
  const r = Math.round(Math.min(Math.max(0, radius), safeWidth / 2, safeHeight / 2));
  if (r <= 0) {
    return `m 0 0 l ${safeWidth} 0 l ${safeWidth} ${safeHeight} l 0 ${safeHeight}`;
  }
  return [
    `m ${r} 0`,
    `l ${safeWidth - r} 0`,
    `b ${safeWidth - Math.round(r / 2)} 0 ${safeWidth} ${Math.round(r / 2)} ${safeWidth} ${r}`,
    `l ${safeWidth} ${safeHeight - r}`,
    `b ${safeWidth} ${safeHeight - Math.round(r / 2)} ${safeWidth - Math.round(r / 2)} ${safeHeight} ${safeWidth - r} ${safeHeight}`,
    `l ${r} ${safeHeight}`,
    `b ${Math.round(r / 2)} ${safeHeight} 0 ${safeHeight - Math.round(r / 2)} 0 ${safeHeight - r}`,
    `l 0 ${r}`,
    `b 0 ${Math.round(r / 2)} ${Math.round(r / 2)} 0 ${r} 0`,
  ].join(' ');
}

function subtitlePositionPoint(subtitleStyle, playResX, playResY) {
  const position = String(subtitleStyle.position || '').toLowerCase();
  if (position === 'custom') {
    return {
      x: Math.round(Math.min(97, Math.max(3, Number(subtitleStyle.positionX ?? 50))) / 100 * playResX),
      y: Math.round(Math.min(95, Math.max(5, Number(subtitleStyle.positionY ?? 88))) / 100 * playResY),
    };
  }
  if (position === 'top') return { x: Math.round(playResX / 2), y: 78 };
  if (position === 'center') return { x: Math.round(playResX / 2), y: Math.round(playResY / 2) };
  return { x: Math.round(playResX / 2), y: playResY - 84 };
}

async function createRoundedAssSubtitle(subtitlePath, subtitleStyle = {}) {
  const content = await fs.readFile(subtitlePath, 'utf8');
  const entries = parseSrtForAss(content);
  const assPath = subtitlePath.replace(/\.(srt|vtt|ass)$/i, '') + '.rounded_box.ass';
  const playResX = 1920;
  const playResY = 1080;
  const position = subtitlePositionPoint(subtitleStyle, playResX, playResY);
  const backgroundAlpha = Math.min(1, Math.max(0, Number(subtitleStyle.backgroundOpacity ?? subtitleStyle.boxOpacity ?? 0) / 100));
  const backgroundColor = subtitleStyle.backgroundColor || subtitleStyle.boxColor || '#000000';
  const outlineEnabled = subtitleStyle.outlineEnabled === true;
  const baseFontSize = exportSubtitleFontSize(subtitleStyle);
  const renderScale = subtitleRenderScale(subtitleStyle);
  const radius = Math.max(0, Math.min(96, Number(subtitleStyle.backgroundRadius ?? subtitleStyle.boxRadius ?? 0) * renderScale));
  const maxLineLength = Math.max(18, Math.min(40, Number(subtitleStyle.maxCharsPerLine || subtitleStyle.maxLineLength || 32)));
  const textStyle = [
    String(subtitleStyle.fontFamily || 'Arial').replace(/,/g, ''),
    baseFontSize.toFixed(0),
    hexToAssColor(subtitleStyle.textColor || '#ffffff', 0),
    '&H000000FF',
    backgroundAlpha > 0
      ? hexToAssColor(backgroundColor, 1 - backgroundAlpha)
      : hexToAssColor(subtitleStyle.outlineColor || '#000000', outlineEnabled ? 0.08 : 1),
    '&HFF000000',
    '-1',
    '0',
    '0',
    '0',
    '100',
    '100',
    '0',
    '0',
    '1',
    outlineEnabled ? '3' : '0',
    '0',
    '5',
    '20',
    '20',
    '20',
    '1',
  ].join(',');
  const boxStyle = [
    'Arial',
    '1',
    hexToAssColor(backgroundColor, 1 - backgroundAlpha),
    '&H000000FF',
    '&HFF000000',
    '&HFF000000',
    '0',
    '0',
    '0',
    '0',
    '100',
    '100',
    '0',
    '0',
    '1',
    '0',
    '0',
    '5',
    '0',
    '0',
    '0',
    '1',
  ].join(',');
  const dialogueLines = entries.flatMap((entry) => {
    const wrappedText = wrapSubtitleText(String(entry.text || '').replace(/\\N/g, ' '), maxLineLength);
    const lines = String(wrappedText || '').split(/\n/);
    const entryFontSize = exportSubtitleFontSize(subtitleStyle, Math.max(1, lines.filter(Boolean).length));
    const entryPaddingX = backgroundAlpha > 0 ? 14 * renderScale : 0;
    const entryPaddingY = backgroundAlpha > 0 ? 2.5 * renderScale : 0;
    const maxLineWidth = Math.max(...lines.map((line) => subtitleTextWidth(line, entryFontSize)), entryFontSize);
    const width = Math.min(playResX * 0.94, Math.max(entryFontSize * 2, maxLineWidth + entryPaddingX * 2));
    const height = Math.max(entryFontSize * 1.25, (lines.length * entryFontSize * 1.25) + entryPaddingY * 2);
    const path = roundedRectPath(width, height, radius);
    const start = formatAssTime(entry.start);
    const end = formatAssTime(entry.end);
    return [
      `Dialogue: 0,${start},${end},SubtitleBox,,0,0,0,,{\\an5\\pos(${position.x},${position.y})\\p1}${path}`,
      `Dialogue: 1,${start},${end},SubtitleText,,0,0,0,,{\\an5\\pos(${position.x},${position.y})\\fs${entryFontSize.toFixed(0)}}${assEscapeText(wrappedText)}`,
    ];
  });
  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${playResX}`,
    `PlayResY: ${playResY}`,
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: SubtitleText,${textStyle}`,
    `Style: SubtitleBox,${boxStyle}`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...dialogueLines,
    '',
  ];
  await fs.writeFile(assPath, lines.join('\n'), 'utf8');
  return assPath;
}

async function createPositionedAssSubtitle(subtitlePath, subtitleStyle = {}) {
  const content = await fs.readFile(subtitlePath, 'utf8');
  const entries = parseSrtForAss(content);
  const assPath = subtitlePath.replace(/\.(srt|vtt|ass)$/i, '') + '.custom_position.ass';
  const playResX = 1920;
  const playResY = 1080;
  const position = subtitlePositionPoint(subtitleStyle, playResX, playResY);
  // `boxEnabled` is intentional.  Do not infer it from opacity: the preview can
  // have a black colour saved while its subtitle box is switched off.
  const boxEnabled = subtitleStyle.boxEnabled === true
    || (subtitleStyle.boxEnabled === undefined
      && Number(subtitleStyle.backgroundOpacity ?? subtitleStyle.boxOpacity ?? 0) > 0);
  const backgroundAlpha = boxEnabled
    ? Math.min(1, Math.max(0, Number(subtitleStyle.backgroundOpacity ?? subtitleStyle.boxOpacity ?? 0) / 100))
    : 0;
  const backgroundColor = subtitleStyle.backgroundColor || subtitleStyle.boxColor || '#000000';
  const outlineEnabled = subtitleStyle.outlineEnabled === true;
  const renderScale = subtitleRenderScale(subtitleStyle);
  const baseFontSize = exportSubtitleFontSize(subtitleStyle).toFixed(0);
  const boxRadius = Math.max(0, Number(subtitleStyle.backgroundRadius ?? subtitleStyle.boxRadius ?? 0) * renderScale);
  const maxLineLength = Math.max(18, Math.min(40, Number(subtitleStyle.maxCharsPerLine || subtitleStyle.maxLineLength || 32)));
  const style = [
    String(subtitleStyle.fontFamily || 'Arial').replace(/,/g, ''),
    baseFontSize,
    hexToAssColor(subtitleStyle.textColor || '#ffffff', 0),
    '&H000000FF',
    backgroundAlpha > 0
      ? hexToAssColor(backgroundColor, 1 - backgroundAlpha)
      : hexToAssColor(subtitleStyle.outlineColor || '#000000', outlineEnabled ? 0.08 : 1),
    // A fully transparent BackColour is required when the preview box is off.
    // Some libass builds still paint BackColour with BorderStyle=1 otherwise.
    backgroundAlpha > 0 ? hexToAssColor(backgroundColor, 1 - backgroundAlpha) : '&HFF000000',
    '-1',
    '0',
    '0',
    '0',
    '100',
    '100',
    '0',
    '0',
    '1',
    '0',
    '0',
    '5',
    '20',
    '20',
    '20',
    '1',
  ].join(',');
  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${playResX}`,
    `PlayResY: ${playResY}`,
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${style}`,
    `Style: SubtitleBox,Arial,1,${hexToAssColor(backgroundColor, 1 - backgroundAlpha)},&H000000FF,&HFF000000,&HFF000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...entries.flatMap((entry) => {
      // A manual timeline row is rendered as one line. Long narration has
      // already been split into sequential timed cues by buildDisplaySubtitleSegments.
      const wrappedText = normalizeSubtitleText(String(entry.text || '').replace(/\\N/g, ' '));
      const lineCount = 1;
      const entryFontSize = exportSubtitleFontSize(subtitleStyle, lineCount).toFixed(0);
      const boxPaddingX = Math.max(0, Number(subtitleStyle.boxPaddingX ?? 7) * renderScale);
      const boxPaddingY = Math.max(0, Number(subtitleStyle.boxPaddingY ?? 3) * renderScale);
      const numericFontSize = Number(entryFontSize) || Number(baseFontSize) || 32;
      const lines = [wrappedText];
      const textWidth = Math.max(...lines.map((line) => subtitleAssBoxTextWidth(line, numericFontSize)), numericFontSize);
      const boxWidth = Math.min(playResX * 0.94, textWidth + boxPaddingX * 2);
      const boxHeight = Math.max(numericFontSize * 1.25, lines.length * numericFontSize * 1.25 + boxPaddingY * 2);
      const boxLeft = Math.round(position.x - boxWidth / 2);
      const boxTop = Math.round(position.y - boxHeight / 2);
      const boxLine = backgroundAlpha > 0
        ? `Dialogue: 0,${formatAssTime(entry.start)},${formatAssTime(entry.end)},SubtitleBox,,0,0,0,,{\\an7\\pos(${boxLeft},${boxTop})\\p1}${roundedRectPathFromOrigin(boxWidth, boxHeight, boxRadius)}`
        : '';
      const textLine = `Dialogue: 1,${formatAssTime(entry.start)},${formatAssTime(entry.end)},Default,,0,0,0,,{\\an5\\pos(${position.x},${position.y})\\fs${entryFontSize}}${assEscapeText(wrappedText)}`;
      return [boxLine, textLine].filter(Boolean);
    }),
    '',
  ];
  await fs.writeFile(assPath, lines.join('\n'), 'utf8');
  return assPath;
}

function subtitleAlignment(position) {
  switch (String(position || '').toLowerCase()) {
    case 'top':
      return { alignment: 8, marginV: 48 };
    case 'center':
      return { alignment: 5, marginV: 0 };
    case 'bottom':
    default:
      return { alignment: 2, marginV: 54 };
  }
}

async function buildSubtitleFilter(subtitlePath, subtitleStyle = {}) {
  const subtitleSourcePath = await createPositionedAssSubtitle(subtitlePath, subtitleStyle);
  const subtitleFile = path.basename(subtitleSourcePath || 'translated.srt').replace(/'/g, "\\'");
  return `subtitles='${subtitleFile}'`;
}

function logoOverlayPosition(position, options = {}) {
  const margin = 24;
  if (String(position || '').toLowerCase() === 'custom') {
    const x = Math.min(100, Math.max(0, Number(options.logoX ?? 88))) / 100;
    const y = Math.min(100, Math.max(0, Number(options.logoY ?? 12))) / 100;
    return `main_w*${x.toFixed(4)}-overlay_w/2:main_h*${y.toFixed(4)}-overlay_h/2`;
  }
  switch (String(position || 'top-right').toLowerCase()) {
    case 'top-left':
      return `${margin}:${margin}`;
    case 'top-center':
      return `(main_w-overlay_w)/2:${margin}`;
    case 'middle-left':
      return `${margin}:(main_h-overlay_h)/2`;
    case 'center':
      return `(main_w-overlay_w)/2:(main_h-overlay_h)/2`;
    case 'middle-right':
      return `main_w-overlay_w-${margin}:(main_h-overlay_h)/2`;
    case 'bottom-left':
      return `${margin}:main_h-overlay_h-${margin}`;
    case 'bottom-center':
      return `(main_w-overlay_w)/2:main_h-overlay_h-${margin}`;
    case 'bottom-right':
      return `main_w-overlay_w-${margin}:main_h-overlay_h-${margin}`;
    case 'top-right':
    default:
      return `main_w-overlay_w-${margin}:${margin}`;
  }
}

function appendLogoOverlayFilter(filters, videoLabel, logoInputLabel, exportOptions = {}) {
  const sizeRatio = Math.min(0.8, Math.max(0.001, Number(exportOptions.logoSize ?? 18) / 100));
  const opacity = Math.min(1, Math.max(0, Number(exportOptions.logoOpacity ?? 90) / 100));
  const index = filters.length;
  const rgbaLabel = `logo${index}rgba`;
  const logoLabel = `logo${index}`;
  const baseLabel = `vlogo${index}`;
  const outputLabel = `vlogoout${index}`;
  filters.push(`[${logoInputLabel}]format=rgba,colorchannelmixer=aa=${opacity.toFixed(2)}[${rgbaLabel}]`);
  filters.push(`[${rgbaLabel}][${videoLabel}]scale2ref=w='main_w*${sizeRatio.toFixed(4)}':h='ow/mdar'[${logoLabel}][${baseLabel}]`);
  const randomEnable = exportOptions.randomLogoText
    ? `:enable='lt(mod(t\\,${Math.max(1, Number(exportOptions.randomIntervalSeconds || 5)).toFixed(2)})\\,${Math.max(0.5, Number(exportOptions.randomIntervalSeconds || 5) / 2).toFixed(2)})'`
    : '';
  filters.push(`[${baseLabel}][${logoLabel}]overlay=${logoOverlayPosition(exportOptions.logoPosition, exportOptions)}${randomEnable}[${outputLabel}]`);
  return outputLabel;
}

function hexToDrawboxColor(hex, opacity = 100) {
  const clean = String(hex || '#000000').replace('#', '').padEnd(6, '0').slice(0, 6);
  const alpha = Math.min(1, Math.max(0, Number(opacity ?? 100) / 100));
  return `0x${clean}@${alpha.toFixed(3)}`;
}

function normalizeSubtitleCover(options = {}) {
  if (!options.subtitleCoverEnabled && !options.coverEnabled && !options.subtitleStyle?.coverEnabled) {
    return null;
  }
  const style = options.subtitleStyle || {};
  const x = Math.min(100, Math.max(0, Number(options.subtitleCoverX ?? style.coverX ?? 18)));
  const y = Math.min(100, Math.max(0, Number(options.subtitleCoverY ?? style.coverY ?? 82)));
  const w = Math.min(100, Math.max(1, Number(options.subtitleCoverW ?? style.coverW ?? 64)));
  const h = Math.min(100, Math.max(1, Number(options.subtitleCoverH ?? style.coverH ?? 10)));
  return {
    x,
    y,
    w,
    h,
    mode: String(options.subtitleCoverMode ?? style.coverMode ?? 'blur').toLowerCase(),
    blur: Math.max(1, Math.min(60, Number(options.subtitleCoverBlur ?? style.coverBlur ?? 18))),
    feather: Math.max(1, Math.min(40, Number(options.subtitleCoverFeather ?? style.coverFeather ?? 12))),
    color: hexToDrawboxColor(options.subtitleCoverColor ?? style.coverColor ?? '#000000', options.subtitleCoverOpacity ?? style.coverOpacity ?? 85),
  };
}

function appendSubtitleCoverFilter(filters, videoLabel, cover, index = 0) {
  if (!cover) return videoLabel;
  const outputLabel = `vcover${index}`;
  if (cover.mode === 'box' || cover.mode === 'solid') {
    filters.push(`[${videoLabel}]drawbox=x=iw*${(cover.x / 100).toFixed(4)}:y=ih*${(cover.y / 100).toFixed(4)}:w=iw*${(cover.w / 100).toFixed(4)}:h=ih*${(cover.h / 100).toFixed(4)}:color=${cover.color}:t=fill[${outputLabel}]`);
    return outputLabel;
  }

  const baseLabel = `coverbase${index}`;
  const fillBaseLabel = `coverfillbase${index}`;
  const upperInputLabel = `coverupperinput${index}`;
  const lowerInputLabel = `coverlowerinput${index}`;
  const maskInputLabel = `covermaskinput${index}`;
  const upperPatchLabel = `coverupperpatch${index}`;
  const lowerPatchLabel = `coverlowerpatch${index}`;
  const blendedPatchLabel = `coverblendedpatch${index}`;
  const patchLabel = `coverpatch${index}`;
  const fillLabel = `coverfill${index}`;
  const maskLabel = `covermask${index}`;
  const xRatio = cover.x / 100;
  const yRatio = cover.y / 100;
  const widthRatio = cover.w / 100;
  const heightRatio = cover.h / 100;
  const canSampleAbove = cover.y >= cover.h * 1.05;
  const canSampleBelow = cover.y + cover.h * 2.05 <= 100;
  const fallbackY = Math.max(0, Math.min(100 - cover.h, cover.y));
  const upperSourceY = canSampleAbove
    ? cover.y - cover.h * 1.05
    : canSampleBelow
      ? cover.y + cover.h * 1.05
      : fallbackY;
  const lowerSourceY = canSampleBelow
    ? cover.y + cover.h * 1.05
    : upperSourceY;
  const upperSourceYRatio = upperSourceY / 100;
  const lowerSourceYRatio = lowerSourceY / 100;
  const patchBlur = Math.max(0.6, Math.min(3, cover.blur / 16));
  const feather = Math.max(1, Math.min(40, Number(cover.feather ?? 12)));
  const featherText = feather.toFixed(2);
  const xStart = `W*${xRatio.toFixed(4)}`;
  const xEnd = `W*${(xRatio + widthRatio).toFixed(4)}`;
  const yStart = `H*${yRatio.toFixed(4)}`;
  const yEnd = `H*${(yRatio + heightRatio).toFixed(4)}`;
  const xCenter = `(${xStart}+${xEnd})/2`;
  const yCenter = `(${yStart}+${yEnd})/2`;
  const halfWidth = `(${xEnd}-${xStart})/2`;
  const halfHeight = `(${yEnd}-${yStart})/2`;
  const cornerRadius = `min(${halfWidth}\\,${halfHeight})`;
  const innerHalfWidth = `max(${halfWidth}-${cornerRadius}\\,0)`;
  const innerHalfHeight = `max(${halfHeight}-${cornerRadius}\\,0)`;
  const cornerDistance = `hypot(max(abs(X-${xCenter})-${innerHalfWidth}\\,0)\\,max(abs(Y-${yCenter})-${innerHalfHeight}\\,0))`;
  const maskExpression = `255*lte(${cornerDistance}\\,${cornerRadius})`;

  // Rebuild the complete covered band across its full width. Clean strips from
  // above and below are blended vertically, then only the outer join is feathered.
  filters.push(`[${videoLabel}]split=5[${baseLabel}][${fillBaseLabel}][${upperInputLabel}][${lowerInputLabel}][${maskInputLabel}]`);
  filters.push(`[${upperInputLabel}]crop=w='max(2\\,iw*${widthRatio.toFixed(4)})':h='max(2\\,ih*${heightRatio.toFixed(4)})':x='iw*${xRatio.toFixed(4)}':y='ih*${upperSourceYRatio.toFixed(4)}'[${upperPatchLabel}]`);
  filters.push(`[${lowerInputLabel}]crop=w='max(2\\,iw*${widthRatio.toFixed(4)})':h='max(2\\,ih*${heightRatio.toFixed(4)})':x='iw*${xRatio.toFixed(4)}':y='ih*${lowerSourceYRatio.toFixed(4)}'[${lowerPatchLabel}]`);
  filters.push(`[${upperPatchLabel}][${lowerPatchLabel}]blend=all_expr='A*(1-Y/H)+B*(Y/H)'[${blendedPatchLabel}]`);
  filters.push(`[${blendedPatchLabel}]gblur=sigma=${patchBlur.toFixed(2)}:steps=1[${patchLabel}]`);
  filters.push(`[${fillBaseLabel}][${patchLabel}]overlay=x='main_w*${xRatio.toFixed(4)}':y='main_h*${yRatio.toFixed(4)}':shortest=1[${fillLabel}]`);
  filters.push(`[${maskInputLabel}]geq=lum='${maskExpression}':cb='${maskExpression}':cr='${maskExpression}',gblur=sigma=${featherText}:steps=2[${maskLabel}]`);
  filters.push(`[${baseLabel}][${fillLabel}][${maskLabel}]maskedmerge[${outputLabel}]`);
  return outputLabel;
}

function normalizeTextOverlays(exportOptions = {}) {
  const rawOverlays = Array.isArray(exportOptions.textOverlays)
    ? exportOptions.textOverlays
    : exportOptions.textOverlay
      ? [exportOptions.textOverlay]
      : [];

  return rawOverlays
    .map((overlay) => {
      const text = String(overlay?.text || '').trim();
      const start = Math.max(0, Number(overlay?.start) || 0);
      const end = Math.max(start + 0.1, Number(overlay?.end) || start + 5);
      return {
        ...overlay,
        text,
        start,
        end,
        x: Math.min(100, Math.max(0, Number(overlay?.x ?? 50))),
        y: Math.min(100, Math.max(0, Number(overlay?.y ?? 50))),
      };
    })
    .filter((overlay) => overlay.text && overlay.end > overlay.start);
}

async function buildTextOverlayFilter(exportOptions = {}, workDir = '') {
  const overlays = normalizeTextOverlays(exportOptions);
  if (!overlays.length || !workDir) return '';

  await fs.mkdir(workDir, { recursive: true });
  const assPath = path.join(workDir, `text_overlay_${Date.now()}.ass`);
  const playResX = 1920;
  const playResY = 1080;
  const first = overlays[0] || {};
  const fallbackStyle = exportOptions.subtitleStyle || {};
  const outlineEnabled = first.outlineEnabled === true || fallbackStyle.outlineEnabled === true;
  const backgroundOpacity = Math.min(1, Math.max(0, Number(first.backgroundOpacity ?? fallbackStyle.backgroundOpacity ?? fallbackStyle.boxOpacity ?? 0) / 100));
  const backgroundColor = first.backgroundColor || fallbackStyle.backgroundColor || fallbackStyle.boxColor || '#000000';
  const fontSize = Math.max(16, Math.min(120, Number(first.fontSize || fallbackStyle.fontSize || 32) * 1.6)).toFixed(0);
  const style = [
    String(first.fontFamily || fallbackStyle.fontFamily || 'Arial').replace(/,/g, ''),
    fontSize,
    hexToAssColor(first.textColor || fallbackStyle.textColor || '#ffffff', 0),
    '&H000000FF',
    hexToAssColor(first.outlineColor || fallbackStyle.outlineColor || '#000000', outlineEnabled ? 0.08 : 1),
    hexToAssColor(backgroundColor, 1 - backgroundOpacity),
    '-1',
    '0',
    '0',
    '0',
    '100',
    '100',
    '0',
    '0',
    backgroundOpacity > 0 ? '4' : '1',
    outlineEnabled ? '3' : '0',
    '0',
    '5',
    '20',
    '20',
    '20',
    '1',
  ].join(',');
  const dialogueLines = overlays.map((overlay) => {
    const x = Math.round((overlay.x / 100) * playResX);
    const y = Math.round((overlay.y / 100) * playResY);
    return `Dialogue: 0,${formatAssTime(overlay.start)},${formatAssTime(overlay.end)},TextOverlay,,0,0,0,,{\\an5\\pos(${x},${y})}${assEscapeText(overlay.text)}`;
  });
  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${playResX}`,
    `PlayResY: ${playResY}`,
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: TextOverlay,${style}`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...dialogueLines,
    '',
  ];
  await fs.writeFile(assPath, lines.join('\n'), 'utf8');
  return `subtitles='${path.basename(assPath).replace(/'/g, "\\'")}'`;
}

function crfFromQuality(quality) {
  const safe = Math.min(100, Math.max(30, Number(quality || 80)));
  return String(Math.round(34 - safe * 0.18));
}

function softSubtitleCodecForOutput(outputPath) {
  const extension = path.extname(String(outputPath || '')).toLowerCase();
  if (['.mp4', '.m4v', '.mov'].includes(extension)) return 'mov_text';
  if (extension === '.mkv') return 'srt';
  return '';
}

const OUTPUT_ASPECT_RATIOS = {
  '16:9': 16 / 9,
  '9:16': 9 / 16,
  '4:3': 4 / 3,
};

function normalizeOutputAspectRatio(value) {
  const text = String(value || '').trim();
  return Object.prototype.hasOwnProperty.call(OUTPUT_ASPECT_RATIOS, text) ? text : 'source';
}

function appendOutputAspectFilter(filters, inputLabel, outputAspectRatio) {
  const aspectKey = normalizeOutputAspectRatio(outputAspectRatio);
  if (aspectKey === 'source') return inputLabel;
  const ratio = OUTPUT_ASPECT_RATIOS[aspectKey];
  const ratioText = ratio.toFixed(8);
  const outputLabel = `vaspect${filters.length}`;
  const scaledLabel = `${outputLabel}s`;
  filters.push(
    `[${inputLabel}]scale=w='if(gt(a\\,${ratioText})\\,trunc(ih*${ratioText}/2)*2\\,-2)':h='if(gt(a\\,${ratioText})\\,-2\\,trunc(iw/${ratioText}/2)*2)':flags=lanczos[${scaledLabel}]`
  );
  filters.push(
    `[${scaledLabel}]pad=w='if(gt(a\\,${ratioText})\\,iw\\,trunc(ih*${ratioText}/2)*2)':h='if(gt(a\\,${ratioText})\\,trunc(iw/${ratioText}/2)*2\\,ih)':x='(ow-iw)/2':y='(oh-ih)/2':color=black,setsar=1[${outputLabel}]`
  );
  return outputLabel;
}

async function hasMediaStream(filePath, selector) {
  try {
    if (!filePath) return false;
    await fs.access(filePath);
    const { stdout } = await execFileAsync(resolveBundledTool('ffprobe'), [
      '-v', 'error',
      '-select_streams', selector,
      '-show_entries', 'stream=index',
      '-of', 'csv=p=0',
      filePath,
    ], {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return Boolean(String(stdout || '').trim());
  } catch {
    return false;
  }
}

async function mergeVideoAndAudio(videoPath, audioPath, outputPath, exportOptions = {}) {
  try {
    const originalAudioVolume = Math.min(1, Math.max(0, Number(exportOptions.originalAudioVolume ?? 0.18)));
    const burnSubtitles = Boolean(exportOptions.burnSubtitles && exportOptions.subtitlePath);
    const softSubtitlePath = String(exportOptions.softSubtitlePath || '').trim();
    const softSubtitleCodec = softSubtitleCodecForOutput(outputPath);
    const embedSoftSubtitles = Boolean(exportOptions.embedSoftSubtitles && softSubtitlePath && softSubtitleCodec);
    const musicPath = String(exportOptions.musicPath || '').trim();
    const randomLogoPaths = String(exportOptions.randomLogoPaths || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    const logoPath = String(exportOptions.logoPath || randomLogoPaths[0] || '').trim();
    const logoSizePercent = Number(exportOptions.logoSize ?? 18);
    const logoEnabledExplicitly = exportOptions.logoEnabled === true;
    const musicEnabledExplicitly = exportOptions.musicEnabled === true;
    if (logoEnabledExplicitly && !logoPath) {
      throw new Error('Logo is enabled but no logo file was provided. Choose a logo file or turn off logo export.');
    }
    if (logoEnabledExplicitly && (!Number.isFinite(logoSizePercent) || logoSizePercent <= 0)) {
      throw new Error('Logo is enabled but logo size is 0. Increase logo size or turn off logo export.');
    }
    if (musicEnabledExplicitly && !musicPath) {
      throw new Error('Background music is enabled but no audio file was provided. Choose a music file or turn off background music.');
    }
    const hasMusic = exportOptions.musicEnabled !== false && Boolean(musicPath);
    const hasLogo = exportOptions.logoEnabled !== false && Boolean(logoPath) && logoSizePercent > 0;
    if (hasLogo) {
      await fs.access(logoPath).catch(() => {
        throw new Error(`Logo file is missing: ${logoPath}`);
      });
    }
    const subtitleCover = normalizeSubtitleCover(exportOptions);
    const hasSubtitleCover = Boolean(subtitleCover);
    const filterWorkDir = burnSubtitles ? path.dirname(exportOptions.subtitlePath) : path.dirname(outputPath);
    const textOverlayFilter = await buildTextOverlayFilter(exportOptions, filterWorkDir);
    const hasTextOverlay = Boolean(textOverlayFilter);
    const subtitleFilter = burnSubtitles ? await buildSubtitleFilter(
      exportOptions.subtitlePath,
      exportOptions.subtitleStyle || {},
    ) : '';
    const crf = crfFromQuality(exportOptions.outputQuality);

    const includeDubbedAudio = exportOptions.includeDubbedAudio !== false;
    const sourceHasAudio = await hasMediaStream(videoPath, 'a:0');
    const dubbedHasAudio = includeDubbedAudio && await hasMediaStream(audioPath, 'a:0');
    if (includeDubbedAudio && !dubbedHasAudio) {
      throw new Error('Dubbed audio is missing or has no audio stream. Run TTS again or disable Dubbed audio before exporting.');
    }

    const musicHasAudio = hasMusic && await hasMediaStream(musicPath, 'a:0');
    if (musicEnabledExplicitly && !musicHasAudio) {
      throw new Error(`Background music file is missing or has no audio stream: ${musicPath}`);
    }
    const keepBackgroundMusic = Boolean(exportOptions.keepBackgroundMusic && sourceHasAudio);
    const inputs = ['-y', '-i', videoPath];
    let nextInputIndex = 1;
    const dubbedIndex = dubbedHasAudio ? nextInputIndex++ : -1;
    if (dubbedHasAudio) inputs.push('-i', audioPath);
    const musicIndex = musicHasAudio ? nextInputIndex++ : -1;
    if (musicHasAudio) inputs.push('-i', musicPath);
    const logoIndex = hasLogo ? nextInputIndex++ : -1;
    if (hasLogo) inputs.push('-i', logoPath);
    const softSubtitleIndex = embedSoftSubtitles ? nextInputIndex++ : -1;
    if (embedSoftSubtitles) inputs.push('-i', softSubtitlePath);

    const filters = [];
    let videoLabel = '0:v:0';
    videoLabel = appendOutputAspectFilter(filters, videoLabel, exportOptions.outputAspectRatio);
    videoLabel = appendSubtitleCoverFilter(filters, videoLabel, subtitleCover, 0);
    if (burnSubtitles) {
      filters.push(`[${videoLabel}]${subtitleFilter}[vsub]`);
      videoLabel = 'vsub';
    }
    if (hasTextOverlay) {
      filters.push(`[${videoLabel}]${textOverlayFilter}[vtext]`);
      videoLabel = 'vtext';
    }
    if (hasLogo) {
      videoLabel = appendLogoOverlayFilter(filters, videoLabel, `${logoIndex}:v`, exportOptions);
    }

    const audioFilterInputs = [];
    let directAudioMap = '';
    if (keepBackgroundMusic) {
      filters.push(`[0:a:0]volume=${originalAudioVolume.toFixed(2)}[bg]`);
      audioFilterInputs.push('[bg]');
    }
    if (dubbedHasAudio) {
      audioFilterInputs.push(`[${dubbedIndex}:a:0]`);
      directAudioMap = `${dubbedIndex}:a:0`;
    }
    if (musicHasAudio) {
      const musicVolume = Math.min(1, Math.max(0, Number(exportOptions.musicVolume ?? 35) / 100));
      const fade = exportOptions.musicFade ? ',afade=t=in:st=0:d=1.5' : '';
      filters.push(`[${musicIndex}:a]volume=${musicVolume.toFixed(2)}${fade}[music]`);
      audioFilterInputs.push('[music]');
    }
    let audioMap = directAudioMap;
    if (audioFilterInputs.length > 1) {
      filters.push(`${audioFilterInputs.join('')}amix=inputs=${audioFilterInputs.length}:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95:level=false[mixed]`);
      audioMap = '[mixed]';
    } else if (audioFilterInputs.length === 1 && audioFilterInputs[0] !== `[${dubbedIndex}:a:0]`) {
      audioMap = audioFilterInputs[0];
    }

    const hasVideoFilters = videoLabel !== '0:v:0';
    const ffmpegArgs = [
      ...inputs,
      ...(filters.length ? ['-filter_complex', filters.join(';')] : []),
      '-map', videoLabel.includes(':') ? videoLabel : `[${videoLabel}]`,
      ...(audioMap ? ['-map', audioMap] : []),
      ...(embedSoftSubtitles ? ['-map', `${softSubtitleIndex}:s:0`] : []),
      '-c:v', hasVideoFilters ? 'libx264' : 'copy',
      ...(hasVideoFilters ? ['-preset', 'veryfast', '-crf', crf] : []),
      ...(audioMap ? ['-c:a', 'aac', '-b:a', '192k'] : []),
      ...(embedSoftSubtitles ? [
        '-c:s',
        softSubtitleCodec,
        '-metadata:s:s:0',
        `language=${String(exportOptions.softSubtitleLanguage || 'und')}`,
        '-metadata:s:s:0',
        `title=${String(exportOptions.softSubtitleTitle || 'Subtitles')}`,
        '-disposition:s:0',
        'default',
      ] : []),
      outputPath,
    ];

    const cwd = hasVideoFilters ? filterWorkDir : undefined;

    await execFileAsync(resolveBundledTool('ffmpeg'), ffmpegArgs, {
      cwd,
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 40,
    });
    await fs.access(outputPath);
    return outputPath;
  } catch (error) {
    throw new Error(`Export failed: ${error.stderr || error.message}`);
  }
}

async function exportSrt(segments, outputPath, options = {}) {
  const finalSegments = options.displayOptimized ? buildDisplaySubtitleSegments(segments, options) : segments;
  const lines = finalSegments.map((segment, index) => [
    String(index + 1),
    `${formatSrtTime(segment.start)} --> ${formatSrtTime(segment.end)}`,
    segment.text || '',
    '',
  ].join('\n'));

  await fs.writeFile(outputPath, lines.join('\n'), 'utf8');
  return outputPath;
}

async function exportVtt(segments, outputPath) {
  const lines = ['WEBVTT', ''];
  segments.forEach((segment) => {
    lines.push(`${formatVttTime(segment.start)} --> ${formatVttTime(segment.end)}`);
    lines.push(segment.text || '');
    lines.push('');
  });

  await fs.writeFile(outputPath, lines.join('\n'), 'utf8');
  return outputPath;
}

module.exports = {
  exportSrt,
  exportVtt,
  mergeVideoAndAudio,
  _private: {
    appendLogoOverlayFilter,
    appendSubtitleCoverFilter,
    appendOutputAspectFilter,
    buildDisplaySubtitleSegments,
    normalizeSubtitleCover,
    normalizeOutputAspectRatio,
    softSubtitleCodecForOutput,
    wrapSubtitleText,
  },
};
