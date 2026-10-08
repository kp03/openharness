import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/widgets/setting_row.dart';

/// "Test on device": the robot plays its notification sound, or shows its character's animations,
/// as it holds them now. [test] answers null once the device did, or one line saying why not.
class DeviceTestButton extends StatefulWidget {
  const DeviceTestButton({
    super.key,
    required this.title,
    required this.detail,
    required this.enabled,
    required this.test,
  });

  final String title;
  final String detail;
  final bool enabled;
  final Future<String?> Function()? test;

  @override
  State<DeviceTestButton> createState() => _DeviceTestButtonState();
}

class _DeviceTestButtonState extends State<DeviceTestButton> {
  bool _busy = false;
  String? _error;

  Future<void> _run() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    String? error;
    try {
      error = await widget.test!();
    } catch (_) {
      error = 'The device did not answer.';
    }
    if (!mounted) return;
    setState(() {
      _busy = false;
      _error = error;
    });
  }

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      SettingRow(
        title: widget.title,
        detail: widget.detail,
        controlSemanticLabel: widget.title,
        control: SizedBox(
          width: SettingRow.controlWidth,
          child: OutlinedButton(
            onPressed: widget.enabled && !_busy && widget.test != null
                ? () => unawaited(_run())
                : null,
            child: Text(_busy ? 'Testing…' : 'Test on device'),
          ),
        ),
      ),
      if (_error != null)
        Text(
          _error!,
          style: TextStyle(color: Theme.of(context).colorScheme.error),
        ),
    ],
  );
}
