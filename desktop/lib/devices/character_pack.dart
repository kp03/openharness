import 'dart:math' as math;
import 'dart:typed_data';

/// The device character the owner builds from sprite sheets: three animations (thinking, a tool running,
/// finished or resting) in the bytes the firmware reads (custom_character.h). The CLI builds the same
/// bytes from the same sheets (cli/src/devices/assets.ts); test vectors on both sides keep them in step.
enum CharacterRole { thinking, tool, idle }

const characterMagic = 0x31484348; // "HCH1"
const characterMaxBytes = 0x80000 - 80;
const characterMaxFrames = 32;
const _alphaMin = 64;

/// The tallest a character is drawn on the 466 px round screen, below the agent's name.
const _maxDrawn = 256;
const defaultStepMs = {
  CharacterRole.thinking: 110,
  CharacterRole.tool: 90,
  CharacterRole.idle: 140,
};

/// Straight (not premultiplied) RGBA, row by row.
class RgbaImage {
  const RgbaImage(this.width, this.height, this.data);
  final int width, height;
  final Uint8List data;
}

class SheetLayout {
  const SheetLayout(this.frameWidth, this.frameHeight, this.columns, this.rows);
  final int frameWidth, frameHeight, columns, rows;
}

/// One animation: which sheet, where its frames are, and how fast they play.
class SheetChoice {
  const SheetChoice(
    this.image, {
    this.frameWidth,
    this.frameHeight,
    this.row = 0,
    this.stepMs,
  });
  final RgbaImage image;
  final int? frameWidth, frameHeight;
  final int row;
  final int? stepMs;

  SheetChoice copyWith({int? row, int? stepMs}) => SheetChoice(
    image,
    frameWidth: frameWidth,
    frameHeight: frameHeight,
    row: row ?? this.row,
    stepMs: stepMs ?? this.stepMs,
  );
}

class CharacterError implements Exception {
  const CharacterError(this.message);
  final String message;
  @override
  String toString() => message;
}

/// Where a sheet's frames are, when the owner does not say: square frames, in the two layouts sheets
/// come in — four rows, one per direction (CraftPix and most RPG packs), or one strip. It is four rows
/// when the lines either side of each row boundary are empty; a cut through a strip crosses the character.
SheetLayout sheetLayout(SheetChoice sheet) {
  final image = sheet.image;
  var frameWidth = sheet.frameWidth, frameHeight = sheet.frameHeight;
  if (frameHeight == null) {
    if (frameWidth != null) {
      frameHeight = frameWidth;
    } else {
      bool clear(int y) {
        for (var x = 0; x < image.width; x++) {
          if (image.data[(y * image.width + x) * 4 + 3] >= _alphaMin) {
            return false;
          }
        }
        return true;
      }

      final quarter = image.height ~/ 4;
      final rows =
          image.height % 4 == 0 &&
          quarter > 0 &&
          image.width % quarter == 0 &&
          [1, 2, 3].every((k) => clear(k * quarter - 1) && clear(k * quarter));
      frameHeight = rows ? quarter : image.height;
    }
  }
  frameWidth ??= frameHeight;
  if (frameWidth < 1 ||
      frameHeight < 1 ||
      image.width % frameWidth != 0 ||
      image.height % frameHeight != 0) {
    throw CharacterError(
      'A ${image.width} x ${image.height} sheet does not divide into '
      '$frameWidth x $frameHeight frames.',
    );
  }
  return SheetLayout(
    frameWidth,
    frameHeight,
    image.width ~/ frameWidth,
    image.height ~/ frameHeight,
  );
}

class _Cut {
  _Cut(this.role, this.frames, this.frameWidth, this.frameHeight, this.stepMs);
  final CharacterRole role;
  final List<Uint8List> frames;
  final int frameWidth, frameHeight, stepMs;
}

