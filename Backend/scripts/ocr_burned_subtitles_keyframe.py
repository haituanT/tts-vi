#!/usr/bin/env python3
"""OCR burned-in subtitles with local timeline scan + Google keyframes.

This experimental mode separates two jobs:
- local OpenCV scans the crop at a high FPS to infer cue timing;
- RapidOCR local reads only representative keyframes for text.

The script intentionally does not NLP-split text. Cue boundaries come from
visual subtitle changes in the cropped region.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from ocr_burned_subtitles import (
    FrameOcr,
    clean_ocr_text,
    clamp,
    crop_frame,
    google_vision_detect_text_boxes,
    google_vision_ocr,
    keep_cjk_lines,
    normalize_for_compare,
    one_line,
    rapidocr_detect_text_boxes,
    rapidocr_ocr,
    similar,
    srt_timestamp,
)


def eprint(*args: Any) -> None:
    print(*args, file=os.sys.stderr, flush=True)


@dataclass
class KeySample:
    time: float
    frame: Any
    clarity: float
    role: str


@dataclass
class LocalGroup:
    start: float
    end: float
    frame_count: int = 0
    max_change: float = 0.0
    end_is_boundary: bool = False
    first: KeySample | None = None
    best: KeySample | None = None
    last: KeySample | None = None
    checkpoints: list[KeySample] = field(default_factory=list)
    changes: list[float] = field(default_factory=list)

    def add(self, timestamp: float, frame: Any, clarity: float, change: float, sample_every_seconds: float = 0.0) -> None:
        self.end = timestamp
        self.frame_count += 1
        self.max_change = max(self.max_change, change)
        sample = KeySample(time=timestamp, frame=frame.copy(), clarity=clarity, role="sample")
        if self.first is None:
            self.first = KeySample(time=timestamp, frame=frame.copy(), clarity=clarity, role="first")
            self.checkpoints.append(KeySample(time=timestamp, frame=frame.copy(), clarity=clarity, role="scan"))
        self.last = KeySample(time=timestamp, frame=frame.copy(), clarity=clarity, role="last")
        if self.best is None or clarity >= self.best.clarity:
            self.best = KeySample(time=timestamp, frame=frame.copy(), clarity=clarity, role="best")
        if sample_every_seconds > 0:
            last_checkpoint_time = self.checkpoints[-1].time if self.checkpoints else -1e9
            if timestamp - last_checkpoint_time >= sample_every_seconds:
                self.checkpoints.append(KeySample(time=timestamp, frame=frame.copy(), clarity=clarity, role="scan"))

    def duration(self, interval: float) -> float:
        return max(0.0, self.visual_end(interval) - self.start)

    def visual_end(self, interval: float) -> float:
        return self.end if self.end_is_boundary else self.end + interval

    def samples(
        self,
        interval: float,
        verify_long_seconds: float,
        suspicious_change: float,
        dense_sample_seconds: float = 0.0,
    ) -> list[KeySample]:
        chosen: list[KeySample] = []
        if self.best is not None:
            chosen.append(KeySample(self.best.time, self.best.frame, self.best.clarity, "middle"))
        should_verify = dense_sample_seconds > 0 or self.duration(interval) >= verify_long_seconds or self.max_change >= suspicious_change
        if should_verify:
            for item, role in ((self.first, "start"), (self.last, "end")):
                if item is not None:
                    chosen.append(KeySample(item.time, item.frame, item.clarity, role))
        if dense_sample_seconds > 0:
            for item in self.checkpoints:
                chosen.append(KeySample(item.time, item.frame, item.clarity, "scan"))
        deduped: list[KeySample] = []
        seen: set[float] = set()
        for item in sorted(chosen, key=lambda value: value.time):
            key = round(item.time, 3)
            if key in seen:
                continue
            seen.add(key)
            deduped.append(item)
        return deduped


def make_text_mask(frame: Any, target_width: int = 480) -> tuple[Any, float, float]:
    if frame is None or frame.size == 0:
        empty = np.zeros((24, target_width), dtype=np.uint8)
        return empty, 0.0, 0.0

    height, width = frame.shape[:2]
    scale = target_width / max(1, width)
    target_height = max(24, int(round(height * scale)))
    small = cv2.resize(frame, (target_width, target_height), interpolation=cv2.INTER_AREA)

    hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
    hue, sat, val = cv2.split(hsv)
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    gray = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 4)).apply(gray)

    white = (val > 168) & (sat < 155)
    bright = val > 222
    yellow = (hue >= 12) & (hue <= 45) & (sat > 45) & (val > 115)
    dark_text = (gray < 70) & (sat < 180)

    edges = cv2.Canny(gray, 70, 170)
    edge_mask = edges > 0
    mask = (white | bright | yellow | (dark_text & edge_mask)).astype("uint8") * 255

    kernel_open = cv2.getStructuringElement(cv2.MORPH_RECT, (2, 2))
    kernel_close = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 2))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel_open)

    component_count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    filtered = np.zeros_like(mask)
    frame_area = max(1, mask.shape[0] * mask.shape[1])
    max_component_area = max(180, int(frame_area * 0.028))
    max_component_width = max(24, int(mask.shape[1] * 0.16))
    max_component_height = max(10, int(mask.shape[0] * 0.82))
    for component_index in range(1, component_count):
        x, y, comp_width, comp_height, area = stats[component_index]
        if area < 4:
            continue
        if area > max_component_area:
            continue
        if comp_width > max_component_width or comp_height > max_component_height:
            continue
        if comp_height >= mask.shape[0] * 0.72 and (y <= 1 or y + comp_height >= mask.shape[0] - 1):
            continue
        if comp_width < 2 or comp_height < 2:
            continue
        filtered[labels == component_index] = 255

    mask = cv2.morphologyEx(filtered, cv2.MORPH_CLOSE, kernel_close)
    mask = cv2.dilate(mask, kernel_close, iterations=1)

    density = float((mask > 0).mean())
    edge_density = float((edges > 0).mean())
    clarity = density + edge_density * 0.35
    return mask, density, clarity


def mask_distance(previous: Any, current: Any) -> float:
    if previous is None and current is None:
        return 0.0
    if previous is None or current is None:
        return 1.0
    if previous.shape != current.shape:
        current = cv2.resize(current, (previous.shape[1], previous.shape[0]), interpolation=cv2.INTER_NEAREST)
    left = previous > 0
    right = current > 0
    union = np.logical_or(left, right).sum()
    if union <= 0:
        return 0.0
    xor = np.logical_xor(left, right).sum()
    return float(xor / union)


def scan_local_groups(
    video_path: Path,
    crop: dict[str, float],
    timeline_fps: float,
    change_threshold: float,
    min_text_density: float,
    empty_confirm_frames: int,
    min_group_duration: float,
    sample_every_seconds: float,
    progress_every: int,
) -> tuple[list[LocalGroup], dict[str, Any]]:
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError(f"Could not open video: {video_path}")

    native_fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    if native_fps <= 0:
        raise RuntimeError("Could not determine video FPS.")
    duration = frame_count / native_fps if frame_count > 0 else 0.0
    if duration <= 0:
        raise RuntimeError("Could not determine video duration.")

    target_fps = max(0.1, min(float(timeline_fps), native_fps))
    step = max(1, int(round(native_fps / target_fps)))
    interval = step / native_fps

    groups: list[LocalGroup] = []
    active: LocalGroup | None = None
    previous_mask = None
    previous_nonempty_mask = None
    empty_run = 0
    local_frames_scanned = 0
    local_empty_frames = 0
    local_change_frames = 0

    def close_active(end_time: float | None = None) -> None:
        nonlocal active
        if active is None:
            return
        if end_time is not None:
            active.end = max(active.start, end_time)
            active.end_is_boundary = True
        if active.duration(interval) >= min_group_duration and active.frame_count > 0:
            groups.append(active)
        active = None

    frame_index = -1
    while True:
        ok, frame = cap.read()
        if not ok or frame is None:
            break
        frame_index += 1
        if frame_index % step != 0:
            continue

        timestamp = frame_index / native_fps
        cropped = crop_frame(frame, crop)
        mask, density, clarity = make_text_mask(cropped)
        local_frames_scanned += 1

        has_text_shape = density >= min_text_density
        if not has_text_shape:
            local_empty_frames += 1
            empty_run += 1
            if active is not None and empty_run >= empty_confirm_frames:
                close_active(max(active.start, timestamp - interval * max(1, empty_confirm_frames - 1)))
            previous_mask = mask
            if progress_every > 0 and local_frames_scanned % progress_every == 0:
                eprint(f"Local scan: {local_frames_scanned} frames, {len(groups)} groups")
            continue

        empty_run = 0
        distance = mask_distance(previous_nonempty_mask, mask) if previous_nonempty_mask is not None else 1.0
        previous_nonempty_mask = mask
        previous_mask = mask

        if active is None:
            active = LocalGroup(start=timestamp, end=timestamp)
            active.add(timestamp, cropped, clarity, 0.0, sample_every_seconds)
        elif distance >= change_threshold and active.duration(interval) >= min_group_duration:
            local_change_frames += 1
            active.changes.append(timestamp)
            close_active(timestamp)
            active = LocalGroup(start=timestamp, end=timestamp)
            active.add(timestamp, cropped, clarity, 0.0, sample_every_seconds)
        else:
            active.add(timestamp, cropped, clarity, distance, sample_every_seconds)

        if progress_every > 0 and local_frames_scanned % progress_every == 0:
            eprint(f"Local scan: {local_frames_scanned} frames, {len(groups)} groups")

    cap.release()
    close_active(duration)

    return groups, {
        "nativeFps": native_fps,
        "durationSeconds": duration,
        "frameCount": frame_count,
        "timelineFps": target_fps,
        "scanStep": step,
        "frameInterval": interval,
        "localFramesScanned": local_frames_scanned,
        "localEmptyFrames": local_empty_frames,
        "localChangeFrames": local_change_frames,
    }


def merge_fragmented_groups(
    groups: list[LocalGroup],
    interval: float,
    max_fragment_duration: float,
    max_gap: float,
    checkpoint_seconds: float,
) -> list[LocalGroup]:
    if not groups:
        return groups

    merged: list[LocalGroup] = []
    index = 0

    def append_merged_run(run: list[LocalGroup]) -> None:
        if len(run) <= 1:
            merged.extend(run)
            return

        combined = LocalGroup(
            start=run[0].start,
            end=run[-1].end,
            frame_count=sum(item.frame_count for item in run),
            max_change=max((item.max_change for item in run), default=0.0),
            end_is_boundary=run[-1].end_is_boundary,
        )
        combined.first = run[0].first
        combined.last = run[-1].last
        candidates = [item.best for item in run if item.best is not None]
        combined.best = max(candidates, key=lambda item: item.clarity) if candidates else combined.first
        combined.changes = [change for item in run for change in item.changes]

        checkpoint_candidates: list[KeySample] = []
        for item in run:
            checkpoint_candidates.extend(item.checkpoints)
            for sample in (item.first, item.best, item.last):
                if sample is not None:
                    checkpoint_candidates.append(sample)

        seen: set[float] = set()
        last_time = -1e9
        for sample in sorted(checkpoint_candidates, key=lambda value: value.time):
            key = round(sample.time, 3)
            if key in seen:
                continue
            if checkpoint_seconds > 0 and combined.checkpoints and sample.time - last_time < checkpoint_seconds:
                continue
            seen.add(key)
            combined.checkpoints.append(KeySample(sample.time, sample.frame, sample.clarity, "scan"))
            last_time = sample.time

        merged.append(combined)

    while index < len(groups):
        current = groups[index]
        if current.duration(interval) > max_fragment_duration:
            merged.append(current)
            index += 1
            continue

        run = [current]
        index += 1
        while index < len(groups):
            previous = run[-1]
            candidate = groups[index]
            gap = candidate.start - previous.visual_end(interval)
            if gap > max_gap or candidate.duration(interval) > max_fragment_duration:
                break
            run.append(candidate)
            index += 1

        append_merged_run(run)

    return merged


def box_color_metrics(frame: Any, box: dict[str, Any]) -> dict[str, float]:
    height, width = frame.shape[:2]
    x1 = int(clamp(float(box.get("x", 0)), 0, max(0, width - 1)))
    y1 = int(clamp(float(box.get("y", 0)), 0, max(0, height - 1)))
    x2 = int(clamp(float(box.get("x", 0)) + float(box.get("w", 0)), x1 + 1, width))
    y2 = int(clamp(float(box.get("y", 0)) + float(box.get("h", 0)), y1 + 1, height))
    roi = frame[y1:y2, x1:x2]
    if roi.size == 0:
        return {"whiteRatio": 0.0, "colorRatio": 0.0, "darkRatio": 0.0, "value": 0.0}
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    _, sat, val = cv2.split(hsv)
    white = (val > 150) & (sat < 120)
    colored = (val > 95) & (sat > 80)
    dark = val < 80
    return {
        "whiteRatio": float(white.mean()),
        "colorRatio": float(colored.mean()),
        "darkRatio": float(dark.mean()),
        "value": float(val.mean() / 255.0),
    }


def select_subtitle_text_from_boxes(
    frame: Any,
    boxes: list[dict[str, Any]],
    require_cjk: bool,
) -> dict[str, Any]:
    height, width = frame.shape[:2]
    candidates: list[dict[str, Any]] = []
    for box in boxes:
        text = clean_ocr_text(str(box.get("text") or ""))
        if require_cjk:
            text = keep_cjk_lines(text)
        if not text:
            continue
        box_width = float(box.get("w") or 0)
        box_height = float(box.get("h") or 0)
        if box_width <= 2 or box_height <= 2:
            continue
        if box_height > height * 0.86 or box_width > width * 0.96:
            continue
        metrics = box_color_metrics(frame, box)
        enriched = {
            **box,
            "text": text,
            "confidence": float(box.get("confidence") or 0.0),
            **metrics,
        }
        candidates.append(enriched)

    if not candidates:
        return {"text": "", "confidence": 0.0, "boxes": [], "rawBoxCount": len(boxes)}

    bands: list[list[dict[str, Any]]] = []
    for anchor in candidates:
        ay = float(anchor.get("cy") or 0)
        tolerance = max(8.0, min(height * 0.16, float(anchor.get("h") or 0) * 0.50))
        band = [box for box in candidates if abs(float(box.get("cy") or 0) - ay) <= tolerance]
        key = tuple(sorted((round(float(box.get("x") or 0), 1), round(float(box.get("y") or 0), 1), str(box.get("text") or "")) for box in band))
        if any(key == tuple(sorted((round(float(item.get("x") or 0), 1), round(float(item.get("y") or 0), 1), str(item.get("text") or "")) for item in existing)) for existing in bands):
            continue
        bands.append(band)

    def band_score(band: list[dict[str, Any]]) -> float:
        if not band:
            return -1e9
        x1 = min(float(box.get("x") or 0) for box in band)
        x2 = max(float(box.get("x") or 0) + float(box.get("w") or 0) for box in band)
        cy = sum(float(box.get("cy") or 0) for box in band) / len(band)
        text = "".join(str(box.get("text") or "") for box in band)
        text_len = len(one_line(text))
        avg_conf = sum(float(box.get("confidence") or 0) for box in band) / len(band)
        white_ratio = sum(float(box.get("whiteRatio") or 0) for box in band) / len(band)
        color_ratio = sum(float(box.get("colorRatio") or 0) for box in band) / len(band)
        center = (x1 + x2) / 2
        center_score = 1.0 - min(1.0, abs(center - width / 2) / max(1.0, width / 2))
        lower_score = cy / max(1.0, height)
        width_ratio = (x2 - x1) / max(1.0, width)
        length_penalty = max(0, text_len - 24) * 0.25
        width_penalty = max(0.0, width_ratio - 0.78) * 8.0
        return (
            min(text_len, 24) * 0.55
            + avg_conf * 8.0
            + white_ratio * 5.0
            + center_score * 4.0
            + lower_score * 2.2
            - color_ratio * 10.0
            - length_penalty
            - width_penalty
        )

    selected = max(bands, key=band_score)
    selected = sorted(selected, key=lambda item: (float(item.get("y") or 0), float(item.get("x") or 0)))
    text = clean_ocr_text(" ".join(str(box.get("text") or "") for box in selected))
    confidence_values = [float(box.get("confidence") or 0) for box in selected if float(box.get("confidence") or 0) > 0]
    confidence = sum(confidence_values) / len(confidence_values) if confidence_values else 0.0
    return {
        "text": text,
        "confidence": confidence,
        "boxes": selected,
        "rawBoxCount": len(boxes),
        "candidateBoxCount": len(candidates),
    }


def select_group_samples(
    group: LocalGroup,
    interval: float,
    verify_long_seconds: float,
    suspicious_change: float,
    dense_sample_seconds: float,
) -> list[KeySample]:
    duration = group.duration(interval)
    chosen: list[KeySample] = []
    if group.best is not None:
        chosen.append(KeySample(group.best.time, group.best.frame, group.best.clarity, "middle"))

    change_gate = min(max(0.22, suspicious_change), 0.34)
    needs_edges = duration >= verify_long_seconds or (duration >= 0.75 and group.max_change >= change_gate)
    if needs_edges:
        for sample, role in ((group.first, "start"), (group.last, "end")):
            if sample is not None:
                chosen.append(KeySample(sample.time, sample.frame, sample.clarity, role))

    if duration >= 1.6 and group.max_change >= change_gate:
        min_gap = max(0.8, dense_sample_seconds if dense_sample_seconds > 0 else 1.0)
        last_added = -1e9
        for sample in sorted(group.checkpoints, key=lambda item: item.time):
            if sample.time - last_added < min_gap:
                continue
            chosen.append(KeySample(sample.time, sample.frame, sample.clarity, "scan"))
            last_added = sample.time
            if sum(1 for item in chosen if item.role == "scan") >= 4:
                break

    deduped: list[KeySample] = []
    seen: set[float] = set()
    for item in sorted(chosen, key=lambda value: value.time):
        key = round(item.time, 3)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)
    return deduped


def ocr_sample(
    group_index: int,
    sample: KeySample,
    provider: str,
    api_key: str,
    language_hints: list[str],
    feature_type: str,
    require_cjk: bool,
) -> dict[str, Any]:
    if provider == "google_vision":
        result, boxes = google_vision_detect_text_boxes(
            sample.frame,
            api_key=api_key,
            language_hints=language_hints,
            feature_type=feature_type,
        )
    else:
        result, boxes = rapidocr_detect_text_boxes(sample.frame)
    selection = select_subtitle_text_from_boxes(sample.frame, boxes, require_cjk=require_cjk)
    raw_text = clean_ocr_text(result.text)
    text = clean_ocr_text(str(selection.get("text") or raw_text))
    filtered_out = False
    if require_cjk:
        original = text
        text = keep_cjk_lines(text)
        filtered_out = bool(original.strip() and not text.strip())
    return {
        "groupIndex": group_index,
        "time": sample.time,
        "role": sample.role,
        "text": text,
        "textOneLine": one_line(text),
        "rawText": raw_text,
        "rawTextOneLine": one_line(raw_text),
        "confidence": float(selection.get("confidence") or result.confidence or 0.0),
        "rawConfidence": result.confidence,
        "rawBoxCount": int(selection.get("rawBoxCount") or len(boxes)),
        "candidateBoxCount": int(selection.get("candidateBoxCount") or 0),
        "selectedBoxes": selection.get("boxes") or [],
        "filteredOut": filtered_out,
        "error": "",
    }


def run_google_samples(
    samples: list[tuple[int, KeySample]],
    provider: str,
    api_key: str,
    language_hints: list[str],
    feature_type: str,
    require_cjk: bool,
    concurrency: int,
    progress_every: int,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if not samples:
        return [], []

    max_workers = max(1, min(32, int(concurrency) if concurrency else 1))
    if provider == "rapidocr":
        max_workers = max(1, min(4, max_workers))
    results: list[dict[str, Any] | None] = [None] * len(samples)
    errors: list[dict[str, Any]] = []
    completed = 0

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        future_map = {
            executor.submit(
                ocr_sample,
                group_index,
                sample,
                provider,
                api_key,
                language_hints,
                feature_type,
                require_cjk,
            ): index
            for index, (group_index, sample) in enumerate(samples)
        }
        for future in as_completed(future_map):
            index = future_map[future]
            group_index, sample = samples[index]
            try:
                results[index] = future.result()
            except Exception as exc:
                errors.append({"groupIndex": group_index, "time": sample.time, "error": str(exc)})
                results[index] = {
                    "groupIndex": group_index,
                    "time": sample.time,
                    "role": sample.role,
                    "text": "",
                    "textOneLine": "",
                    "confidence": 0.0,
                    "filteredOut": False,
                    "error": str(exc),
                }
            completed += 1
            if progress_every > 0 and completed % progress_every == 0:
                eprint(f"{provider} OCR: {completed}/{len(samples)} keyframes")

    return [item for item in results if item is not None], errors


def fallback_samples_for_empty_groups(
    groups: list[LocalGroup],
    ocr_results: list[dict[str, Any]],
) -> list[tuple[int, KeySample]]:
    by_group: dict[int, list[dict[str, Any]]] = {}
    for item in ocr_results:
        by_group.setdefault(int(item.get("groupIndex", -1)), []).append(item)

    fallback: list[tuple[int, KeySample]] = []
    seen: set[tuple[int, float]] = set()
    for group_index, group in enumerate(groups):
        items = by_group.get(group_index, [])
        if any(str(item.get("text") or "").strip() for item in items):
            continue
        for sample, role in ((group.first, "fallback_start"), (group.last, "fallback_end")):
            if sample is None:
                continue
            key = (group_index, round(sample.time, 3))
            if key in seen or any(round(float(item.get("time") or 0), 3) == key[1] for item in items):
                continue
            seen.add(key)
            fallback.append((group_index, KeySample(sample.time, sample.frame, sample.clarity, role)))
    return fallback


def choose_text(items: list[dict[str, Any]], similarity: float) -> str:
    texts = [str(item.get("text") or "").strip() for item in items if str(item.get("text") or "").strip()]
    if not texts:
        return ""
    clusters: list[list[dict[str, Any]]] = []
    for item in items:
        text = str(item.get("text") or "").strip()
        if not text:
            continue
        for cluster in clusters:
            if similar(str(cluster[0].get("text") or ""), text, similarity):
                cluster.append(item)
                break
        else:
            clusters.append([item])
    best = max(
        clusters,
        key=lambda cluster: (
            len(cluster),
            sum(float(item.get("confidence") or 0) for item in cluster) / max(1, len(cluster)),
            -abs(max(len(str(item.get("text") or "")) for item in cluster) - 14),
        ),
    )
    return max(
        best,
        key=lambda item: (
            float(item.get("confidence") or 0),
            len(str(item.get("text") or "")),
        ),
    ).get("text", "").strip()


def text_overlap_ratio(left: str, right: str) -> float:
    a = normalize_for_compare(left)
    b = normalize_for_compare(right)
    if not a or not b:
        return 0.0
    if a in b or b in a:
        return 1.0
    common = 0
    remaining = list(b)
    for char in a:
        if char in remaining:
            common += 1
            remaining.remove(char)
    return common / max(1, min(len(a), len(b)))


def related_subtitle_text(left: str, right: str, similarity: float) -> bool:
    if similar(left, right, similarity):
        return True
    a = normalize_for_compare(left)
    b = normalize_for_compare(right)
    if not a or not b:
        return False
    shorter, longer = (a, b) if len(a) <= len(b) else (b, a)
    if len(shorter) >= 2 and shorter in longer:
        return True
    return text_overlap_ratio(a, b) >= 0.78


def smooth_unique_runs(runs: list[dict[str, Any]], similarity: float) -> list[dict[str, Any]]:
    if len(runs) <= 1:
        return runs
    smoothed: list[dict[str, Any]] = []
    for index, run in enumerate(runs):
        items = run.get("items") or []
        text = str(run.get("text") or "").strip()
        avg_conf = sum(float(item.get("confidence") or 0) for item in items) / max(1, len(items))
        previous_text = str(smoothed[-1].get("text") or "") if smoothed else ""
        next_text = str(runs[index + 1].get("text") or "") if index + 1 < len(runs) else ""
        is_weak_single = len(items) <= 1 and avg_conf < 0.94
        is_short_fragment = len(normalize_for_compare(text)) <= 3
        overlaps_neighbor = (
            (previous_text and text_overlap_ratio(text, previous_text) >= 0.72)
            or (next_text and text_overlap_ratio(text, next_text) >= 0.72)
        )
        if smoothed and (is_weak_single or is_short_fragment) and overlaps_neighbor:
            smoothed[-1]["items"].extend(items)
            smoothed[-1]["text"] = choose_text(smoothed[-1]["items"], similarity)
            continue
        smoothed.append(run)
    return smoothed


def build_cues_from_groups(
    groups: list[LocalGroup],
    ocr_results: list[dict[str, Any]],
    frame_interval: float,
    duration: float,
    similarity: float,
    max_empty_gap: float,
    min_duration: float,
) -> list[dict[str, Any]]:
    by_group: dict[int, list[dict[str, Any]]] = {}
    for item in ocr_results:
        by_group.setdefault(int(item.get("groupIndex", -1)), []).append(item)

    raw_cues: list[dict[str, Any]] = []
    split_groups = 0
    for index, group in enumerate(groups):
        items = sorted(by_group.get(index, []), key=lambda item: float(item.get("time") or 0))
        texts = [item for item in items if str(item.get("text") or "").strip()]
        if not texts:
            continue

        unique_runs: list[dict[str, Any]] = []
        for item in texts:
            text = str(item.get("text") or "").strip()
            if unique_runs and similar(str(unique_runs[-1]["text"]), text, similarity):
                unique_runs[-1]["items"].append(item)
                unique_runs[-1]["text"] = choose_text(unique_runs[-1]["items"], similarity)
            else:
                unique_runs.append({"text": text, "items": [item]})
        unique_runs = smooth_unique_runs(unique_runs, similarity)

        if len(unique_runs) > 1:
            split_groups += 1

        boundaries = [group.start]
        if len(unique_runs) > 1:
            run_times = [float(run["items"][0].get("time") or group.start) for run in unique_runs]
            for left, right in zip(run_times, run_times[1:]):
                boundaries.append(round((left + right) / 2, 3))
        boundaries.append(min(duration, group.visual_end(frame_interval)))

        for run_index, run in enumerate(unique_runs):
            start = max(0.0, boundaries[run_index])
            end = min(duration, boundaries[run_index + 1])
            text = choose_text(run["items"], similarity) or str(run["text"]).strip()
            if text and end - start >= min_duration:
                raw_cues.append(
                    {
                        "start": round(start, 3),
                        "end": round(max(start + min_duration, end), 3),
                        "text": text,
                        "groupIndex": index,
                        "sampleCount": len(run["items"]),
                    }
                )

    merged: list[dict[str, Any]] = []
    for cue in sorted(raw_cues, key=lambda item: (item["start"], item["end"])):
        if (
            merged
            and cue["start"] - merged[-1]["end"] <= max_empty_gap
            and related_subtitle_text(str(merged[-1]["text"]), str(cue["text"]), similarity)
        ):
            merged[-1]["end"] = round(max(merged[-1]["end"], cue["end"]), 3)
            merged[-1]["sampleCount"] = int(merged[-1].get("sampleCount", 1)) + int(cue.get("sampleCount", 1))
            continue
        merged.append(dict(cue))

    final: list[dict[str, Any]] = []
    last_end = 0.0
    for cue in merged:
        start = max(last_end, float(cue["start"]))
        end = min(duration, max(start + min_duration, float(cue["end"])))
        if end - start < min_duration:
            continue
        if final:
            gap = start - float(final[-1]["end"])
            if 0 < gap <= max_empty_gap:
                final[-1]["end"] = round(start, 3)
                final[-1]["duration"] = round(float(final[-1]["end"]) - float(final[-1]["start"]), 3)
                last_end = float(final[-1]["end"])
        final.append(
            {
                "id": f"ocr-keyframe-{len(final) + 1}",
                "index": len(final),
                "start": round(start, 3),
                "end": round(end, 3),
                "duration": round(end - start, 3),
                "text": str(cue["text"]).strip(),
                "sampleCount": int(cue.get("sampleCount", 1)),
                "groupIndex": cue.get("groupIndex"),
            }
        )
        last_end = end

    for item in final:
        item["splitGroups"] = split_groups
    return final


def write_srt(cues: list[dict[str, Any]], output_path: Path) -> None:
    blocks = []
    for index, cue in enumerate(cues, start=1):
        blocks.append(
            "\n".join(
                [
                    str(index),
                    f"{srt_timestamp(float(cue['start']))} --> {srt_timestamp(float(cue['end']))}",
                    str(cue.get("text") or "").strip(),
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
    parser.add_argument("--timeline-fps", type=float, default=30.0)
    parser.add_argument("--crop-x", type=float, default=0.0)
    parser.add_argument("--crop-y", type=float, default=0.72)
    parser.add_argument("--crop-w", type=float, default=1.0)
    parser.add_argument("--crop-h", type=float, default=0.24)
    parser.add_argument("--language-hints", default="zh,zh-Hans")
    parser.add_argument("--feature-type", default="TEXT_DETECTION")
    parser.add_argument("--require-cjk", action="store_true")
    parser.add_argument("--change-threshold", type=float, default=0.12)
    parser.add_argument("--suspicious-change", type=float, default=1.0)
    parser.add_argument("--min-text-density", type=float, default=0.002)
    parser.add_argument("--empty-confirm-frames", type=int, default=2)
    parser.add_argument("--verify-long-seconds", type=float, default=999.0)
    parser.add_argument("--sample-every-seconds", type=float, default=0.0)
    parser.add_argument("--boundary-refine-window", type=float, default=0.16)
    parser.add_argument("--similarity", type=float, default=0.86)
    parser.add_argument("--max-empty-gap", type=float, default=0.35)
    parser.add_argument("--min-duration", type=float, default=0.12)
    parser.add_argument("--ocr-concurrency", type=int, default=8)
    parser.add_argument("--progress-every", type=int, default=500)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.provider == "google_vision" and not args.api_key:
        raise RuntimeError("Missing Google Vision API key.")

    video_path = Path(args.video)
    output_path = Path(args.output)
    report_path = Path(args.report)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.parent.mkdir(parents=True, exist_ok=True)

    crop = {"x": args.crop_x, "y": args.crop_y, "w": args.crop_w, "h": args.crop_h}
    language_hints = [item.strip() for item in str(args.language_hints or "").split(",") if item.strip()]
    started_at = time.time()

    scan_started_at = time.time()
    groups, scan_report = scan_local_groups(
        video_path=video_path,
        crop=crop,
        timeline_fps=max(0.1, float(args.timeline_fps)),
        change_threshold=max(0.01, float(args.change_threshold)),
        min_text_density=max(0.0, float(args.min_text_density)),
        empty_confirm_frames=max(1, int(args.empty_confirm_frames)),
        min_group_duration=max(0.0, float(args.min_duration)),
        sample_every_seconds=max(0.0, float(args.sample_every_seconds)),
        progress_every=max(0, int(args.progress_every)),
    )
    scan_seconds = round(time.time() - scan_started_at, 3)

    grouping_started_at = time.time()
    interval = float(scan_report["frameInterval"])
    groups_before_fragment_merge = len(groups)
    groups = merge_fragmented_groups(
        groups=groups,
        interval=interval,
        max_fragment_duration=max(interval * 2.0, float(args.min_duration) * 1.5),
        max_gap=interval * 1.5,
        checkpoint_seconds=max(0.8, float(args.sample_every_seconds) if float(args.sample_every_seconds) > 0 else 0.0),
    )
    sample_pairs: list[tuple[int, KeySample]] = []
    for group_index, group in enumerate(groups):
        for sample in select_group_samples(
            group,
            interval=interval,
            verify_long_seconds=max(0.1, float(args.verify_long_seconds)),
            suspicious_change=max(0.01, float(args.suspicious_change)),
            dense_sample_seconds=max(0.0, float(args.sample_every_seconds)),
        ):
            sample_pairs.append((group_index, sample))
    grouping_seconds = round(time.time() - grouping_started_at, 3)

    ocr_started_at = time.time()
    ocr_results, ocr_errors = run_google_samples(
        samples=sample_pairs,
        provider=args.provider,
        api_key=args.api_key,
        language_hints=language_hints,
        feature_type=args.feature_type,
        require_cjk=bool(args.require_cjk),
        concurrency=max(1, int(args.ocr_concurrency)),
        progress_every=20,
    )
    primary_ocr_seconds = round(time.time() - ocr_started_at, 3)
    fallback_pairs: list[tuple[int, KeySample]] = []
    fallback_ocr_seconds = 0.0
    if args.provider == "rapidocr":
        fallback_pairs = fallback_samples_for_empty_groups(groups, ocr_results)
        if fallback_pairs:
            fallback_started_at = time.time()
            fallback_results, fallback_errors = run_google_samples(
                samples=fallback_pairs,
                provider=args.provider,
                api_key=args.api_key,
                language_hints=language_hints,
                feature_type=args.feature_type,
                require_cjk=bool(args.require_cjk),
                concurrency=max(1, int(args.ocr_concurrency)),
                progress_every=20,
            )
            fallback_ocr_seconds = round(time.time() - fallback_started_at, 3)
            ocr_results.extend(fallback_results)
            ocr_errors.extend(fallback_errors)

    merge_started_at = time.time()
    cues = build_cues_from_groups(
        groups=groups,
        ocr_results=ocr_results,
        frame_interval=interval,
        duration=float(scan_report["durationSeconds"]),
        similarity=clamp(float(args.similarity), 0.5, 1.0),
        max_empty_gap=max(0.0, float(args.max_empty_gap)),
        min_duration=max(0.0, float(args.min_duration)),
    )
    merge_seconds = round(time.time() - merge_started_at, 3)
    write_srt(cues, output_path)

    elapsed = round(time.time() - started_at, 3)
    provider_label = "google_vision_keyframe" if args.provider == "google_vision" else "rapidocr_keyframe"
    report = {
        "provider": provider_label,
        "ocrProvider": args.provider,
        "video": str(video_path),
        "durationSeconds": scan_report["durationSeconds"],
        "nativeFps": scan_report["nativeFps"],
        "timelineFps": scan_report["timelineFps"],
        "crop": crop,
        "languageHints": language_hints,
        "featureType": args.feature_type,
        "requireCjk": bool(args.require_cjk),
        "changeThreshold": max(0.01, float(args.change_threshold)),
        "suspiciousChange": max(0.01, float(args.suspicious_change)),
        "minTextDensity": max(0.0, float(args.min_text_density)),
        "verifyLongSeconds": max(0.1, float(args.verify_long_seconds)),
        "sampleEverySeconds": max(0.0, float(args.sample_every_seconds)),
        "ocrConcurrency": max(1, int(args.ocr_concurrency)),
        "ocrWorkers": max(1, min(4 if args.provider == "rapidocr" else 32, int(args.ocr_concurrency))),
        "localFramesScanned": scan_report["localFramesScanned"],
        "localEmptyFrames": scan_report["localEmptyFrames"],
        "localChangeFrames": scan_report["localChangeFrames"],
        "groupsDetected": len(groups),
        "groupsBeforeFragmentMerge": groups_before_fragment_merge,
        "googleRequests": len(sample_pairs) if args.provider == "google_vision" else 0,
        "rapidOcrRequests": (len(sample_pairs) + len(fallback_pairs)) if args.provider == "rapidocr" else 0,
        "ocrRequests": len(sample_pairs) + len(fallback_pairs),
        "fallbackOcrRequests": len(fallback_pairs),
        "framesWithText": sum(1 for item in ocr_results if str(item.get("text") or "").strip()),
        "framesFilteredOut": sum(1 for item in ocr_results if item.get("filteredOut")),
        "segmentCount": len(cues),
        "elapsedSeconds": elapsed,
        "scanSeconds": scan_seconds,
        "groupingSeconds": grouping_seconds,
        "primaryOcrSeconds": primary_ocr_seconds,
        "fallbackOcrSeconds": fallback_ocr_seconds,
        "ocrSeconds": round(primary_ocr_seconds + fallback_ocr_seconds, 3),
        "mergeSeconds": merge_seconds,
        "errors": ocr_errors[:100],
        "segments": cues,
        "groups": [
            {
                "index": index,
                "start": round(group.start, 3),
                "end": round(min(float(scan_report["durationSeconds"]), group.visual_end(interval)), 3),
                "duration": round(group.duration(interval), 3),
                "endIsBoundary": group.end_is_boundary,
                "frameCount": group.frame_count,
                "maxChange": round(group.max_change, 5),
                "sampleTimes": [
                    round(sample.time, 3)
                    for sample in select_group_samples(
                        group,
                        interval,
                        float(args.verify_long_seconds),
                        float(args.suspicious_change),
                        float(args.sample_every_seconds),
                    )
                ],
            }
            for index, group in enumerate(groups)
        ],
        "keyframes": ocr_results,
    }
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "success": True,
        "segments": len(cues),
        "provider": provider_label,
        "ocrRequests": len(sample_pairs) + len(fallback_pairs),
        "elapsedSeconds": elapsed,
        "scanSeconds": scan_seconds,
        "ocrSeconds": round(primary_ocr_seconds + fallback_ocr_seconds, 3),
        "ocrWorkers": max(1, min(4 if args.provider == "rapidocr" else 32, int(args.ocr_concurrency))),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        eprint(f"ERROR: {exc}")
        raise SystemExit(1)
