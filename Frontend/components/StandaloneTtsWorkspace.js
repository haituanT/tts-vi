'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Download,
  FolderOpen,
  GripVertical,
  Loader2,
  Merge,
  Play,
  RefreshCw,
  Scissors,
  Trash2,
  Volume2,
  X,
} from 'lucide-react';
import { playErrorSound } from '../lib/audioFeedback';

const STORAGE_KEY = 'dubflow.standaloneTts.v1';
const LANGUAGES = ['vi-VN', 'en-US', 'zh-CN', 'ja-JP', 'ko-KR', 'th-TH', 'id-ID', 'fr-FR', 'de-DE', 'es-ES'];
const AIMAX_MODELS = {
  minimax: ['speech-2.8-hd', 'speech-2.8-turbo', 'speech-2.6-hd', 'speech-2.6-turbo'],
  elevenlabs: ['eleven_v3', 'eleven_multilingual_v2', 'eleven_flash_v2_5', 'eleven_turbo_v2_5'],
};
const GOOGLE_CHIRP_FEMALE_NAMES = new Set([
  'Achernar', 'Aoede', 'Autonoe', 'Callirrhoe', 'Despina', 'Erinome', 'Gacrux',
  'Kore', 'Laomedeia', 'Leda', 'Pulcherrima', 'Sulafat', 'Vindemiatrix', 'Zephyr',
]);
const GOOGLE_CHIRP_MALE_NAMES = new Set([
  'Achird', 'Algenib', 'Algieba', 'Alnilam', 'Charon', 'Enceladus', 'Fenrir',
  'Iapetus', 'Orus', 'Puck', 'Rasalgethi', 'Sadachbia', 'Sadaltager', 'Schedar',
  'Umbriel', 'Zubenelgenubi',
]);
const VIETNAMESE_RECOMMENDED_VOICES = [
  'vi-VN-Neural2-A',
  'vi-VN-Neural2-D',
  'vi-VN-Chirp3-HD-Aoede',
  'vi-VN-Chirp3-HD-Charon',
  'vi-VN-Chirp3-HD-Orus',
  'vi-VN-Chirp3-HD-Kore',
  'vi-VN-Chirp3-HD-Fenrir',
  'vi-VN-Chirp3-HD-Leda',
  'vi-VN-Chirp3-HD-Puck',
  'vi-VN-Wavenet-A',
  'vi-VN-Wavenet-B',
];
const VOICE_FAMILY_ORDER = ['Chirp 3 HD', 'Neural2', 'WaveNet', 'Standard', 'Edge Neural', 'Khác'];
const VOICE_GENDER_ORDER = ['FEMALE', 'MALE', 'NEUTRAL', ''];
const CHIRP_VOICE_GUIDANCE = {
  Achernar: { tone: 'dịu, mềm', use: 'truyện cảm xúc, thiền, nội dung chữa lành' },
  Achird: { tone: 'thân thiện', use: 'hướng dẫn, vlog, giới thiệu gần gũi' },
  Algenib: { tone: 'khàn, có độ nhám', use: 'trailer, chuyện bí ẩn, nhân vật cá tính' },
  Algieba: { tone: 'mượt, thư thái', use: 'quảng cáo nhẹ, giới thiệu sản phẩm' },
  Alnilam: { tone: 'chắc, nghiêm', use: 'tin tức, thông báo, nội dung chính luận' },
  Aoede: { tone: 'thoáng, tự nhiên', use: 'kể chuyện, podcast, video giải thích', recommended: true },
  Autonoe: { tone: 'sáng, tích cực', use: 'quảng cáo, thiếu nhi, nội dung vui' },
  Callirrhoe: { tone: 'thư thả, dễ gần', use: 'tâm sự, podcast, hội thoại' },
  Charon: { tone: 'điềm, giàu thông tin', use: 'tài liệu, kiến thức, video giải thích', recommended: true },
  Despina: { tone: 'mượt, ấm áp', use: 'gia đình, đời sống, lời chào thương hiệu' },
  Enceladus: { tone: 'nhẹ hơi, giàu cảm xúc', use: 'truyện tình cảm, nhân vật, quảng cáo mềm' },
  Erinome: { tone: 'rõ, chuẩn xác', use: 'giáo dục, thuyết minh, đào tạo' },
  Fenrir: { tone: 'sôi nổi, hào hứng', use: 'review, giải trí, video nhịp nhanh', recommended: true },
  Gacrux: { tone: 'trưởng thành', use: 'tài liệu, chuyện đời, nội dung chuyên môn' },
  Iapetus: { tone: 'rõ ràng, gần gũi', use: 'hướng dẫn, kiến thức, vlog' },
  Kore: { tone: 'chắc, tự tin', use: 'tin ngắn, quảng cáo, nội dung dứt khoát', recommended: true },
  Laomedeia: { tone: 'năng động, tươi', use: 'podcast, giải thích, nội dung trẻ' },
  Leda: { tone: 'trẻ trung', use: 'truyện thiếu nhi, video tuổi trẻ, nhân vật', recommended: true },
  Orus: { tone: 'đĩnh đạc, chắc giọng', use: 'tài liệu, lịch sử, truyện nghiêm túc', recommended: true },
  Puck: { tone: 'vui, nhiều năng lượng', use: 'review, vlog, bán hàng, giải trí', recommended: true },
  Pulcherrima: { tone: 'biểu cảm, trực diện', use: 'quảng cáo, nhân vật, nội dung gây chú ý' },
  Rasalgethi: { tone: 'rõ chất thông tin', use: 'giải thích, podcast, bình luận' },
  Sadachbia: { tone: 'sống động, có lực', use: 'giải trí, quảng cáo, trailer' },
  Sadaltager: { tone: 'hiểu biết, chuyên nghiệp', use: 'giáo dục, tài liệu, thuyết trình' },
  Schedar: { tone: 'đều, trung tính', use: 'đọc dài, hướng dẫn, nội dung tổng hợp' },
  Sulafat: { tone: 'ấm, dễ mến', use: 'kể chuyện, chăm sóc khách hàng, đời sống' },
  Umbriel: { tone: 'thư thả, dễ nghe', use: 'podcast, tâm sự, kể chuyện nhẹ' },
  Vindemiatrix: { tone: 'dịu dàng', use: 'thiền, truyện chữa lành, nội dung cảm xúc' },
  Zephyr: { tone: 'sáng, vui', use: 'thiếu nhi, quảng cáo, nội dung tích cực' },
  Zubenelgenubi: { tone: 'tự nhiên, đời thường', use: 'vlog, hội thoại, hướng dẫn thân thiện' },
};
const VIETNAMESE_CLASSIC_VOICE_GUIDANCE = {
  'vi-VN-Neural2-A': {
    tone: 'nữ tự nhiên, rõ và đa dụng',
    use: 'kể chuyện, video kiến thức, thuyết minh dài',
    recommended: true,
    familiar: true,
  },
  'vi-VN-Neural2-D': {
    tone: 'nam điềm, rõ và đa dụng',
    use: 'tài liệu, lịch sử, video giải thích',
    recommended: true,
    familiar: true,
  },
  'vi-VN-Wavenet-A': {
    tone: 'nữ rõ, ổn định',
    use: 'thuyết minh, hướng dẫn, nội dung tổng hợp',
    familiar: true,
  },
  'vi-VN-Wavenet-B': {
    tone: 'nam rõ, ổn định',
    use: 'tin tức, hướng dẫn, video kiến thức',
    familiar: true,
  },
  'vi-VN-Wavenet-C': { tone: 'nữ mềm, đều', use: 'truyện nhẹ, đời sống, quảng cáo' },
  'vi-VN-Wavenet-D': { tone: 'nam chắc, đều', use: 'tài liệu, thông báo, hướng dẫn' },
  'vi-VN-Standard-A': { tone: 'nữ cơ bản, ít biểu cảm', use: 'bản nháp, thông báo ngắn, tiết kiệm chi phí' },
  'vi-VN-Standard-B': { tone: 'nam cơ bản, ít biểu cảm', use: 'bản nháp, thông báo ngắn, tiết kiệm chi phí' },
  'vi-VN-Standard-C': { tone: 'nữ cơ bản, đều', use: 'đọc hệ thống, nội dung thử nghiệm' },
  'vi-VN-Standard-D': { tone: 'nam cơ bản, đều', use: 'đọc hệ thống, nội dung thử nghiệm' },
};

