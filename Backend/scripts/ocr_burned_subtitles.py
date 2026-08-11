#!/usr/bin/env python3
"""OCR burned-in subtitles from video frames and export SRT/JSON.

The script intentionally preserves the OCR text visible in sampled frames. It
does not run NLP subtitle splitting; cue boundaries are created only when the
visible frame text changes or disappears.
"""

from __future__ import annotations

import argparse
import base64
import difflib
import json
import math
import os
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import cv2
import requests


GOOGLE_VISION_ENDPOINT = "https://vision.googleapis.com/v1/images:annotate"
_rapidocr_thread_local = threading.local()


def eprint(*args: Any) -> None:
    print(*args, file=sys.stderr, flush=True)


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def rapidocr_engine() -> Any:
    try:
        from rapidocr import RapidOCR
    except Exception as exc:  # pragma: no cover - optional fallback
        raise RuntimeError(f"RapidOCR is not available: {exc}") from exc

    engine = getattr(_rapidocr_thread_local, "engine", None)
    if engine is None:
        params = {}
        if str(os.environ.get("RAPIDOCR_USE_DML", "")).strip().lower() in {"1", "true", "yes"}:
            params["EngineConfig.onnxruntime.use_dml"] = True
        if str(os.environ.get("RAPIDOCR_USE_CUDA", "")).strip().lower() in {"1", "true", "yes"}:
            params["EngineConfig.onnxruntime.use_cuda"] = True
        engine = RapidOCR(params=params or None)
        _rapidocr_thread_local.engine = engine
    return engine


def srt_timestamp(seconds: float) -> str:
    millis_total = max(0, int(round(seconds * 1000)))
    hours, rem = divmod(millis_total, 3_600_000)
    minutes, rem = divmod(rem, 60_000)
    secs, millis = divmod(rem, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def normalize_for_compare(text: str) -> str:
    text = text or ""
    text = re.sub(r"\s+", "", text)
    text = re.sub(r"[，,。.!！?？;；:：、\"'“”‘’\-_\[\]()（）【】<>《》|/\\]+", "", text)
    return text.lower()


def clean_ocr_text(text: str) -> str:
    lines = []
    for raw_line in str(text or "").replace("\r", "\n").split("\n"):
        line = re.sub(r"\s+", " ", raw_line).strip()
        if line:
            lines.append(line)
    return "\n".join(lines).strip()


def has_cjk(text: str) -> bool:
    return bool(re.search(r"[\u3400-\u9fff]", str(text or "")))


def keep_cjk_lines(text: str) -> str:
    lines = []
    for raw_line in str(text or "").replace("\r", "\n").split("\n"):
        line = re.sub(r"\s+", " ", raw_line).strip()
        if line and has_cjk(line):
            line = re.sub(r"(^|\s)[\-—]+(?=[\u3400-\u9fff])", r"\1一", line)
            line = re.sub(r"[^\u3400-\u9fff0-9０-９，。！？、；：“”‘’（）《》【】\s]", "", line)
            line = re.sub(r"\s+", " ", line).strip()
            if line and has_cjk(line):
                lines.append(line)
    return "\n".join(lines).strip()


def one_line(text: str) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()


def similar(left: str, right: str, threshold: float) -> bool:
    a = normalize_for_compare(left)
    b = normalize_for_compare(right)
    if not a or not b:
        return False
    if a == b:
        return True
    shorter, longer = (a, b) if len(a) <= len(b) else (b, a)
    if len(shorter) >= 4 and shorter in longer:
        return True
    return difflib.SequenceMatcher(None, a, b).ratio() >= threshold


@dataclass
class FrameOcr:
    time: float
    text: str
    confidence: float = 0.0
    provider: str = "rapidocr"
    error: str = ""
    visual_end: float = 0.0
    change_score: float = 0.0
    skipped_frames: int = 0
    filtered_out: bool = False


@dataclass
class CueBuilder:
    start: float
    last_seen: float
    visual_end: float = 0.0
    texts: list[str] = field(default_factory=list)
    frames: int = 0

    def add(self, item: FrameOcr) -> None:
        self.last_seen = item.time
        self.visual_end = max(self.visual_end, item.visual_end or item.time)
        self.frames += 1
        if item.text:
            self.texts.append(item.text)

    def text(self) -> str:
        candidates = [text for text in self.texts if text.strip()]
        if not candidates:
            return ""
        normalized_counts = Counter(normalize_for_compare(text) for text in candidates)
        best_norm, _ = normalized_counts.most_common(1)[0]
        matching = [text for text in candidates if normalize_for_compare(text) == best_norm]
        return max(matching, key=lambda value: (len(value), candidates.count(value))).strip()


def crop_frame(frame: Any, crop: dict[str, float]) -> Any:
    height, width = frame.shape[:2]
    x = int(round(clamp(float(crop.get("x", 0.0)), 0.0, 1.0) * width))
    y = int(round(clamp(float(crop.get("y", 0.72)), 0.0, 1.0) * height))
    w = int(round(clamp(float(crop.get("w", 1.0)), 0.01, 1.0) * width))
    h = int(round(clamp(float(crop.get("h", 0.24)), 0.01, 1.0) * height))
    x2 = min(width, max(x + 1, x + w))
    y2 = min(height, max(y + 1, y + h))
    return frame[y:y2, x:x2]


def encode_jpeg(frame: Any, quality: int = 90) -> str:
    ok, buffer = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), int(quality)])
    if not ok:
        raise RuntimeError("Could not encode frame as JPEG.")
    return base64.b64encode(buffer.tobytes()).decode("ascii")


