# OpenHarness device firmware

A round USB companion for your agents. See their progress, read and answer questions, and speak a
task from the device on your desk. This is the open-source ESP32-S3 firmware; you can build it,
flash a supported board, or contribute a hardware port.

**The connection is USB.** The host computer runs the Harness daemon and sends the agent state over
the cable. The current firmware has no Wi-Fi setup, backend connection, account credentials, or
pairing code. Plugging the device into the host establishes the connection.

The schematic, PCB and enclosure designs are in [`../hardware/`](../hardware/).

## Supported hardware

The Harness device is an ESP32-S3 with a 466 × 466 CO5300 AMOLED display, touch, microphones, and
audio output. The firmware detects two touch/board
variants on the I²C bus:

| Variant | Touch | Power management | Display / touch reset pins |
|---|---|---|---|
| Original board | CST9217 | AXP2101 | GPIO 39 / 40 |
| Compatible DXQ0175Y003 module | CST816S | No AXP2101 on the tested board | GPIO 1 / 2 |

The detected hardware, rather than a separate firmware build, selects the drivers and pins.
See [`main/board/`](main/board/) for the detection table and [`main/board/board_pins.h`](main/board/board_pins.h)
for the shared pin definitions. Other ESP32 boards need a port; matching the MCU alone is not enough.

## Build and flash your board

Install and activate ESP-IDF 5.5 or newer. From the repository root:

```bash
cd devices/harness-device/firmware
idf.py set-target esp32s3
idf.py build
idf.py -p PORT flash monitor
```

Replace `PORT` with your board's serial port, for example `/dev/cu.usbmodem1101` on macOS.
Only one process can own the serial port: stop the daemon's device connection before using
`idf.py flash monitor`, and exit the monitor before reconnecting through the app. The normal app
flasher coordinates the serial-port handoff for you.

`sdkconfig.defaults` contains the build defaults. `sdkconfig` and the `build/` directory are
local generated files. After flashing, connect the board to a computer running the Harness daemon.
Firmware updates also travel through the host over USB; older descriptions of Wi-Fi provisioning
and device-initiated OTA downloads do not apply to this firmware.

## Customize your device: notification sound and character

You can install your own completion sound and your own character from the computer the
device is plugged into. Both are stored in the device's `assets` flash partition, survive
unplugging, rebooting and normal firmware updates, and can be restored to the defaults.

**First, flash this firmware once over USB** with `idf.py flash`. It writes the new
partition table: each app slot shrinks from 8 MB to 7 MB (about twice today's image) and
the space after them becomes the 1.9 MB `assets` partition. An app-only OTA update cannot
change the table, so a board on the older layout reports neither feature and the app
offers neither. NVS stays where it was, so pairing and settings are kept. `erase-flash`
erases what you installed.

**From the desktop app:** open the device's settings. Under **Notification sound**, choose
any audio file, preview it and install it. Under **Character**, choose a sprite sheet for
**Thinking**, **Running a tool** and **Finished** (any of them can be left out), pick the
row of each sheet that should play, check the animated preview, and install it.

**From the command line** (the daemon running from a checkout with this feature):

```bash
harness hardware sound ~/Sounds/finish.mp3
harness hardware character --thinking Run.png --tool Run_Attack.png --idle Idle.png --row 1
harness hardware sound --restore
harness hardware character --restore
```

`--machine` and `--device` choose another computer or device; without them the command
uses this computer's only plugged-in device. `--frame WxH`, `--ms N` and per-animation
forms such as `--idle-row 2` or `--tool-ms 80` adjust how a sheet is read.

What each one becomes on the device:

- **Sound:** converted to 16 kHz mono, silence trimmed from both ends, at most 16 seconds,
  scaled to the built-in chime's loudness, and stored as 8-bit mu-law. It replaces the
  completion chime; the short start cue stays. The device's mute setting silences either,
  and microphone capture interrupts it. macOS converts with `afconvert`; Linux needs `ffmpeg`.
- **Character:** sheets of square frames, either one strip or four rows (one per direction,
  as in CraftPix and most RPG packs; four rows is recognised when each row boundary is
  empty). Every animation needs the same frame size and at most 32 frames. All frames share
  one crop, so the character stays in place when it changes animation; it is drawn at the
  largest whole scale up to 256 px tall, with at most 255 colours (more are reduced). On the
  Focus face it plays **Thinking** while the agent's status line says it is thinking,
  reasoning or planning (or before anything runs), **Running a tool** while a tool runs,
  and **Finished** in place of the engine pet when a task is done or resting. Questions and
  voice screens keep their normal artwork; a missing working animation borrows the other.

Each kind has two slots. An upload is written to the slot that is not active and becomes
active only after its length and SHA-256 are verified (and, for a character, after the
firmware has checked it can draw it), so an interrupted or refused install keeps the
previous one.

## Contribute a hardware port

Start with the board detection and pin definitions. Include the board model, the observed I²C
addresses, and the display, touch, audio, and power-management behavior you tested. A photo or a
short recording helps someone with the same board reproduce the result.

The host-side checks do not require a physical board. From the repository root:

```bash
make device-test
```

Then test the actual device: boot, display, touch, USB reconnection, questions, audio, and firmware
update recovery. Report the hardware checks separately from the host tests.

The firmware is covered by the repository's [MIT license](../../LICENSE). Third-party components
retain their own licenses. See the [contribution guide](../../CONTRIBUTING.md) to get involved.