_Cut _cut(CharacterRole role, SheetChoice sheet) {
  final layout = sheetLayout(sheet);
  if (sheet.row < 0 || sheet.row >= layout.rows) {
    throw CharacterError(
      'The ${role.name} sheet has rows 0 to ${layout.rows - 1}.',
    );
  }
  if (layout.columns > characterMaxFrames) {
    throw CharacterError(
      'The ${role.name} animation has ${layout.columns} frames; '
      'the device plays up to $characterMaxFrames.',
    );
  }
  final stepMs = sheet.stepMs ?? defaultStepMs[role]!;
  if (stepMs < 20 || stepMs > 5000) {
    throw const CharacterError('Frame time must be 20 to 5000 ms.');
  }
  final frames = <Uint8List>[];
  final rowBytes = layout.frameWidth * 4;
  for (var f = 0; f < layout.columns; f++) {
    final pixels = Uint8List(layout.frameWidth * layout.frameHeight * 4);
    for (var y = 0; y < layout.frameHeight; y++) {
      final from =
          ((sheet.row * layout.frameHeight + y) * sheet.image.width +
              f * layout.frameWidth) *
          4;
      pixels.setRange(
        y * rowBytes,
        (y + 1) * rowBytes,
        sheet.image.data,
        from,
      );
    }
    frames.add(pixels);
  }
  return _Cut(role, frames, layout.frameWidth, layout.frameHeight, stepMs);
}

/// RGB565 in the panel's byte order, as the firmware's palettes hold it.
int _rgb565(int r, int g, int b) {
  final value = ((r & 248) << 8) | ((g & 252) << 3) | (b >> 3);
  return ((value << 8) | (value >> 8)) & 0xffff;
}

class CharacterAnimation {
  const CharacterAnimation(this.width, this.height, this.frames, this.stepMs);

  /// Drawn size in px on the device.
  final int width, height;
  final int frames, stepMs;
}

class BuiltCharacter {
  const BuiltCharacter(
    this.bytes,
    this.roles,
    this.colours,
    this.scale,
    this.cols,
    this.rows,
  );
  final Uint8List bytes;
  final Map<CharacterRole, CharacterAnimation> roles;
  final int colours, scale;

  /// The shared crop, in sheet pixels.
  final int cols, rows;

  /// A frame of `role` as the device draws it: straight RGBA, cols x rows, from the palette.
  Uint8List frameRgba(CharacterRole role, int frame) {
    final view = ByteData.sublistView(bytes);
    final entry = 4 + 512 + 12 * role.index;
    final offset = view.getUint32(entry + 8, Endian.little) + frame * cols * rows;
    final out = Uint8List(cols * rows * 4);
    for (var i = 0; i < cols * rows; i++) {
      final index = bytes[offset + i];
      if (index == 0) continue;
      final stored = view.getUint16(4 + 2 * index, Endian.little);
      final value = ((stored << 8) | (stored >> 8)) & 0xffff;
      out[i * 4] = (value >> 8) & 248;
      out[i * 4 + 1] = (value >> 3) & 252;
      out[i * 4 + 2] = (value << 3) & 248;
      out[i * 4 + 3] = 255;
    }
    return out;
  }
}

