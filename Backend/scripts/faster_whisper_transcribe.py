import argparse
import json
import os
import site
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")


def set_env_if_missing(key, value):
    if value and not os.environ.get(key):
        os.environ[key] = value


def init_model_cache_root():
    root = os.path.abspath(os.environ.get("DUBFLOW_MODEL_CACHE_ROOT") or r"D:\DubFlowModelCache")
    directories = {
        "DUBFLOW_MODEL_CACHE_ROOT": root,
        "HF_HOME": os.path.join(root, "huggingface"),
        "HUGGINGFACE_HUB_CACHE": os.path.join(root, "huggingface", "hub"),
        "TRANSFORMERS_CACHE": os.path.join(root, "transformers"),
        "TORCH_HOME": os.path.join(root, "torch"),
        "SENTENCE_TRANSFORMERS_HOME": os.path.join(root, "sentence-transformers"),
        "XDG_CACHE_HOME": os.path.join(root, "xdg-cache"),
        "TMP": os.path.join(root, "temp"),
        "TEMP": os.path.join(root, "temp"),
    }

    for directory in directories.values():
        os.makedirs(directory, exist_ok=True)
    for key, value in directories.items():
        set_env_if_missing(key, value)


def add_nvidia_dll_directories():
    if os.name != "nt":
        return

    site_dirs = []
    try:
        site_dirs.extend(site.getsitepackages())
    except Exception:
        pass
    try:
        site_dirs.append(site.getusersitepackages())
    except Exception:
        pass

    dll_dirs = []
    for site_dir in site_dirs:
        nvidia_root = os.path.join(site_dir, "nvidia")
        dll_dirs.extend(
            [
                os.path.join(nvidia_root, "cublas", "bin"),
                os.path.join(nvidia_root, "cudnn", "bin"),
                os.path.join(nvidia_root, "cuda_nvrtc", "bin"),
            ]
        )

    for dll_dir in dll_dirs:
        if not os.path.isdir(dll_dir):
            continue
        if hasattr(os, "add_dll_directory"):
            os.add_dll_directory(dll_dir)
        if dll_dir not in os.environ.get("PATH", "").split(os.pathsep):
            os.environ["PATH"] = dll_dir + os.pathsep + os.environ.get("PATH", "")


init_model_cache_root()
add_nvidia_dll_directories()

from faster_whisper import WhisperModel


MAX_RAW_CUE_SECONDS = 5.0
MAX_RAW_CUE_CHARS = 88
MIN_RAW_CUE_SECONDS = 0.45
PAUSE_BREAK_SECONDS = 0.45
PUNCTUATION_BREAKS = (".", "?", "!", "。", "？", "！")


def parse_bool(value, default=False):
    if value is None:
        return default
    text = str(value).strip().lower()
    if text in ("1", "true", "yes", "y", "on"):
        return True
    if text in ("0", "false", "no", "n", "off"):
        return False
    return default


def parse_int(value, default, minimum=None, maximum=None):
    try:
        parsed = int(str(value).strip())
    except Exception:
        parsed = default
    if minimum is not None:
        parsed = max(minimum, parsed)
    if maximum is not None:
        parsed = min(maximum, parsed)
    return parsed


def parse_float(value, default, minimum=None, maximum=None):
    try:
        parsed = float(str(value).strip())
    except Exception:
        parsed = default
    if minimum is not None:
        parsed = max(minimum, parsed)
    if maximum is not None:
        parsed = min(maximum, parsed)
    return parsed


def normalize_language(language_code):
    if not language_code:
        return None

    language = language_code.split("-")[0].lower()
    if language == "zh":
        return "zh"
    return language


def normalize_transcript_text(text):
    cleaned = " ".join(str(text or "").split())
    for token in [".", ",", "?", "!", ";", ":", "。", "，", "？", "！", "；", "："]:
        cleaned = cleaned.replace(f" {token}", token)
    return cleaned.strip()


def word_to_dict(word):
    text = normalize_transcript_text(getattr(word, "word", ""))
    start = getattr(word, "start", None)
    end = getattr(word, "end", None)
    if start is None or end is None or not text:
        return None
    return {"text": text, "start": float(start), "end": float(end)}


def make_result_segment(words):
    valid = [item for item in words if item and item.get("text")]
    if not valid:
        return None
    start = float(valid[0]["start"])
    end = float(valid[-1]["end"])
    text = normalize_transcript_text(" ".join(item["text"] for item in valid))
    if not text or end <= start:
        return None
    return {
        "text": text,
        "start": start,
        "end": end,
        "duration": max(0.1, end - start),
        "words": valid,
    }


