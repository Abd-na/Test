import 'package:flutter/services.dart';

import 'models.dart';

/// Bridge to the native Android gateway (foreground service, SMS radio, receivers).
abstract class Gateway {
  Stream<GatewaySnapshot> get snapshots;
  Future<GatewaySnapshot> current();

  /// Pairs [line] (a SIM slot "1", "2"… or "any") with a server device.
  Future<void> savePairing(PairingData data, String deviceName, {String line = GatewayLine.any});

  /// Unpairs one line, or every line when [line] is null.
  Future<void> unpair({String? line});
  Future<void> setEnabled(bool enabled);
  Future<bool> isIgnoringBatteryOptimizations();
  Future<void> requestIgnoreBatteryOptimizations();

  /// Sends an SMS straight from this phone (not through the server). Returns the SIM used.
  Future<String> sendTestSms(String to, {int? sim});
}

class NativeGateway implements Gateway {
  static const _methods = MethodChannel('veta/gateway');
  static const _events = EventChannel('veta/gateway/events');

  @override
  late final Stream<GatewaySnapshot> snapshots = _events.receiveBroadcastStream().map(
    (e) => GatewaySnapshot.fromMap(e as Map<dynamic, dynamic>),
  );

  @override
  Future<GatewaySnapshot> current() async =>
      GatewaySnapshot.fromMap(await _methods.invokeMethod<Map<dynamic, dynamic>>('getState') ?? const {});

  @override
  Future<void> savePairing(PairingData data, String deviceName, {String line = GatewayLine.any}) async {
    try {
      await _methods.invokeMethod('pair', {'url': data.url, 'token': data.token, 'name': deviceName, 'line': line});
    } on PlatformException catch (e) {
      throw Exception(e.message ?? e.code);
    }
  }

  @override
  Future<void> unpair({String? line}) => _methods.invokeMethod('unpair', {'line': line});

  @override
  Future<void> setEnabled(bool enabled) => _methods.invokeMethod(enabled ? 'start' : 'stop');

  @override
  Future<bool> isIgnoringBatteryOptimizations() async =>
      await _methods.invokeMethod<bool>('isIgnoringBattery') ?? false;

  @override
  Future<void> requestIgnoreBatteryOptimizations() => _methods.invokeMethod('requestIgnoreBattery');

  @override
  Future<String> sendTestSms(String to, {int? sim}) async {
    try {
      return await _methods.invokeMethod<String>('testSms', {'to': to, 'sim': sim}) ?? '';
    } on PlatformException catch (e) {
      throw Exception(e.message ?? e.code);
    }
  }
}
