import 'dart:async';

import 'package:flutter/material.dart';
import 'package:permission_handler/permission_handler.dart';

import 'api.dart';
import 'gateway.dart';
import 'models.dart';
import 'scan_screen.dart';

typedef PairingVerifier = Future<String> Function(PairingData data);

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, required this.gateway, this.verify = verifyPairing, this.checkPermissions = true});

  final Gateway gateway;
  final PairingVerifier verify;

  /// Disabled in widget tests (no platform plugins there).
  final bool checkPermissions;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> with WidgetsBindingObserver {
  GatewaySnapshot _state = const GatewaySnapshot();
  StreamSubscription<GatewaySnapshot>? _sub;
  Map<Permission, PermissionStatus> _permissions = {};
  bool _batteryOk = true;
  bool _busy = false;

  static final _required = <Permission, String>{
    Permission.sms: 'إرسال واستقبال الرسائل',
    Permission.phone: 'معرفة الشرائح',
    Permission.notification: 'الإشعارات',
  };

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _sub = widget.gateway.snapshots.listen((s) => setState(() => _state = s));
    widget.gateway.current().then((s) {
      if (mounted) setState(() => _state = s);
    });
    _refreshSetup();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _refreshSetup();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _sub?.cancel();
    super.dispose();
  }

  Future<void> _refreshSetup() async {
    if (!widget.checkPermissions) return;
    final statuses = {for (final p in _required.keys) p: await p.status};
    final battery = await widget.gateway.isIgnoringBatteryOptimizations();
    if (!mounted) return;
    setState(() {
      _permissions = statuses;
      _batteryOk = battery;
    });
  }

  bool get _smsGranted => !widget.checkPermissions || (_permissions[Permission.sms]?.isGranted ?? false);

  Future<void> _requestPermissions() async {
    await _required.keys.toList().request();
    await _refreshSetup();
  }

  void _toast(String msg) => ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));

  Future<void> _pair(PairingData data) async {
    setState(() => _busy = true);
    try {
      final name = await widget.verify(data);
      await widget.gateway.savePairing(data, name);
      _toast('تم الربط بنجاح ✓');
      if (!_smsGranted) await _requestPermissions();
      if (_smsGranted) await widget.gateway.setEnabled(true);
    } on PairingException catch (e) {
      _toast('فشل الربط: ${e.message}');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _scan() async {
    if (widget.checkPermissions && !await Permission.camera.request().isGranted) {
      _toast('نحتاج صلاحية الكاميرا لمسح الرمز');
      return;
    }
    if (!mounted) return;
    final data = await Navigator.of(context).push<PairingData>(MaterialPageRoute(builder: (_) => const ScanScreen()));
    if (data != null) await _pair(data);
  }

  Future<void> _manual() async {
    final url = TextEditingController(text: _state.serverUrl);
    final token = TextEditingController();
    final data = await showDialog<PairingData>(
      context: context,
      builder: (ctx) {
        String? error;
        return StatefulBuilder(
          builder: (ctx, setLocal) => AlertDialog(
            title: const Text('إدخال يدوي'),
            content: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextField(
                  controller: url,
                  keyboardType: TextInputType.url,
                  textDirection: TextDirection.ltr,
                  decoration: const InputDecoration(labelText: 'رابط السيرفر', hintText: 'https://msg.example.com'),
                ),
                const SizedBox(height: 8),
                TextField(
                  controller: token,
                  textDirection: TextDirection.ltr,
                  autocorrect: false,
                  decoration: InputDecoration(labelText: 'رمز الجهاز', hintText: 'vmd_...', errorText: error),
                ),
              ],
            ),
            actions: [
              TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('إلغاء')),
              FilledButton(
                onPressed: () {
                  final d = PairingData.tryCreate(url.text, token.text);
                  if (d == null) {
                    setLocal(() => error = 'تحقق من الرابط (يبدأ بـ https://) ومن رمز الجهاز');
                  } else {
                    Navigator.pop(ctx, d);
                  }
                },
                child: const Text('ربط'),
              ),
            ],
          ),
        );
      },
    );
    if (data != null) await _pair(data);
  }

  Future<void> _toggle(bool on) async {
    if (on && !_smsGranted) {
      _toast('امنح صلاحية الرسائل أولاً');
      await _requestPermissions();
      if (!_smsGranted) return;
    }
    await widget.gateway.setEnabled(on);
  }

  Future<void> _testSms() async {
    final controller = TextEditingController();
    final to = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('رسالة تجريبية'),
        content: TextField(
          controller: controller,
          keyboardType: TextInputType.phone,
          textDirection: TextDirection.ltr,
          decoration: const InputDecoration(labelText: 'رقم المستلم', hintText: '+9647701234567'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('إلغاء')),
          FilledButton(onPressed: () => Navigator.pop(ctx, controller.text.trim()), child: const Text('إرسال')),
        ],
      ),
    );
    if (to == null || to.isEmpty) return;
    try {
      final sim = await widget.gateway.sendTestSms(to);
      _toast('أُرسلت للشبكة عبر $sim — تابع النتيجة في سجل النشاط');
    } catch (e) {
      _toast('فشل الإرسال: ${e.toString().replaceFirst('Exception: ', '')}');
    }
  }

  Future<void> _unpair() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('إلغاء الربط؟'),
        content: const Text('سيتوقف الهاتف عن إرسال الرسائل حتى تربطه من جديد.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('رجوع')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('إلغاء الربط')),
        ],
      ),
    );
    if (ok == true) await widget.gateway.unpair();
  }

  @override
  Widget build(BuildContext context) {
    final s = _state;
    return Scaffold(
      appBar: AppBar(title: const Text('Veta SMS Gateway')),
      body: RefreshIndicator(
        onRefresh: _refreshSetup,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            _StatusCard(state: s, onToggle: s.paired && !_busy ? _toggle : null),
            const SizedBox(height: 12),
            _PairingCard(state: s, busy: _busy, onScan: _scan, onManual: _manual, onUnpair: _unpair),
            if (widget.checkPermissions) ...[
              const SizedBox(height: 12),
              _SetupCard(
                labels: _required,
                permissions: _permissions,
                batteryOk: _batteryOk,
                onRequest: _requestPermissions,
                onBattery: () async {
                  await widget.gateway.requestIgnoreBatteryOptimizations();
                },
              ),
            ],
            const SizedBox(height: 12),
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text('اختبار الشريحة', style: Theme.of(context).textTheme.titleMedium),
                    const SizedBox(height: 4),
                    Text(
                      'يرسل SMS مباشرة من هذا الهاتف (بدون السيرفر) للتأكد أن الشريحة والصلاحيات تعمل.',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                    const SizedBox(height: 8),
                    OutlinedButton.icon(
                      onPressed: _testSms,
                      icon: const Icon(Icons.sms_outlined),
                      label: const Text('إرسال رسالة تجريبية'),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 12),
            _LogCard(lines: s.log),
          ],
        ),
      ),
    );
  }
}

