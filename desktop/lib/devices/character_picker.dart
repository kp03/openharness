import 'dart:async';
import 'dart:ui' as ui;

import 'package:file_selector/file_selector.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../shared/widgets/app_select_field.dart';
import '../shared/widgets/setting_row.dart';
import 'character_pack.dart';

const _roleTitles = {
  CharacterRole.thinking: 'Thinking',
  CharacterRole.tool: 'Running a tool',
  CharacterRole.idle: 'Finished',
};
const _roleDetails = {
  CharacterRole.thinking: 'Plays while the agent thinks.',
  CharacterRole.tool: 'Plays while a command or tool runs.',
  CharacterRole.idle: 'Plays when the task is done.',
};

/// Any image Flutter decodes (PNG, GIF, WebP, …) as straight RGBA. Its own function so tests can stand in.
typedef SheetDecoder = Future<RgbaImage> Function(Uint8List bytes);

Future<RgbaImage> decodeSheet(Uint8List bytes) async {
  final codec = await ui.instantiateImageCodec(bytes);
  try {
    final frame = await codec.getNextFrame();
    final image = frame.image;
    try {
      final data = await image.toByteData(
        format: ui.ImageByteFormat.rawStraightRgba,
      );
      if (data == null) throw const CharacterError('Could not read this image.');
      return RgbaImage(image.width, image.height, data.buffer.asUint8List());
    } finally {
      image.dispose();
    }
  } finally {
    codec.dispose();
  }
}

class _Sheet {
  _Sheet(this.fileName, this.choice, this.layout);
  final String fileName;
  final SheetChoice choice;
  final SheetLayout layout;
}

/// The device's character: a sheet for each of its three animations, a live preview of what the device
/// will draw, and Install / Restore default pets. Shared by the Devices tab and the cabled device card.
class DeviceCharacterPicker extends StatefulWidget {
  const DeviceCharacterPicker({
    super.key,
    required this.name,
    required this.bytes,
    required this.enabled,
    required this.send,
    this.pickFile,
    this.decode = decodeSheet,
  });

  /// What the device reports: empty for the engine pets.
  final String name;
  final int bytes;
  final bool enabled;

  /// Installs `bytes` (or restores the pets with null); resolves to an error, or null once the device
  /// has verified it.
  final Future<String?> Function(String name, Uint8List? bytes)? send;

  /// The file dialog; tests pass their own.
  final Future<XFile?> Function()? pickFile;
  final SheetDecoder decode;

  @override
  State<DeviceCharacterPicker> createState() => _DeviceCharacterPickerState();
}

class _DeviceCharacterPickerState extends State<DeviceCharacterPicker> {
  final _sheets = <CharacterRole, _Sheet>{};
  BuiltCharacter? _built;
  String? _error;
  bool _busy = false;

  bool get _canSend => widget.enabled && !_busy && widget.send != null;

