import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/devices/character_pack.dart';
import 'package:harness/devices/notification_sound_import.dart';

/// The shared vector: frame (c, r) has a 6 px block in (c*20, r*60, 200), one px right on odd columns.
/// cli/src/devices/assets.spec.ts builds the same sheets and pins the same hash.
RgbaImage sheet(int columns, int rows, {int frame = 16, int block = 6}) {
  final width = columns * frame, height = rows * frame;
  final data = Uint8List(width * height * 4);
  for (var r = 0; r < rows; r++) {
    for (var c = 0; c < columns; c++) {
      for (var y = 4; y < 4 + block; y++) {
        for (var x = 5 + c % 2; x < 5 + c % 2 + block; x++) {
          data.setAll(((r * frame + y) * width + c * frame + x) * 4, [
            c * 20,
            r * 60,
            200,
            255,
          ]);
        }
      }
    }
  }
  return RgbaImage(width, height, data);
}

Future<String> sha256Hex(List<int> bytes) async {
  final hash = await Sha256().hash(bytes);
  return hash.bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
}

void main() {
  test('builds the vector the CLI pins: the two converters agree byte for byte', () async {
    final built = buildCharacter({
      CharacterRole.thinking: SheetChoice(sheet(4, 4), row: 1),
      CharacterRole.tool: SheetChoice(sheet(5, 4), row: 3, stepMs: 60),
      CharacterRole.idle: SheetChoice(sheet(6, 4), row: 2, stepMs: 200),
    });
    expect(built.bytes.length, 1182);
    expect(
      await sha256Hex(built.bytes),
      '129bedc61d670c2226b7732f5e18d0da534603600eec4c6865ebdc4fa0cdfff3',
    );
    expect(built.roles[CharacterRole.tool]!.frames, 5);
    expect(built.roles[CharacterRole.idle]!.stepMs, 200);
    expect(built.scale, 16);
  });

  test('finds four direction rows or a strip, and takes the owner’s frame size', () {
    final four = sheetLayout(SheetChoice(sheet(8, 4)));
    expect([four.frameWidth, four.frameHeight, four.columns, four.rows], [16, 16, 8, 4]);
    // A strip whose height divides by four is still a strip: the quarter lines cross its frames.
    final strip = sheetLayout(SheetChoice(sheet(8, 1, block: 10)));
    expect([strip.frameWidth, strip.columns, strip.rows], [16, 8, 1]);
    final sized = sheetLayout(
      SheetChoice(sheet(8, 4), frameWidth: 32, frameHeight: 16),
    );
    expect([sized.columns, sized.rows], [4, 4]);
    expect(
      () => sheetLayout(SheetChoice(sheet(8, 4), frameWidth: 30)),
      throwsA(isA<CharacterError>()),
    );
  });

  test('previews from the installed bytes: a frame decodes back to its palette colours', () {
    final built = buildCharacter({
      CharacterRole.idle: SheetChoice(sheet(2, 1)),
    });
    final frame = built.frameRgba(CharacterRole.idle, 0);
    expect(frame.length, built.cols * built.rows * 4);
    // Top-left of the crop is frame 0's block: (0, 0, 200) through RGB565 is (0, 0, 200).
    expect(frame.sublist(0, 4), [0, 0, 200, 255]);
    // Frame 0's block is one px left of frame 1's, so the crop's last column is clear in frame 0.
    expect(frame[(built.cols - 1) * 4 + 3], 0);
  });

  test('refuses what the device cannot draw', () {
    void refuses(Map<CharacterRole, SheetChoice> sheets, String words) => expect(
      () => buildCharacter(sheets),
      throwsA(
        isA<CharacterError>().having((e) => e.message, 'message', contains(words)),
      ),
    );
    refuses({}, 'at least one');
    refuses({
      CharacterRole.thinking: SheetChoice(sheet(4, 4)),
      CharacterRole.tool: SheetChoice(sheet(4, 1, frame: 32)),
    }, 'same frame size');
    refuses({CharacterRole.idle: SheetChoice(sheet(33, 1))}, 'up to 32');
    refuses({CharacterRole.idle: SheetChoice(sheet(4, 4), row: 4)}, 'rows 0 to 3');
    refuses({CharacterRole.idle: SheetChoice(sheet(4, 4), stepMs: 5)}, '20 to 5000');
    refuses({
      CharacterRole.idle: SheetChoice(RgbaImage(16, 16, Uint8List(1024))),
    }, 'transparent');
  });

  test('names the asset from its file, as the device stores names', () {
    expect(assetName('Knight_Run.png', 'x'), 'Knight_Run');
    expect(assetName('éé.png', 'Custom character'), 'Custom character');
    expect(assetName('${'k' * 40}.png', 'x').length, 31);
  });

  test('makes the sound clip: silence trimmed, sixteen seconds at most, no louder than the chime', () {
    final pcm = List<int>.filled(20 * 16000, 0)..fillRange(16000, 20 * 16000, 12000);
    final clip = soundFromPcm(pcm);
    expect(clip.length, soundMaxSamples);
    expect(clip.first, encodeMuLaw(6000));
    expect(soundFromPcm([0, 5, 300, -400, 7, 0]), [encodeMuLaw(300), encodeMuLaw(-400)]);
    expect(() => soundFromPcm(List.filled(100, 0)), throwsFormatException);
  });
}