class _StatusCard extends StatelessWidget {
  const _StatusCard({required this.state, required this.onToggle});

  final GatewaySnapshot state;
  final ValueChanged<bool>? onToggle;

  @override
  Widget build(BuildContext context) {
    final (label, color) = switch (state.status) {
      GatewayStatus.online => ('متصلة وجاهزة للإرسال', Colors.green.shade600),
      GatewayStatus.connecting => ('جارٍ الاتصال…', Colors.amber.shade700),
      GatewayStatus.error => ('خطأ', Colors.red.shade600),
      GatewayStatus.stopped => ('متوقفة', Colors.grey),
    };
    final theme = Theme.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Container(
                  width: 12,
                  height: 12,
                  decoration: BoxDecoration(color: color, shape: BoxShape.circle),
                ),
                const SizedBox(width: 8),
                Expanded(child: Text(label, style: theme.textTheme.titleMedium)),
                Switch(value: state.enabled, onChanged: onToggle),
              ],
            ),
            if (state.detail.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(state.detail, style: theme.textTheme.bodySmall),
              ),
            if (state.paired && !state.canSendSms)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  '⚠ صلاحية إرسال الرسائل غير ممنوحة، لن تُرسل أي رسالة',
                  style: theme.textTheme.bodyMedium?.copyWith(color: theme.colorScheme.error),
                ),
              ),
            const SizedBox(height: 12),
            Row(
              children: [
                _Stat(label: 'أُرسلت', value: state.sent),
                _Stat(label: 'فشلت', value: state.failed),
                _Stat(label: 'استُلمت', value: state.received),
                _Stat(label: 'بانتظار الرفع', value: state.pending),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _Stat extends StatelessWidget {
  const _Stat({required this.label, required this.value});
  final String label;
  final int value;

  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: Column(
        children: [
          Text('$value', style: Theme.of(context).textTheme.titleLarge),
          Text(label, style: Theme.of(context).textTheme.bodySmall, textAlign: TextAlign.center),
        ],
      ),
    );
  }
}

class _PairingCard extends StatelessWidget {
  const _PairingCard({
    required this.state,
    required this.busy,
    required this.onScan,
    required this.onManual,
    required this.onUnpair,
  });

