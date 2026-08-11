import argparse
import asyncio
import json
import random
import re
import sys
from pathlib import Path

import edge_tts
from edge_tts.exceptions import NoAudioReceived

EDGE_SAVE_ATTEMPTS = 3
EDGE_RETRY_BASE_SECONDS = 0.9

DEFAULT_VOICES = {
    "vi-VN": {"MALE": "vi-VN-NamMinhNeural", "FEMALE": "vi-VN-HoaiMyNeural", "NEUTRAL": "vi-VN-HoaiMyNeural"},
    "en-US": {"MALE": "en-US-GuyNeural", "FEMALE": "en-US-AriaNeural", "NEUTRAL": "en-US-AriaNeural"},
    "ja-JP": {"MALE": "ja-JP-KeitaNeural", "FEMALE": "ja-JP-NanamiNeural", "NEUTRAL": "ja-JP-NanamiNeural"},
    "ko-KR": {"MALE": "ko-KR-InJoonNeural", "FEMALE": "ko-KR-SunHiNeural", "NEUTRAL": "ko-KR-SunHiNeural"},
    "zh-CN": {"MALE": "zh-CN-YunxiNeural", "FEMALE": "zh-CN-XiaoxiaoNeural", "NEUTRAL": "zh-CN-XiaoxiaoNeural"},
    "es-ES": {"MALE": "es-ES-AlvaroNeural", "FEMALE": "es-ES-ElviraNeural", "NEUTRAL": "es-ES-ElviraNeural"},
    "fr-FR": {"MALE": "fr-FR-HenriNeural", "FEMALE": "fr-FR-DeniseNeural", "NEUTRAL": "fr-FR-DeniseNeural"},
    "de-DE": {"MALE": "de-DE-ConradNeural", "FEMALE": "de-DE-KatjaNeural", "NEUTRAL": "de-DE-KatjaNeural"},
    "th-TH": {"MALE": "th-TH-NiwatNeural", "FEMALE": "th-TH-PremwadeeNeural", "NEUTRAL": "th-TH-PremwadeeNeural"},
    "id-ID": {"MALE": "id-ID-ArdiNeural", "FEMALE": "id-ID-GadisNeural", "NEUTRAL": "id-ID-GadisNeural"},
}


def parse_args():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    list_parser = sub.add_parser("list")
    list_parser.add_argument("--language-code", default="")

    synth_parser = sub.add_parser("synthesize")
    synth_parser.add_argument("--text", required=True)
    synth_parser.add_argument("--voice", default="")
    synth_parser.add_argument("--language-code", default="vi-VN")
    synth_parser.add_argument("--gender", default="")
    synth_parser.add_argument("--rate", default="+0%")
    synth_parser.add_argument("--output", required=True)

    return parser.parse_args()


async def list_command(language_code: str):
    voices = await edge_tts.list_voices()
    wanted = language_code.lower().strip()
    if wanted:
        voices = [voice for voice in voices if voice.get("Locale", "").lower().startswith(wanted)]

    normalized = [
        {
            "name": voice.get("ShortName") or voice.get("Name"),
            "displayName": voice.get("FriendlyName") or voice.get("ShortName") or voice.get("Name"),
            "locale": voice.get("Locale"),
            "ssmlGender": str(voice.get("Gender", "NEUTRAL")).upper(),
        }
        for voice in voices
        if voice.get("ShortName") or voice.get("Name")
    ]
    print(json.dumps({"voices": normalized}, ensure_ascii=False))


def clean_text_for_edge_tts(value: str) -> str:
    cleaned = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", " ", str(value or ""))
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if not cleaned:
        raise ValueError("Edge TTS text is empty after cleanup.")
    return cleaned


def locale_matches(candidate: str, requested: str) -> bool:
    candidate = str(candidate or "").lower().strip()
    requested = str(requested or "").lower().strip()
    if not requested:
        return True
    return candidate == requested or candidate.startswith(f"{requested}-") or requested.startswith(f"{candidate}-")


def normalize_gender(value: str) -> str:
    text = str(value or "").strip().upper()
    if text in {"MALE", "FEMALE", "NEUTRAL"}:
        return text
    if text == "ALL":
        return ""
    if text.startswith("M"):
        return "MALE"
    if text.startswith("F"):
        return "FEMALE"
    if text.startswith("N"):
        return "NEUTRAL"
    return ""


def voice_gender(item) -> str:
    return normalize_gender(item.get("Gender") or item.get("ssmlGender"))


def voice_locale_from_name(voice: str) -> str:
    match = re.match(r"^([a-z]{2,3}-[A-Z]{2})-", str(voice or "").strip())
    return match.group(1) if match else ""


def infer_voice_gender_from_name(voice: str) -> str:
    lower = str(voice or "").lower()
    if re.search(r"(namminh|andrew|brian|guy|roger|steffan|yunjian|yunxi|yunyang|keita|daichi|naoki|hyunsu|injoon|niwat|ardi|henri|conrad|killian|alvaro)", lower):
        return "MALE"
    if re.search(r"(hoaimy|aria|ava|emma|jenny|michelle|xiaoxiao|xiaoyi|yunxia|nanami|aoi|mayu|shiori|sunhi|premwadee|gadis|denise|eloise|vivienne|amala|katja|seraphina|elvira|ximena)", lower):
        return "FEMALE"
    return ""


