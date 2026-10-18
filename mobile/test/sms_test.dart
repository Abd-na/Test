import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:veta_sms_gateway/main.dart';
import 'package:veta_sms_gateway/src/app_shell.dart';
import 'package:veta_sms_gateway/src/sms/inbox_screen.dart';
import 'package:veta_sms_gateway/src/sms/sms_models.dart';
import 'package:veta_sms_gateway/src/sms/sms_repository.dart';

import 'home_screen_test.dart' show FakeGateway;

/// In-memory SMS store that behaves like the phone's.
class FakeSms implements SmsRepository {
  FakeSms({this.isDefault = false});

  bool isDefault;
  final _changes = StreamController<void>.broadcast();
  final _open = StreamController<OpenRequest>.broadcast();
  OpenRequest? pendingOpen;
  final calls = <String>[];
  var _nextId = 100;
  final store = <int, List<Map<String, Object?>>>{
    1: [
      {'id': 1, 'body': 'مرحبا', 'date': 1000, 'type': 1, 'status': -1, 'read': 0, 'address': '+9647700000001'},
      {'id': 2, 'body': 'أهلاً', 'date': 2000, 'type': 2, 'status': 0, 'read': 1, 'address': '+9647700000001'},
      {'id': 3, 'body': 'هل وصل الطلب؟', 'date': 3000, 'type': 1, 'status': -1, 'read': 0, 'address': '+9647700000001'},
    ],
    2: [
      {'id': 4, 'body': 'رمز التحقق 1234', 'date': 500, 'type': 1, 'status': -1, 'read': 1, 'address': 'Veta'},
    ],
  };

  void emitChange() => _changes.add(null);
  void requestOpen(OpenRequest r) => _open.add(r);

  int _threadFor(String address) {
    for (final e in store.entries) {
      if (e.value.any((m) => m['address'] == address)) return e.key;
    }
    final id = store.keys.fold(0, (a, b) => a > b ? a : b) + 1;
    store[id] = [];
    return id;
  }

  @override
  Future<SmsStatus> status() async => SmsStatus(isDefault: isDefault, canRead: true, canSend: true);

  @override
  Future<List<SmsThread>> threads() async {
    final list = store.entries.where((e) => e.value.isNotEmpty).map((e) {
      final last = e.value.last;
      return SmsThread(
        threadId: e.key,
        address: last['address'] as String,
        name: e.key == 1 ? 'أحمد' : null,
        snippet: last['body'] as String,
        date: DateTime.fromMillisecondsSinceEpoch(last['date'] as int),
        unread: e.value.where((m) => m['type'] == 1 && m['read'] == 0).length,
        lastBox: smsBoxFromType(last['type'] as int),
      );
    }).toList()..sort((a, b) => b.date.compareTo(a.date));
    return list;
  }

  @override
  Future<({int threadId, List<SmsItem> messages})> messages({int? threadId, String? address}) async {
    final id = threadId ?? _threadFor(address!);
    return (threadId: id, messages: (store[id] ?? []).map(SmsItem.fromMap).toList());
  }

  @override
  Future<void> send(String to, String text) async {
    calls.add('send:$to:$text');
    store[_threadFor(to)]!.add({
      'id': _nextId++,
      'body': text,
      'date': 9000,
      'type': 4,
      'status': 32,
      'read': 1,
      'address': to,
    });
    emitChange();
  }

  @override
  Future<void> markRead(int threadId) async {
    calls.add('read:$threadId');
    for (final m in store[threadId] ?? <Map<String, Object?>>[]) {
      m['read'] = 1;
    }
  }

  @override
  Future<bool> deleteThread(int threadId) async {
    calls.add('deleteThread:$threadId');
    store.remove(threadId);
    return true;
  }

  @override
  Future<bool> deleteMessage(int id) async => true;

  @override
  Future<void> requestDefault() async => calls.add('requestDefault');

  @override
  Stream<void> get changes => _changes.stream;

  @override
  Stream<OpenRequest> get openRequests => _open.stream;

  @override
  Future<OpenRequest?> consumeOpenRequest() async {
    final r = pendingOpen;
    pendingOpen = null;
    return r;
  }
}

Widget shell(FakeSms sms) {
  final g = FakeGateway();
  return GatewayApp(
    gateway: g,
    home: AppShell(gateway: g, sms: sms, checkPermissions: false),
  );
}