def google_vision_ocr(
    frame: Any,
    api_key: str,
    language_hints: list[str],
    feature_type: str = "TEXT_DETECTION",
    timeout: float = 30.0,
) -> FrameOcr:
    content = encode_jpeg(frame)
    payload = {
        "requests": [
            {
                "image": {"content": content},
                "features": [{"type": feature_type, "maxResults": 10}],
                "imageContext": {"languageHints": language_hints} if language_hints else {},
            }
        ]
    }
    response = requests.post(
        GOOGLE_VISION_ENDPOINT,
        params={"key": api_key},
        json=payload,
        timeout=timeout,
    )
    response.raise_for_status()
    data = response.json()
    result = (data.get("responses") or [{}])[0]
    if result.get("error"):
        message = result["error"].get("message") or json.dumps(result["error"], ensure_ascii=False)
        raise RuntimeError(message)

    text = ""
    if result.get("fullTextAnnotation", {}).get("text"):
        text = result["fullTextAnnotation"]["text"]
    elif result.get("textAnnotations"):
        text = result["textAnnotations"][0].get("description", "")

    confidence_values = []
    for page in result.get("fullTextAnnotation", {}).get("pages", []) or []:
        for block in page.get("blocks", []) or []:
            if isinstance(block.get("confidence"), (int, float)):
                confidence_values.append(float(block["confidence"]))
    confidence = sum(confidence_values) / len(confidence_values) if confidence_values else 0.0
    return FrameOcr(time=0.0, text=clean_ocr_text(text), confidence=confidence)


def google_vision_detect_text_boxes(
    frame: Any,
    api_key: str,
    language_hints: list[str],
    feature_type: str = "TEXT_DETECTION",
    timeout: float = 30.0,
) -> tuple[FrameOcr, list[dict[str, Any]]]:
    content = encode_jpeg(frame)
    payload = {
        "requests": [
            {
                "image": {"content": content},
                "features": [{"type": feature_type, "maxResults": 50}],
                "imageContext": {"languageHints": language_hints} if language_hints else {},
            }
        ]
    }
    response = requests.post(
        GOOGLE_VISION_ENDPOINT,
        params={"key": api_key},
        json=payload,
        timeout=timeout,
    )
    response.raise_for_status()
    data = response.json()
    result = (data.get("responses") or [{}])[0]
    if result.get("error"):
        message = result["error"].get("message") or json.dumps(result["error"], ensure_ascii=False)
        raise RuntimeError(message)

    full_text = ""
    if result.get("fullTextAnnotation", {}).get("text"):
        full_text = result["fullTextAnnotation"]["text"]
    elif result.get("textAnnotations"):
        full_text = result["textAnnotations"][0].get("description", "")

    boxes: list[dict[str, Any]] = []
    annotations = result.get("textAnnotations") or []
    for annotation in annotations[1:]:
        vertices = annotation.get("boundingPoly", {}).get("vertices", []) or []
        xs = [int(vertex.get("x", 0)) for vertex in vertices]
        ys = [int(vertex.get("y", 0)) for vertex in vertices]
        if not xs or not ys:
            continue
        x1, x2 = min(xs), max(xs)
        y1, y2 = min(ys), max(ys)
        text = str(annotation.get("description") or "").strip()
        if not text or x2 <= x1 or y2 <= y1:
            continue
        boxes.append(
            {
                "text": text,
                "x": x1,
                "y": y1,
                "w": x2 - x1,
                "h": y2 - y1,
                "cx": (x1 + x2) / 2,
                "cy": (y1 + y2) / 2,
            }
        )

    return FrameOcr(time=0.0, text=clean_ocr_text(full_text)), boxes


