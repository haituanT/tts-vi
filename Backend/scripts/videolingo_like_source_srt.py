import argparse
import json
import math
import re
import sys
from dataclasses import dataclass
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")


STRONG_PUNCT = set("。！？!?")
CLAUSE_PUNCT = set("，,；;：:")
OPEN_QUOTES = set("“‘「『《（(")
CLOSE_QUOTES = set("”’」』》）)")
ZH_CONNECTORS = (
    "但是",
    "但",
    "不过",
    "然而",
    "可是",
    "因为",
    "所以",
    "如果",
    "虽然",
    "尽管",
    "即使",
    "而且",
    "然后",
    "接着",
    "于是",
    "与此同时",
    "后来",
)
WEAK_PREFIXES = (
    "的",
    "了",
    "着",
    "过",
    "地",
    "得",
    "和",
    "与",
    "及",
    "以及",
    "或",
    "在",
    "于",
    "向",
    "把",
    "被",
)
MEASURE_WORDS = (
    "个",
    "名",
    "位",
    "只",
    "条",
    "次",
    "年",
    "月",
    "日",
    "秒",
    "分钟",
    "小时",
    "米",
    "公里",
    "美元",
)
CREDIT_NOISE_PATTERNS = (
    "字幕",
    "志愿者",
    "翻译",
    "校对",
    "时间轴",
)

try:
    import jieba  # type: ignore
except Exception:
    jieba = None

try:
    from wtpsplit_lite import SaT  # type: ignore
except Exception:
    SaT = None


@dataclass
class Word:
    text: str
    start: float
    end: float
    segment_index: int = -1


@dataclass
class Cue:
    text: str
    start: float
    end: float
    words: list[Word]


def normalize_text(text: str) -> str:
    cleaned = re.sub(r"\s+", " ", str(text or "")).strip()
    cleaned = re.sub(r"\s+([，。！？；：,.!?;:])", r"\1", cleaned)
    cleaned = re.sub(r"([“‘「『《（])\s+", r"\1", cleaned)
    cleaned = re.sub(r"\s+([”’」』》）])", r"\1", cleaned)
    return cleaned


def is_cjk(char: str) -> bool:
    if not char:
        return False
    code = ord(char)
    return (
        0x3400 <= code <= 0x9FFF
        or 0x3040 <= code <= 0x30FF
        or 0xAC00 <= code <= 0xD7AF
    )


def is_punctuation(text: str) -> bool:
    return bool(text) and all(ch in STRONG_PUNCT or ch in CLAUSE_PUNCT or ch in OPEN_QUOTES or ch in CLOSE_QUOTES for ch in text)


def weighted_len(text: str) -> float:
    total = 0.0
    for char in text:
        code = ord(char)
        if 0x4E00 <= code <= 0x9FFF or 0x3040 <= code <= 0x30FF:
            total += 1.75
        elif 0xAC00 <= code <= 0xD7AF:
            total += 1.5
        elif 0xFF01 <= code <= 0xFF5E:
            total += 1.75
        else:
            total += 0.55 if char.isspace() else 1.0
    return total


def join_tokens(words: list[Word]) -> str:
    output = ""
    for word in words:
        token = normalize_text(word.text)
        if not token:
            continue
        if not output:
            output = token
            continue
        prev = output[-1]
        first = token[0]
        if first in STRONG_PUNCT or first in CLAUSE_PUNCT or first in CLOSE_QUOTES:
            output += token
        elif prev in OPEN_QUOTES:
            output += token
        elif is_cjk(prev) or is_cjk(first):
            output += token
        else:
            output += " " + token
    return normalize_text(output)


