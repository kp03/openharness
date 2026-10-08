import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart';
import 'package:file_selector/file_selector.dart';

import '../shared/theme/app_icons.dart';
import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/app_select_field.dart';
import '../shared/widgets/setting_row.dart';
import '../widgets/desktop_chrome.dart';
import 'devices_controller.dart';
import '../state/app_state.dart' show DeviceAsset;
import 'character_picker.dart';
import 'device_test_button.dart';
import 'notification_sound_import.dart';

/// Face ids belong to the firmware (character.h), not screen dimensions.
/// Add future faces here only when production firmware can actually select them.
const deviceFaces = [
  SelectOption(value: 2, label: 'Focus', detail: 'Your agents, at a glance.'),
];

class DeviceSettingsPanel extends StatefulWidget {
  const DeviceSettingsPanel({
    super.key,
    required this.device,
    required this.controller,
    this.onSound,
    this.onCharacter,
    this.onTest,
  });
  final HarnessDevice device;
  final DevicesController controller;
  final Future<String?> Function(HarnessDevice, String, Uint8List?)? onSound;
  final Future<String?> Function(HarnessDevice, String, Uint8List?)?
  onCharacter;
  final Future<String?> Function(HarnessDevice, DeviceAsset)? onTest;
  @override
  State<DeviceSettingsPanel> createState() => _DeviceSettingsPanelState();
}

class _DeviceSettingsPanelState extends State<DeviceSettingsPanel> {
  double? _brightness;
  PreparedDeviceSound? _chosenSound;
  bool _soundBusy = false;
  String? _soundError;

  Future<void> _chooseSound() async {
    try {
      final file = await openFile();
      if (file == null) return;
      setState(() {
        _soundBusy = true;
        _soundError = null;
      });
      final sound = await prepareDeviceSound(file.path);
      if (mounted) {
        setState(() => _chosenSound = sound);
      }
    } catch (error) {
      if (mounted) {
        setState(
          () => _soundError = error is FormatException
              ? error.message
              : 'Could not prepare this sound.',
        );
      }
    } finally {
      if (mounted) setState(() => _soundBusy = false);
    }
  }

  Future<void> _sendSound({bool restore = false}) async {
    final send = widget.onSound;
    final chosen = _chosenSound;
    if (send == null || (!restore && chosen == null)) return;
    setState(() {
      _soundBusy = true;
      _soundError = null;
    });
    final error = await send(
      widget.device,
      restore ? '' : chosen!.name,
      restore ? null : chosen!.bytes,
    );
    if (!mounted) return;
    setState(() {
      _soundBusy = false;
      _soundError = error;
      if (error == null) _chosenSound = null;
    });
  }

