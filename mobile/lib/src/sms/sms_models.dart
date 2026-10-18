/// Android's SMS store values (Telephony.Sms.TYPE / STATUS).
enum SmsBox { inbox, sent, draft, outbox, failed, queued, unknown }

SmsBox smsBoxFromType(int type) => switch (type) {
  1 => SmsBox.inbox,
  2 => SmsBox.sent,
  3 => SmsBox.draft,
  4 => SmsBox.outbox,
  5 => SmsBox.failed,
  6 => SmsBox.queued,
  _ => SmsBox.unknown,
};

class SmsThread {
  const SmsThread({
    required this.threadId,
    required this.address,
    this.name,
    required this.snippet,
    required this.date,
    required this.unread,
    required this.lastBox,
  });

  final int threadId;
  final String address;
  final String? name;
  final String snippet;
  final DateTime date;
  final int unread;
  final SmsBox lastBox;

  String get title => (name?.isNotEmpty ?? false) ? name! : address;

  factory SmsThread.fromMap(Map<dynamic, dynamic> m) => SmsThread(
    threadId: (m['threadId'] as num).toInt(),
    address: m['address'] as String? ?? '',
    name: m['name'] as String?,
    snippet: m['snippet'] as String? ?? '',
    date: DateTime.fromMillisecondsSinceEpoch((m['date'] as num?)?.toInt() ?? 0),
    unread: (m['unread'] as num?)?.toInt() ?? 0,
    lastBox: smsBoxFromType((m['lastType'] as num?)?.toInt() ?? 0),
  );
}

class SmsItem {
  const SmsItem({required this.id, required this.body, required this.date, required this.box, required this.status});

  final int id;
  final String body;
  final DateTime date;
  final SmsBox box;

  /// Telephony.Sms.STATUS: -1 none, 0 delivered, 32 pending, 64 failed
  final int status;

  bool get outgoing => box != SmsBox.inbox;
  bool get isFailed => box == SmsBox.failed || status == 64;
  bool get isPending => box == SmsBox.outbox || box == SmsBox.queued;
  bool get isDelivered => box == SmsBox.sent && status == 0;

  factory SmsItem.fromMap(Map<dynamic, dynamic> m) => SmsItem(
    id: (m['id'] as num).toInt(),
    body: m['body'] as String? ?? '',
    date: DateTime.fromMillisecondsSinceEpoch((m['date'] as num?)?.toInt() ?? 0),
    box: smsBoxFromType((m['type'] as num?)?.toInt() ?? 0),
    status: (m['status'] as num?)?.toInt() ?? -1,
  );
}

class SmsStatus {
  const SmsStatus({this.isDefault = false, this.canRead = false, this.canSend = false, this.canReadContacts = false});

  final bool isDefault;
  final bool canRead;
  final bool canSend;
  final bool canReadContacts;

  factory SmsStatus.fromMap(Map<dynamic, dynamic> m) => SmsStatus(
    isDefault: m['isDefault'] == true,
    canRead: m['canRead'] == true,
    canSend: m['canSend'] == true,
    canReadContacts: m['canReadContacts'] == true,
  );
}

/// Request to open a conversation (notification tap or sms: link).
class OpenRequest {
  const OpenRequest(this.address, {this.body});
  final String address;
  final String? body;
}

const _gsm7 =
    '@£\$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const _gsm7ext = '^{}\\[~]|€\f';

/// How many SMS parts a text needs (Arabic/emoji switch to UCS-2: 70 chars, 67 per part).
({int parts, int remaining}) smsParts(String text) {
  if (text.isEmpty) return (parts: 0, remaining: 160);
  var gsm = true;
  var units = 0;
  for (final rune in text.runes) {
    final ch = String.fromCharCode(rune);
    if (_gsm7.contains(ch)) {
      units += 1;
    } else if (_gsm7ext.contains(ch)) {
      units += 2;
    } else {
      gsm = false;
      break;
    }
  }
  if (!gsm) units = text.codeUnits.length; // UTF-16 code units
  final single = gsm ? 160 : 70;
  final multi = gsm ? 153 : 67;
  if (units <= single) return (parts: 1, remaining: single - units);
  final parts = (units / multi).ceil();
  return (parts: parts, remaining: parts * multi - units);
}

String formatSmsDate(DateTime d, {DateTime? now}) {
  final n = now ?? DateTime.now();
  String two(int v) => v.toString().padLeft(2, '0');
  if (d.year == n.year && d.month == n.month && d.day == n.day) return '${two(d.hour)}:${two(d.minute)}';
  final yesterday = DateTime(n.year, n.month, n.day).subtract(const Duration(days: 1));
  if (d.year == yesterday.year && d.month == yesterday.month && d.day == yesterday.day) return 'أمس';
  if (d.year == n.year) return '${d.day}/${d.month}';
  return '${d.day}/${d.month}/${d.year}';
}
