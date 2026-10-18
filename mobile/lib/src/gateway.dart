import 'package:flutter/services.dart';

import 'models.dart';

/// Bridge to the native Android gateway (foreground service, SMS radio, receivers).
abstract class Gateway {
  Stream<GatewaySnapshot> get snapshots;
  Future<GatewaySnapshot> current();
  Future<void> savePairing(PairingData data, String deviceName);
  Future<void> unpair();
  Future<void> setEnabled(bool enabled);
  Future<bool> isIgnoringBatteryOptimizations();
  Future<void> requestIgnoreBatteryOptimizations();
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
  Future<void> savePairing(PairingData data, String deviceName) =>
      _methods.invokeMethod('pair', {'url': data.url, 'token': data.token, 'name': deviceName});

  @override
  Future<void> unpair() => _methods.invokeMethod('unpair');

  @override
  Future<void> setEnabled(bool enabled) => _methods.invokeMethod(enabled ? 'start' : 'stop');

  @override
  Future<bool> isIgnoringBatteryOptimizations() async =>
      await _methods.invokeMethod<bool>('isIgnoringBattery') ?? false;

  @override
  Future<void> requestIgnoreBatteryOptimizations() => _methods.invokeMethod('requestIgnoreBattery');
}