function Button({ tone = 'dark', className = '', disabled, children, ...props }) {
  const tones = {
    dark: 'bg-slate-800/90 text-slate-200 hover:bg-slate-700/90 hover:text-white border border-slate-700/60',
    blue: 'bg-indigo-600 text-white hover:bg-indigo-500 shadow-indigo-900/20',
    green: 'bg-emerald-600 text-white hover:bg-emerald-500 shadow-emerald-900/20',
    red: 'bg-rose-600 text-white hover:bg-rose-500 shadow-rose-900/20',
    yellow: 'bg-amber-500 text-slate-950 font-bold hover:bg-amber-400 shadow-amber-900/20',
  };
  return (
    <button
      type="button"
      disabled={disabled}
      className={`inline-flex h-9 items-center justify-center gap-2 rounded-lg px-3.5 text-xs font-semibold tracking-tight shadow-md transition-all duration-150 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 ${tones[tone] || tones.dark} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

function Field({ label, children }) {
  return (
    <label className="grid gap-1.5 text-xs text-slate-200">
      <span className="font-semibold text-slate-300 tracking-tight">{label}</span>
      {children}
    </label>
  );
}

function Input(props) {
  return <input {...props} className={`h-9 w-full rounded-lg border border-slate-800 bg-slate-900/80 px-3 text-xs text-slate-100 placeholder-slate-500 outline-none transition-all focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 ${props.className || ''}`} />;
}

function Select(props) {
  return <select {...props} className={`h-9 w-full rounded-lg border border-slate-800 bg-slate-900/80 px-3 text-xs text-slate-100 outline-none transition-all focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 ${props.className || ''}`} />;
}

function inferVoiceGender(voiceName = '') {
  const chirpName = String(voiceName).split('-').pop();
  if (GOOGLE_CHIRP_FEMALE_NAMES.has(chirpName)) return 'FEMALE';
  if (GOOGLE_CHIRP_MALE_NAMES.has(chirpName)) return 'MALE';
  return '';
}

function inferVoiceFamily(voiceName = '') {
  const name = String(voiceName);
  if (name.includes('Chirp3-HD') || name.includes('Chirp-HD')) return 'Chirp 3 HD';
  if (name.includes('Neural2')) return 'Neural2';
  if (name.toLowerCase().includes('wavenet')) return 'WaveNet';
  if (name.includes('Standard')) return 'Standard';
  if (name.endsWith('Neural')) return 'Edge Neural';
  return 'Khác';
}

function voiceGenderLabel(gender = '') {
  return { FEMALE: 'Nữ', MALE: 'Nam', NEUTRAL: 'Trung tính' }[gender] || 'Chưa rõ';
}

function voiceGuidance(voice) {
  const classic = VIETNAMESE_CLASSIC_VOICE_GUIDANCE[voice?.value];
  if (classic) return classic;
  const presetName = String(voice?.value || '').split('-').pop();
  return CHIRP_VOICE_GUIDANCE[presetName] || null;
}

function normalizeVoice(voice) {
  if (typeof voice === 'string') {
    return {
      value: voice,
      label: voice,
      gender: inferVoiceGender(voice),
      family: inferVoiceFamily(voice),
    };
  }
  const value = String(voice?.name || voice?.voiceName || voice?.ShortName || '').trim();
  return value ? {
    value,
    label: String(voice.displayName || voice.label || voice.name || voice.voiceName || value),
    gender: String(voice.ssmlGender || voice.gender || inferVoiceGender(value)).toUpperCase(),
    family: inferVoiceFamily(value),
  } : null;
}

function friendlyVoiceLabel(voice, languageCode, provider) {
  if (provider !== 'google_cloud_tts') return voice.label;
  const prefix = `${languageCode}-`;
  const shortName = voice.value.startsWith(prefix) ? voice.value.slice(prefix.length) : voice.label;
  const guidance = languageCode === 'vi-VN' ? voiceGuidance(voice) : null;
  const badge = guidance?.recommended ? '★ ' : '';
  const advice = guidance ? ` · ${guidance.tone} · Hợp: ${guidance.use}` : '';
  return `${badge}${shortName} · ${voiceGenderLabel(voice.gender)}${advice}`;
}

function groupVoices(voices, languageCode, provider) {
  if (provider !== 'google_cloud_tts') {
    return [{ label: 'Danh sách giọng', voices }];
  }

  const recommendedNames = languageCode === 'vi-VN' ? VIETNAMESE_RECOMMENDED_VOICES : [];
  const recommendedSet = new Set(recommendedNames);
  const recommended = recommendedNames
    .map((name) => voices.find((voice) => voice.value === name))
    .filter(Boolean);
  const remaining = voices.filter((voice) => !recommendedSet.has(voice.value));
  const groups = [];

  if (recommended.length) {
    groups.push({ label: 'Đề xuất cho tiếng Việt', voices: recommended });
  }

  VOICE_FAMILY_ORDER.forEach((family) => {
    VOICE_GENDER_ORDER.forEach((gender) => {
      const matches = remaining.filter((voice) => voice.family === family && voice.gender === gender);
      if (matches.length) {
        groups.push({
          label: `${family} · ${voiceGenderLabel(gender)}`,
          voices: matches,
        });
      }
    });
  });

  return groups;
}

function preferredVoiceName(voices, languageCode, provider, genderFilter) {
  if (provider !== 'google_cloud_tts' || languageCode !== 'vi-VN') return voices[0]?.value || '';
  const gender = String(genderFilter || 'all').toUpperCase();
  return VIETNAMESE_RECOMMENDED_VOICES
    .map((name) => voices.find((voice) => voice.value === name))
    .find((voice) => gender === 'ALL' || !gender || voice.gender === gender)?.value
    || voices[0]?.value
    || '';
}

function defaultConcurrency(provider) {
  if (provider === 'google_cloud_tts') return 2;
  if (provider === 'edge_tts') return 20;
  if (provider === 'aimax_tts') return 30;
  return 3;
}

function maxConcurrency(provider) {
  if (provider === 'google_cloud_tts') return 3;
  if (provider === 'edge_tts') return 20;
  if (provider === 'aimax_tts') return 30;
  return 6;
}

function defaultAttempts(provider) {
  return provider === 'edge_tts' ? 4 : 3;
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function formatDuration(value) {
  const seconds = Math.max(0, Number(value) || 0);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
}

function statusLabel(status) {
  return {
    queued: 'Chờ',
    running: 'Đang tạo',
    retrying: 'Đang thử lại',
    completed: 'Xong',
    failed: 'Lỗi',
    canceled: 'Đã hủy',
  }[status] || status || 'Chờ';
}

export default function StandaloneTtsWorkspace({ apiBase, config, onConfigChange, googleCloudConfig }) {
  const [text, setText] = useState('');
  const [segments, setSegments] = useState([]);
  const [history, setHistory] = useState([]);
  const [outputFormat, setOutputFormat] = useState('mp3');
  const [fileName, setFileName] = useState('');
  const [outputDirectory, setOutputDirectory] = useState('');
  const [operation, setOperation] = useState(null);
  const [voices, setVoices] = useState([]);
  const [previewAudio, setPreviewAudio] = useState('');
  const [busyAction, setBusyAction] = useState('');
  const [message, setMessage] = useState('');
  const [draggedId, setDraggedId] = useState('');
  const selectionRef = useRef({});
  const pollRef = useRef(null);

  const reportError = (nextMessage) => {
    playErrorSound();
    setMessage(nextMessage);
  };

  const visibleVoices = useMemo(() => voices.filter((voice) => {
    const gender = String(config.voiceGenderFilter || 'all').toUpperCase();
    return gender === 'ALL' || !gender || !voice.gender || voice.gender === gender;
  }), [voices, config.voiceGenderFilter]);
  const voiceGroups = useMemo(
    () => groupVoices(visibleVoices, config.ttsLanguageCode, config.ttsProvider),
    [visibleVoices, config.ttsLanguageCode, config.ttsProvider],
  );
  const selectedVoice = useMemo(
    () => visibleVoices.find((voice) => voice.value === config.ttsVoiceName) || null,
    [visibleVoices, config.ttsVoiceName],
  );
  const selectedVoiceGuidance = useMemo(
    () => (
      config.ttsProvider === 'google_cloud_tts' && config.ttsLanguageCode === 'vi-VN'
        ? voiceGuidance(selectedVoice)
        : null
    ),
    [config.ttsProvider, config.ttsLanguageCode, selectedVoice],
  );
  const requestTtsConfig = useMemo(() => ({
    ...googleCloudConfig,
    ttsProvider: config.ttsProvider,
    ttsLanguageCode: config.ttsLanguageCode,
    ttsVoiceName: config.ttsVoiceName || '',
    voiceGenderFilter: config.voiceGenderFilter,
    ssmlGender: config.ssmlGender,
    aimaxApiKey: config.aimaxApiKey,
    aimaxBaseUrl: config.aimaxBaseUrl,
    aimaxProvider: config.aimaxProvider,
    aimaxModel: config.aimaxModel,
    speakingRate: config.speakingRate,
    pitch: config.pitch,
    ttsConcurrency: config.ttsConcurrency,
    ttsMaxAttempts: config.ttsMaxAttempts,
  }), [googleCloudConfig, config]);

  const request = async (url, options = {}) => {
    let response;
    try {
      response = await fetch(`${apiBase}${url}`, options);
    } catch {
      throw new Error(`Không kết nối được backend tại ${apiBase}. Hãy kiểm tra app backend đã chạy chưa và port 3001 có bị chặn không.`);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) {
      throw new Error([data.message, data.detail, data.suggestion].filter(Boolean).join(' | ') || 'Yêu cầu thất bại.');
    }
    return data;
  };

  const loadHistory = async () => {
    const data = await request('/api/standalone-tts/history');
    setHistory(Array.isArray(data.history) ? data.history : []);
    setOutputDirectory((current) => current || data.defaultOutputDirectory || '');
  };

  const loadVoices = async () => {
    setBusyAction('voices');
    try {
      const data = await request('/api/tts-voices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          languageCode: config.ttsLanguageCode,
          targetLanguage: config.targetLanguage,
          googleCloudConfig: requestTtsConfig,
        }),
      });
      const next = (data.voices || []).map(normalizeVoice).filter(Boolean);
      setVoices(next);
      if (next.length && !next.some((voice) => voice.value === config.ttsVoiceName)) {
        onConfigChange({
          ttsVoiceName: preferredVoiceName(
            next,
            config.ttsLanguageCode,
            config.ttsProvider,
            config.voiceGenderFilter,
          ),
        });
      }
    } catch (error) {
      reportError(error.message);
    } finally {
      setBusyAction('');
    }
  };

  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}');
      setText(String(saved.text || ''));
      setSegments(Array.isArray(saved.segments) ? saved.segments : []);
      setOutputFormat(saved.outputFormat === 'wav' ? 'wav' : 'mp3');
      setFileName(String(saved.fileName || ''));
      setOutputDirectory(String(saved.outputDirectory || ''));
    } catch {}
    loadHistory().catch((error) => reportError(error.message));
  }, []);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      text,
      segments,
      outputFormat,
      fileName,
      outputDirectory,
    }));
  }, [text, segments, outputFormat, fileName, outputDirectory]);

  useEffect(() => {
    setVoices([]);
    loadVoices();
  }, [config.ttsProvider, config.ttsLanguageCode, config.aimaxProvider, config.aimaxApiKey]);

  useEffect(() => () => {
    if (pollRef.current) window.clearInterval(pollRef.current);
  }, []);

  const updateSegment = (id, patch) => {
    setSegments((current) => current.map((segment) => segment.id === id ? { ...segment, ...patch } : segment));
  };

  const reindexSegments = (items) => items.map((segment, index) => ({
    ...segment,
    index,
    breakAfter: index === items.length - 1 ? 'none' : (segment.breakAfter === 'paragraph' ? 'paragraph' : 'sentence'),
  }));

  const planText = async () => {
    if (!text.trim()) {
      reportError('Hãy nhập văn bản trước khi chia đoạn.');
      return;
    }
    setBusyAction('plan');
    setMessage('');
    try {
      const data = await request('/api/standalone-tts/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      setSegments(data.segments || []);
    } catch (error) {
      reportError(error.message);
    } finally {
      setBusyAction('');
    }
  };

  const splitSegment = (id) => {
    setSegments((current) => {
      const index = current.findIndex((segment) => segment.id === id);
      if (index < 0) return current;
      const segment = current[index];
      const preferred = Number(selectionRef.current[id]);
      const splitAt = preferred > 0 && preferred < segment.text.length ? preferred : Math.floor(segment.text.length / 2);
      const left = segment.text.slice(0, splitAt).trim();
      const right = segment.text.slice(splitAt).trim();
      if (!left || !right) return current;
      const next = [
        ...current.slice(0, index),
        { ...segment, text: left, breakAfter: 'sentence' },
        { ...segment, id: `${segment.id}-${Date.now()}`, text: right },
        ...current.slice(index + 1),
      ];
      return reindexSegments(next);
    });
  };

  const mergeSegment = (id, direction) => {
    setSegments((current) => {
      const index = current.findIndex((segment) => segment.id === id);
      const otherIndex = direction === 'previous' ? index - 1 : index + 1;
      if (index < 0 || otherIndex < 0 || otherIndex >= current.length) return current;
      const firstIndex = Math.min(index, otherIndex);
      const secondIndex = Math.max(index, otherIndex);
      const mergedText = `${current[firstIndex].text} ${current[secondIndex].text}`.replace(/\s+/g, ' ').trim();
      if (mergedText.length > 500) {
        reportError('Không thể ghép vì đoạn mới vượt quá 500 ký tự.');
        return current;
      }
      const merged = {
        ...current[firstIndex],
        text: mergedText,
        breakAfter: current[secondIndex].breakAfter,
      };
      return reindexSegments([
        ...current.slice(0, firstIndex),
        merged,
        ...current.slice(secondIndex + 1),
      ]);
    });
  };

  const moveSegment = (targetId) => {
    if (!draggedId || draggedId === targetId) return;
    setSegments((current) => {
      const from = current.findIndex((segment) => segment.id === draggedId);
      const to = current.findIndex((segment) => segment.id === targetId);
      if (from < 0 || to < 0) return current;
      const next = [...current];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return reindexSegments(next);
    });
    setDraggedId('');
  };

  const pickFolder = async () => {
    setBusyAction('folder');
    try {
      const data = await request('/api/pick-output-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!data.cancelled && data.folderPath) setOutputDirectory(data.folderPath);
    } catch (error) {
      reportError(error.message);
    } finally {
      setBusyAction('');
    }
  };

  const previewVoice = async () => {
    setBusyAction('preview');
    setMessage('');
    try {
      const data = await request('/api/preview-voice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: segments[0]?.text?.slice(0, 220) || text.slice(0, 220) || 'Đây là câu nghe thử giọng đọc.',
          targetLanguage: config.targetLanguage,
          googleCloudConfig: requestTtsConfig,
        }),
      });
      setPreviewAudio(`data:${data.mimeType || 'audio/mpeg'};base64,${data.audioContent}`);
    } catch (error) {
      reportError(error.message);
    } finally {
      setBusyAction('');
    }
  };

  const pollOperation = (operationId) => {
    if (pollRef.current) window.clearInterval(pollRef.current);
    const poll = async () => {
      try {
        const data = await request(`/api/standalone-tts/jobs/${operationId}`);
        setOperation(data);
        if (['completed', 'failed', 'canceled'].includes(data.status)) {
          window.clearInterval(pollRef.current);
          pollRef.current = null;
          setBusyAction('');
          await loadHistory();
          if (data.status === 'failed') reportError(data.error || 'Tạo TTS thất bại.');
        }
      } catch (error) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
        setBusyAction('');
        reportError(error.message);
      }
    };
    poll();
    pollRef.current = window.setInterval(poll, 900);
  };

  const createAudio = async () => {
    if (!segments.length) {
      reportError('Hãy tự động chia đoạn trước khi tạo audio.');
      return;
    }
    if (segments.some((segment) => !segment.text.trim() || segment.text.trim().length > 500)) {
      reportError('Mỗi đoạn phải có nội dung và không vượt quá 500 ký tự.');
      return;
    }
    setBusyAction('create');
    setMessage('');
    setOperation(null);
    try {
      const data = await request('/api/standalone-tts/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          segments,
          outputFormat,
          fileName,
          outputDirectory,
          targetLanguage: config.targetLanguage,
          googleCloudConfig: requestTtsConfig,
        }),
      });
      setOperation(data);
      pollOperation(data.operationId);
    } catch (error) {
      setBusyAction('');
      reportError(error.message);
    }
  };

  const cancelAudio = async () => {
    if (!operation?.operationId) return;
    await request(`/api/standalone-tts/jobs/${operation.operationId}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }).catch((error) => reportError(error.message));
  };

  const clearHistory = async () => {
    await request('/api/standalone-tts/history', { method: 'DELETE' });
    setHistory([]);
  };

  const openFolder = async (folderPath) => {
    await request('/api/standalone-tts/open-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderPath }),
    }).catch((error) => reportError(error.message));
  };

  const progress = operation?.totalSegments
    ? Math.round((Number(operation.completedSegments) / operation.totalSegments) * 100)
    : 0;

  return (
    <div className="min-h-0 flex-1 overflow-auto px-4 pb-5 pt-3 2xl:px-5">
      <div className="mx-auto grid max-w-[1500px] gap-3 xl:grid-cols-[minmax(0,1fr)_390px]">
        <section className="grid content-start gap-3">
          <div className="rounded-[8px] border border-[#20385f] bg-[#0a1426] p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h1 className="text-lg font-black text-[#f1cc00]">TTS riêng lẻ</h1>
                <p className="text-xs text-slate-400">Tạo audio độc lập, không thay đổi video, phụ đề hoặc timeline dự án.</p>
              </div>
              <div className="text-xs font-bold text-slate-300">{text.length.toLocaleString('vi-VN')} ký tự</div>
            </div>
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="Dán văn bản cần chuyển thành giọng nói..."
              className="min-h-[190px] w-full resize-y rounded border border-[#263a5d] bg-[#071020] p-3 text-sm leading-6 text-white outline-none focus:border-[#f1cc00]"
            />
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button tone="yellow" onClick={planText} disabled={busyAction === 'plan'}>
                {busyAction === 'plan' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Scissors className="h-4 w-4" />}
                Tự động chia đoạn
              </Button>
              <Button onClick={() => { setText(''); setSegments([]); setOperation(null); }}>Xóa nội dung</Button>
              <span className="ml-auto text-xs text-slate-400">Mục tiêu 350, tối đa 500 ký tự mỗi đoạn</span>
            </div>
          </div>

          <div className="rounded-[8px] border border-[#20385f] bg-[#0a1426]">
            <div className="flex items-center justify-between border-b border-[#20385f] px-4 py-3">
              <div className="font-black text-white">Các đoạn TTS</div>
              <div className="text-xs text-slate-400">{segments.length} đoạn</div>
            </div>
            <div className="grid max-h-[520px] gap-2 overflow-auto p-3">
              {!segments.length ? <div className="rounded border border-dashed border-[#263a5d] p-8 text-center text-sm text-slate-400">Chưa có đoạn. Nhập văn bản và bấm Tự động chia đoạn.</div> : null}
              {segments.map((segment, index) => {
                const liveStatus = operation?.segments?.find((item) => item.id === segment.id) || operation?.segments?.[index];
                return (
                  <div
                    key={segment.id}
                    draggable
                    onDragStart={() => setDraggedId(segment.id)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => moveSegment(segment.id)}
                    className="grid grid-cols-[26px_minmax(0,1fr)] gap-2 rounded border border-[#263a5d] bg-[#071020] p-2"
                  >
                    <div className="flex cursor-grab flex-col items-center gap-2 pt-2 text-slate-500">
                      <GripVertical className="h-4 w-4" />
                      <span className="text-[10px] font-black">{index + 1}</span>
                    </div>
                    <div className="min-w-0">
                      <textarea
                        value={segment.text}
                        onChange={(event) => updateSegment(segment.id, { text: event.target.value })}
                        onSelect={(event) => { selectionRef.current[segment.id] = event.currentTarget.selectionStart; }}
                        className="min-h-[76px] w-full resize-y rounded border border-[#1d3152] bg-[#0b1426] p-2 text-xs leading-5 text-white outline-none focus:border-[#f1cc00]"
                      />
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <Button className="h-7 px-2" onClick={() => splitSegment(segment.id)}><Scissors className="h-3.5 w-3.5" />Tách</Button>
                        <Button className="h-7 px-2" disabled={!index} onClick={() => mergeSegment(segment.id, 'previous')}><Merge className="h-3.5 w-3.5" />Ghép trước</Button>
                        <Button className="h-7 px-2" disabled={index === segments.length - 1} onClick={() => mergeSegment(segment.id, 'next')}><Merge className="h-3.5 w-3.5" />Ghép sau</Button>
                        <Select
                          value={segment.breakAfter}
                          disabled={index === segments.length - 1}
                          onChange={(event) => updateSegment(segment.id, { breakAfter: event.target.value })}
                          className="h-7 w-[140px] px-2"
                        >
                          <option value="sentence">Nghỉ 120 ms</option>
                          <option value="paragraph">Nghỉ 300 ms</option>
                          <option value="none">Không nghỉ</option>
                        </Select>
                        <button type="button" className="ml-auto rounded p-1.5 text-red-300 hover:bg-red-500/15" onClick={() => setSegments((current) => reindexSegments(current.filter((item) => item.id !== segment.id)))}><Trash2 className="h-4 w-4" /></button>
                        <span className={`text-[11px] font-bold ${segment.text.length > 500 ? 'text-red-300' : 'text-slate-400'}`}>{segment.text.length}/500</span>
                        {liveStatus ? <span className={`rounded px-2 py-1 text-[10px] font-black ${liveStatus.status === 'completed' ? 'bg-emerald-500/15 text-emerald-300' : liveStatus.status === 'failed' ? 'bg-red-500/15 text-red-300' : 'bg-blue-500/15 text-blue-200'}`}>{statusLabel(liveStatus.status)}{liveStatus.attempts > 1 ? ` · lần ${liveStatus.attempts}` : ''}</span> : null}
                      </div>
                      {liveStatus?.error ? <div className="mt-1 text-[11px] text-red-300">{liveStatus.error}</div> : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        <aside className="grid content-start gap-3">
          <div className="rounded-[8px] border border-[#20385f] bg-[#0a1426] p-3">
            <div className="mb-3 flex items-center justify-between">
              <div className="font-black text-white">Cấu hình giọng</div>
              <Button className="h-7 px-2" onClick={loadVoices} disabled={busyAction === 'voices'}>
                <RefreshCw className={`h-3.5 w-3.5 ${busyAction === 'voices' ? 'animate-spin' : ''}`} />Tải giọng
              </Button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
              <Field label="Provider">
                <Select value={config.ttsProvider} onChange={(event) => {
                  const provider = event.target.value;
                  onConfigChange({
                    ttsProvider: provider,
                    ttsVoiceName: '',
                    ttsConcurrency: defaultConcurrency(provider),
                    ttsMaxAttempts: defaultAttempts(provider),
                  });
                }}>
                  <option value="edge_tts">Edge TTS</option>
                  <option value="google_cloud_tts">Google Cloud TTS</option>
                  <option value="aimax_tts">AIMAX Clone</option>
                </Select>
              </Field>
              <Field label="Ngôn ngữ">
                <Select value={config.ttsLanguageCode} onChange={(event) => onConfigChange({ ttsLanguageCode: event.target.value, ttsVoiceName: '' })}>
                  {LANGUAGES.map((item) => <option key={item} value={item}>{item}</option>)}
                </Select>
              </Field>
              <Field label="Giới tính">
                <Select value={config.voiceGenderFilter || 'all'} onChange={(event) => onConfigChange({ voiceGenderFilter: event.target.value, ssmlGender: event.target.value === 'all' ? 'NEUTRAL' : event.target.value, ttsVoiceName: '' })}>
                  <option value="all">Tất cả</option>
                  <option value="MALE">Nam</option>
                  <option value="FEMALE">Nữ</option>
                  <option value="NEUTRAL">Trung tính</option>
                </Select>
              </Field>
              <Field label={`Giọng (${visibleVoices.length})`}>
                <Select
                  aria-label={`Giọng (${visibleVoices.length})`}
                  value={config.ttsVoiceName || ''}
                  onChange={(event) => onConfigChange({ ttsVoiceName: event.target.value })}
                >
                  {!visibleVoices.length ? <option value="">Tự chọn giọng</option> : null}
                  {voiceGroups.map((group) => (
                    <optgroup key={group.label} label={group.label}>
                      {group.voices.map((voice) => (
                        <option key={voice.value} value={voice.value}>
                          {friendlyVoiceLabel(voice, config.ttsLanguageCode, config.ttsProvider)}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </Select>
                {selectedVoiceGuidance ? (
                  <span className="rounded border border-[#29446d] bg-[#101d33] p-2 text-[10px] leading-4 text-slate-300">
                    <strong className="text-[#f1cc00]">
                      {selectedVoiceGuidance.recommended ? '★ Nên thử' : 'Gợi ý sử dụng'}
                    </strong>
                    {' · '}
                    {voiceGenderLabel(selectedVoice?.gender)}, {selectedVoiceGuidance.tone}.
                    <br />
                    <strong className="text-white">Phù hợp:</strong> {selectedVoiceGuidance.use}.
                    {selectedVoiceGuidance.familiar ? ' Đây là dòng giọng Việt lâu năm, dễ dùng cho nội dung phổ thông.' : ''}
                  </span>
                ) : null}
                {config.ttsProvider === 'google_cloud_tts' && config.ttsLanguageCode === 'vi-VN' ? (
                  <span className="text-[9px] leading-3 text-slate-500">
                    ★ là đề xuất thực tế, không phải bảng xếp hạng lượt dùng. Hãy nghe thử bằng chính kịch bản của bạn.
                  </span>
                ) : null}
              </Field>
              {config.ttsProvider === 'aimax_tts' ? (
                <>
                  <Field label="AIMAX provider">
                    <Select value={config.aimaxProvider || 'minimax'} onChange={(event) => {
                      const provider = event.target.value;
                      onConfigChange({ aimaxProvider: provider, aimaxModel: AIMAX_MODELS[provider][0], ttsVoiceName: '' });
                    }}>
                      <option value="minimax">Minimax</option>
                      <option value="elevenlabs">ElevenLabs</option>
                    </Select>
                  </Field>
                  <Field label="AIMAX model">
                    <Select value={config.aimaxModel || AIMAX_MODELS[config.aimaxProvider || 'minimax'][0]} onChange={(event) => onConfigChange({ aimaxModel: event.target.value })}>
                      {AIMAX_MODELS[config.aimaxProvider || 'minimax'].map((item) => <option key={item} value={item}>{item}</option>)}
                    </Select>
                  </Field>
                  <Field label="AIMAX API key">
                    <Input type="password" value={config.aimaxApiKey || ''} placeholder="Để trống dùng Backend/.env" onChange={(event) => onConfigChange({ aimaxApiKey: event.target.value })} />
                  </Field>
                </>
              ) : null}
              <Field label="Tốc độ">
                <Input type="number" min="0.5" max="2" step="0.05" value={config.speakingRate ?? 1} onChange={(event) => onConfigChange({ speakingRate: Number(event.target.value) || 1 })} />
              </Field>
              <Field label="Pitch">
                <Input type="number" min="-20" max="20" step="0.5" value={config.pitch ?? 0} onChange={(event) => onConfigChange({ pitch: Number(event.target.value) || 0 })} />
              </Field>
              <Field label="Chạy song song">
                <Input type="number" min="1" max={maxConcurrency(config.ttsProvider)} value={config.ttsConcurrency ?? defaultConcurrency(config.ttsProvider)} onChange={(event) => onConfigChange({ ttsConcurrency: Math.min(maxConcurrency(config.ttsProvider), Math.max(1, Number(event.target.value) || 1)) })} />
              </Field>
              <Field label="Số lần thử">
                <Input type="number" min="1" max="5" value={config.ttsMaxAttempts ?? defaultAttempts(config.ttsProvider)} onChange={(event) => onConfigChange({ ttsMaxAttempts: Math.min(5, Math.max(1, Number(event.target.value) || 1)) })} />
              </Field>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <Button tone="blue" className="flex-1" onClick={previewVoice} disabled={busyAction === 'preview'}>
                {busyAction === 'preview' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Volume2 className="h-4 w-4" />}Nghe thử
              </Button>
              {previewAudio ? <audio controls src={previewAudio} className="h-9 min-w-0 flex-1" /> : null}
            </div>
          </div>

          <div className="rounded-[8px] border border-[#20385f] bg-[#0a1426] p-3">
            <div className="mb-3 font-black text-white">Xuất audio</div>
            <div className="grid gap-3">
              <div className="grid grid-cols-2 gap-2">
                <Field label="Định dạng">
                  <Select value={outputFormat} onChange={(event) => setOutputFormat(event.target.value)}>
                    <option value="mp3">MP3 192 kbps</option>
                    <option value="wav">WAV PCM 32 kHz</option>
                  </Select>
                </Field>
                <Field label="Tên file">
                  <Input value={fileName} onChange={(event) => setFileName(event.target.value)} placeholder="Tự tạo theo thời gian" />
                </Field>
              </div>
              <Field label="Thư mục lưu">
                <div className="grid grid-cols-[1fr_auto] gap-2">
                  <Input value={outputDirectory} onChange={(event) => setOutputDirectory(event.target.value)} />
                  <Button onClick={pickFolder} disabled={busyAction === 'folder'}><FolderOpen className="h-4 w-4" />Chọn</Button>
                </div>
              </Field>
              <div className="grid grid-cols-[1fr_auto] gap-2">
                <Button tone="green" className="h-11 text-sm" onClick={createAudio} disabled={busyAction === 'create' || !segments.length}>
                  {busyAction === 'create' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}Tạo audio
                </Button>
                <Button tone="red" className="h-11" disabled={!operation || !['queued', 'running'].includes(operation.status)} onClick={cancelAudio}><X className="h-4 w-4" />Hủy</Button>
              </div>
              {operation ? (
                <div className="grid gap-2 rounded border border-[#263a5d] bg-[#071020] p-3 text-xs">
                  <div className="flex items-center justify-between"><span>{statusLabel(operation.status)}</span><strong>{operation.completedSegments || 0}/{operation.totalSegments || 0}</strong></div>
                  <div className="h-2 overflow-hidden rounded bg-[#14243f]"><div className="h-full bg-[#f1cc00] transition-all" style={{ width: `${operation.status === 'completed' ? 100 : progress}%` }} /></div>
                  {operation.result ? (
                    <>
                      <audio controls src={`${apiBase}${operation.result.audioUrl}?t=${Date.now()}`} className="mt-1 w-full" />
                      <div className="flex gap-2">
                        <a className="inline-flex h-8 flex-1 items-center justify-center gap-2 rounded bg-[#4389ee] px-3 font-black text-white" href={`${apiBase}${operation.result.downloadUrl}`}><Download className="h-4 w-4" />Tải file</a>
                        <Button className="h-8" onClick={() => openFolder(operation.result.outputDirectory)}><FolderOpen className="h-4 w-4" />Mở thư mục</Button>
                      </div>
                    </>
                  ) : null}
                </div>
              ) : null}
              {message ? <div className="rounded border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-200">{message}</div> : null}
            </div>
          </div>

          <div className="rounded-[8px] border border-[#20385f] bg-[#0a1426]">
            <div className="flex items-center justify-between border-b border-[#20385f] px-3 py-2.5">
              <div className="font-black text-white">20 kết quả gần nhất</div>
              <Button className="h-7 px-2" onClick={clearHistory} disabled={!history.length}><Trash2 className="h-3.5 w-3.5" />Xóa lịch sử</Button>
            </div>
            <div className="grid max-h-[330px] gap-2 overflow-auto p-2">
              {!history.length ? <div className="p-5 text-center text-xs text-slate-400">Chưa có kết quả.</div> : null}
              {history.map((item) => (
                <div key={item.id} className="rounded border border-[#263a5d] bg-[#071020] p-2 text-xs">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate font-bold text-white">{item.fileName || `Tác vụ ${item.id.slice(0, 8)}`}</div>
                      <div className="mt-1 text-[11px] text-slate-400">{item.provider} · {item.segmentCount || 0} đoạn · {item.outputFormat?.toUpperCase()}</div>
                      <div className="text-[11px] text-slate-500">{new Date(item.createdAt).toLocaleString('vi-VN')}</div>
                    </div>
                    <span className={`rounded px-1.5 py-1 text-[10px] font-black ${item.status === 'completed' && !item.missing ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300'}`}>{item.missing ? 'Thiếu file' : statusLabel(item.status)}</span>
                  </div>
                  {item.status === 'completed' && !item.missing ? (
                    <div className="mt-2 flex items-center gap-2">
                      <span className="text-[11px] text-slate-400">{formatDuration(item.durationSeconds)} · {formatBytes(item.fileSizeBytes)}</span>
                      <a className="ml-auto rounded bg-[#4389ee] p-1.5 text-white" href={`${apiBase}${item.downloadUrl}`} title="Tải file"><Download className="h-3.5 w-3.5" /></a>
                      <button type="button" className="rounded bg-[#111c2f] p-1.5 text-white" onClick={() => openFolder(item.outputDirectory)} title="Mở thư mục"><FolderOpen className="h-3.5 w-3.5" /></button>
                    </div>
                  ) : item.error ? <div className="mt-2 text-[11px] text-red-300">{item.error}</div> : null}
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