  @override
  void didUpdateWidget(DeviceSettingsPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.device.key != widget.device.key || !widget.device.canEdit) {
      _brightness = null;
      _chosenSound = null;
      _soundError = null;
    }
  }

  @override
  Widget build(BuildContext context) {
    final device = widget.device;
    final settings = device.status.settings;
    final controller = widget.controller;
    if (settings == null) {
      return Padding(
        padding: const EdgeInsets.all(24),
        child: Text(
          device.status.attached
              ? 'Waiting for your device’s settings. If they don’t appear, check that its firmware is up to date.'
              : 'Connect this device to see its settings.',
          style: DesktopChrome.text(color: DesktopChrome.muted),
        ),
      );
    }
    final enabled = device.canEdit && !controller.saving(device.key);
    void change(Map<String, Object?> patch) {
      controller.update(device.key, patch);
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (!device.hostOnline ||
            !device.hostAvailable ||
            !device.status.attached ||
            device.status.updating != null ||
            device.status.id == null) ...[
          Text(
            !device.hostOnline
                ? '${device.machineName} is offline. Showing last reported settings.'
                : !device.hostAvailable
                ? 'Reconnect or update Harness on ${device.machineName} to change settings.'
                : device.status.updating != null
                ? 'Updating to ${device.status.updating}. Keep your device connected.'
                : device.status.attached
                ? 'Update the Harness app and reconnect to change settings.'
                : 'Showing saved settings. Connect this device to ${device.machineName} to make changes.',
            style: DesktopChrome.text(color: DesktopChrome.muted),
          ),
          const SizedBox(height: 16),
        ],
        SettingRow(
          title: 'Brightness',
          detail: '${(_brightness ?? settings.brightness).round()}%',
          controlSemanticLabel: 'Device brightness',
          control: SizedBox(
            width: SettingRow.controlWidth,
            child: Slider(
              key: ValueKey('devices-brightness-${device.key}'),
              value: _brightness ?? settings.brightness.toDouble(),
              min: 0,
              max: 100,
              divisions: 20,
              semanticFormatterCallback: (value) => '${value.round()} percent',
              onChanged: enabled
                  ? (value) => setState(() => _brightness = value)
                  : null,
              onChangeEnd: enabled
                  ? (value) {
                      setState(() => _brightness = null);
                      change({'brightness': value.round()});
                    }
                  : null,
            ),
          ),
        ),
        const SizedBox(height: 10),
        SettingRow(
          title: 'Sound',
          detail: 'A quiet chime when your attention is needed.',
          controlSemanticLabel: 'Device sound',
          control: Switch(
            key: ValueKey('devices-sound-${device.key}'),
            value: !settings.muted,
            onChanged: enabled ? (value) => change({'muted': !value}) : null,
          ),
        ),
        if (settings.soundName != null) ...[
          const SizedBox(height: 10),
          SettingRow(
            title: 'Notification sound',
            detail: settings.soundName!.isEmpty
                ? 'Built-in chime'
                : '${settings.soundName} · ${(settings.soundBytes ?? 0) / 16000}s',
            control: TextButton(
              onPressed:
                  enabled && !_soundBusy && !kIsWeb && widget.onSound != null
                  ? _chooseSound
                  : null,
              child: const Text('Choose sound'),
            ),
          ),
          if (_chosenSound != null) ...[
            Text(
              '${_chosenSound!.name} · ${_chosenSound!.duration.toStringAsFixed(1)}s',
              style: DesktopChrome.metadata(),
            ),
            Wrap(
              spacing: 8,
              children: [
                TextButton(
                  onPressed: _soundBusy
                      ? null
                      : () => unawaited(
                          _chosenSound!.preview().catchError((Object _) {
                            if (mounted) {
                              setState(
                                () =>
                                    _soundError = 'Could not play the preview.',
                              );
                            }
                          }),
                        ),
                  child: const Text('Preview'),
                ),
                TextButton(
                  onPressed: enabled && !_soundBusy && widget.onSound != null
                      ? () => unawaited(_sendSound())
                      : null,
                  child: const Text('Install on device'),
                ),
              ],
            ),
          ],
          if (settings.soundName!.isNotEmpty)
            TextButton(
              onPressed: enabled && !_soundBusy && widget.onSound != null
                  ? () => unawaited(_sendSound(restore: true))
                  : null,
              child: const Text('Restore built-in chime'),
            ),
          DeviceTestButton(
            key: ValueKey('sound-test-${widget.device.key}'),
            title: 'Play on the robot',
            detail: 'The sound it plays when a turn finishes. Muted robots stay silent.',
            enabled: enabled && !_soundBusy,
            test: widget.onTest == null
                ? null
                : () => widget.onTest!(widget.device, DeviceAsset.sound),
          ),
          if (_soundBusy) const LinearProgressIndicator(),
          if (_soundError != null)
            Text(
              _soundError!,
              style: TextStyle(color: Theme.of(context).colorScheme.error),
            ),
        ],
        if (settings.characterName != null) ...[
          const SizedBox(height: 10),
          DeviceCharacterPicker(
            key: ValueKey('character-picker-${widget.device.key}'),
            name: settings.characterName!,
            bytes: settings.characterBytes ?? 0,
            enabled: enabled,
            send: widget.onCharacter == null
                ? null
                : (name, data) =>
                      widget.onCharacter!(widget.device, name, data),
          ),
          DeviceTestButton(
            key: ValueKey('character-test-${widget.device.key}'),
            title: 'Show on the robot',
            detail:
                'Plays each of its animations on the screen for a few seconds.',
            enabled: enabled,
            test: widget.onTest == null
                ? null
                : () => widget.onTest!(widget.device, DeviceAsset.character),
          ),
        ],
        const SizedBox(height: 10),
        SettingRow(
          title: 'Reverse scrolling',
          detail: 'Change the direction of a vertical swipe.',
          controlSemanticLabel: 'Reverse scrolling',
          control: Switch(
            key: ValueKey('devices-scroll-${device.key}'),
            value: settings.scrollReversed,
            onChanged: enabled
                ? (value) => change({'scrollReversed': value})
                : null,
          ),
        ),
        const SizedBox(height: 10),
        SettingRow(
          title: 'Voice language',
          detail: 'The language you speak to this device.',
          control: SizedBox(
            width: SettingRow.controlWidth,
            child: enabled
                ? AppSelectField<String>(
                    semanticLabel: 'Device voice language',
                    value: settings.voiceLang,
                    options: [
                      const SelectOption(value: 'en', label: 'English'),
                      const SelectOption(value: 'vi', label: 'Tiếng Việt'),
                      const SelectOption(value: 'es', label: 'Español'),
                      const SelectOption(value: 'fr', label: 'Français'),
                      const SelectOption(value: 'ja', label: '日本語'),
                      const SelectOption(value: 'it', label: 'Italiano'),
                      if (!const [
                        'en',
                        'vi',
                        'es',
                        'fr',
                        'ja',
                        'it',
                      ].contains(settings.voiceLang))
                        SelectOption(
                          value: settings.voiceLang,
                          label: settings.voiceLang,
                        ),
                    ],
                    onChanged: (value) => change({'voiceLang': value}),
                  )
                : Text(
                    _languageLabel(settings.voiceLang),
                    style: DesktopChrome.control(),
                  ),
          ),
        ),
        const SizedBox(height: 12),
        Semantics(
          liveRegion: true,
          child: Text(
            controller.saving(device.key)
                ? 'Saving to ${device.name}…'
                : controller.deviceError(device.key) ??
                      'Settings are saved on this device.',
            style: DesktopChrome.metadata(
              color: controller.deviceError(device.key) == null
                  ? DesktopChrome.muted
                  : Theme.of(context).colorScheme.error,
            ),
          ),
        ),
      ],
    );
  }
}

