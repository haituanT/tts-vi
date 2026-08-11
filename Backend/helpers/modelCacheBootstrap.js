const fs = require('fs');
const path = require('path');

function ensureDir(dirPath) {
  if (!dirPath) return;
  fs.mkdirSync(dirPath, { recursive: true });
}

function setIfMissing(key, value) {
  if (!process.env[key] && value) {
    process.env[key] = value;
  }
}

function initModelCacheRoot() {
  const root = process.env.DUBFLOW_MODEL_CACHE_ROOT || 'D:\\DubFlowModelCache';
  const normalizedRoot = path.resolve(root);

  const directories = {
    root: normalizedRoot,
    huggingface: path.join(normalizedRoot, 'huggingface'),
    huggingfaceHub: path.join(normalizedRoot, 'huggingface', 'hub'),
    transformers: path.join(normalizedRoot, 'transformers'),
    torch: path.join(normalizedRoot, 'torch'),
    sentenceTransformers: path.join(normalizedRoot, 'sentence-transformers'),
    xdg: path.join(normalizedRoot, 'xdg-cache'),
    temp: path.join(normalizedRoot, 'temp'),
  };

  Object.values(directories).forEach(ensureDir);

  setIfMissing('DUBFLOW_MODEL_CACHE_ROOT', directories.root);
  setIfMissing('HF_HOME', directories.huggingface);
  setIfMissing('HUGGINGFACE_HUB_CACHE', directories.huggingfaceHub);
  setIfMissing('TRANSFORMERS_CACHE', directories.transformers);
  setIfMissing('TORCH_HOME', directories.torch);
  setIfMissing('SENTENCE_TRANSFORMERS_HOME', directories.sentenceTransformers);
  setIfMissing('XDG_CACHE_HOME', directories.xdg);
  setIfMissing('TMP', directories.temp);
  setIfMissing('TEMP', directories.temp);

  return directories;
}

module.exports = {
  initModelCacheRoot,
};
