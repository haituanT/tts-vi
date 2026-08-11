import argparse
import re
import sys

from wtpsplit_lite import SaT

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def parse_srt(srt_text: str):
    blocks = re.split(r"\n\n+", srt_text.strip())
    entries = []
    for block in blocks:
        lines = block.strip().splitlines()
        if len(lines) < 3:
            continue
        timing = lines[1].split(" --> ")
        if len(timing) != 2:
            continue
        entries.append(
            {
                "start": timing[0].strip(),
                "end": timing[1].strip(),
                "text": " ".join(line.strip() for line in lines[2:] if line.strip()),
            }
        )
    return entries


def srt_time_to_sec(t: str) -> float:
    hours, minutes, seconds = t.split(":")
    whole, millis = seconds.split(",")
    return int(hours) * 3600 + int(minutes) * 60 + int(whole) + int(millis) / 1000.0


def sec_to_srt_time(s: float) -> str:
    millis_total = max(0, int(round(s * 1000)))
    hours = millis_total // 3600000
    minutes = (millis_total % 3600000) // 60000
    seconds = (millis_total % 60000) // 1000
    millis = millis_total % 1000
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{millis:03d}"


def resegment(srt_text: str, lang_code: str) -> str:
    sat = SaT("sat-3l-sm")
    entries = parse_srt(srt_text)
    if not entries:
        return srt_text.strip() + "\n"

    full_text = ""
    char_time = []
    for entry in entries:
        text = entry["text"].strip()
        if not text:
            continue
        start = srt_time_to_sec(entry["start"])
        end = srt_time_to_sec(entry["end"])
        duration = max(0.001, end - start)
        text_len = max(1, len(text))
        for i in range(text_len):
            char_time.append(start + duration * (i / text_len))
        full_text += text + " "
        char_time.append(end)

    sentences = sat.split(full_text.strip(), lang_code=lang_code)
    result = []
    idx = 0

    for sentence in sentences:
        sentence = sentence.strip()
        if not sentence:
            continue
        start_idx = min(idx, len(char_time) - 1)
        start_time = char_time[start_idx]
        idx += len(sentence)
        end_idx = min(idx, len(char_time) - 1)
        end_time = char_time[end_idx]
        if end_time - start_time < 0.8:
            end_time = start_time + 0.8
        if end_time - start_time > 6.0:
            end_time = start_time + 6.0
        result.append(
            {
                "start": start_time,
                "end": end_time,
                "text": sentence,
            }
        )
        idx += 1

    out = []
    for i, item in enumerate(result, 1):
        out.append(str(i))
        out.append(f"{sec_to_srt_time(item['start'])} --> {sec_to_srt_time(item['end'])}")
        out.append(item["text"])
        out.append("")
    return "\n".join(out).strip() + "\n"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--lang", default="vi")
    parser.add_argument("--input", default="")
    args = parser.parse_args()
    if args.input:
        with open(args.input, "r", encoding="utf-8") as handle:
            source = handle.read()
    else:
        source = sys.stdin.read()
    sys.stdout.write(resegment(source, args.lang))


if __name__ == "__main__":
    main()