  Future<void> _choose(CharacterRole role) async {
    try {
      final file = await (widget.pickFile ??
          () => openFile(
            acceptedTypeGroups: const [
              XTypeGroup(
                label: 'Images',
                extensions: ['png', 'gif', 'webp', 'jpg', 'jpeg', 'bmp'],
              ),
            ],
          ))();
      if (file == null) return;
      setState(() {
        _busy = true;
        _error = null;
      });
      final bytes = await file.readAsBytes();
      if (bytes.length > 20 * 1024 * 1024) {
        throw const CharacterError('Choose an image smaller than 20 MB.');
      }
      final image = await widget.decode(bytes);
      final choice = SheetChoice(image);
      final layout = sheetLayout(choice);
      if (!mounted) return;
      _sheets[role] = _Sheet(file.name, choice, layout);
      _rebuild();
    } catch (error) {
      if (mounted) {
        setState(
          () => _error = error is CharacterError
              ? error.message
              : 'Could not read this image.',
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _setRow(CharacterRole role, int row) {
    final sheet = _sheets[role]!;
    _sheets[role] = _Sheet(sheet.fileName, sheet.choice.copyWith(row: row), sheet.layout);
    _rebuild();
  }

  void _remove(CharacterRole role) {
    _sheets.remove(role);
    _rebuild();
  }

  /// The bytes the device would get, rebuilt after every choice so the preview is always what installs.
  void _rebuild() {
    setState(() {
      _error = null;
      _built = null;
      if (_sheets.isEmpty) return;
      try {
        _built = buildCharacter({
          for (final entry in _sheets.entries) entry.key: entry.value.choice,
        });
      } on CharacterError catch (error) {
        _error = error.message;
      }
    });
  }

  String get _chosenName {
    final first = CharacterRole.values.firstWhere(_sheets.containsKey);
    return assetName(_sheets[first]!.fileName, 'Custom character');
  }

  Future<void> _send({bool restore = false}) async {
    final send = widget.send;
    final built = _built;
    if (send == null || (!restore && built == null)) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    final error = await send(
      restore ? '' : _chosenName,
      restore ? null : built!.bytes,
    );
    if (!mounted) return;
    setState(() {
      _busy = false;
      _error = error;
      if (error == null) {
        _sheets.clear();
        _built = null;
      }
    });
  }

  Widget _roleRow(CharacterRole role) {
    final sheet = _sheets[role];
    final rows = sheet?.layout.rows ?? 1;
    return SettingRow(
      title: _roleTitles[role]!,
      detail: sheet == null
          ? _roleDetails[role]
          : '${sheet.fileName} · ${sheet.layout.columns} frames of '
                '${sheet.layout.frameWidth} x ${sheet.layout.frameHeight}',
      control: Wrap(
        spacing: 6,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          if (sheet != null && rows > 1)
            SizedBox(
              width: 96,
              child: AppSelectField<int>(
                value: sheet.choice.row,
                semanticLabel: '${_roleTitles[role]} row',
                options: [
                  for (var r = 0; r < rows; r++)
                    SelectOption(value: r, label: 'Row ${r + 1}'),
                ],
                onChanged: (row) => _setRow(role, row),
              ),
            ),
          if (sheet != null)
            TextButton(
              onPressed: _busy ? null : () => _remove(role),
              child: const Text('Remove'),
            ),
          TextButton(
            onPressed: widget.enabled && !_busy && !kIsWeb
                ? () => unawaited(_choose(role))
                : null,
            child: Text(sheet == null ? 'Choose sheet' : 'Change'),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final built = _built;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SettingRow(
          title: 'Character',
          detail: widget.name.isEmpty
              ? 'The Codex and Claude pets. Choose sprite sheets to use your own.'
              : '${widget.name} · ${(widget.bytes / 1024).toStringAsFixed(0)} KB',
          control: widget.name.isNotEmpty
              ? TextButton(
                  onPressed: _canSend ? () => unawaited(_send(restore: true)) : null,
                  child: const Text('Restore default pets'),
                )
              : const SizedBox.shrink(),
        ),
        for (final role in CharacterRole.values) _roleRow(role),
        if (built != null) ...[
          const SizedBox(height: 8),
          Wrap(
            spacing: 16,
            runSpacing: 8,
            children: [
              for (final entry in built.roles.entries)
                Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    CharacterPreview(
                      key: ValueKey('preview-${entry.key.name}'),
                      character: built,
                      role: entry.key,
                    ),
                    const SizedBox(height: 4),
                    Text(
                      '${_roleTitles[entry.key]} · ${entry.value.frames} frames',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ],
                ),
            ],
          ),
          const SizedBox(height: 8),
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton(
              onPressed: _canSend ? () => unawaited(_send()) : null,
              child: Text('Install "$_chosenName" on device'),
            ),
          ),
        ],
        if (_busy) const LinearProgressIndicator(),
        if (_error != null)
          Text(
            _error!,
            style: TextStyle(color: Theme.of(context).colorScheme.error),
          ),
      ],
    );
  }
}

/// One animation as the device will draw it, from the bytes it will get, on the device's black.
class CharacterPreview extends StatefulWidget {
  const CharacterPreview({
    super.key,
    required this.character,
    required this.role,
    this.height = 96,
  });
  final BuiltCharacter character;
  final CharacterRole role;
  final double height;

  @override
  State<CharacterPreview> createState() => _CharacterPreviewState();
}

class _CharacterPreviewState extends State<CharacterPreview> {
  final _frames = <ui.Image>[];
  Timer? _timer;
  int _frame = 0;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  @override
  void didUpdateWidget(CharacterPreview oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.character != widget.character || oldWidget.role != widget.role) {
      unawaited(_load());
    }
  }

  Future<void> _load() async {
    _timer?.cancel();
    final character = widget.character;
    final animation = character.roles[widget.role]!;
    final images = <ui.Image>[];
    for (var f = 0; f < animation.frames; f++) {
      final completer = Completer<ui.Image>();
      ui.decodeImageFromPixels(
        character.frameRgba(widget.role, f),
        character.cols,
        character.rows,
        ui.PixelFormat.rgba8888,
        completer.complete,
      );
      images.add(await completer.future);
    }
    if (!mounted || character != widget.character) {
      for (final image in images) {
        image.dispose();
      }
      return;
    }
    setState(() {
      _dispose();
      _frames.addAll(images);
      _frame = 0;
    });
    _timer = Timer.periodic(Duration(milliseconds: animation.stepMs), (_) {
      if (mounted) setState(() => _frame = (_frame + 1) % _frames.length);
    });
  }

  void _dispose() {
    for (final image in _frames) {
      image.dispose();
    }
    _frames.clear();
  }

  @override
  void dispose() {
    _timer?.cancel();
    _dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final aspect = widget.character.cols / widget.character.rows;
    return Container(
      width: widget.height,
      height: widget.height,
      decoration: const BoxDecoration(color: Colors.black, shape: BoxShape.circle),
      alignment: Alignment.center,
      child: _frames.isEmpty
          ? null
          : SizedBox(
              width: widget.height * 0.7 * (aspect > 1 ? 1 : aspect),
              height: widget.height * 0.7 / (aspect > 1 ? aspect : 1),
              child: RawImage(
                image: _frames[_frame],
                filterQuality: FilterQuality.none,
                fit: BoxFit.contain,
              ),
            ),
    );
  }
}
