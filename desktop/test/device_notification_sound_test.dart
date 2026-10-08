import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/devices/notification_sound_import.dart';

void main() {
  test('mu-law codec preserves silence and bounds the loudest samples', () {
    for (final sample in [0, 1, -1, 500, -500, 12000, -12000, 32767, -32768]) {
      final decoded = decodeMuLaw(encodeMuLaw(sample));
      expect(decoded.abs(), lessThanOrEqualTo(32767));
      if (sample.abs() > 100) expect(decoded.isNegative, sample.isNegative);
    }
    expect(decodeMuLaw(encodeMuLaw(0)), 0);
  });

  test('imports an ordinary WAV and caps it at sixteen seconds', () async {
    if (!Platform.isMacOS && !Platform.isLinux) return;
    if (Platform.isLinux) {
      try {
        if ((await Process.run('ffmpeg', ['-version'])).exitCode != 0) return;
      } on ProcessException {
        return;
      }
    }
    final folder = await Directory.systemTemp.createTemp('harness-sound-test-');
    try {
      final samples = 16000 * 20;
      final wav = Uint8List(44 + samples * 2);
      final view = ByteData.sublistView(wav);
      void tag(int at, String value) =>
          wav.setRange(at, at + 4, value.codeUnits);
      tag(0, 'RIFF');
      view.setUint32(4, wav.length - 8, Endian.little);
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
      view.setUint32(40, samples * 2, Endian.little);
      for (var i = 0; i < samples; i++) {
        view.setInt16(
          44 + i * 2,
          (math.sin(i * 440 * math.pi * 2 / 16000) * 15000).round(),
          Endian.little,
        );
      }
      final input = File('${folder.path}/Bell.wav');
      await input.writeAsBytes(wav);
      final sound = await prepareDeviceSound(input.path);
      expect(sound.name, 'Bell');
      expect(sound.bytes.length, soundMaxSamples);
      expect(sound.bytes.any((byte) => byte != 0xff), true);
      expect(
        sound.bytes
            .map(decodeMuLaw)
            .map((sample) => sample.abs())
            .reduce(math.max),
        lessThan(7000),
      );
    } finally {
      await folder.delete(recursive: true);
    }
  });
}
