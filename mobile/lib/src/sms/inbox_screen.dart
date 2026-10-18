import 'dart:async';

import 'package:flutter/material.dart';
import 'package:permission_handler/permission_handler.dart';

import 'conversation_screen.dart';
import 'sms_models.dart';
import 'sms_repository.dart';

class InboxScreen extends StatefulWidget {
  const InboxScreen({super.key, required this.repo, this.checkPermissions = true});

  final SmsRepository repo;
  final bool checkPermissions;

  @override
  State<InboxScreen> createState() => _InboxScreenState();
}

class _InboxScreenState extends State<InboxScreen> with WidgetsBindingObserver {
  List<SmsThread> _threads = const [];
  SmsStatus _status = const SmsStatus();
  bool _loading = true;
  String? _error;
  StreamSubscription<void>? _changes;
  Timer? _debounce;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _changes = widget.repo.changes.listen((_) {
      _debounce?.cancel();
      _debounce = Timer(const Duration(milliseconds: 300), _load);
    });
    _load();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // back from the "default SMS app" dialog or app settings
    if (state == AppLifecycleState.resumed) _load();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _changes?.cancel();
    _debounce?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final status = await widget.repo.status();
      final threads = status.canRead ? await widget.repo.threads() : const <SmsThread>[];
      if (!mounted) return;
      setState(() {
        _status = status;
        _threads = threads;
        _loading = false;
        _error = null;
      });
    } catch (e) {
      if (mounted) {
        setState(() {
          _loading = false;
          _error = '$e';
        });
      }
    }
  }

  Future<void> _requestPermissions() async {
    if (widget.checkPermissions) await [Permission.sms, Permission.contacts].request();
    await _load();
  }

  Future<void> _open(String address, {int? threadId, String? name}) async {
    await Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => ConversationScreen(repo: widget.repo, address: address, threadId: threadId, name: name),
      ),
    );
    _load();
  }

  Future<void> _newMessage() async {
    final controller = TextEditingController();
    final address = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('رسالة جديدة'),
        content: TextField(
          controller: controller,
          autofocus: true,
          keyboardType: TextInputType.phone,
          textDirection: TextDirection.ltr,
          decoration: const InputDecoration(labelText: 'رقم المستلم', hintText: '+9647701234567'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('إلغاء')),
          FilledButton(onPressed: () => Navigator.pop(ctx, controller.text.trim()), child: const Text('متابعة')),
        ],
      ),
    );
    if (address != null && address.isNotEmpty) await _open(address);
  }

  Future<void> _delete(SmsThread t) async {
    if (!_status.isDefault) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('حذف المحادثات يتطلب أن يكون التطبيق هو تطبيق الرسائل الافتراضي')));
      return;
    }
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('حذف المحادثة؟'),
        content: Text('سيتم حذف كل الرسائل مع ${t.title} من الهاتف.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('إلغاء')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('حذف')),
        ],
      ),
    );
    if (ok == true) {
      await widget.repo.deleteThread(t.threadId);
      _load();
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(
        title: const Text('الرسائل'),
        actions: [
          if (!_loading && _status.canRead && !_status.canReadContacts && widget.checkPermissions)
            IconButton(
              tooltip: 'عرض أسماء جهات الاتصال',
              icon: const Icon(Icons.contacts_outlined),
              onPressed: () async {
                await Permission.contacts.request();
                await _load();
              },
            ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _newMessage,
        icon: const Icon(Icons.edit),
        label: const Text('رسالة جديدة'),
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          padding: const EdgeInsets.only(bottom: 96),
          children: [
            if (!_loading && !_status.isDefault)
              Card(
                margin: const EdgeInsets.fromLTRB(16, 12, 16, 4),
                color: theme.colorScheme.primaryContainer,
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Text(
                        'اجعل Veta تطبيق الرسائل الافتراضي',
                        style: theme.textTheme.titleMedium?.copyWith(color: theme.colorScheme.onPrimaryContainer),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        'لتستقبل الرسائل هنا مع الإشعارات، وتحذف المحادثات، وتظهر كل الرسائل المرسلة.',
                        style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onPrimaryContainer),
                      ),
                      const SizedBox(height: 8),
                      FilledButton(onPressed: widget.repo.requestDefault, child: const Text('تعيين كتطبيق افتراضي')),
                      TextButton(
                        onPressed: widget.checkPermissions ? openAppSettings : null,
                        child: const Text('لا تظهر النافذة؟ اسمح بالإعدادات المقيدة من إعدادات التطبيق'),
                      ),
                    ],
                  ),
                ),
              ),
            if (!_loading && !_status.canRead)
              Card(
                margin: const EdgeInsets.fromLTRB(16, 12, 16, 4),
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      const Text('نحتاج صلاحية قراءة الرسائل لعرض محادثاتك.'),
                      const SizedBox(height: 8),
                      FilledButton.tonal(onPressed: _requestPermissions, child: const Text('منح الصلاحية')),
                    ],
                  ),
                ),
              ),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.all(16),
                child: Text(_error!, style: TextStyle(color: theme.colorScheme.error)),
              ),
            if (_loading)
              const Padding(
                padding: EdgeInsets.all(32),
                child: Center(child: CircularProgressIndicator()),
              ),
            if (!_loading && _status.canRead && _threads.isEmpty)
              const Padding(
                padding: EdgeInsets.all(48),
                child: Center(child: Text('لا توجد رسائل')),
              ),
            for (final t in _threads)
              ListTile(
                onTap: () => _open(t.address, threadId: t.threadId, name: t.name),
                onLongPress: () => _delete(t),
                leading: CircleAvatar(
                  backgroundColor: theme.colorScheme.secondaryContainer,
                  child: (t.name?.isNotEmpty ?? false)
                      ? Text(t.name!.characters.first)
                      : const Icon(Icons.person_outline),
                ),
                title: Text(
                  t.title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  textDirection: (t.name?.isNotEmpty ?? false) ? null : TextDirection.ltr,
                  textAlign: TextAlign.start,
                  style: t.unread > 0 ? const TextStyle(fontWeight: FontWeight.bold) : null,
                ),
                subtitle: Text(
                  '${t.lastBox == SmsBox.inbox ? '' : 'أنت: '}${t.snippet}',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: t.unread > 0 ? TextStyle(color: theme.colorScheme.onSurface) : null,
                ),
                trailing: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    Text(formatSmsDate(t.date), style: theme.textTheme.bodySmall),
                    if (t.unread > 0) ...[const SizedBox(height: 4), Badge(label: Text('${t.unread}'))],
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}
