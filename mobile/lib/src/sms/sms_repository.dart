import 'dart:async';

import 'package:flutter/services.dart';

import 'sms_models.dart';

/// The phone's SMS store, through the native side.
abstract class SmsRepository {
  Future<SmsStatus> status();
  Future<List<SmsThread>> threads();
  Future<({int threadId, List<SmsItem> messages})> messages({int? threadId, String? address});
  Future<void> send(String to, String text);
  Future<void> markRead(int threadId);
  Future<bool> deleteThread(int threadId);
  Future<bool> deleteMessage(int id);
  Future<void> requestDefault();

  /// Fires when the SMS store changes (new message, status update, delete).
  Stream<void> get changes;

  /// Conversations to open (notification tap / sms: link while the app runs).
  Stream<OpenRequest> get openRequests;
  Future<OpenRequest?> consumeOpenRequest();
}

class NativeSmsRepository implements SmsRepository {
  static const _methods = MethodChannel('veta/sms');
  static const _events = EventChannel('veta/sms/events');
  final _open = StreamController<OpenRequest>.broadcast();
  bool _listening = false;

  /// Registered on first use, never in the constructor: main() creates this
  /// object before the Flutter binding exists (doing it earlier = black screen).
  void _listenForOpenRequests() {
    if (_listening) return;
    _listening = true;
    _methods.setMethodCallHandler((call) async {
      if (call.method == 'openConversation') {
        final m = call.arguments as Map<dynamic, dynamic>;
        _open.add(OpenRequest(m['address'] as String? ?? '', body: m['body'] as String?));
      }
    });
  }

  Future<T?> _call<T>(String method, [Map<String, Object?>? args]) async {
    try {
      return await _methods.invokeMethod<T>(method, args);
    } on PlatformException catch (e) {
      throw Exception(e.message ?? e.code);
    }
  }

  @override
  Future<SmsStatus> status() async => SmsStatus.fromMap(await _call<Map<dynamic, dynamic>>('status') ?? const {});

  @override
  Future<List<SmsThread>> threads() async =>
      (await _call<List<dynamic>>('threads') ?? const []).map((e) => SmsThread.fromMap(e as Map)).toList();

  @override
  Future<({int threadId, List<SmsItem> messages})> messages({int? threadId, String? address}) async {
    final m = await _call<Map<dynamic, dynamic>>('messages', {'threadId': threadId, 'address': address}) ?? const {};
    return (
      threadId: (m['threadId'] as num?)?.toInt() ?? 0,
      messages: (m['messages'] as List? ?? const []).map((e) => SmsItem.fromMap(e as Map)).toList(),
    );
  }

  @override
  Future<void> send(String to, String text) => _call('send', {'to': to, 'text': text});

  @override
  Future<void> markRead(int threadId) => _call('markRead', {'threadId': threadId});

  @override
  Future<bool> deleteThread(int threadId) async => await _call<bool>('deleteThread', {'threadId': threadId}) ?? false;

  @override
  Future<bool> deleteMessage(int id) async => await _call<bool>('deleteMessage', {'id': id}) ?? false;

  @override
  Future<void> requestDefault() => _call('requestDefault');

  @override
  late final Stream<void> changes = _events.receiveBroadcastStream().map((_) {});

  @override
  Stream<OpenRequest> get openRequests {
    _listenForOpenRequests();
    return _open.stream;
  }

  @override
  Future<OpenRequest?> consumeOpenRequest() async {
    _listenForOpenRequests();
    final m = await _call<Map<dynamic, dynamic>>('consumeOpenRequest');
    if (m == null) return null;
    return OpenRequest(m['address'] as String? ?? '', body: m['body'] as String?);
  }
}