String _languageLabel(String code) =>
    const {
      'en': 'English',
      'vi': 'Tiếng Việt',
      'es': 'Español',
      'fr': 'Français',
      'ja': '日本語',
      'it': 'Italiano',
    }[code] ??
    code;

Future<void> showDeviceFaces(BuildContext context) => showAppDialog<void>(
  context: context,
  builder: (context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(24),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 440),
        child: DesktopDialogSurface(
          child: SingleChildScrollView(
            child: Padding(
              padding: const EdgeInsets.all(28),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  DesktopDialogHeader(
                    title: 'Faces',
                    padding: EdgeInsets.zero,
                    onClose: () => Navigator.of(context).pop(),
                  ),
                  const SizedBox(height: 28),
                  for (final face in deviceFaces) ...[
                    const Center(child: FocusFacePreview()),
                    const SizedBox(height: 22),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Text(face.label, style: DesktopChrome.heading()),
                        const SizedBox(width: 8),
                        Icon(
                          AppIcons.circleCheck,
                          color: DesktopChrome.accent,
                          size: 20,
                        ),
                      ],
                    ),
                    const SizedBox(height: 8),
                    Text(
                      face.detail!,
                      textAlign: TextAlign.center,
                      style: DesktopChrome.text(color: DesktopChrome.muted),
                    ),
                  ],
                  const SizedBox(height: 20),
                  Text(
                    'Focus is the included face. New faces will appear here as they become available.',
                    textAlign: TextAlign.center,
                    style: DesktopChrome.metadata(),
                  ),
                  const SizedBox(height: 24),
                  FilledButton(
                    onPressed: () => Navigator.of(context).pop(),
                    child: const Text('Done'),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    ),
  ),
);

/// A quiet, schematic preview, not fabricated live agent telemetry.
class FocusFacePreview extends StatelessWidget {
  const FocusFacePreview({super.key, this.size = 156});
  final double size;
  @override
  Widget build(BuildContext context) => Container(
    width: size,
    height: size,
    decoration: BoxDecoration(
      color: const Color(0xff141414),
      shape: BoxShape.circle,
      border: Border.all(color: const Color(0xff393939), width: 3),
    ),
    child: Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            AppIcons.circle,
            size: size * .16,
            color: const Color(0xffbababa),
          ),
          SizedBox(height: size * .065),
          Text(
            'Focus',
            style: DesktopChrome.text(
              color: Colors.white,
              size: size * .14,
              medium: true,
            ),
          ),
        ],
      ),
    ),
  );
}