def is_subtitle_like_text(text: str) -> bool:
    text = str(text or "").strip()
    if not text:
        return False
    if re.search(r"[\u4e00-\u9fff]", text):
        return True
    return len(normalize_for_compare(text)) >= 2


def detect_subtitle_crop_from_boxes(
    boxes: list[dict[str, Any]],
    image_width: int,
    image_height: int,
    preferred_min_y: float = 0.45,
) -> dict[str, Any]:
    candidates = [
        box for box in boxes
        if is_subtitle_like_text(str(box.get("text", "")))
        and float(box.get("cy", 0)) >= image_height * preferred_min_y
    ]
    if not candidates:
        candidates = [box for box in boxes if is_subtitle_like_text(str(box.get("text", "")))]
    if not candidates:
        return {"found": False, "crop": {"x": 0, "y": 0.72, "w": 1, "h": 0.24}, "text": ""}

    # Subtitle words usually share a narrow horizontal band. Pick the densest
    # lower text band and expand around it.
    best_group: list[dict[str, Any]] = []
    best_score = -1.0
    band_height = max(28, image_height * 0.08)
    for anchor in candidates:
        ay = float(anchor.get("cy", 0))
        group = [box for box in candidates if abs(float(box.get("cy", 0)) - ay) <= band_height]
        if not group:
            continue
        x1 = min(float(box["x"]) for box in group)
        y1 = min(float(box["y"]) for box in group)
        x2 = max(float(box["x"]) + float(box["w"]) for box in group)
        y2 = max(float(box["y"]) + float(box["h"]) for box in group)
        text_len = sum(len(str(box.get("text", ""))) for box in group)
        lower_bonus = (y1 / max(1, image_height)) * 3
        width_score = (x2 - x1) / max(1, image_width)
        score = text_len + width_score * 10 + lower_bonus
        if score > best_score:
            best_score = score
            best_group = group

    if not best_group:
        best_group = candidates

    x1 = min(float(box["x"]) for box in best_group)
    y1 = min(float(box["y"]) for box in best_group)
    x2 = max(float(box["x"]) + float(box["w"]) for box in best_group)
    y2 = max(float(box["y"]) + float(box["h"]) for box in best_group)
    pad_x = image_width * 0.04
    pad_y = image_height * 0.035
    x1 = clamp((x1 - pad_x) / image_width, 0.0, 0.98)
    y1 = clamp((y1 - pad_y) / image_height, 0.0, 0.98)
    x2 = clamp((x2 + pad_x) / image_width, x1 + 0.02, 1.0)
    y2 = clamp((y2 + pad_y) / image_height, y1 + 0.02, 1.0)
    text = clean_ocr_text(" ".join(str(box.get("text", "")) for box in sorted(best_group, key=lambda item: (item["y"], item["x"]))))
    return {
        "found": True,
        "crop": {
            "x": round(x1, 4),
            "y": round(y1, 4),
            "w": round(x2 - x1, 4),
            "h": round(y2 - y1, 4),
        },
        "text": text,
        "boxCount": len(best_group),
        "boxes": best_group,
    }


def rapidocr_ocr(frame: Any) -> FrameOcr:
    engine = rapidocr_engine()
    result = engine(frame)
    entries = getattr(result, "txts", None)
    scores = getattr(result, "scores", None)
    if entries is None and isinstance(result, tuple) and result:
        entries = [item[1] for item in result[0] or [] if len(item) >= 2]
        scores = [item[2] for item in result[0] or [] if len(item) >= 3]
    text = clean_ocr_text("\n".join(str(item) for item in (entries or []) if str(item).strip()))
    confidence_values = [float(score) for score in (scores or []) if isinstance(score, (int, float))]
    confidence = sum(confidence_values) / len(confidence_values) if confidence_values else 0.0
    return FrameOcr(time=0.0, text=text, confidence=confidence, provider="rapidocr")


