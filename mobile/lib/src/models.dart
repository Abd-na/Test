import 'dart:convert';

/// Connection data encoded in the pairing QR shown by the dashboard:
/// {"v":1,"url":"https://msg.example.com","token":"vmd_...","name":"..."}
class PairingData {
  const PairingData({required this.url, required this.token, this.name});

  final String url;
  final String token;
  final String? name;

  static PairingData? tryParseQr(String raw) {
    try {
      final data = jsonDecode(raw);
      if (data is! Map) return null;
      return tryCreate(data['url']?.toString() ?? '', data['token']?.toString() ?? '', name: data['name']?.toString());
    } on FormatException {
      return null;
    }
  }

  /// Validates and normalizes manually entered values.
  static PairingData? tryCreate(String url, String token, {String? name}) {
    final cleanUrl = url.trim().replaceAll(RegExp(r'/+$'), '');
    final cleanToken = token.trim();
    final uri = Uri.tryParse(cleanUrl);
    if (uri == null || !(uri.scheme == 'http' || uri.scheme == 'https') || uri.host.isEmpty) return null;
    if (!RegExp(r'^vmd_[A-Za-z0-9]{20,}$').hasMatch(cleanToken)) return null;
    return PairingData(url: cleanUrl, token: cleanToken, name: (name?.isEmpty ?? true) ? null : name);
  }
}

enum GatewayStatus { stopped, connecting, online, error }

/// State pushed by the native gateway service.
class GatewaySnapshot {
  const GatewaySnapshot({
    this.status = GatewayStatus.stopped,
    this.detail = '',
    this.sent = 0,
    this.failed = 0,
    this.received = 0,
    this.pending = 0,
    this.log = const [],
    this.enabled = false,
    this.paired = false,
    this.serverUrl = '',
    this.deviceName = '',
  });

  final GatewayStatus status;
  final String detail;
  final int sent;
  final int failed;
  final int received;
  final int pending;
  final List<String> log;
  final bool enabled;
  final bool paired;
  final String serverUrl;
  final String deviceName;

  factory GatewaySnapshot.fromMap(Map<dynamic, dynamic> m) {
    int n(String k) => (m[k] as num?)?.toInt() ?? 0;
    return GatewaySnapshot(
      status: GatewayStatus.values.firstWhere(
        (s) => s.name == (m['status'] as String? ?? '').toLowerCase(),
        orElse: () => GatewayStatus.stopped,
      ),
      detail: m['detail'] as String? ?? '',
      sent: n('sent'),
      failed: n('failed'),
      received: n('received'),
      pending: n('pending'),
      log: (m['log'] as List?)?.map((e) => e.toString()).toList() ?? const [],
      enabled: m['enabled'] == true,
      paired: m['paired'] == true,
      serverUrl: m['serverUrl'] as String? ?? '',
      deviceName: m['deviceName'] as String? ?? '',
    );
  }
}
