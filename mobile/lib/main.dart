import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';

import 'src/app_shell.dart';
import 'src/gateway.dart';
import 'src/sms/sms_repository.dart';

void main() {
  runZonedGuarded(
    () {
      // must run before anything touches platform channels
      WidgetsFlutterBinding.ensureInitialized();
      // show errors as readable text instead of a blank/black screen
      ErrorWidget.builder = (details) => _StartupError(details.exceptionAsString());
      final gateway = NativeGateway();
      final sms = NativeSmsRepository();
      runApp(
        GatewayApp(
          gateway: gateway,
          home: AppShell(gateway: gateway, sms: sms),
        ),
      );
    },
    (error, stack) {
      debugPrint('Uncaught: $error\n$stack');
      runApp(_StartupError('$error'));
    },
  );
}

class _StartupError extends StatelessWidget {
  const _StartupError(this.message);
  final String message;

  @override
  Widget build(BuildContext context) => Directionality(
    textDirection: TextDirection.ltr,
    child: Container(
      color: const Color(0xFFFFFFFF),
      padding: const EdgeInsets.fromLTRB(16, 48, 16, 16),
      child: Text(
        'حدث خطأ في التطبيق / App error:\n\n$message',
        style: const TextStyle(color: Color(0xFFB91C1C), fontSize: 14, decoration: TextDecoration.none),
      ),
    ),
  );
}

class GatewayApp extends StatelessWidget {
  const GatewayApp({super.key, required this.gateway, required this.home});

  final Gateway gateway;
  final Widget home;

  @override
  Widget build(BuildContext context) {
    ThemeData theme(Brightness b) => ThemeData(
      useMaterial3: true,
      colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF0F766E), brightness: b),
    );
    return MaterialApp(
      title: 'Veta SMS',
      debugShowCheckedModeBanner: false,
      theme: theme(Brightness.light),
      darkTheme: theme(Brightness.dark),
      locale: const Locale('ar'),
      supportedLocales: const [Locale('ar'), Locale('en')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      home: home,
    );
  }
}
