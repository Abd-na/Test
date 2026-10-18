import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:veta_sms_gateway/main.dart';
import 'package:veta_sms_gateway/src/gateway.dart';
import 'package:veta_sms_gateway/src/home_screen.dart';
import 'package:veta_sms_gateway/src/models.dart';

class FakeGateway implements Gateway {
  final controller = StreamController<GatewaySnapshot>.broadcast();
  GatewaySnapshot state = const GatewaySnapshot();
  PairingData? saved;
  final calls = <String>[];

  void emit(GatewaySnapshot s) {
    state = s;
    controller.add(s);
  }

  @override
  Stream<GatewaySnapshot> get snapshots => controller.stream;
  @override
  Future<GatewaySnapshot> current() async => state;
  @override
  Future<void> savePairing(PairingData data, String deviceName) async {
    saved = data;
    calls.add('pair:$deviceName');
    emit(GatewaySnapshot(paired: true, serverUrl: data.url, deviceName: deviceName));
  }

  @override
  Future<void> unpair() async => calls.add('unpair');
  @override
  Future<void> setEnabled(bool enabled) async {
    calls.add(enabled ? 'start' : 'stop');
    emit(
      GatewaySnapshot(
        paired: state.paired,
        enabled: enabled,
        status: enabled ? GatewayStatus.online : GatewayStatus.stopped,
      ),
    );
  }

  @override
  Future<bool> isIgnoringBatteryOptimizations() async => true;
  @override
  Future<void> requestIgnoreBatteryOptimizations() async {}
}

Widget app(FakeGateway g, {PairingVerifier? verify}) => GatewayApp(
  gateway: g,
  home: HomeScreen(gateway: g, checkPermissions: false, verify: verify ?? (_) async => 'Samsung A15'),
);

void main() {
  testWidgets('shows unpaired state in Arabic', (tester) async {
    await tester.pumpWidget(app(FakeGateway()));
    await tester.pumpAndSettle();
    expect(find.text('متوقفة'), findsOneWidget);
    expect(find.textContaining('الهاتف غير مربوط'), findsOneWidget);
    expect(find.text('مسح رمز QR'), findsOneWidget);
    expect(tester.widget<Switch>(find.byType(Switch)).onChanged, isNull);
  });

  testWidgets('manual pairing verifies, saves and starts the gateway', (tester) async {
    final g = FakeGateway();
    await tester.pumpWidget(app(g));
    await tester.pumpAndSettle();

    await tester.tap(find.text('إدخال يدوي'));
    await tester.pumpAndSettle();
    final fields = find.byType(TextField);
    await tester.enterText(fields.at(0), 'https://msg.veta.io');
    await tester.enterText(fields.at(1), 'bad-token');
    await tester.tap(find.text('ربط'));
    await tester.pumpAndSettle();
    expect(find.textContaining('تحقق من الرابط'), findsOneWidget);

    await tester.enterText(fields.at(1), 'vmd_abcdefghijklmnopqrstuvwxyz0123456789ABCD');
    await tester.tap(find.text('ربط'));
    await tester.pumpAndSettle();

    expect(g.saved?.url, 'https://msg.veta.io');
    expect(g.calls, ['pair:Samsung A15', 'start']);
    expect(find.text('متصلة وجاهزة للإرسال'), findsOneWidget);
  });

  testWidgets('live snapshots update the screen', (tester) async {
    final g = FakeGateway();
    await tester.pumpWidget(app(g));
    await tester.pumpAndSettle();
    g.emit(
      const GatewaySnapshot(
        paired: true,
        enabled: true,
        status: GatewayStatus.error,
        detail: 'رمز الجهاز غير صالح',
        sent: 7,
        log: ['12:00:00  ↑ إرسال إلى +964770'],
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('خطأ'), findsOneWidget);
    expect(find.text('رمز الجهاز غير صالح'), findsOneWidget);
    expect(find.text('7'), findsOneWidget);
    expect(find.textContaining('إرسال إلى'), findsOneWidget);
  });
}
