import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:veta_sms_gateway/src/api.dart';
import 'package:veta_sms_gateway/src/models.dart';

const token = 'vmd_abcdefghijklmnopqrstuvwxyz0123456789ABCD';

void main() {
  group('PairingData', () {
    test('parses the dashboard QR payload', () {
      final d = PairingData.tryParseQr(
        jsonEncode({'v': 1, 'url': 'https://msg.veta.io/', 'token': token, 'name': 'A15'}),
      );
      expect(d, isNotNull);
      expect(d!.url, 'https://msg.veta.io');
      expect(d.token, token);
      expect(d.name, 'A15');
    });

    test('rejects other QR codes', () {
      expect(PairingData.tryParseQr('https://example.com'), isNull);
      expect(PairingData.tryParseQr('{"url":"https://x.io"}'), isNull);
      expect(PairingData.tryParseQr('[1,2]'), isNull);
    });

    test('validates manual input', () {
      expect(PairingData.tryCreate(' https://msg.veta.io ', ' $token '), isNotNull);
      expect(PairingData.tryCreate('msg.veta.io', token), isNull);
      expect(PairingData.tryCreate('ftp://msg.veta.io', token), isNull);
      expect(PairingData.tryCreate('https://msg.veta.io', 'vk_live_abc'), isNull);
    });
  });

  group('GatewaySnapshot', () {
    test('maps the native state', () {
      final s = GatewaySnapshot.fromMap({
        'status': 'ONLINE',
        'sent': 3,
        'log': ['a', 'b'],
        'paired': true,
        'enabled': true,
        'serverUrl': 'https://x.io',
      });
      expect(s.status, GatewayStatus.online);
      expect(s.sent, 3);
      expect(s.log, ['a', 'b']);
      expect(s.paired, isTrue);
    });

    test('falls back to defaults', () {
      final s = GatewaySnapshot.fromMap({'status': 'weird'});
      expect(s.status, GatewayStatus.stopped);
      expect(s.log, isEmpty);
    });

    test('without per-SIM lines there is one "any SIM" line', () {
      final s = GatewaySnapshot.fromMap({'status': 'ONLINE', 'paired': true, 'serverUrl': 'https://x.io'});
      expect(s.lines, hasLength(1));
      expect(s.lines.single.isAnySim, isTrue);
      expect(s.lines.single.paired, isTrue);
      expect(s.lines.single.serverUrl, 'https://x.io');
    });

    test('maps the SIMs and their lines', () {
      final s = GatewaySnapshot.fromMap({
        'status': 'ONLINE',
        'sims': [
          {'slot': 1, 'carrier': 'Zain'},
          {'slot': 2, 'carrier': 'Asiacell'},
        ],
        'lines': [
          {'key': '1', 'slot': 1, 'carrier': 'Zain', 'paired': true, 'status': 'ONLINE', 'present': true},
          {'key': '2', 'slot': 2, 'carrier': 'Asiacell', 'paired': false, 'status': 'STOPPED', 'present': false},
        ],
      });
      expect(s.sims.map((e) => e.slot), [1, 2]);
      expect(s.lines.map((e) => e.key), ['1', '2']);
      expect(s.lines.first.status, GatewayStatus.online);
      expect(s.lines.first.isAnySim, isFalse);
      expect(s.lines.last.present, isFalse);
    });
  });

  group('verifyPairing', () {
    final data = PairingData.tryCreate('https://msg.veta.io', token)!;

    test('returns the device name from the heartbeat', () async {
      late http.Request seen;
      final client = MockClient((req) async {
        seen = req;
        return http.Response(
          jsonEncode({
            'success': true,
            'data': {
              'device': {'id': 'dev_1', 'name': 'Samsung', 'enabled': true},
            },
          }),
          200,
        );
      });
      expect(await verifyPairing(data, client: client), 'Samsung');
      expect(seen.url.toString(), 'https://msg.veta.io/api/device/v1/heartbeat');
      expect(seen.headers['Authorization'], 'Bearer $token');
    });

    test('explains an invalid token', () async {
      final client = MockClient((_) async => http.Response('{"success":false}', 401));
      expect(() => verifyPairing(data, client: client), throwsA(isA<PairingException>()));
    });

    test('wraps network errors', () async {
      final client = MockClient((_) async => throw Exception('offline'));
      expect(
        () => verifyPairing(data, client: client),
        throwsA(isA<PairingException>().having((e) => e.message, 'message', contains('تعذر الاتصال'))),
      );
    });
  });
}
