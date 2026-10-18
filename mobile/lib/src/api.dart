import 'dart:convert';

import 'package:http/http.dart' as http;

import 'models.dart';

class PairingException implements Exception {
  PairingException(this.message);
  final String message;
  @override
  String toString() => message;
}

/// Checks a pairing against the server before saving it.
/// Returns the device name registered in the dashboard.
Future<String> verifyPairing(PairingData data, {http.Client? client}) async {
  final c = client ?? http.Client();
  try {
    final res = await c
        .post(
          Uri.parse('${data.url}/api/device/v1/heartbeat'),
          headers: {'Authorization': 'Bearer ${data.token}', 'Content-Type': 'application/json'},
          body: jsonEncode({}),
        )
        .timeout(const Duration(seconds: 15));
    Map<String, dynamic>? body;
    try {
      body = jsonDecode(res.body) as Map<String, dynamic>;
    } catch (_) {
      body = null;
    }
    if (res.statusCode == 401) throw PairingException('رمز الجهاز غير صالح أو تم حذفه');
    if (res.statusCode != 200 || body?['success'] != true) {
      throw PairingException(body?['error']?['message']?.toString() ?? 'HTTP ${res.statusCode}');
    }
    return body?['data']?['device']?['name']?.toString() ?? data.name ?? '';
  } on PairingException {
    rethrow;
  } catch (e) {
    throw PairingException('تعذر الاتصال بالسيرفر: $e');
  } finally {
    if (client == null) c.close();
  }
}
