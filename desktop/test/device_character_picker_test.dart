import 'dart:typed_data';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/devices/character_pack.dart';
import 'package:harness/devices/character_picker.dart';
import 'package:harness/settings/sections/cabled_device_card.dart';
import 'package:harness/state/dial_status.dart';

import 'character_pack_test.dart' show sheet;

const _settings = DeviceSettings(
  brightness: 60,
  character: 0,
  face: 466,
  muted: false,
  quiet: false,
  straightTitle: false,
  focusFace: false,
  scrollReversed: false,
  round: true,
  voiceLang: 'en',
  characterName: '',
  characterBytes: 0,
);

/// Files the "dialog" hands back, in order; each decodes to the sheet beside it (no real image codec).
class Files {
  final queue = <(String, RgbaImage?)>[];
  final images = <String, RgbaImage?>{};
  Future<XFile?> pick() async {
    if (queue.isEmpty) return null;
    final (name, image) = queue.removeAt(0);
    images[name] = image;
    return XFile.fromData(Uint8List.fromList(name.codeUnits), name: name, path: name);
  }

  Future<RgbaImage> decode(Uint8List bytes) async {
    final image = images[String.fromCharCodes(bytes)];
    if (image == null) throw Exception('not an image');
    return image;
  }
}

Widget _picker({
  required Files files,
  String name = '',
  bool enabled = true,
  Future<String?> Function(String, Uint8List?)? send,
}) => MaterialApp(
  home: Scaffold(
    body: SingleChildScrollView(
      child: DeviceCharacterPicker(
        name: name,
        bytes: 27432,
        enabled: enabled,
        send: send,
        pickFile: files.pick,
        decode: files.decode,
      ),
    ),
  ),
);

Future<void> _tap(WidgetTester tester, Finder finder) async {
  await tester.ensureVisible(finder);
  await tester.tap(finder);
  await tester.pumpAndSettle();
}

void main() {
  testWidgets(
    'choosing sheets previews and installs exactly the bytes the converter builds',
    (tester) async {
      final files = Files()
        ..queue.add(('Knight_Run.png', sheet(4, 4)))
        ..queue.add(('Knight_Idle.png', sheet(6, 4)));
      final sent = <(String, Uint8List?)>[];
      await tester.pumpWidget(
        _picker(
          files: files,
          send: (name, bytes) async {
            sent.add((name, bytes));
            return null;
          },
        ),
      );
      expect(find.textContaining('The Codex and Claude pets'), findsOneWidget);
      expect(find.text('Restore default pets'), findsNothing);

      await _tap(tester, find.text('Choose sheet').at(0)); // Thinking
      expect(find.textContaining('Knight_Run.png · 4 frames of 16 x 16'), findsOneWidget);
      await _tap(tester, find.text('Choose sheet').at(1)); // Finished (Running a tool is now index 0)
      expect(find.byType(CharacterPreview), findsNWidgets(2));

      // A four-row sheet offers its rows; the choice changes what installs.
      await _tap(tester, find.text('Row 1').first);
      await _tap(tester, find.text('Row 2').last);

      await _tap(tester, find.text('Install "Knight_Run" on device'));
      expect(sent, hasLength(1));
      expect(sent.single.$1, 'Knight_Run');
      final expected = buildCharacter({
        CharacterRole.thinking: SheetChoice(sheet(4, 4), row: 1),
        CharacterRole.idle: SheetChoice(sheet(6, 4)),
      });
      expect(sent.single.$2, expected.bytes);
      // Installed: the choices clear and the device's report takes over.
      expect(find.byType(CharacterPreview), findsNothing);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('a file that is not an image, or not a sheet, says so and installs nothing', (
    tester,
  ) async {
    final files = Files()
      ..queue.add(('notes.txt', null))
      ..queue.add(('odd.png', RgbaImage(10, 7, Uint8List(280))));
    await tester.pumpWidget(_picker(files: files, send: (_, _) async => null));
    await _tap(tester, find.text('Choose sheet').first);
    expect(find.text('Could not read this image.'), findsOneWidget);
    await _tap(tester, find.text('Choose sheet').first);
    expect(find.textContaining('does not divide into 7 x 7 frames'), findsOneWidget);
    expect(find.textContaining('Install'), findsNothing);
  });

  testWidgets('a device error is shown and the choice kept, so Install can be tried again', (
    tester,
  ) async {
    final files = Files()..queue.add(('Run.png', sheet(4, 1)));
    await tester.pumpWidget(
      _picker(files: files, send: (_, _) async => 'The device is busy.'),
    );
    await _tap(tester, find.text('Choose sheet').first);
    await _tap(tester, find.text('Install "Run" on device'));
    expect(find.text('The device is busy.'), findsOneWidget);
    expect(find.text('Install "Run" on device'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('an installed character can be restored; an unplugged device cannot change', (
    tester,
  ) async {
    final sent = <Uint8List?>[];
    await tester.pumpWidget(
      _picker(
        files: Files(),
        name: 'Knight',
        send: (_, bytes) async {
          sent.add(bytes);
          return null;
        },
      ),
    );
    expect(find.textContaining('Knight · 27 KB'), findsOneWidget);
    await _tap(tester, find.text('Restore default pets'));
    expect(sent, [null]);

    await tester.pumpWidget(
      _picker(files: Files(), name: 'Knight', enabled: false, send: (_, _) async => null),
    );
    for (final label in ['Restore default pets', 'Choose sheet']) {
      final button = tester.widget<TextButton>(find.widgetWithText(TextButton, label).first);
      expect(button.onPressed, isNull, reason: label);
    }
  });

  testWidgets('the cabled card shows Character only for firmware that reports one', (tester) async {
    Future<void> card(DeviceSettings settings) => tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: CabledDeviceCard(
              devices: [DialStatus(attached: true, id: 'AA:01', settings: settings)],
              onChanged: (_, _) {},
              onCharacter: (_, _, _) async => null,
            ),
          ),
        ),
      ),
    );
    await card(_settings);
    expect(find.byType(DeviceCharacterPicker), findsOneWidget);
    await card(const DeviceSettings(
      brightness: 60,
      character: 0,
      face: 466,
      muted: false,
      quiet: false,
      straightTitle: false,
      focusFace: false,
      scrollReversed: false,
      round: true,
      voiceLang: 'en',
    ));
    expect(find.byType(DeviceCharacterPicker), findsNothing);
  });
}
