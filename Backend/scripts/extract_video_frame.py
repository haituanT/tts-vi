#!/usr/bin/env python3
"""Extract one video frame as an image and write a small JSON report."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import cv2


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True)
    parser.add_argument("--time", type=float, default=0.0)
    parser.add_argument("--output", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--jpeg-quality", type=int, default=92)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    video_path = Path(args.video)
    output_path = Path(args.output)
    report_path = Path(args.report)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.parent.mkdir(parents=True, exist_ok=True)

    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError(f"Could not open video: {video_path}")

    timestamp = max(0.0, float(args.time))
    cap.set(cv2.CAP_PROP_POS_MSEC, timestamp * 1000.0)
    ok, frame = cap.read()
    if not ok or frame is None:
        cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
        ok, frame = cap.read()
    cap.release()
    if not ok or frame is None:
        raise RuntimeError("Could not read frame from video.")

    height, width = frame.shape[:2]
    ok = cv2.imwrite(str(output_path), frame, [int(cv2.IMWRITE_JPEG_QUALITY), int(args.jpeg_quality)])
    if not ok:
        raise RuntimeError(f"Could not write frame image: {output_path}")

    report: dict[str, Any] = {
        "video": str(video_path),
        "time": timestamp,
        "output": str(output_path),
        "width": width,
        "height": height,
    }
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"success": True, **report}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
