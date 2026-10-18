import 'package:flutter_test/flutter_test.dart';
import 'package:veta_sms_gateway/src/gateway.dart';
import 'package:veta_sms_gateway/src/sms/sms_repository.dart';

// Regression: main() builds these before runApp(). Constructing them must not
// touch platform channels, or release builds die before the first frame
// (black screen).
void main() {
  test('native bridges can be created before the Flutter binding exists', () {
    expect(NativeGateway.new, returnsNormally);
    expect(NativeSmsRepository.new, returnsNormally);
  });
}
