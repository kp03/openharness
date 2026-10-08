# Custom notification sound for the Harness device

Status: implemented locally on `notification-custom`; no code has been pushed or device flashed.

## Goal and current behavior

A person chooses an audio file in the Harness desktop app, previews the result, and installs it on one connected Harness device. The device plays that clip for its notification and retains it after unplugging, rebooting, and a normal firmware update. They can restore the built-in chime. The existing mute setting remains independent.

Today, the device synthesizes three square-wave beeps in `audio_capture.c`. The app's device controls only change `muted`; `settings.set` carries small JSON patches. The USB protocol caps each frame at 8,192 payload bytes and reserves its firmware binary frame for OTA. There is no audio asset upload, custom sound metadata, or persistent audio partition.

## Proposed user flow

1. In the selected device's settings, keep the **Notification sound** switch. Add **Choose sound**, **Preview**, **Install on device**, and **Restore built-in chime** controls. Show the selected file, processed duration, and the sound currently reported by that device.
2. The file picker accepts common audio formats supported by the desktop decoder. Decode locally to signed 16-bit, mono, 16 kHz PCM; trim to a maximum of three seconds, limit peaks to the existing chime's level, encode to 8-bit µ-law, and preview the *processed* clip. A file that cannot be decoded gets a clear error. A selected file is not installed until the person chooses **Install on device**.
3. Show a busy indicator during transfer and verification for the selected physical device. Keep its reported sound unchanged in the UI until the device verifies the upload and confirms the new metadata. Disallow installation while unplugged or while firmware update or microphone capture is active. A failed or interrupted upload leaves the previous sound usable.
4. **Restore built-in chime** selects the generated beep and clears the custom clip after the device confirms the change. Mute continues to suppress either sound.

The app already has two device settings surfaces: `desktop/lib/settings/sections/cabled_device_card.dart` and `desktop/lib/devices/device_settings.dart`. Keep their behavior and wording consistent. The Devices view may represent a remote host; transfer must be addressed to the host that owns the USB device, then to that device's ID, without sending the file to other devices.

## Storage and playback

- Reserve the unused `0xFE0000`–`0xFFFFFF` region of the current 16 MiB flash layout as a 128 KiB data partition. The existing NVS offset and both OTA slots stay at their current addresses. Confirm ESP-IDF partition alignment and image-size checks before adopting this layout.
- A board with the old partition table needs one full `idf.py flash` before the sound controls become available. Later app-only OTA updates preserve the partition.
- Three seconds of 16 kHz mono 16-bit PCM is 96,000 bytes, so uncompressed PCM cannot fit twice in this partition. 8-bit µ-law is 48,000 bytes for the same clip, leaving room for two independently valid 64 KiB slots, headers, and metadata. The firmware decodes in 320-sample blocks; it never copies the whole clip into RAM.
- Write the inactive slot first and commit its valid header only after full length and SHA-256 verification. On boot, choose the newest valid slot; if neither verifies, play the built-in chime. An interrupted replacement preserves the previous slot. The previous slot remains intact until a later replacement or restore erases it.
- Playback must yield promptly to microphone capture and mute, and keep the current notification rate limit. Test the audio codec lock under playback, recording, disconnection, and upload.
- Normal OTA should preserve this data partition. Explicit erase-flash or a partition migration may remove it; report this in the UI/docs if applicable.

## Transfer and compatibility

1. Add a versioned sound-upload capability to the device greeting. Older firmware must simply leave the new controls unavailable. Do not infer support from a version string alone.
2. The desktop sends a bounded, authenticated, device-addressed request to the owning host. Encoded audio travels as base64 in this single encrypted request, then in 4096-byte USB slices. It does not enter `settings.set` or status events.
3. The USB link uses a dedicated sound frame kind plus JSON offer, progress, done, error, restore, and cancel messages. It does not reuse `CableType.Fw`. The offer carries length and SHA-256; one slice is outstanding at a time, progress acknowledges the cumulative byte offset, and the host times out after 30 seconds. The firmware rejects sound offers during OTA or microphone capture.
4. The device reports the active name and byte count in `settings.state`, with an empty name for the built-in chime. Keep old app/firmware combinations functional; update strict settings parsers on the CLI and desktop when adding reported fields. Never report an unverified transfer as active.
5. Keep source audio on the desktop only if the user asks to retain it. Device status should contain metadata, not raw audio. The host should discard transient transfer bytes after a completed or failed upload.

## Work sequence

1. Check the actual available flash, partition-table fit, target image size, and an atomic storage design that holds the old clip while a replacement is written. The code reserves the unused 128 KiB and uses two 64 KiB slots; an ESP-IDF build and physical board check are still required.
2. Build a standalone audio preparation path for macOS and Linux, including decoder availability/licensing, trimming, volume bounds, and deterministic PCM output. Add file picking and processed preview to both device settings surfaces.
3. Add the authenticated, addressed desktop-to-host request and the host-to-device framed transfer with progress, cancellation, timeout, capability gating, and device metadata reports.
4. Add firmware storage, checksum verification, restore behavior, and streamed decoding/playback through the existing speaker path. Preserve mute, microphone priority, and notification throttling.
5. Integrate the UI state machine so reconnects and errors show device-confirmed state. Document the supported file types, duration limit, and persistence behavior.

## Validation plan

- Firmware host tests: partition bounds, interrupted write and reboot, invalid header/hash/length, replace and restore, transfer ordering/duplicate chunks/timeout, OTA conflict, and playback interruption. Run `make device-test` and an ESP-IDF build when the toolchain is available.
- CLI tests: capability negotiation, one-device addressing, chunk backpressure, disconnect/retry, refusal and confirmed status, plus protocol frame vectors. Run typecheck, affected cable/device tests, and relevant integration checks; use the full CLI suite because this changes shared device transport and requests.
- Desktop: Dart analysis, affected widget/controller tests, native file-picker and audio-preview checks on macOS and Linux, including unsupported files and unplugged or older devices. Run the full Desktop VM suite because both device surfaces and state parsing change.
- Hardware: install and play on a supported board; test mute, simultaneous microphone use, USB disconnect during upload, reboot, OTA update, and a second connected device. Measure speaker level and flash write/read behavior. Record hardware results separately from host tests.

The implementation is local. Validation results and any unavailable checks must be reported with the finished work. No code was pushed, merged, published, or flashed.