def join_tokens_with_mapping(words: list[Word]) -> tuple[str, list[int]]:
    output = ""
    char_to_word: list[int] = []
    for word_index, word in enumerate(words):
        token = normalize_text(word.text)
        if not token:
            continue
        spacer = ""
        if output:
            prev = output[-1]
            first = token[0]
            if first in STRONG_PUNCT or first in CLAUSE_PUNCT or first in CLOSE_QUOTES:
                spacer = ""
            elif prev in OPEN_QUOTES:
                spacer = ""
            elif is_cjk(prev) or is_cjk(first):
                spacer = ""
            else:
                spacer = " "
        if spacer:
            output += spacer
            char_to_word.append(word_index)
        output += token
        char_to_word.extend([word_index] * len(token))
    return output, char_to_word


def flatten_words(segments: list[dict]) -> list[Word]:
    words: list[Word] = []
    for segment_index, segment in enumerate(segments):
        raw_words = segment.get("words") or []
        if raw_words:
            for item in raw_words:
                text = normalize_text(item.get("text") or item.get("word") or "")
                start = safe_float(item.get("start"))
                end = safe_float(item.get("end"))
                if text and end > start:
                    words.append(Word(text=text, start=start, end=end, segment_index=segment_index))
            continue

        text = normalize_text(segment.get("text") or "")
        start = safe_float(segment.get("start"))
        end = safe_float(segment.get("end"))
        if text and end > start:
            words.append(Word(text=text, start=start, end=end, segment_index=segment_index))
    return words


def safe_float(value) -> float:
    try:
        result = float(value)
    except Exception:
        return 0.0
    return result if math.isfinite(result) else 0.0


def sec_to_srt_time(seconds: float) -> str:
    millis_total = max(0, int(round(seconds * 1000)))
    hours = millis_total // 3_600_000
    minutes = (millis_total % 3_600_000) // 60_000
    secs = (millis_total % 60_000) // 1000
    millis = millis_total % 1000
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def cue_to_srt(cues: list[Cue]) -> str:
    blocks = []
    for index, cue in enumerate(cues, 1):
        blocks.append(
            f"{index}\n"
            f"{sec_to_srt_time(cue.start)} --> {sec_to_srt_time(cue.end)}\n"
            f"{cue.text}"
        )
    return "\n\n".join(blocks).strip() + "\n"


def compact_for_match(text: str) -> str:
    return re.sub(r"[^\w\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]+", "", str(text or "").lower())


def compact_text_with_mapping(text: str) -> tuple[str, list[int]]:
    compact = []
    mapping = []
    for index, char in enumerate(text):
        cleaned = compact_for_match(char)
        if not cleaned:
            continue
        compact.append(cleaned)
        mapping.extend([index] * len(cleaned))
    return "".join(compact), mapping


def token_starts_with(text: str, prefixes: tuple[str, ...]) -> bool:
    cleaned = normalize_text(text)
    return any(cleaned.startswith(prefix) for prefix in prefixes)


def token_ends_sentence(text: str) -> bool:
    cleaned = normalize_text(text)
    return bool(cleaned) and cleaned[-1] in STRONG_PUNCT


def token_ends_clause(text: str) -> bool:
    cleaned = normalize_text(text)
    return bool(cleaned) and cleaned[-1] in CLAUSE_PUNCT


def looks_like_number_unit(left: str, right: str) -> bool:
    return bool(re.search(r"\d$", left)) and any(right.startswith(unit) for unit in MEASURE_WORDS)


def boundary_char_position(words: list[Word], split_index: int) -> int:
    return len(join_tokens(words[: split_index + 1]))


def jieba_boundary_positions(text: str) -> set[int]:
    if jieba is None:
        return set()
    positions = set()
    cursor = 0
    for token in jieba.lcut(text, cut_all=False):
        cursor += len(token)
        positions.add(cursor)
    return positions


def is_word_boundary(words: list[Word], split_index: int) -> bool:
    if jieba is None:
        return True
    text = join_tokens(words)
    if not text:
        return True
    cjk_count = sum(1 for char in text if is_cjk(char))
    if cjk_count < max(4, len(text) * 0.45):
        return True
    return boundary_char_position(words, split_index) in jieba_boundary_positions(text)