  final GatewaySnapshot state;
  final bool busy;
  final VoidCallback onScan;
  final VoidCallback onManual;
  final VoidCallback onUnpair;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('الربط مع السيرفر', style: theme.textTheme.titleMedium),
            const SizedBox(height: 4),
            Text(
              state.paired
                  ? 'مربوط بـ ${state.serverUrl}\nالجهاز: ${state.deviceName.isEmpty ? '—' : state.deviceName}'
                  : 'الهاتف غير مربوط. أنشئ هاتفاً من لوحة التحكم وامسح رمز QR.',
              style: theme.textTheme.bodySmall,
            ),
            const SizedBox(height: 12),
            if (busy) const LinearProgressIndicator(),
            FilledButton.icon(
              onPressed: busy ? null : onScan,
              icon: const Icon(Icons.qr_code_scanner),
              label: const Text('مسح رمز QR'),
            ),
            const SizedBox(height: 8),
            OutlinedButton.icon(
              onPressed: busy ? null : onManual,
              icon: const Icon(Icons.keyboard),
              label: const Text('إدخال يدوي'),
            ),
            if (state.paired)
              TextButton.icon(
                onPressed: busy ? null : onUnpair,
                icon: const Icon(Icons.link_off),
                label: const Text('إلغاء الربط'),
              ),
          ],
        ),
      ),
    );
  }
}

class _SetupCard extends StatelessWidget {
  const _SetupCard({
    required this.labels,
    required this.permissions,
    required this.batteryOk,
    required this.onRequest,
    required this.onBattery,
  });

  final Map<Permission, String> labels;
  final Map<Permission, PermissionStatus> permissions;
  final bool batteryOk;
  final VoidCallback onRequest;
  final VoidCallback onBattery;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final missing = labels.keys.where((p) => !(permissions[p]?.isGranted ?? false)).toList();
    Widget line(bool ok, String text) => Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        children: [
          Icon(
            ok ? Icons.check_circle : Icons.error_outline,
            size: 18,
            color: ok ? Colors.green.shade600 : Colors.amber.shade800,
          ),
          const SizedBox(width: 8),
          Expanded(child: Text(text, style: theme.textTheme.bodyMedium)),
        ],
      ),
    );
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('الإعداد', style: theme.textTheme.titleMedium),
            const SizedBox(height: 8),
            for (final e in labels.entries) line(permissions[e.key]?.isGranted ?? false, e.value),
            line(batteryOk, batteryOk ? 'مستثنى من تحسين البطارية' : 'يُنصح بإيقاف تحسين البطارية حتى لا يتوقف'),
            const SizedBox(height: 8),
            if (missing.isNotEmpty) FilledButton.tonal(onPressed: onRequest, child: const Text('منح الصلاحيات')),
            if (!(permissions[Permission.sms]?.isGranted ?? false)) ...[
              const SizedBox(height: 8),
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: theme.colorScheme.errorContainer,
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Text(
                  'بدون صلاحية الرسائل لن يُرسل الهاتف أي SMS.\n'
                  'إذا لم تظهر نافذة الصلاحية أو ظهرت رسالة "إعداد مقيَّد" (أندرويد 13 وما بعده للتطبيقات المثبتة من ملف APK):\n'
                  '1) افتح إعدادات التطبيق بالزر أدناه\n'
                  '2) اضغط ⋮ في الأعلى ← "السماح بالإعدادات المقيدة"\n'
                  '3) ارجع إلى "الأذونات" ← الرسائل القصيرة ← سماح\n'
                  'في هواتف شاومي: الأذونات ← أذونات أخرى ← "إرسال الرسائل" ← سماح.',
                  style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onErrorContainer),
                ),
              ),
              TextButton(onPressed: openAppSettings, child: const Text('فتح إعدادات التطبيق')),
            ],
            if (!batteryOk) FilledButton.tonal(onPressed: onBattery, child: const Text('إيقاف تحسين البطارية')),
          ],
        ),
      ),
    );
  }
}

class _LogCard extends StatelessWidget {
  const _LogCard({required this.lines});
  final List<String> lines;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('النشاط', style: theme.textTheme.titleMedium),
            const SizedBox(height: 8),
            if (lines.isEmpty) Text('لا يوجد نشاط بعد', style: theme.textTheme.bodySmall),
            for (final l in lines.take(50))
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 2),
                child: Text(l, style: theme.textTheme.bodySmall?.copyWith(fontFamily: 'monospace')),
              ),
          ],
        ),
      ),
    );
  }
}
