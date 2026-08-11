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
  const text = fs.readFileSync(referencePath, 'utf8');
  cache.set(cacheKey, text);
  return text;
}

function loadRuntimeSkillText(skillName, targetLanguage) {
  const skillText = loadSkillText(skillName);
  if (skillName !== 'subtitle-translation-prompt' || !isVietnameseTarget(targetLanguage)) {
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