def default_voice_for(language_code: str, gender: str = "") -> str:
    defaults = DEFAULT_VOICES.get(language_code) or DEFAULT_VOICES["en-US"]
    normalized_gender = normalize_gender(gender)
    return defaults.get(normalized_gender) or defaults.get("NEUTRAL") or defaults.get("FEMALE") or defaults.get("MALE") or ""


async def resolve_voice(voice: str, language_code: str, gender: str = ""):
    requested_voice = str(voice or "").strip()
    requested_locale = str(language_code or "").strip() or "en-US"
    requested_gender = normalize_gender(gender)
    if requested_gender == "NEUTRAL":
        requested_gender = ""

    if requested_voice:
        inferred_locale = voice_locale_from_name(requested_voice)
        if inferred_locale and not locale_matches(inferred_locale, requested_locale):
            raise ValueError(
                f"Selected Edge TTS voice '{requested_voice}' is locale '{inferred_locale}', "
                f"not requested language '{requested_locale}'."
            )
        inferred_gender = infer_voice_gender_from_name(requested_voice)
        if requested_gender and inferred_gender and inferred_gender != requested_gender:
            raise ValueError(
                f"Selected Edge TTS voice '{requested_voice}' is {inferred_gender}, not requested {requested_gender}."
            )
        if inferred_locale:
            return requested_voice, requested_locale, requested_voice

    voices = await edge_tts.list_voices()
    by_name = {
        str(item.get("ShortName") or item.get("Name") or "").strip(): item
        for item in voices
        if item.get("ShortName") or item.get("Name")
    }

    if requested_voice:
        selected = by_name.get(requested_voice)
        if not selected:
            raise ValueError(f"Selected Edge TTS voice '{requested_voice}' was not found.")
        if not locale_matches(selected.get("Locale", ""), requested_locale):
            raise ValueError(
                f"Selected Edge TTS voice '{requested_voice}' is locale '{selected.get('Locale', '')}', "
                f"not requested language '{requested_locale}'."
            )
        selected_gender = voice_gender(selected)
        if requested_gender and selected_gender and selected_gender != requested_gender:
            raise ValueError(
                f"Selected Edge TTS voice '{requested_voice}' is {selected_gender}, not requested {requested_gender}."
            )
        return requested_voice, requested_locale, requested_voice

    default_voice = default_voice_for(requested_locale, requested_gender)
    if default_voice in by_name:
        return default_voice, requested_locale, requested_voice

    locale_voice = next(
        (
            str(item.get("ShortName") or item.get("Name")).strip()
            for item in voices
            if locale_matches(item.get("Locale", ""), requested_locale)
            and (not requested_gender or voice_gender(item) == requested_gender)
        ),
        "",
    )
    if locale_voice:
        return locale_voice, requested_locale, requested_voice

    raise ValueError(f"No Edge TTS voice is available for language code '{requested_locale}'.")


async def save_with_audio_check(text: str, voice: str, rate: str, output_path: str):
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    last_error = None
    for attempt in range(1, EDGE_SAVE_ATTEMPTS + 1):
        Path(output_path).unlink(missing_ok=True)
        try:
            communicate = edge_tts.Communicate(text=text, voice=voice, rate=rate)
            await communicate.save(output_path)
            if Path(output_path).exists() and Path(output_path).stat().st_size > 0:
                return
            raise NoAudioReceived("Edge TTS produced an empty audio file.")
        except NoAudioReceived as exc:
            last_error = exc
            Path(output_path).unlink(missing_ok=True)
            if attempt < EDGE_SAVE_ATTEMPTS:
                await asyncio.sleep((EDGE_RETRY_BASE_SECONDS * attempt) + random.uniform(0.1, 0.6))
    raise NoAudioReceived(f"Edge TTS produced no audio after {EDGE_SAVE_ATTEMPTS} tries. Last error: {last_error}")


async def synthesize_command(text: str, voice: str, language_code: str, gender: str, rate: str, output_path: str):
    cleaned_text = clean_text_for_edge_tts(text)
    selected_voice, resolved_locale, requested_voice = await resolve_voice(voice, language_code, gender)
    attempted = []

    candidates = [selected_voice]
    if not requested_voice:
        default_for_locale = default_voice_for(resolved_locale, gender)
        if default_for_locale and default_for_locale not in candidates:
            candidates.append(default_for_locale)

    last_error = None
    for candidate in candidates:
        attempted.append(candidate)
        try:
            await save_with_audio_check(cleaned_text, candidate, rate, output_path)
            print(json.dumps({
                "success": True,
                "voice": candidate,
                "requestedVoice": requested_voice,
                "languageCode": resolved_locale,
                "fallbackUsed": candidate != requested_voice if requested_voice else False,
                "attemptedVoices": attempted,
            }, ensure_ascii=False))
            return
        except NoAudioReceived as exc:
            last_error = exc
            Path(output_path).unlink(missing_ok=True)
            continue

    raise NoAudioReceived(
        f"No audio was received from Edge TTS after trying: {', '.join(attempted)}. Last error: {last_error}"
    )


async def main():
    args = parse_args()
    if args.command == "list":
      await list_command(args.language_code)
      return
    if args.command == "synthesize":
      await synthesize_command(args.text, args.voice, args.language_code, args.gender, args.rate, args.output)
      return
    raise RuntimeError(f"Unsupported command: {args.command}")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as exc:
        print(json.dumps({"success": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