void main() {
  group('smsParts', () {
    test('GSM text: 160 chars per single SMS, 153 per part', () {
      expect(smsParts('').parts, 0);
      expect(smsParts('a' * 160), (parts: 1, remaining: 0));
      expect(smsParts('a' * 161).parts, 2);
      expect(smsParts('{' * 80).parts, 1); // extension chars count double
      expect(smsParts('{' * 81).parts, 2);
    });

    test('Arabic switches to UCS-2: 70 / 67', () {
      expect(smsParts('م' * 70), (parts: 1, remaining: 0));
      expect(smsParts('م' * 71).parts, 2);
      expect(smsParts('م' * 135).parts, 3);
    });
  });

  test('formatSmsDate', () {
    final now = DateTime(2026, 10, 18, 15, 0);
    expect(formatSmsDate(DateTime(2026, 10, 18, 9, 5), now: now), '09:05');
    expect(formatSmsDate(DateTime(2026, 10, 17, 22, 0), now: now), 'أمس');
    expect(formatSmsDate(DateTime(2026, 3, 2), now: now), '2/3');
    expect(formatSmsDate(DateTime(2025, 3, 2), now: now), '2/3/2025');
  });

  testWidgets('inbox lists conversations with unread counts and the default-app prompt', (tester) async {
    final sms = FakeSms();
    await tester.pumpWidget(shell(sms));
    await tester.pumpAndSettle();

    expect(find.text('أحمد'), findsOneWidget);
    expect(find.text('Veta'), findsOneWidget);
    expect(find.text('هل وصل الطلب؟'), findsOneWidget);
    expect(find.text('2'), findsOneWidget); // unread badge

    await tester.tap(find.text('تعيين كتطبيق افتراضي'));
    expect(sms.calls, contains('requestDefault'));
  });

  testWidgets('no default-app prompt once the app is the default', (tester) async {
    await tester.pumpWidget(shell(FakeSms(isDefault: true)));
    await tester.pumpAndSettle();
    expect(find.text('تعيين كتطبيق افتراضي'), findsNothing);
  });

  testWidgets('opening a conversation marks it read and sending shows the message', (tester) async {
    final sms = FakeSms(isDefault: true);
    await tester.pumpWidget(shell(sms));
    await tester.pumpAndSettle();

    await tester.tap(find.text('أحمد'));
    await tester.pumpAndSettle();
    expect(find.text('مرحبا'), findsOneWidget);
    expect(sms.calls, contains('read:1'));

    await tester.enterText(find.byType(TextField), 'تم الشحن');
    await tester.pump();
    expect(find.text('62 / 1'), findsOneWidget); // UCS-2 counter
    await tester.tap(find.byTooltip('إرسال'));
    await tester.pumpAndSettle();

    expect(sms.calls, contains('send:+9647700000001:تم الشحن'));
    expect(find.text('تم الشحن'), findsOneWidget);
    expect(find.byIcon(Icons.schedule), findsOneWidget); // pending until the radio confirms
  });

  testWidgets('new message to a new number', (tester) async {
    final sms = FakeSms();
    await tester.pumpWidget(shell(sms));
    await tester.pumpAndSettle();
    await tester.tap(find.text('رسالة جديدة'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), '+9647711112222');
    await tester.tap(find.text('متابعة'));
    await tester.pumpAndSettle();
    expect(find.text('ابدأ المحادثة'), findsOneWidget);
    await tester.enterText(find.byType(TextField), 'hello');
    await tester.pump();
    await tester.tap(find.byTooltip('إرسال'));
    await tester.pumpAndSettle();
    expect(sms.calls, contains('send:+9647711112222:hello'));
  });

  testWidgets('long-press deletes a conversation when default', (tester) async {
    final sms = FakeSms(isDefault: true);
    await tester.pumpWidget(shell(sms));
    await tester.pumpAndSettle();
    await tester.longPress(find.text('Veta'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('حذف'));
    await tester.pumpAndSettle();
    expect(sms.calls, contains('deleteThread:2'));
    expect(find.text('Veta'), findsNothing);
  });

  testWidgets('notification tap / sms: link opens the conversation with a draft', (tester) async {
    final sms = FakeSms()..pendingOpen = const OpenRequest('+9647700000001', body: 'مسودة');
    await tester.pumpWidget(shell(sms));
    await tester.pumpAndSettle();
    expect(find.text('مرحبا'), findsOneWidget);
    expect(find.text('مسودة'), findsOneWidget);

    Navigator.of(tester.element(find.text('مرحبا'))).pop();
    await tester.pumpAndSettle();
    sms.requestOpen(const OpenRequest('Veta'));
    await tester.pumpAndSettle();
    expect(find.text('رمز التحقق 1234'), findsOneWidget);
  });

  testWidgets('gateway tab is still there', (tester) async {
    await tester.pumpWidget(shell(FakeSms()));
    await tester.pumpAndSettle();
    await tester.tap(find.text('البوابة'));
    await tester.pumpAndSettle();
    expect(find.text('Veta SMS Gateway'), findsOneWidget);
    expect(find.byType(InboxScreen, skipOffstage: false), findsOneWidget);
  });
}
