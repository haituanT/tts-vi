# DubFlow Pipeline

This document defines the stable workflow vocabulary used by the backend and UI.
It is intentionally behavior-focused so refactors can keep the same user-facing
results while moving logic into smaller modules.

## Canonical Flow

```text
sourceAsset
-> rawTranscript
-> sourceSegments
-> sourceCues
-> meaningAtoms
-> storySegments
-> displayRows
-> ttsUnits
-> ttsClips
-> syncedVoiceTrack
-> finalMux
```

## Artifact Meaning

- `sourceAsset`: the selected local or YouTube video plus extracted audio.
- `rawTranscript`: raw STT/OCR provider output before app-level cleanup.
- `sourceSegments`: clean source subtitles/transcript rows after normalization.
- `sourceCues`: stable `Cxxxx` source IDs with source timing and optional word timestamps.
- `meaningAtoms`: hidden bilingual meaning ledger linking facts to ordered source cue IDs.
- `storySegments`: complete Vietnamese narration sentences linked to ordered atom/source IDs.
- `displayRows`: story sentences meant for editing, review, SRT/VTT, and burn-in.
- `ttsUnits`: verified story sentences used directly for TTS; invalid or edited mappings are blocked.
- `ttsClips`: audio files generated per TTS unit.
- `syncedVoiceTrack`: one WAV aligned to the video timeline.
- `finalMux`: final video/audio/subtitle export artifacts.

## QC Reports

Each stage should produce a machine-readable report when possible:

```text
source_qc_report.json
translation_qc_report.json
tts_qc_report.json
sync_report.json
```

Report statuses use:

- `ok`: no blocking or notable warning.
- `warn`: export can continue, but the user should review highlighted rows.
- `error`: the stage output is structurally invalid and should not be trusted.

Minimum checks:

- no invalid or overlapping timeline rows;
- no empty text rows in required subtitle/TTS stages;
- no cues that are too short, too long, or too dense for their duration;
- no obvious loss of critical numbers during translation;
- every meaning atom translated exactly once or explicitly omitted as repetition, filler, or branding;
- story text exactly equals its ordered segment text and source mappings never cross or reorder;
- no story segment longer than 10 seconds and no internal boundary shift over 350 ms;
- no TTS clip overflow beyond its target slot;
- no sync drift/overflow beyond configured tolerance.

## Refactor Rule

Auto and manual workflows should both call the shared timeline pipeline:

```text
buildSourceTimeline
buildStoryWindows
buildMeaningAtoms
buildStorySegments
validateStoryResult
buildTtsUnitsFromVerifiedStory
validateTimelineArtifacts
```

The legacy one-to-one translation pipeline remains available only through the explicit
`translationMode: "legacy"` setting. `story_v2` validation failures never fall back to
length-based text redistribution; they remain `needs_review` and cannot enter TTS.