def split_words_into_raw_cues(words):
    valid_words = [word_to_dict(word) for word in words or []]
    valid_words = [word for word in valid_words if word]
    if not valid_words:
        return []

    cues = []
    buffer = []
    for index, word in enumerate(valid_words):
        buffer.append(word)
        next_word = valid_words[index + 1] if index + 1 < len(valid_words) else None
        text = normalize_transcript_text(" ".join(item["text"] for item in buffer))
        duration = max(0.0, float(word["end"]) - float(buffer[0]["start"]))
        next_gap = max(0.0, float(next_word["start"]) - float(word["end"])) if next_word else 0.0
        ends_sentence = text.endswith(PUNCTUATION_BREAKS)

        should_flush = next_word is None
        should_flush = should_flush or (duration >= MIN_RAW_CUE_SECONDS and next_gap >= PAUSE_BREAK_SECONDS)
        should_flush = should_flush or (duration >= 1.1 and ends_sentence)
        should_flush = should_flush or duration >= MAX_RAW_CUE_SECONDS
        should_flush = should_flush or len(text) >= MAX_RAW_CUE_CHARS

        if should_flush:
            cue = make_result_segment(buffer)
            if cue:
                cues.append(cue)
            buffer = []

    return cues


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--model", default="base")
    parser.add_argument("--language", default="")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--compute-type", default="default")
    parser.add_argument("--vad-filter", default=os.environ.get("DUBFLOW_FW_VAD_FILTER", "false"))
    parser.add_argument("--beam-size", default=os.environ.get("DUBFLOW_FW_BEAM_SIZE", "3"))
    parser.add_argument("--best-of", default=os.environ.get("DUBFLOW_FW_BEST_OF", "1"))
    parser.add_argument("--condition-on-previous-text", default=os.environ.get("DUBFLOW_FW_CONDITION_ON_PREVIOUS_TEXT", "false"))
    parser.add_argument("--no-speech-threshold", default=os.environ.get("DUBFLOW_FW_NO_SPEECH_THRESHOLD", "0.45"))
    parser.add_argument("--word-timestamps", default=os.environ.get("DUBFLOW_ENABLE_WORD_TIMESTAMPS", "true"))
    parser.add_argument("--word-cue-mode", default=os.environ.get("DUBFLOW_FW_WORD_CUE_MODE", "false"))
    parser.add_argument("--output", default="")
    args = parser.parse_args()

    kwargs = {"device": args.device}
    if args.compute_type != "default":
        kwargs["compute_type"] = args.compute_type

    model = WhisperModel(args.model, **kwargs)
    use_vad = parse_bool(args.vad_filter, False)
    use_word_timestamps = parse_bool(args.word_timestamps, True)
    use_word_cue_mode = parse_bool(args.word_cue_mode, False)
    transcribe_options = {
        "language": normalize_language(args.language),
        "vad_filter": use_vad,
        "beam_size": parse_int(args.beam_size, 3, 1, 12),
        "best_of": parse_int(args.best_of, 1, 1, 12),
        "word_timestamps": use_word_timestamps,
        "condition_on_previous_text": parse_bool(args.condition_on_previous_text, False),
        "no_speech_threshold": parse_float(args.no_speech_threshold, 0.45, 0.05, 0.95),
    }
    if use_vad:
        transcribe_options["vad_parameters"] = {
            "min_silence_duration_ms": 700,
            "speech_pad_ms": 400,
        }

    segments, _ = model.transcribe(
        args.audio,
        **transcribe_options,
    )

    result = []
    for segment in segments:
        text = segment.text.strip()
        if not text:
            continue

        segment_words = [word for word in (word_to_dict(word) for word in (getattr(segment, "words", None) or [])) if word] if use_word_timestamps else []
        word_cues = split_words_into_raw_cues(getattr(segment, "words", None)) if use_word_timestamps and use_word_cue_mode else []
        if word_cues:
            result.extend(word_cues)
            continue

        start = float(segment.start)
        end = float(segment.end)
        item = {
            "text": text,
            "start": start,
            "end": end,
            "duration": max(0.1, end - start),
        }
        if segment_words:
            item["words"] = segment_words
        result.append(item)

    payload = json.dumps(result, ensure_ascii=False)
    if args.output:
        with open(args.output, "w", encoding="utf-8") as handle:
            handle.write(payload)
            handle.write("\n")
    else:
        print(payload)
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
