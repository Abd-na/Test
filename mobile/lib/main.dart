import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';

import 'src/app_shell.dart';
import 'src/gateway.dart';
import 'src/sms/sms_repository.dart';

void main() {
  final gateway = NativeGateway();
  final sms = NativeSmsRepository();
  runApp(
    GatewayApp(
      gateway: gateway,
      home: AppShell(gateway: gateway, sms: sms),
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
