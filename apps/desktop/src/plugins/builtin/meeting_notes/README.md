# Meeting notes

Kuku built-in plugin, depending on `core-editor`. Ported from Ulpaso commit
`bb502e4`; the Qwen3-ASR / Sortformer pins, artifact digests, Python lock,
PCM framing, resampling and rolling transcription are preserved. Final speaker
text alignment uses bounded global edit alignment to fix repeated utterances
being attached to a later occurrence; model decoding and canonical text remain
unchanged. The Ulpaso application shell and editor are not included.

## Try it

1. Use an Apple Silicon Mac running macOS 15 or later. Open a writable `.md`
   document in a vault, then click the title-bar microphone, use `⌘⇧M`, or
   select `/meeting`.
2. Choose microphone + system, microphone only, or system only in meeting settings. First use
   discloses the download estimate (about 1.76 GB), available space and local
   processing; “Download and start” grants consent. Grant the requested macOS audio permissions.
   Once models are ready, the microphone starts recording directly with the saved audio source.
3. Speak, switch to another tab, and edit surrounding notes. The original
   document owns the transcription. Finish with the microphone button.
4. Try closing the recording tab or changing vaults: confirmation, final
   transcription and successful saving must precede navigation.

The plugin and meeting detection default to enabled. Detection only offers an
in-app confirmation; it never starts recording. Activation does not download
models. Toggle the plugin in Kuku's existing plugin settings and restart to apply.
Unsupported hosts keep all other Kuku functions, without detection or a worker.

Audio/inference stay local. Saved Markdown follows the vault's existing sync
configuration. No screen video is retained. Speaker labels are anonymous (up to
four), not voice identification. Recordings are limited to six hours.

## Storage and failure cleanup

All models, runtime, tools, caches and temporary recording data live under the current
variant's `plugins/meeting-notes/` directory (`~/.kuku`, `~/.kuku.dev`, or
`~/.kuku.preview`). Existing Ulpaso installation data is neither reused nor
migrated. Deleting plugin data requires a separate explicit confirmation and
does not delete Markdown documents.

While a recording is active, a native journal orders editor snapshots and audio
against Kuku's checksum guard. It is an implementation detail, not a recovery
feature. Successful final save removes it after disk acknowledgement. Capture
failure, cancellation and plugin disposal restore the document block and delete
the journal, PCM and WAV. Startup also deletes stale files left by a force quit;
the cleanup does not parse the journal first, so a truncated JSON file cannot
block removal. There are no recovery menus, lists, badges or startup notices. A
changed document is never overwritten. A crashed worker still gets one in-session
replay before the session is considered failed.

The shipped notices and original MIT attribution are in
`src-tauri/resources/meeting_notes/`. Dependencies/models are installed on demand,
not shipped in the app. Debug overrides are `KUKU_MEETING_ASR_MOCK`,
`KUKU_MEETING_AUDIO_MOCK`, and `KUKU_MEETING_ASR_PYTHON`; never enable mocks when
checking real capture quality.

## Automated checks

From the repository root:

```sh
python3 -m venv /tmp/kuku-meeting-tests
/tmp/kuku-meeting-tests/bin/pip install -r scripts/meeting_notes/requirements-test.txt
PATH="/tmp/kuku-meeting-tests/bin:$PATH" pnpm exec moon run desktop:test
pnpm exec moon run desktop:check
pnpm --filter @kuku/desktop exec tsc -p tsconfig.app.json --noEmit
pnpm --filter @kuku/desktop build
```

Only NumPy and tqdm are needed for model-free worker tests; MLX/models and
microphone permission are not needed. `desktop:test` includes the worker unit
tests, framed protocol subprocess, native format/target-selection test, Rust and
frontend suites. The native test compiles with the old deployment target and
weak ScreenCaptureKit linkage; non-macOS hosts skip that test.

The development-only browser fixture is `/tests/meeting_notes/` on the Vite dev
server. It runs the real plugin UI/service against synthetic IPC, not a microphone.
It is excluded from the production Vite entry and native bundle.

## Validation record (2026-09-02)