def rapidocr_detect_text_boxes(frame: Any) -> tuple[FrameOcr, list[dict[str, Any]]]:
    engine = rapidocr_engine()
    result = engine(frame)
    entries = list(getattr(result, "txts", None) or [])
    scores = list(getattr(result, "scores", None) or [])
    raw_boxes = getattr(result, "boxes", None)

    boxes: list[dict[str, Any]] = []
    if raw_boxes is not None:
        for index, points in enumerate(raw_boxes):
            try:
                xs = [float(point[0]) for point in points]
                ys = [float(point[1]) for point in points]
            except Exception:
                continue
            if not xs or not ys:
                continue
            x1, x2 = min(xs), max(xs)
            y1, y2 = min(ys), max(ys)
            text = str(entries[index] if index < len(entries) else "").strip()
            if not text or x2 <= x1 or y2 <= y1:
                continue
            score = float(scores[index]) if index < len(scores) and isinstance(scores[index], (int, float)) else 0.0
            boxes.append(
                {
                    "text": text,
                    "x": x1,
                    "y": y1,
                    "w": x2 - x1,
                    "h": y2 - y1,
                    "cx": (x1 + x2) / 2,
                    "cy": (y1 + y2) / 2,
                    "confidence": score,
                }
            )

    text = clean_ocr_text("\n".join(str(item) for item in entries if str(item).strip()))
    confidence_values = [float(score) for score in scores if isinstance(score, (int, float))]
    confidence = sum(confidence_values) / len(confidence_values) if confidence_values else 0.0
    return FrameOcr(time=0.0, text=text, confidence=confidence, provider="rapidocr"), boxes


def sample_times(duration: float, fps: float, start: float, end: float) -> list[float]:
    start = max(0.0, start)
    end = duration if end <= 0 else min(duration, end)
    if end <= start:
        return []
    interval = 1.0 / max(0.1, fps)
    count = int(math.floor((end - start) / interval)) + 1
    return [round(start + index * interval, 3) for index in range(count) if start + index * interval <= end + 1e-6]


def read_frame_at(cap: Any, timestamp: float) -> Any:
    cap.set(cv2.CAP_PROP_POS_MSEC, max(0.0, timestamp) * 1000.0)
    ok, frame = cap.read()
    if not ok or frame is None:
        return None
    return frame


def subtitle_change_signature(frame: Any) -> Any:
    """Return a small binary mask focused on subtitle-like bright/yellow text."""
    if frame is None or frame.size == 0:
        return None
    height, width = frame.shape[:2]
    target_width = 360
    scale = target_width / max(1, width)
    target_height = max(24, int(round(height * scale)))
    small = cv2.resize(frame, (target_width, target_height), interpolation=cv2.INTER_AREA)
    hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
    hue, sat, val = cv2.split(hsv)
    white = (val > 170) & (sat < 145)
    bright = val > 215
    yellow = (hue >= 12) & (hue <= 45) & (sat > 55) & (val > 120)
    mask = (white | bright | yellow).astype("uint8") * 255
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 2))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
    mask = cv2.dilate(mask, kernel, iterations=1)
    return mask


def change_score(previous: Any, current: Any) -> float:
    if previous is None and current is None:
        return 0.0
    if previous is None or current is None:
        return 1.0
    if previous.shape != current.shape:
        current = cv2.resize(current, (previous.shape[1], previous.shape[0]), interpolation=cv2.INTER_NEAREST)
    diff = cv2.absdiff(previous, current)
    return float((diff > 0).mean())


