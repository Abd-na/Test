import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';

import 'src/gateway.dart';
import 'src/home_screen.dart';

void main() => runApp(GatewayApp(gateway: NativeGateway()));

class GatewayApp extends StatelessWidget {
  const GatewayApp({super.key, required this.gateway, this.home});

  final Gateway gateway;
  final Widget? home;

  @override
  Widget build(BuildContext context) {
    ThemeData theme(Brightness b) => ThemeData(
      useMaterial3: true,
      colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF0F766E), brightness: b),
    );
    return MaterialApp(
      title: 'Veta SMS Gateway',
      debugShowCheckedModeBanner: false,
      theme: theme(Brightness.light),
      darkTheme: theme(Brightness.dark),
      locale: const Locale('ar'),
      supportedLocales: const [Locale('ar'), Locale('en')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      home: home ?? HomeScreen(gateway: gateway),
    );
  }
}
