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
  Future<void> savePairing(PairingData data, String deviceName, {String line = GatewayLine.any}) async {
    saved = data;
    calls.add(line == GatewayLine.any ? 'pair:$deviceName' : 'pair:$line:$deviceName');
    emit(GatewaySnapshot(paired: true, serverUrl: data.url, deviceName: deviceName));
  }

  @override
  Future<void> unpair({String? line}) async => calls.add(line == null ? 'unpair' : 'unpair:$line');
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
  @override
  Future<String> sendTestSms(String to, {int? sim}) async {
    calls.add(sim == null ? 'test:$to' : 'test:$to:SIM$sim');
    return 'SIM${sim ?? 1}';
  }
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

  testWidgets('test SMS goes through the native gateway', (tester) async {
    final g = FakeGateway();
    await tester.pumpWidget(app(g));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(find.text('إرسال رسالة تجريبية'), 200);
    await tester.tap(find.text('إرسال رسالة تجريبية'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), '+9647701234567');
    await tester.tap(find.text('إرسال'));
    await tester.pumpAndSettle();
    expect(g.calls, ['test:+9647701234567']);
    expect(find.textContaining('SIM1'), findsOneWidget);
  });

  testWidgets('warns when the phone cannot send SMS', (tester) async {
    final g = FakeGateway();
    await tester.pumpWidget(app(g));
    await tester.pumpAndSettle();
    g.emit(const GatewaySnapshot(paired: true, enabled: true, status: GatewayStatus.online, canSendSms: false));
    await tester.pumpAndSettle();
    expect(find.textContaining('صلاحية إرسال الرسائل غير ممنوحة'), findsOneWidget);
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
    await tester.scrollUntilVisible(find.textContaining('إرسال إلى'), 200);
    expect(find.textContaining('إرسال إلى'), findsOneWidget);
  });

  group('dual SIM', () {
    const sims = [SimCard(slot: 1, carrier: 'Zain'), SimCard(slot: 2, carrier: 'Asiacell')];
    const dual = GatewaySnapshot(
      sims: sims,
      lines: [
        GatewayLine(key: '1', slot: 1, carrier: 'Zain'),
        GatewayLine(key: '2', slot: 2, carrier: 'Asiacell'),
      ],
    );

    testWidgets('shows a pairing card per SIM and pairs the chosen one', (tester) async {
      final g = FakeGateway()..state = dual;
      await tester.pumpWidget(app(g));
      await tester.pumpAndSettle();
      expect(find.text('الشريحة 1 · Zain'), findsOneWidget);
      expect(find.text('الشريحة 2 · Asiacell'), findsOneWidget);
      expect(find.text('مسح رمز QR'), findsNWidgets(2));

      await tester.ensureVisible(find.text('إدخال يدوي').at(1));
      await tester.pumpAndSettle();
      await tester.tap(find.text('إدخال يدوي').at(1));
      await tester.pumpAndSettle();
      expect(find.text('إدخال يدوي — الشريحة 2'), findsOneWidget);
      final fields = find.byType(TextField);
      await tester.enterText(fields.at(0), 'https://msg.veta.io');
      await tester.enterText(fields.at(1), 'vmd_abcdefghijklmnopqrstuvwxyz0123456789ABCD');
      await tester.tap(find.text('ربط'));
      await tester.pumpAndSettle();
      expect(g.calls, ['pair:2:Samsung A15', 'start']);
    });

    testWidgets('each SIM shows its own status and unpairs alone', (tester) async {
      final g = FakeGateway()
        ..state = const GatewaySnapshot(
          paired: true,
          enabled: true,
          status: GatewayStatus.online,
          sims: sims,
          lines: [
            GatewayLine(
              key: '1',
              slot: 1,
              carrier: 'Zain',
              paired: true,
              serverUrl: 'https://msg.veta.io',
              deviceName: 'Phone A SIM1',
              status: GatewayStatus.online,
            ),
            GatewayLine(
              key: '2',
              slot: 2,
              carrier: 'Asiacell',
              paired: true,
              serverUrl: 'https://msg.veta.io',
              deviceName: 'Phone A SIM2',
              status: GatewayStatus.error,
              detail: 'رمز الجهاز غير صالح أو تم حذفه',
            ),
          ],
        );
      await tester.pumpWidget(app(g));
      await tester.pumpAndSettle();
      expect(find.textContaining('Phone A SIM2'), findsOneWidget);
      expect(find.text('خطأ'), findsOneWidget);
      expect(find.text('رمز الجهاز غير صالح أو تم حذفه'), findsOneWidget);

      await tester.scrollUntilVisible(find.textContaining('Phone A SIM2'), 200);
      final sim2Card = find.ancestor(of: find.textContaining('Phone A SIM2'), matching: find.byType(Card));
      final unpair = find.descendant(of: sim2Card, matching: find.text('إلغاء الربط'));
      await tester.ensureVisible(unpair);
      await tester.pumpAndSettle();
      await tester.tap(unpair);
      await tester.pumpAndSettle();
      expect(find.text('إلغاء ربط الشريحة 2؟'), findsOneWidget);
      await tester.tap(find.widgetWithText(FilledButton, 'إلغاء الربط'));
      await tester.pumpAndSettle();
      expect(g.calls, ['unpair:2']);
    });

    testWidgets('test SMS lets you pick the SIM', (tester) async {
      final g = FakeGateway()..state = dual;
      await tester.pumpWidget(app(g));
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(find.text('إرسال رسالة تجريبية'), 200);
      await tester.ensureVisible(find.text('إرسال رسالة تجريبية'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('إرسال رسالة تجريبية'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), '+9647701234567');
      await tester.tap(find.widgetWithText(ChoiceChip, 'الشريحة 2 · Asiacell'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('إرسال'));
      await tester.pumpAndSettle();
      expect(g.calls, ['test:+9647701234567:SIM2']);
    });
  });
}
