function cleanString(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function containsReplacementCharacter(value = '') {
  return String(value || '').includes('\uFFFD');
}

function containsCjkUnifiedIdeograph(value = '') {
  return /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/u.test(String(value || ''));
}

function containsKnownCorruptTranslationArtifact(value = '') {
  const text = String(value || '');
  return /ki\s+l\?\s+m\?t/iu.test(text)
    || /ki\s+l(?:i|í)t\?\s+m(?:e|é)t\?/iu.test(text)
    || /[\p{L}]ki\s+l(?:\?|(?:i|í)t\?|ô\s+m(?:e|é)t)/iu.test(text);
}

function applyCase(original, replacement) {
  return /^[A-ZÀ-ỴĐ]/u.test(String(original || ''))
    ? replacement.charAt(0).toUpperCase() + replacement.slice(1)
    : replacement;
}

function replaceKeepingCase(text, pattern, replacement) {
  return String(text || '').replace(pattern, (match) => applyCase(match, replacement));
}

function repairCommonReplacementCharacters(text = '') {
  let output = cleanString(text);
  if (!containsReplacementCharacter(output)) return output;

  // Antigravity on Windows can occasionally emit U+FFFD after a Vietnamese tone mark
  // is lost in the terminal stream. Repair the common subtitle words we can identify
  // safely, then validation rejects anything still corrupt.
  output = replaceKeepingCase(output, /\bn\uFFFD{1,3}ng\b/giu, 'nắng');
  output = replaceKeepingCase(output, /\bv\uFFFD{1,3}\b/giu, 'và');
  output = replaceKeepingCase(output, /\bl\uFFFD{1,3}\b/giu, 'là');
  output = replaceKeepingCase(output, /\bc\uFFFD{1,3}\b/giu, 'có');
  output = replaceKeepingCase(output, /\bkh\uFFFD{1,3}ng\b/giu, 'không');
  output = replaceKeepingCase(output, /\bng\uFFFD{1,4}i\b/giu, 'người');
  output = replaceKeepingCase(output, /\bquy\uFFFD{1,3}t\b/giu, 'quyết');

  return cleanString(output);
}

module.exports = {
  containsReplacementCharacter,
  containsCjkUnifiedIdeograph,
  containsKnownCorruptTranslationArtifact,
  repairCommonReplacementCharacters,
};
