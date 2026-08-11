# MP3 export from the audio editor

## Context

The audio editor currently keeps the original imported media blob unchanged and stores cell-level edit settings separately: trim range, fade-in, fade-out, and volume offset. Playback applies these settings at runtime through Web Audio APIs.

The desired future feature is a separate "Download" action inside the audio editor. It should render a new edited file from the original blob and the current editor draft without replacing or mutating the original media stored in the app.

## Target behavior

- The original imported file remains unchanged in storage.
- The user can adjust trim, fades, and volume in the editor draft.
- Pressing "Download" creates a derived audio file from the current draft.
- The downloaded file contains the audible result of the editor settings.
- MP3 is the preferred output format because most user-imported tracks are expected to be MP3.
- WAV should remain available as a fallback or diagnostic export path.

## Proposed pipeline

1. Read the original blob with `getMediaBlob(media.id)`.
2. Decode it to an `AudioBuffer` with `AudioContext.decodeAudioData`.
3. Clamp the editor range:
   - `startMs = clamp(trimStartMs ?? 0, 0, durationMs)`
   - `endMs = clamp(trimEndMs ?? durationMs, startMs, durationMs)`
4. Render only the selected range into a new buffer with `OfflineAudioContext`.
5. Apply volume offset using the same multiplier rules as preview/playback.
6. Apply fade-in and fade-out using the same envelope logic from `audioEnvelope.ts`.
7. Encode the rendered PCM buffer:
   - preferred: MP3 encoder library;
   - fallback: local WAV encoder.
8. Trigger a browser download with a generated file name, for example `track-edited.mp3`.

## Main implementation options

### Option 1: WAV-only export

This is the lowest-risk implementation. The browser can reliably decode audio and render PCM through Web Audio APIs, and the app can encode WAV directly without external dependencies.

Pros:
- Works offline.
- No server needed.
- No new heavy dependency.
- Predictable browser behavior.

Cons:
- WAV files are much larger than MP3.
- Users who imported MP3 may expect an MP3 download.

### Option 2: Browser-side MP3 export

Use a JS or WASM MP3 encoder after rendering edited PCM.

Pros:
- Best match for the expected user workflow.
- Keeps the feature offline and local.
- Does not require backend infrastructure.

Cons:
- Adds a dependency and increases bundle size.
- Encoding can be slow on low-power mobile devices.
- Large tracks can use significant memory because compressed audio is decoded to PCM before encoding.
- Need careful testing across Chromium, Firefox, Safari, and iOS.

### Option 3: Server-side export

Upload the original blob and edit settings to a backend service that runs ffmpeg and returns an MP3.

Pros:
- Best format control.
- Easier to support MP3 bitrate, metadata, normalization, and future formats.

Cons:
- Conflicts with the app's offline-first direction.
- Requires backend, upload progress, privacy messaging, storage limits, and failure handling.

## Recommended approach

Implement the export pipeline in two layers:

1. Build a format-independent render step that produces an edited `AudioBuffer`.
2. Add encoders behind a small interface:
   - `encodeWav(audioBuffer): Blob`
   - `encodeMp3(audioBuffer, options): Promise<Blob>`

Ship WAV fallback first if needed, then enable MP3 when the encoder dependency is selected and tested. This keeps the core edit rendering reusable and limits MP3-specific risk to one module.

## Risks and mitigations

- **Memory usage:** Decode and render only the trimmed range when possible. Disable export for very long tracks if memory pressure becomes visible.
- **Clipping after volume boost:** Match current playback first, then consider a limiter or normalization option later.
- **Encoder speed:** Show a loading state on the Download button and block duplicate exports while encoding.
- **Browser compatibility:** Keep WAV fallback and runtime feature checks.
- **Sound mismatch between preview and export:** Reuse `audioEnvelope.ts` and the same volume multiplier logic instead of reimplementing curves differently.
- **File naming:** Preserve the base name and append `-edited`, changing the extension to `.mp3` or `.wav`.

## Implementation plan

1. Create `src/features/audio-editor/model/renderEditedAudio.ts`.
2. Move shared range clamping and edited-duration calculation into a small reusable helper.
3. Implement `renderEditedAudioBuffer(mediaId, draft, durationMs)`.
4. Reuse envelope logic from `src/features/playback/model/audioEnvelope.ts`.
5. Add `src/features/audio-editor/model/encodeWav.ts` as a fallback encoder.
6. Select and add an MP3 encoder dependency after bundle-size and browser testing.
7. Add `src/features/audio-editor/model/downloadEditedAudio.ts`.
8. Add a Download button next to Reset and OK in `AudioEditorDialog`.
9. Add loading/error UI for export progress.
10. Cover with focused tests:
    - trimmed duration is exported;
    - fade-in/fade-out changes samples near boundaries;
    - volume offset changes sample amplitude;
    - original media blob is not modified;
    - download file name and extension are correct.
