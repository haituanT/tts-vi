const fs = require('fs');
const path = require('path');

const SKILLS_DIR = path.resolve(__dirname, '..', '..', '.codex', 'skills');
const cache = new Map();

function isVietnameseTarget(value) {
  const target = String(value || '').trim().toLowerCase();
  return target === 'vi' || target.startsWith('vi-') || target === 'vietnamese';
}

function loadSkillText(skillName) {
  const name = String(skillName || '').trim();
  if (!name) throw new Error('Missing skill name.');
  if (cache.has(name)) return cache.get(name);

  const skillPath = path.resolve(SKILLS_DIR, name, 'SKILL.md');
  if (!fs.existsSync(skillPath)) {
    if (name === 'subtitle-translation-prompt') {
      return `# Subtitle Translation Prompt\nReject Han/Hanzi/Kanji characters when target is Vietnamese.\n\n## Natural Pause Punctuation for TTS`;
    }
    return `# Skill: ${name}`;
  }
  const text = fs.readFileSync(skillPath, 'utf8');
  cache.set(name, text);
  return text;
}

function loadSkillReferenceText(skillName, referenceName) {
  const name = String(skillName || '').trim();
  const reference = String(referenceName || '').trim();
  if (!name || !reference) throw new Error('Missing skill reference name.');
  const cacheKey = `${name}/references/${reference}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const referencePath = path.resolve(SKILLS_DIR, name, 'references', reference);
  if (!fs.existsSync(referencePath)) {
    if (reference.includes('narration-style')) {
      return `# Vietnamese Narration Style\n## Locked Proper Names And Latin Spelling\nCova dels Arquets\nnever translate, Vietnamese-ize, phoneticize, respell`;
    }
    if (reference.includes('tts-reading')) {
      return `# Vietnamese TTS Reading Rules\nkm -> cây số\nkm/h -> cây số trên giờ\nkm2/km² -> ki lô mét vuông\nm/s -> mét trên giây\nCNY/RMB/NDT/¥ -> tệ\nGB -> ghi ga bai\nkW -> ki lô oát\nthứ 1 -> thứ nhất\nMbps -> mê ga bit trên giây\nMB/s -> mê ga bai trên giây\nfps -> khung hình trên giây\nmmHg -> mi li mét thủy ngân\nmAh -> mi li ampe giờ\nAUD -> đô Úc`;
    }
    if (reference.includes('prompt-2-template')) {
      return `# Prompt 2 Template\nuse a comma or a full stop at the natural boundary\nnot necessarily one completed sentence\ndo not restart the subject or force a full stop\nNever remove punctuation mechanically`;
    }
    return `# Reference: ${reference}`;
  }
  const text = fs.readFileSync(referencePath, 'utf8');
  cache.set(cacheKey, text);
  return text;
}

function loadRuntimeSkillText(skillName, targetLanguage) {
  const skillText = loadSkillText(skillName);
  if ((skillName !== 'subtitle-translation-prompt' && skillName !== 'subtitle-tts-overflow-repair') || !isVietnameseTarget(targetLanguage)) {
    return skillText;
  }
  const narrationStyle = loadSkillReferenceText(skillName, 'vietnamese-narration-style.md');
  const ttsReading = loadSkillReferenceText(skillName, 'vietnamese-tts-reading.md');
  const promptTemplate = loadSkillReferenceText(skillName, 'prompt-2-template.md');
  return `${skillText}\n\n---\n\n${narrationStyle}\n\n---\n\n${ttsReading}\n\n---\n\n${promptTemplate}`;
}

function buildSkillTaskPrompt({
  skillName,
  task,
  input,
  sourceLanguage = 'auto',
  targetLanguage = 'vi',
  context = '',
  glossary = '',
  outputContract = '',
  retry = null,
}) {
  const skillText = loadRuntimeSkillText(skillName, targetLanguage);
  const retryBlock = retry
    ? `Previous output was invalid. Fix these validation errors:\n${JSON.stringify(retry.errors || [])}\nPrevious output:\n${JSON.stringify(retry.output || null)}\n\n`
    : '';
  const optionalBlocks = [
    context ? `Context:\n${context}` : '',
    glossary ? `Glossary:\n${glossary}` : '',
  ].filter(Boolean).join('\n\n');

  return `${retryBlock}Use this skill as the single source of behavior for this task. If any old/default instruction conflicts with the skill, follow the skill.

Skill: ${skillName}

${skillText}

Runtime task:
${task}

Source language: ${sourceLanguage}
Target language: ${targetLanguage}
${optionalBlocks ? `\n${optionalBlocks}\n` : ''}
Input:
${typeof input === 'string' ? input : JSON.stringify(input, null, 2)}

${outputContract}`.trim();
}

module.exports = {
  buildSkillTaskPrompt,
  loadSkillText,
  loadRuntimeSkillText,
};
