import 'dart:async';
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:path/path.dart' as path;

/// The device plays 16 kHz mono G.711 mu-law, up to sixteen seconds (cli/src/devices/assets.ts SOUND_MAX_SAMPLES).
const soundMaxSamples = 16 * 16000;

/// Below this at both ends is silence the device need not play.
const _silence = 200;
class PreparedDeviceSound {
  const PreparedDeviceSound(this.name, this.bytes);
  final String name;
  final Uint8List bytes;
  double get duration => bytes.length / 16000;

  Future<void> preview() async {
    final folder = await Directory.systemTemp.createTemp(
      'harness-sound-preview-',
    );
    try {
      final pcm = ByteData(bytes.length * 2);
      for (var i = 0; i < bytes.length; i++) {
        pcm.setInt16(i * 2, decodeMuLaw(bytes[i]), Endian.little);
      }
      final output = File(path.join(folder.path, 'preview.wav'));
      await output.writeAsBytes(_wav(pcm.buffer.asUint8List()), flush: true);
      final command = Platform.isMacOS ? 'afplay' : 'aplay';
      final process = await Process.start(command, [output.path]);
      unawaited(process.stdout.drain<void>());
      unawaited(process.stderr.drain<void>());
      final result = await process.exitCode.timeout(
        const Duration(seconds: 8),
        onTimeout: () {
          process.kill();
          return -1;
        },
      );
      if (result != 0) {
        throw StateError('Could not play the preview on this computer.');
      }
    } finally {
      await folder.delete(recursive: true);
    }
  }
}

Future<PreparedDeviceSound> prepareDeviceSound(String source) async {
  final input = File(source);
  if (!await input.exists() || await input.length() > 20 * 1024 * 1024) {
    throw FormatException('Choose an audio file smaller than 20 MB.');
  }
  final folder = await Directory.systemTemp.createTemp('harness-sound-import-');
  try {
    final converted = path.join(folder.path, 'sound.wav');
    final tool = Platform.isMacOS ? 'afconvert' : 'ffmpeg';
    final args = Platform.isMacOS
        ? [source, converted, '-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1']
        : [
            '-nostdin',
            '-y',
            '-i',
            source,
            '-t',
            '30',
            '-f',
            'wav',
            '-acodec',
            'pcm_s16le',
            '-ac',
            '1',
            '-ar',
            '16000',
            converted,
          ];
    Process process;
    try {
      process = await Process.start(tool, args);
    } on ProcessException {
      throw FormatException(
        'Audio conversion is unavailable. Install ffmpeg to import sounds on Linux.',
      );
    }
    unawaited(process.stdout.drain<void>());
    unawaited(process.stderr.drain<void>());
    final exit = await process.exitCode.timeout(
      const Duration(seconds: 30),
      onTimeout: () {
        process.kill();
        return -1;
      },
    );
    if (exit != 0) {
      throw FormatException('This audio file could not be decoded.');
    }
    final output = File(converted);
    if (await output.length() > 20 * 1024 * 1024) {
      throw FormatException(
        'This sound is too long to convert. Choose a shorter clip.',
      );
    }
    final wav = await output.readAsBytes();
    final samples = _pcmFromWav(wav);
    if (samples.isEmpty) {
      throw FormatException('The audio file is empty.');
    }
    final encoded = soundFromPcm(samples);
    final title = path
        .basenameWithoutExtension(source)
        .replaceAll(RegExp(r'[^\x20-\x7e]'), '')
        .trim();
    return PreparedDeviceSound(
      title.isEmpty
          ? 'Custom sound'
          : title.substring(0, math.min(31, title.length)),
      encoded,
    );
  } finally {
    await folder.delete(recursive: true);
  }
}

List<int> _pcmFromWav(Uint8List wav) {
  if (wav.length < 44) {
    throw FormatException('The converted audio is incomplete.');
  }
  final view = ByteData.sublistView(wav);
  String tag(int at) => String.fromCharCodes(wav.sublist(at, at + 4));
  if (tag(0) != 'RIFF' || tag(8) != 'WAVE') {
    throw FormatException('The converted audio is not WAV.');
  }
  var at = 12;
  var format = false;
  var dataAt = -1, dataSize = 0;
  while (at + 8 <= wav.length) {
    final chunk = tag(at);
    final length = view.getUint32(at + 4, Endian.little);
    if (length > wav.length - at - 8) {
      throw FormatException('The converted audio is truncated.');
    }
    if (chunk == 'fmt ' && length >= 16) {
      format =
          view.getUint16(at + 8, Endian.little) == 1 &&
          view.getUint16(at + 10, Endian.little) == 1 &&
          view.getUint32(at + 12, Endian.little) == 16000 &&
          view.getUint16(at + 22, Endian.little) == 16;
    }
    if (chunk == 'data') {
      dataAt = at + 8;
      dataSize = length;
      break;
    }
    at += 8 + length + (length & 1);
  }
  if (!format || dataAt < 0) {
    throw FormatException('The converted audio has the wrong format.');
  }
  return [
    for (var i = 0; i + 1 < dataSize && i < 30 * 16000 * 2; i += 2)
      view.getInt16(dataAt + i, Endian.little),
  ];
}

/// 16 kHz mono PCM → the device's clip: ends' silence trimmed, at most sixteen seconds, no louder than the
/// built-in chime (which peaks at 6000 on this same codec path). The CLI's soundFromPcm does the same.
Uint8List soundFromPcm(List<int> samples) {
  var first = 0, last = samples.length - 1;
  while (first <= last && samples[first].abs() <= _silence) {
    first++;
  }
  while (last >= first && samples[last].abs() <= _silence) {
    last--;
  }
  if (first > last) throw const FormatException('The audio file is silent.');
  final end = math.min(last + 1, first + soundMaxSamples);
  var peak = 0;
  for (var i = first; i < end; i++) {
    peak = math.max(peak, samples[i].abs());
  }
  final gain = peak > 6000 ? 6000 / peak : 1.0;
  return Uint8List.fromList([
    for (var i = first; i < end; i++) encodeMuLaw((samples[i] * gain).round()),
  ]);
}

int encodeMuLaw(int sample) {
  final sign = sample < 0 ? 0x80 : 0;
  var magnitude = math.min(sample.abs(), 32635) + 132;
  var exponent = 7, mask = 0x4000;
  while (exponent > 0 && (magnitude & mask) == 0) {
    exponent--;
    mask >>= 1;
  }
  final mantissa = (magnitude >> (exponent + 3)) & 15;
  return (~(sign | (exponent << 4) | mantissa)) & 255;
}

int decodeMuLaw(int byte) {
  final u = (~byte) & 255;
  final magnitude =
      math.min(32767, (((u & 15) << 3) + 132) << ((u >> 4) & 7)) - 132;
  return (u & 0x80) != 0 ? -magnitude : magnitude;
}

Uint8List _wav(Uint8List pcm) {
  final out = Uint8List(44 + pcm.length);
  final view = ByteData.sublistView(out);
  void tag(int offset, String value) =>
      out.setRange(offset, offset + 4, value.codeUnits);
  tag(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length, Endian.little);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, Endian.little);
  view.setUint16(20, 1, Endian.little);
  view.setUint16(22, 1, Endian.little);
  view.setUint32(24, 16000, Endian.little);
  view.setUint32(28, 32000, Endian.little);
  view.setUint16(32, 2, Endian.little);
  view.setUint16(34, 16, Endian.little);
  tag(36, 'data');
  view.setUint32(40, pcm.length, Endian.little);
  out.setRange(44, out.length, pcm);
  return out;
}