def collect_ocr_candidates(
    video_path: Path,
    times: list[float],
    crop: dict[str, float],
    skip_unchanged: bool,
    threshold: float,
    max_keyframe_gap: float,
    frame_interval: float,
    timeline_end: float,
    preview_image: str = "",
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], int, str]:
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError(f"Could not open video: {video_path}")

    candidates: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    previous_signature = None
    last_candidate_time: float | None = None
    last_sample_time = times[-1] if times else 0.0
    preview_saved_path = ""

    for index, timestamp in enumerate(times, start=1):
        frame = read_frame_at(cap, timestamp)
        if frame is None:
            errors.append({"time": timestamp, "error": "frame_read_failed"})
            continue

        cropped = crop_frame(frame, crop)
        if preview_image and not preview_saved_path:
            preview_path = Path(preview_image)
            preview_path.parent.mkdir(parents=True, exist_ok=True)
            cv2.imwrite(str(preview_path), cropped)
            preview_saved_path = str(preview_path)

        signature = subtitle_change_signature(cropped)
        score = 1.0 if previous_signature is None else change_score(previous_signature, signature)
        recheck_due = (
            max_keyframe_gap > 0
            and last_candidate_time is not None
            and timestamp - last_candidate_time >= max_keyframe_gap
        )
        should_ocr = (
            not skip_unchanged
            or previous_signature is None
            or score >= threshold
            or recheck_due
        )

        if should_ocr:
            candidates.append(
                {
                    "index": len(candidates),
                    "time": timestamp,
                    "frame": cropped,
                    "changeScore": round(score, 5),
                    "scanIndex": index,
                    "recheckDue": bool(recheck_due),
                }
            )
            last_candidate_time = timestamp

        previous_signature = signature

    cap.release()

    final_end = min(max(0.0, timeline_end), (last_sample_time + frame_interval) if times else 0.0)
    for index, candidate in enumerate(candidates):
        next_time = candidates[index + 1]["time"] if index + 1 < len(candidates) else final_end
        candidate["visualEnd"] = round(max(candidate["time"] + frame_interval, next_time), 3)
        next_scan_index = candidates[index + 1]["scanIndex"] if index + 1 < len(candidates) else len(times) + 1
        candidate["skippedFrames"] = max(0, int(next_scan_index) - int(candidate["scanIndex"]) - 1)

    return candidates, errors, len(times), preview_saved_path


def ocr_candidate(
    candidate: dict[str, Any],
    provider: str,
    api_key: str,
    language_hints: list[str],
    feature_type: str,
    require_cjk: bool,
) -> FrameOcr:
    if provider == "google_vision":
        item = google_vision_ocr(
            candidate["frame"],
            api_key=api_key,
            language_hints=language_hints,
            feature_type=feature_type,
        )
    else:
        item = rapidocr_ocr(candidate["frame"])
    item.time = float(candidate["time"])
    item.provider = provider
    item.visual_end = float(candidate.get("visualEnd") or item.time)
    item.change_score = float(candidate.get("changeScore") or 0.0)
    item.skipped_frames = int(candidate.get("skippedFrames") or 0)
    if require_cjk:
        original_text = item.text
        item.text = keep_cjk_lines(item.text)
        item.filtered_out = bool(original_text.strip() and not item.text.strip())
    return item


def run_ocr_candidates(
    candidates: list[dict[str, Any]],
    provider: str,
    api_key: str,
    language_hints: list[str],
    feature_type: str,
    concurrency: int,
    progress_every: int,
    require_cjk: bool,
) -> tuple[list[FrameOcr], list[dict[str, Any]]]:
    errors: list[dict[str, Any]] = []
    if not candidates:
        return [], errors

    max_workers = max(1, min(32, int(concurrency) if concurrency else 1))
    if provider != "google_vision":
        max_workers = 1

    if max_workers <= 1:
        items: list[FrameOcr] = []
        for index, candidate in enumerate(candidates, start=1):
            try:
                items.append(ocr_candidate(candidate, provider, api_key, language_hints, feature_type, require_cjk))
            except Exception as exc:
                errors.append({"time": candidate.get("time"), "error": str(exc)})
                items.append(
                    FrameOcr(
                        time=float(candidate.get("time") or 0),
                        text="",
                        provider=provider,
                        error=str(exc),
                        visual_end=float(candidate.get("visualEnd") or candidate.get("time") or 0),
                        change_score=float(candidate.get("changeScore") or 0.0),
                        skipped_frames=int(candidate.get("skippedFrames") or 0),
                    )
                )
            if progress_every > 0 and index % progress_every == 0:
                eprint(f"OCR progress: {index}/{len(candidates)} key frames")
        return items, errors

    results: list[FrameOcr | None] = [None] * len(candidates)
    completed = 0
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        future_map = {
            executor.submit(ocr_candidate, candidate, provider, api_key, language_hints, feature_type, require_cjk): index
            for index, candidate in enumerate(candidates)
        }
        for future in as_completed(future_map):
            index = future_map[future]
            candidate = candidates[index]
            try:
                results[index] = future.result()
            except Exception as exc:
                errors.append({"time": candidate.get("time"), "error": str(exc)})
                results[index] = FrameOcr(
                    time=float(candidate.get("time") or 0),
                    text="",
                    provider=provider,
                    error=str(exc),
                    visual_end=float(candidate.get("visualEnd") or candidate.get("time") or 0),
                    change_score=float(candidate.get("changeScore") or 0.0),
                    skipped_frames=int(candidate.get("skippedFrames") or 0),
                )
            completed += 1
            if progress_every > 0 and completed % progress_every == 0:
                eprint(f"OCR progress: {completed}/{len(candidates)} key frames")

    return [item for item in results if item is not None], errors


