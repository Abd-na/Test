import 'dart:async';

import 'package:flutter/material.dart';

import 'gateway.dart';
import 'home_screen.dart';
import 'sms/conversation_screen.dart';
import 'sms/inbox_screen.dart';
import 'sms/sms_models.dart';
import 'sms/sms_repository.dart';

/// Two tabs: the messaging app and the gateway status.
class AppShell extends StatefulWidget {
  const AppShell({super.key, required this.gateway, required this.sms, this.checkPermissions = true});

  final Gateway gateway;
  final SmsRepository sms;
  final bool checkPermissions;

  @override
  State<AppShell> createState() => _AppShellState();
}

class _AppShellState extends State<AppShell> {
  int _tab = 0;
  StreamSubscription<OpenRequest>? _openSub;

  @override
  void initState() {
    super.initState();
    _openSub = widget.sms.openRequests.listen(_openConversation);
    // launched from a notification or an sms: link
    widget.sms
        .consumeOpenRequest()
        .then((req) {
          if (req != null) _openConversation(req);
        })
        .catchError((_) {});
  }

  @override
  void dispose() {
    _openSub?.cancel();
    super.dispose();
  }

  void _openConversation(OpenRequest req) {
    if (!mounted || req.address.isEmpty) return;
    setState(() => _tab = 0);
    Navigator.of(context).popUntil((r) => r.isFirst);
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => ConversationScreen(repo: widget.sms, address: req.address, draft: req.body),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: IndexedStack(
        index: _tab,
        children: [
          InboxScreen(repo: widget.sms, checkPermissions: widget.checkPermissions),
          HomeScreen(gateway: widget.gateway, checkPermissions: widget.checkPermissions),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        destinations: const [
          NavigationDestination(
            icon: Icon(Icons.chat_bubble_outline),
            selectedIcon: Icon(Icons.chat_bubble),
            label: 'الرسائل',
          ),
          NavigationDestination(icon: Icon(Icons.router_outlined), selectedIcon: Icon(Icons.router), label: 'البوابة'),
        ],
      ),
    );
  }
}