- Frontend: 520 tests, including 29 service lifecycle and 10 document-bridge scenarios;
  all pass. Capture failure and cancellation remove temporary data and restore the
  exact document block while preserving surrounding edits. A final save conflict
  also discards the session without touching the existing disk document; a document
  that was saved successfully remains saved if only temporary-data acknowledgement fails.
  Automatic transcript changes are excluded from the typing indicator, including
  appended normalization transactions; surrounding user input still counts.
  Tests cover boundary insertions, protected formatting, duplicate snapshots,
  rejected-final retry, hundreds of multilingual updates, stale events after ACK,
  resource-check failure, cancellation racing a final save, cancellation during
  native startup, a final transcript arriving before startup returns, and late
  native errors racing an accepted final transcript's disk write, and retrying
  a transient native stop failure. First-use disclosure remains mandatory when
  model files already exist but the consent setting does not. Failed document
  preparation also clears a detected app/window target before a later manual start.
  External delete and rename events discard the live session without writing to
  or recreating the old path.
  A successful recording with no recognized speech restores the original block
  instead of leaving an empty meeting heading.
  Slow-save regression tests verify that a returning tab renders immediately,
  can accept new edits, and receives the eventual committed checksum. A
  document-ready callback also writes into the newly attached view. Disk reloads
  are deferred while a document is retained, including when retention starts
  during the asynchronous read, so a watcher cannot erase the transcript range.
- TypeScript check and frontend production build pass. Full lint has no errors;
  the remaining warnings are in pre-existing voxel graph files.
- Model-free Python worker/artifact tests: 91 pass; subprocess PCM protocol: 1 pass.
  Repeated exchanges retain their original turn order and times, Unicode and
  punctuation are preserved, and pathological alignment sizes use the lossless
  fallback instead of unbounded quadratic work.
- Rust desktop library: 376 tests pass, including 42 meeting engine tests.
- Native capture format/target-selection assertions pass with deployment target
  10.15, `-Werror` and weak ScreenCaptureKit linkage.
- Browser: first-use consent, original-document ownership after tab switching,
  guarded close, save conflict, and duplicate-free retry checked with synthetic IPC.
- Local `KukuDev.app` bundle builds. Resource contents, permission localizations,
  minimum OS metadata and `LC_LOAD_WEAK_DYLIB` for ScreenCaptureKit are checked by
  `python3 scripts/meeting_notes/verify_bundle.py target/debug/bundle/macos/KukuDev.app`.
  The verifier now rejects invalid, ad-hoc and identifier-mismatched signatures;
  `scripts/meeting_notes/sign_dev_app.sh` signs a local development bundle with an
  installed Apple Development identity so TCC recognizes it across rebuilds.
- Actual app: plugin enabled, dedicated test vault connected, and runtime/models
  installed. An invalid linker-only development signature was isolated as the
  reason an enabled Screen Recording toggle still returned TCC denial. After full
  Apple Development signing and re-registering the permission entry, system-audio
  capture succeeded. A 27.39 s WAV produced live text, finalized locally, saved to
  the original Markdown document and cleaned its temporary files. The typing
  indicator remained absent while machine text was inserted. No microphone input
  device was connected, so microphone-only and combined capture remain unverified.
- Offline real-model PCM replay: a 27.39 s Korean synthetic recording and a 52.49 s
  alternating two-voice recording completed, with segments reproducing final text.
  Before the alignment fix, the same audio and installed pinned models produced
  identical final text, speaker labels and times with Ulpaso's worker. After the
  fix, the 52.49 s replay still preserves that exact final text, but restores
  the earlier turns: the first segment starts at 0 s instead of 26.32 s, and
  both repeated exchanges retain their own times. A 6 s silence recording
  produced empty text. These runs verify inference/protocol behavior, not
  microphone capture or recognition accuracy. Synthetic speech still exhibits
  ASR errors and fragmented diarization labels; global alignment cannot repair
  incorrect acoustic speaker predictions.
- A 367.44 s replay exercises the actual five-minute rolling-finalization branch:
  122 live updates and 27 final segments cover 0–367.44 s, and their joined text
  exactly matches the final transcript. The same replay with Ulpaso's worker
  produces identical final text, speaker labels and times. This is a six-minute
  inference test, not a six-hour recording or capture endurance test.

Real-model replay can be repeated without network access or macOS capture permission:

```sh
"$KUKU_PYTHON" scripts/meeting_notes/replay_worker.py \
  --python "$KUKU_PYTHON" \
  --worker apps/desktop/src-tauri/resources/meeting_notes/asr/asr_worker.py \
  --models "$KUKU_MODELS" --audio /path/to/mono-16khz-pcm16.wav \
  --output /tmp/meeting-replay.json
```

The runner enforces a deadline, drains stdout/stderr, terminates its worker process
group on failure, and records final output plus events for comparison.

Before release, physically verify all three audio modes, permission denial and
revocation, real model/runtime downloads, multi-speaker quality, meeting detection,
multiple monitors, six-hour behavior, and force-quitting/relaunching the signed app.
Compare identical audio/model revisions against Ulpaso for omissions, duplication
and speaker handling. Also test Intel/older macOS launch and the plugin-disabled
app. Mock/format tests do not establish real capture or speech-recognition quality.
