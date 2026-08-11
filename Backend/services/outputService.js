const fs = require('fs').promises;
const path = require('path');

const INVALID_PATH_CHARS = /[<>:"/\\|?*\x00-\x1F]/g;
const downloadsRoot = path.join(__dirname, '..', 'downloads');

function sanitizePathSegment(value, fallback) {
  const normalized = String(value || '')
    .trim()
    .replace(INVALID_PATH_CHARS, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '');

  return normalized || fallback;
}

function getDefaultOutputRoot() {
  const userProfile = process.env.USERPROFILE || process.env.HOME || '';
  if (userProfile) {
    return path.join(userProfile, 'Videos', 'DubFlow');
  }
  return path.join(process.cwd(), 'exports');
}

function resolveOutputConfig(body = {}, jobId) {
  const outputConfig = body.outputConfig || {};
  const folderName = sanitizePathSegment(outputConfig.folderName || `dubbed_${jobId}`, `dubbed_${jobId}`);
  const fileNameBase = sanitizePathSegment(outputConfig.fileName || folderName, folderName);
  const fileName = fileNameBase.toLowerCase().endsWith('.mp4') ? fileNameBase : `${fileNameBase}.mp4`;
  const outputRootDir = String(outputConfig.outputRootDir || getDefaultOutputRoot()).trim() || getDefaultOutputRoot();
  const finalDirectory = path.join(outputRootDir, folderName);
  const finalVideoPath = path.join(finalDirectory, fileName);

  return {
    outputRootDir,
    folderName,
    fileName,
    finalDirectory,
    finalVideoPath,
  };
}

async function saveExportCopy(sourceVideoPath, outputConfig) {
  await fs.mkdir(outputConfig.finalDirectory, { recursive: true });
  await fs.copyFile(sourceVideoPath, outputConfig.finalVideoPath);
  return outputConfig.finalVideoPath;
}

async function publishJobArtifacts(jobId, artifacts) {
  const targetRoot = path.join(downloadsRoot, jobId);
  await fs.mkdir(targetRoot, { recursive: true });

  const published = {};
  for (const [key, value] of Object.entries(artifacts)) {
    if (!value) continue;

    const fileName = path.basename(value);
    const outputPath = path.join(targetRoot, fileName);
    await fs.copyFile(value, outputPath);
    published[key] = {
      localPath: outputPath,
      downloadUrl: `/downloads/${jobId}/${fileName}`,
    };
  }

  return published;
}

module.exports = {
  getDefaultOutputRoot,
  publishJobArtifacts,
  resolveOutputConfig,
  saveExportCopy,
  sanitizePathSegment,
};
