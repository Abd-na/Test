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

GatewayStatus _parseStatus(Object? raw) => GatewayStatus.values.firstWhere(
  (s) => s.name == (raw as String? ?? '').toLowerCase(),
  orElse: () => GatewayStatus.stopped,
);

/// A SIM card detected in the phone (slot starts at 1).
class SimCard {
  const SimCard({required this.slot, this.carrier = ''});
  final int slot;
  final String carrier;
}

/// Something the phone can be paired on: one per SIM on dual-SIM phones,
/// or a single "any SIM" line ([key] == 'any'). Each line is its own device on the server.
class GatewayLine {
  const GatewayLine({
    required this.key,
    this.slot = 0,
    this.carrier = '',
    this.present = true,
    this.paired = false,
    this.serverUrl = '',
    this.deviceName = '',
    this.status = GatewayStatus.stopped,
    this.detail = '',
  });

  static const any = 'any';

  final String key;
  final int slot;
  final String carrier;

  /// False when the line's SIM was removed from the phone.
  final bool present;
  final bool paired;
  final String serverUrl;
  final String deviceName;
  final GatewayStatus status;
  final String detail;

  bool get isAnySim => key == any;

  factory GatewayLine.fromMap(Map<dynamic, dynamic> m) => GatewayLine(
    key: m['key']?.toString() ?? any,
    slot: (m['slot'] as num?)?.toInt() ?? 0,
    carrier: m['carrier'] as String? ?? '',
    present: m['present'] != false,
    paired: m['paired'] == true,
    serverUrl: m['serverUrl'] as String? ?? '',
    deviceName: m['deviceName'] as String? ?? '',
    status: _parseStatus(m['status']),
    detail: m['detail'] as String? ?? '',
  );
}

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
    this.canSendSms = true,
    List<GatewayLine>? lines,
    this.sims = const [],
  }) : _lines = lines; // ignore: prefer_initializing_formals (public named parameter)

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

  /// SEND_SMS as seen by the native side (the source of truth for the radio).
  final bool canSendSms;

  final List<GatewayLine>? _lines;

  /// SIMs detected in the phone.
  final List<SimCard> sims;

  /// Pairing slots to show; a single "any SIM" line unless the phone has several SIMs.
  List<GatewayLine> get lines =>
      _lines ??
      [
        GatewayLine(
          key: GatewayLine.any,
          paired: paired,
          serverUrl: serverUrl,
          deviceName: deviceName,
          status: paired ? status : GatewayStatus.stopped,
        ),
      ];

  factory GatewaySnapshot.fromMap(Map<dynamic, dynamic> m) {
    int n(String k) => (m[k] as num?)?.toInt() ?? 0;
    return GatewaySnapshot(
      status: _parseStatus(m['status']),
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
      canSendSms: m['canSendSms'] != false,
      lines: (m['lines'] as List?)?.map((e) => GatewayLine.fromMap(e as Map<dynamic, dynamic>)).toList(),
      sims:
          (m['sims'] as List?)
              ?.map((e) => e as Map<dynamic, dynamic>)
              .map((e) => SimCard(slot: (e['slot'] as num?)?.toInt() ?? 0, carrier: e['carrier'] as String? ?? ''))
              .toList() ??
          const [],
    );
  }
}
