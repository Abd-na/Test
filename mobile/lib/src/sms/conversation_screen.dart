import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'sms_models.dart';
import 'sms_repository.dart';

class ConversationScreen extends StatefulWidget {
  const ConversationScreen({
    super.key,
    required this.repo,
    required this.address,
    this.threadId,
    this.name,
    this.draft,
  });

  final SmsRepository repo;
  final String address;
  final int? threadId;
  final String? name;
  final String? draft;

  @override
  State<ConversationScreen> createState() => _ConversationScreenState();
}

class _ConversationScreenState extends State<ConversationScreen> {
  late final TextEditingController _input = TextEditingController(text: widget.draft);
  List<SmsItem> _messages = const [];
  int? _threadId;
  bool _sending = false;
  bool _loading = true;
  StreamSubscription<void>? _changes;
  Timer? _debounce;

  @override
  void initState() {
    super.initState();
    _threadId = widget.threadId;
    _changes = widget.repo.changes.listen((_) {
      _debounce?.cancel();
      _debounce = Timer(const Duration(milliseconds: 250), _load);
    });
    _input.addListener(() => setState(() {}));
    _load();
  }

  @override
  void dispose() {
    _changes?.cancel();
    _debounce?.cancel();
    _input.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final result = await widget.repo.messages(threadId: _threadId, address: widget.address);
    if (!mounted) return;
    setState(() {
      _threadId = result.threadId;
      _messages = result.messages;
      _loading = false;
    });
    if (result.messages.any((m) => m.box == SmsBox.inbox)) {
      widget.repo.markRead(result.threadId);
    }
  }

  Future<void> _send([String? text]) async {
    final body = (text ?? _input.text).trim();
    if (body.isEmpty || _sending) return;
    setState(() => _sending = true);
    try {
      await widget.repo.send(widget.address, body);
      if (text == null) _input.clear();
      await _load();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('فشل الإرسال: ${e.toString().replaceFirst('Exception: ', '')}')));
      }
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _messageActions(SmsItem m) async {
    final action = await showModalBottomSheet<String>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (m.isFailed)
              ListTile(
                leading: const Icon(Icons.refresh),
                title: const Text('إعادة الإرسال'),
                onTap: () => Navigator.pop(ctx, 'resend'),
              ),
            ListTile(
              leading: const Icon(Icons.copy),
              title: const Text('نسخ النص'),
              onTap: () => Navigator.pop(ctx, 'copy'),
            ),
            ListTile(
              leading: const Icon(Icons.delete_outline),
              title: const Text('حذف الرسالة'),
              onTap: () => Navigator.pop(ctx, 'delete'),
            ),
          ],
        ),
      ),
    );
    if (action == 'copy') {
      await Clipboard.setData(ClipboardData(text: m.body));
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('تم النسخ')));
    } else if (action == 'resend') {
      await widget.repo.deleteMessage(m.id);
      await _send(m.body);
    } else if (action == 'delete') {
      final ok = await widget.repo.deleteMessage(m.id);
      if (!ok && mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('الحذف يتطلب أن يكون التطبيق هو تطبيق الرسائل الافتراضي')));
      }
      _load();
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final counter = smsParts(_input.text);
    final title = (widget.name?.isNotEmpty ?? false) ? widget.name! : widget.address;
    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, textDirection: (widget.name?.isNotEmpty ?? false) ? null : TextDirection.ltr),
            if (widget.name?.isNotEmpty ?? false)
              Text(widget.address, style: theme.textTheme.bodySmall, textDirection: TextDirection.ltr),
          ],
        ),
      ),
      body: Column(
        children: [
          Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : _messages.isEmpty
                ? const Center(child: Text('ابدأ المحادثة'))
                : ListView.builder(
                    reverse: true,
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                    itemCount: _messages.length,
                    itemBuilder: (_, i) {
                      final m = _messages[_messages.length - 1 - i];
                      return _Bubble(message: m, onLongPress: () => _messageActions(m));
                    },
                  ),
          ),
          SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(8, 4, 8, 8),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Expanded(
                    child: TextField(
                      controller: _input,
                      minLines: 1,
                      maxLines: 5,
                      textCapitalization: TextCapitalization.sentences,
                      decoration: InputDecoration(
                        hintText: 'اكتب رسالة',
                        helperText: counter.parts > 0 ? '${counter.remaining} / ${counter.parts}' : null,
                        border: OutlineInputBorder(borderRadius: BorderRadius.circular(24)),
                        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Padding(
                    padding: EdgeInsets.only(bottom: counter.parts > 0 ? 22 : 0),
                    child: IconButton.filled(
                      tooltip: 'إرسال',
                      onPressed: _sending || _input.text.trim().isEmpty ? null : () => _send(),
                      icon: _sending
                          ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
                          : const Icon(Icons.send),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _Bubble extends StatelessWidget {
  const _Bubble({required this.message, required this.onLongPress});

  final SmsItem message;
  final VoidCallback onLongPress;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final m = message;
    final mine = m.outgoing;
    final bg = m.isFailed
        ? theme.colorScheme.errorContainer
        : mine
        ? theme.colorScheme.primaryContainer
        : theme.colorScheme.surfaceContainerHighest;
    final fg = m.isFailed
        ? theme.colorScheme.onErrorContainer
        : mine
        ? theme.colorScheme.onPrimaryContainer
        : theme.colorScheme.onSurface;
    final (icon, label) = !mine
        ? (null, null)
        : m.isFailed
        ? (Icons.error_outline, 'فشل الإرسال، اضغط مطولاً لإعادة المحاولة')
        : m.isPending
        ? (Icons.schedule, null)
        : m.isDelivered
        ? (Icons.done_all, null)
        : (Icons.done, null);
    return Align(
      // own messages on the "end" side (left in Arabic), like other RTL chat apps
      alignment: mine ? AlignmentDirectional.centerEnd : AlignmentDirectional.centerStart,
      child: GestureDetector(
        onLongPress: onLongPress,
        child: Container(
          margin: const EdgeInsets.symmetric(vertical: 3),
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 6),
          constraints: BoxConstraints(maxWidth: MediaQuery.sizeOf(context).width * 0.78),
          decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(16)),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(m.body, style: TextStyle(color: fg, fontSize: 16)),
              const SizedBox(height: 2),
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(formatSmsDate(m.date), style: theme.textTheme.labelSmall?.copyWith(color: fg.withAlpha(180))),
                  if (icon != null) ...[const SizedBox(width: 4), Icon(icon, size: 14, color: fg.withAlpha(200))],
                ],
              ),
              if (label != null) Text(label, style: theme.textTheme.labelSmall?.copyWith(color: fg)),
            ],
          ),
        ),
      ),
    );
  }
}