def bad_boundary(left_text: str, right_text: str, left_words: list[Word], right_words: list[Word]) -> bool:
    if not left_words or not right_words:
        return False
    left_token = normalize_text(left_words[-1].text)
    right_token = normalize_text(right_words[0].text)
    if not right_token:
        return True
    if right_token[0] in CLOSE_QUOTES or right_token[0] in STRONG_PUNCT or right_token[0] in CLAUSE_PUNCT:
        return True
    if right_token in WEAK_PREFIXES or token_starts_with(right_token, WEAK_PREFIXES):
        return True
    if left_token in OPEN_QUOTES:
        return True
    if looks_like_number_unit(left_token, right_token):
        return True
    if weighted_len(left_text) < 10 or weighted_len(right_text) < 6:
        return True
    return False


def boundary_score(words: list[Word], split_index: int, max_weight: float) -> float:
    left_words = words[: split_index + 1]
    right_words = words[split_index + 1 :]
    left_text = join_tokens(left_words)
    right_text = join_tokens(right_words)
    left_token = normalize_text(words[split_index].text)
    right_token = normalize_text(words[split_index + 1].text) if split_index + 1 < len(words) else ""
    duration = max(0.01, words[split_index].end - words[0].start)
    total_duration = max(0.01, words[-1].end - words[0].start)
    gap = max(0.0, words[split_index + 1].start - words[split_index].end) if split_index + 1 < len(words) else 0.0
    left_weight = weighted_len(left_text)
    total_weight = max(1.0, weighted_len(join_tokens(words)))
    balance = 1.0 - abs((left_weight / total_weight) - 0.5)

    if bad_boundary(left_text, right_text, left_words, right_words):
        return -100.0

    score = balance * 16.0
    strong_boundary = False
    if token_ends_sentence(left_token):
        strong_boundary = True
        score += 95.0
    elif token_ends_clause(left_token):
        strong_boundary = True
        score += 55.0
    if token_starts_with(right_token, ZH_CONNECTORS):
        strong_boundary = True
        score += 36.0
    if gap >= 0.85:
        strong_boundary = True
        score += 42.0
    elif gap >= 0.45:
        strong_boundary = True
        score += 25.0
    elif gap >= 0.25:
        score += 10.0
    if not strong_boundary and not is_word_boundary(words, split_index):
        score -= 70.0
    if duration >= 1.2:
        score += min(12.0, duration * 1.4)
    if total_duration >= 4.5 and left_weight >= max_weight * 0.42:
        score += 10.0
    if left_weight > max_weight * 1.18:
        score -= 20.0
    if words[split_index].end - words[0].start < 0.8:
        score -= 45.0
    return score


def choose_split(words: list[Word], max_weight: float) -> int | None:
    if len(words) < 2:
        return None
    best_index = None
    best_score = -999.0
    for index in range(len(words) - 1):
        score = boundary_score(words, index, max_weight)
        if score > best_score:
            best_score = score
            best_index = index
    if best_index is None or best_score < 0:
        return None
    return best_index


def should_flush(words: list[Word], next_word: Word | None, args) -> bool:
    if not words:
        return False
    text = join_tokens(words)
    duration = max(0.0, words[-1].end - words[0].start)
    weight = weighted_len(text)
    if next_word is None:
        return True
    if args.respect_asr_segments and next_word.segment_index != words[-1].segment_index and duration >= args.min_segment_seconds:
        return True
    gap = max(0.0, next_word.start - words[-1].end)
    if duration >= args.min_seconds and token_ends_sentence(words[-1].text):
        return True
    if duration >= args.min_seconds and token_ends_clause(words[-1].text) and weight >= args.min_weight:
        return True
    if duration >= args.min_seconds and gap >= args.pause_break:
        return True
    if duration >= args.hard_max_seconds or weight >= args.hard_max_weight:
        return True
    return False