def build_cues(
    frame_items: list[FrameOcr],
    similarity: float,
    max_empty_gap: float,
    frame_interval: float,
    min_duration: float,
) -> list[dict[str, Any]]:
    cues: list[dict[str, Any]] = []
    active: CueBuilder | None = None

    def close_active(end_time: float) -> None:
        nonlocal active
        if not active:
            return
        text = active.text()
        start = active.start
        end = max(end_time, active.visual_end, active.last_seen + frame_interval)
        if text and end - start >= min_duration:
            cues.append(
                {
                    "id": f"ocr-{len(cues) + 1}",
                    "index": len(cues),
                    "start": round(start, 3),
                    "end": round(end, 3),
                    "duration": round(max(0.1, end - start), 3),
                    "text": text,
                    "frameCount": active.frames,
                }
            )
        active = None

    for item in frame_items:
        text = item.text.strip()
        if not text:
            if active and item.time - active.last_seen > max_empty_gap:
                close_active(item.time)
            continue

        if not active:
            active = CueBuilder(start=item.time, last_seen=item.time)
            active.add(item)
            continue

        if similar(active.text(), text, similarity):
            active.add(item)
            continue

        close_active(item.time)
        active = CueBuilder(start=item.time, last_seen=item.time)
        active.add(item)

    if active:
        close_active(active.last_seen + frame_interval)

    return cues