/// The device's character from up to three animations. Every frame of every animation shares one crop,
/// the union of what any of them draws, so the character stands still when it changes animation. Colours
/// past the 255 a palette holds are reduced a bit of precision at a time until they fit.
BuiltCharacter buildCharacter(Map<CharacterRole, SheetChoice> sheets) {
  final cuts = [
    for (final role in CharacterRole.values)
      if (sheets[role] != null) _cut(role, sheets[role]!),
  ];
  if (cuts.isEmpty) throw const CharacterError('Choose at least one animation.');
  final frameWidth = cuts.first.frameWidth, frameHeight = cuts.first.frameHeight;
  if (cuts.any(
    (c) => c.frameWidth != frameWidth || c.frameHeight != frameHeight,
  )) {
    throw const CharacterError(
      'Every animation needs the same frame size, so the character keeps its place.',
    );
  }
  var left = frameWidth, right = -1, top = frameHeight, bottom = -1;
  for (final c in cuts) {
    for (final frame in c.frames) {
      for (var y = 0; y < frameHeight; y++) {
        for (var x = 0; x < frameWidth; x++) {
          if (frame[(y * frameWidth + x) * 4 + 3] >= _alphaMin) {
            left = math.min(left, x);
            right = math.max(right, x);
            top = math.min(top, y);
            bottom = math.max(bottom, y);
          }
        }
      }
    }
  }
  if (right < 0) throw const CharacterError('The sheets are fully transparent.');
  final cols = right - left + 1, rows = bottom - top + 1;
  if (cols > 255 || rows > 255) {
    throw const CharacterError('Frames can be at most 255 px after cropping.');
  }
  final scale = math.max(
    1,
    math.min(16, math.min(_maxDrawn ~/ rows, 466 ~/ cols)),
  );

  int key(Uint8List frame, int o, int drop) => _rgb565(
    frame[o] >> drop << drop,
    frame[o + 1] >> drop << drop,
    frame[o + 2] >> drop << drop,
  );
  var drop = 0;
  var colours = <int, int>{};
  for (; drop <= 5; drop++) {
    colours = {};
    for (final c in cuts) {
      for (final frame in c.frames) {
        for (var y = top; y <= bottom; y++) {
          for (var x = left; x <= right; x++) {
            final o = (y * frameWidth + x) * 4;
            if (frame[o + 3] < _alphaMin) continue;
            colours.putIfAbsent(key(frame, o, drop), () => colours.length + 1);
          }
        }
      }
    }
    if (colours.length <= 255) break;
  }
  if (colours.length > 255) {
    throw const CharacterError('The sheets use too many colours.');
  }

  const header = 4 + 512 + 12 * 3;
  final total =
      header + cuts.fold<int>(0, (sum, c) => sum + c.frames.length * cols * rows);
  if (total > characterMaxBytes) {
    throw const CharacterError(
      'The character is too large for the device. Use fewer frames.',
    );
  }
  final bytes = Uint8List(total);
  final view = ByteData.sublistView(bytes);
  view.setUint32(0, characterMagic, Endian.little);
  colours.forEach((value, index) {
    view.setUint16(4 + 2 * index, value, Endian.little);
  });
  var at = header;
  final roles = <CharacterRole, CharacterAnimation>{};
  for (final c in cuts) {
    final entry = 4 + 512 + 12 * c.role.index;
    bytes
      ..[entry] = c.frames.length
      ..[entry + 1] = cols
      ..[entry + 2] = rows
      ..[entry + 3] = scale;
    view.setUint16(entry + 4, c.stepMs, Endian.little);
    view.setUint32(entry + 8, at, Endian.little);
    for (final frame in c.frames) {
      for (var y = top; y <= bottom; y++) {
        for (var x = left; x <= right; x++) {
          final o = (y * frameWidth + x) * 4;
          bytes[at++] = frame[o + 3] < _alphaMin
              ? 0
              : colours[key(frame, o, drop)]!;
        }
      }
    }
    roles[c.role] = CharacterAnimation(
      cols * scale,
      rows * scale,
      c.frames.length,
      c.stepMs,
    );
  }
  return BuiltCharacter(bytes, roles, colours.length, scale, cols, rows);
}

/// A name the device stores: printable ASCII, at most 31 characters.
String assetName(String fileName, String fallback) {
  final dot = fileName.lastIndexOf('.');
  final base = (dot > 0 ? fileName.substring(0, dot) : fileName)
      .replaceAll(RegExp(r'[^\x20-\x7e]'), '')
      .trim();
  final title = base.substring(0, math.min(31, base.length)).trim();
  return title.isEmpty ? fallback : title;
}