def split_oversized(words: list[Word], args) -> list[list[Word]]:
    if not words:
        return []
    if len(words) <= 1:
        return [words]
    text = join_tokens(words)
    duration = max(0.0, words[-1].end - words[0].start)
    if duration <= args.max_seconds and weighted_len(text) <= args.max_weight:
        return [words]

    split_index = choose_split(words, args.max_weight)
    if split_index is None:
        midpoint = max(1, min(len(words) - 1, len(words) // 2))
        split_index = midpoint - 1

    left = words[: split_index + 1]
    right = words[split_index + 1 :]
    return split_oversized(left, args) + split_oversized(right, args)


def build_cues(words: list[Word], args) -> list[Cue]:
    chunks: list[list[Word]] = []
    buffer: list[Word] = []
    for index, word in enumerate(words):
        buffer.append(word)
        next_word = words[index + 1] if index + 1 < len(words) else None
        if should_flush(buffer, next_word, args):
            chunks.extend(split_oversized(buffer, args))
            buffer = []
    if buffer:
        chunks.extend(split_oversized(buffer, args))

    cues = []
    for chunk in chunks:
        text = join_tokens(chunk)
        if not text:
            continue
        cues.append(Cue(text=text, start=chunk[0].start, end=chunk[-1].end, words=chunk))

    for index in range(len(cues) - 1):
        gap = cues[index + 1].start - cues[index].end
        if 0 < gap < args.fill_gap_under:
            cues[index].end = cues[index + 1].start
    return filter_trailing_noise(cues, args)


def split_full_text_with_sat(full_text: str, args) -> list[str]:
    if SaT is None:
        return []
    sat = SaT(args.sat_model)
    try:
        sentences = sat.split(full_text, lang_code=args.lang)
    except TypeError:
        sentences = sat.split(full_text)
    return [normalize_text(sentence) for sentence in sentences if normalize_text(sentence)]


def map_text_parts_to_word_chunks(words: list[Word], parts: list[str]) -> list[list[Word]]:
    full_text, char_to_word = join_tokens_with_mapping(words)
    compact_full, compact_to_char = compact_text_with_mapping(full_text)
    compact_cursor = 0
    chunks: list[list[Word]] = []

    for part in parts:
        compact_part = compact_for_match(part)
        if not compact_part:
            continue
        match_pos = compact_full.find(compact_part, compact_cursor)
        if match_pos < 0:
            match_pos = compact_full.find(compact_part)
        if match_pos < 0:
            continue

        start_char = compact_to_char[match_pos]
        end_char = compact_to_char[match_pos + len(compact_part) - 1]
        start_word = char_to_word[start_char]
        end_word = char_to_word[end_char]
        if end_word >= start_word:
            chunks.append(words[start_word:end_word + 1])
        compact_cursor = match_pos + len(compact_part)

    return chunks


def build_cues_from_sentence_parts(words: list[Word], parts: list[str], args) -> list[Cue]:
    chunks = []
    for chunk in map_text_parts_to_word_chunks(words, parts):
        chunks.extend(split_oversized(chunk, args))

    cues = []
    for chunk in chunks:
        if not chunk:
            continue
        text = join_tokens(chunk)
        if text:
            cues.append(Cue(text=text, start=chunk[0].start, end=chunk[-1].end, words=chunk))

    for index in range(len(cues) - 1):
        gap = cues[index + 1].start - cues[index].end
        if 0 < gap < args.fill_gap_under:
            cues[index].end = cues[index + 1].start
    return filter_trailing_noise(cues, args)


def build_cues_with_strategy(words: list[Word], args) -> list[Cue]:
    if args.strategy in ("asr", "hybrid"):
        args.respect_asr_segments = True
        return build_cues(words, args)
    if args.strategy == "sat":
        full_text, _ = join_tokens_with_mapping(words)
        parts = split_full_text_with_sat(full_text, args)
        if parts:
            cues = build_cues_from_sentence_parts(words, parts, args)
            if cues:
                return cues
    return build_cues(words, args)


def filter_trailing_noise(cues: list[Cue], args) -> list[Cue]:
    if not args.drop_trailing_credit_noise:
        return cues
    for index, cue in enumerate(cues):
        previous = cues[index - 1] if index > 0 else None
        gap_before = cue.start - previous.end if previous else 0
        text = normalize_text(cue.text)
        if gap_before >= args.trailing_noise_gap and any(pattern in text for pattern in CREDIT_NOISE_PATTERNS):
            return cues[:index]
    return [
        cue for cue in cues
        if not (len(normalize_text(cue.text)) <= 1 and cue.end - cue.start > args.max_single_char_seconds)
    ]


def write_report(cues: list[Cue], output: Path) -> None:
    rows = []
    for index, cue in enumerate(cues, 1):
        rows.append(
            {
                "index": index,
                "start": round(cue.start, 3),
                "end": round(cue.end, 3),
                "duration": round(cue.end - cue.start, 3),
                "weightedLength": round(weighted_len(cue.text), 2),
                "text": cue.text,
            }
        )
    output.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")


def read_json_file(path: Path):
    raw = path.read_bytes()
    for encoding in ("utf-8-sig", "utf-16", "utf-16-le"):
        try:
            return json.loads(raw.decode(encoding))
        except UnicodeDecodeError:
            continue
        except json.JSONDecodeError:
            continue
    raise ValueError(f"Unable to parse JSON file: {path}")


def main():
    parser = argparse.ArgumentParser(description="Generate a VideoLingo-style source SRT from DubFlow/Faster-Whisper word timestamps.")
    parser.add_argument("--input", required=True, help="Transcript JSON from faster_whisper_transcribe.py")
    parser.add_argument("--output", required=True, help="Output SRT path")
    parser.add_argument("--report", default="", help="Optional JSON report path")
    parser.add_argument("--strategy", choices=("hybrid", "sat", "wordstream", "asr"), default="hybrid")
    parser.add_argument("--lang", default="zh")
    parser.add_argument("--sat-model", default="sat-3l-sm")
    parser.add_argument("--max-seconds", type=float, default=4.8)
    parser.add_argument("--min-seconds", type=float, default=0.75)
    parser.add_argument("--min-segment-seconds", type=float, default=0.35)
    parser.add_argument("--max-weight", type=float, default=34.0)
    parser.add_argument("--hard-max-seconds", type=float, default=7.2)
    parser.add_argument("--hard-max-weight", type=float, default=52.0)
    parser.add_argument("--min-weight", type=float, default=11.0)
    parser.add_argument("--pause-break", type=float, default=0.42)
    parser.add_argument("--fill-gap-under", type=float, default=0.75)
    parser.add_argument("--trailing-noise-gap", type=float, default=8.0)
    parser.add_argument("--max-single-char-seconds", type=float, default=5.0)
    parser.add_argument("--respect-asr-segments", action=argparse.BooleanOptionalAction, default=False)
    parser.add_argument("--drop-trailing-credit-noise", action=argparse.BooleanOptionalAction, default=False)
    args = parser.parse_args()

    input_path = Path(args.input)
    payload = read_json_file(input_path)
    if isinstance(payload, dict):
        segments = payload.get("rawSegments") or payload.get("segments") or payload.get("sourceSegments") or []
    else:
        segments = payload
    if not isinstance(segments, list):
        raise SystemExit("Input JSON must be a segment array or a transcript object containing rawSegments/segments.")
    words = flatten_words(segments)
    if not words:
        raise SystemExit("No timed words found. Enable word timestamps before running this script.")

    cues = build_cues_with_strategy(words, args)
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(cue_to_srt(cues), encoding="utf-8")
    if args.report:
        write_report(cues, Path(args.report))
    print(json.dumps({"wordCount": len(words), "cueCount": len(cues), "output": str(output_path)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