def write_srt(cues: list[dict[str, Any]], output_path: Path) -> None:
    blocks = []
    for index, cue in enumerate(cues, start=1):
        text = str(cue.get("text") or "").strip()
        blocks.append(
            "\n".join(
                [
                    str(index),
                    f"{srt_timestamp(float(cue['start']))} --> {srt_timestamp(float(cue['end']))}",
                    text,
                ]
            )
        )
    output_path.write_text("\n\n".join(blocks) + ("\n" if blocks else ""), encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--provider", default="rapidocr", choices=["rapidocr"])
    parser.add_argument("--api-key", default=os.environ.get("GOOGLE_VISION_API_KEY", ""))
    parser.add_argument("--fps", type=float, default=2.0)
    parser.add_argument("--crop-x", type=float, default=0.0)
    parser.add_argument("--crop-y", type=float, default=0.72)
    parser.add_argument("--crop-w", type=float, default=1.0)
    parser.add_argument("--crop-h", type=float, default=0.24)
    parser.add_argument("--language-hints", default="zh,zh-Hans")
    parser.add_argument("--feature-type", default="TEXT_DETECTION")
    parser.add_argument("--similarity", type=float, default=0.86)
    parser.add_argument("--max-empty-gap", type=float, default=0.45)
    parser.add_argument("--min-duration", type=float, default=0.25)
    parser.add_argument("--start", type=float, default=0.0)
    parser.add_argument("--end", type=float, default=0.0)
    parser.add_argument("--preview-image", default="")
    parser.add_argument("--skip-unchanged", action="store_true")
    parser.add_argument("--require-cjk", action="store_true")
    parser.add_argument("--change-threshold", type=float, default=0.025)
    parser.add_argument("--ocr-concurrency", type=int, default=8)
    parser.add_argument("--max-keyframe-gap", type=float, default=1.5)
    parser.add_argument("--progress-every", type=int, default=20)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    video_path = Path(args.video)
    output_path = Path(args.output)
    report_path = Path(args.report)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.parent.mkdir(parents=True, exist_ok=True)

    if args.provider == "google_vision" and not args.api_key:
        raise RuntimeError("Missing Google Vision API key.")

    metadata_cap = cv2.VideoCapture(str(video_path))
    if not metadata_cap.isOpened():
        raise RuntimeError(f"Could not open video: {video_path}")

    native_fps = metadata_cap.get(cv2.CAP_PROP_FPS) or 0.0
    frame_count = metadata_cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0.0
    metadata_cap.release()
    duration = frame_count / native_fps if native_fps > 0 else 0.0
    if duration <= 0:
        raise RuntimeError("Could not determine video duration.")

    fps = max(0.1, float(args.fps))
    frame_interval = 1.0 / fps
    times = sample_times(duration, fps, float(args.start), float(args.end))
    crop = {"x": args.crop_x, "y": args.crop_y, "w": args.crop_w, "h": args.crop_h}
    language_hints = [item.strip() for item in str(args.language_hints or "").split(",") if item.strip()]

    started_at = time.time()

    candidates, scan_errors, frames_scanned, preview_saved_path = collect_ocr_candidates(
        video_path=video_path,
        times=times,
        crop=crop,
        skip_unchanged=bool(args.skip_unchanged),
        threshold=max(0.0, float(args.change_threshold)),
        max_keyframe_gap=max(0.0, float(args.max_keyframe_gap)),
        frame_interval=frame_interval,
        timeline_end=min(duration, float(args.end) if float(args.end) > 0 else duration),
        preview_image=args.preview_image,
    )
    frame_items, ocr_errors = run_ocr_candidates(
        candidates=candidates,
        provider=args.provider,
        api_key=args.api_key,
        language_hints=language_hints,
        feature_type=args.feature_type,
        concurrency=max(1, int(args.ocr_concurrency)),
        progress_every=int(args.progress_every),
        require_cjk=bool(args.require_cjk),
    )
    errors = [*scan_errors, *ocr_errors]

    cues = build_cues(
        frame_items,
        similarity=clamp(float(args.similarity), 0.5, 1.0),
        max_empty_gap=max(0.0, float(args.max_empty_gap)),
        frame_interval=frame_interval,
        min_duration=max(0.0, float(args.min_duration)),
    )
    write_srt(cues, output_path)

    report = {
        "provider": args.provider,
        "video": str(video_path),
        "durationSeconds": duration,
        "fps": fps,
        "nativeFps": native_fps,
        "crop": crop,
        "languageHints": language_hints,
        "featureType": args.feature_type,
        "previewImage": preview_saved_path,
        "skipUnchanged": bool(args.skip_unchanged),
        "requireCjk": bool(args.require_cjk),
        "changeThreshold": max(0.0, float(args.change_threshold)),
        "ocrConcurrency": max(1, int(args.ocr_concurrency)),
        "maxKeyframeGap": max(0.0, float(args.max_keyframe_gap)),
        "framesRequested": len(times),
        "framesScanned": frames_scanned,
        "framesProcessed": len(frame_items),
        "ocrRequests": len(candidates),
        "framesSkipped": max(0, frames_scanned - len(candidates)),
        "skipRatio": round((max(0, frames_scanned - len(candidates)) / frames_scanned) if frames_scanned else 0, 4),
        "framesWithText": sum(1 for item in frame_items if item.text.strip()),
        "framesFilteredOut": sum(1 for item in frame_items if item.filtered_out),
        "segmentCount": len(cues),
        "elapsedSeconds": round(time.time() - started_at, 3),
        "errors": errors[:100],
        "segments": cues,
        "frames": [
            {
                "time": item.time,
                "text": item.text,
                "textOneLine": one_line(item.text),
                "confidence": item.confidence,
                "error": item.error,
                "visualEnd": item.visual_end,
                "changeScore": item.change_score,
                "skippedFrames": item.skipped_frames,
                "filteredOut": item.filtered_out,
            }
            for item in frame_items
        ],
    }
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"success": True, "segments": len(cues), "frames": len(frame_items)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        eprint(f"ERROR: {exc}")
        raise SystemExit(1)
