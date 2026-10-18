#!/usr/bin/env bash
# Launches the release APK on an emulator and reports what is on screen + errors.
# Runs inside reactivecircus/android-emulator-runner.
set -uo pipefail
APK="$1"
PKG=com.veta.smsgateway

echo "::group::APK signing certificate"
keytool -printcert -jarfile "$APK" | grep -E "SHA256|Owner" || true
echo "::endgroup::"

adb install -r "$APK" || { echo "INSTALL FAILED"; exit 1; }

report() {
  local name="$1"
  echo "================ SCENARIO: $name ================"
  adb logcat -c
  adb shell am force-stop "$PKG"
  adb shell am start -W -n "$PKG/.MainActivity" | sed 's/^/am: /'
  sleep 20
  adb exec-out screencap -p > "screen-$name.png"
  python3 - "screen-$name.png" <<'PY'
import struct, sys, zlib
data = open(sys.argv[1], 'rb').read()
# minimal PNG decode (8-bit RGBA, no interlace) to measure how much of the screen is black
pos, w, h, idat = 8, 0, 0, b''
while pos < len(data):
    ln, typ = struct.unpack('>I4s', data[pos:pos+8]); body = data[pos+8:pos+8+ln]; pos += 12 + ln
    if typ == b'IHDR': w, h, depth, ctype = struct.unpack('>IIBB', body[:10])
    elif typ == b'IDAT': idat += body
raw = zlib.decompress(idat); bpp = 4; stride = w * bpp
prev = bytearray(stride); black = total = 0; i = 0
for y in range(h):
    f = raw[i]; line = bytearray(raw[i+1:i+1+stride]); i += 1 + stride
    for x in range(stride):
        a = line[x-bpp] if x >= bpp else 0; b = prev[x]; c = prev[x-bpp] if x >= bpp else 0
        if f == 1: line[x] = (line[x] + a) & 255
        elif f == 2: line[x] = (line[x] + b) & 255
        elif f == 3: line[x] = (line[x] + (a + b) // 2) & 255
        elif f == 4:
            p = a + b - c; pa, pb, pc = abs(p-a), abs(p-b), abs(p-c)
            line[x] = (line[x] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
    prev = line
    if y % 8 == 0:
        for x in range(0, stride, bpp * 8):
            total += 1
            if line[x] < 20 and line[x+1] < 20 and line[x+2] < 20: black += 1
print(f"SCREEN {w}x{h}: {100*black/total:.0f}% black pixels")
PY
  echo "--- visible text (uiautomator) ---"
  adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
  adb shell cat /sdcard/ui.xml 2>/dev/null | grep -o -E '(text|content-desc)="[^"]+"' | head -40
  echo "--- top activity ---"
  adb shell dumpsys activity activities | grep -E "topResumedActivity|mResumedActivity" | head -3
  echo "--- errors ---"
  adb logcat -d -v brief | grep -E "AndroidRuntime|FATAL|flutter|$PKG|E/Flutter|Exception|Error" | grep -v -E "chatty|GoogleApiManager|Finsky|gms" | tail -120
}

report fresh

adb shell pm grant "$PKG" android.permission.READ_SMS
adb shell pm grant "$PKG" android.permission.SEND_SMS
adb shell pm grant "$PKG" android.permission.RECEIVE_SMS
adb shell pm grant "$PKG" android.permission.READ_PHONE_STATE
adb shell pm grant "$PKG" android.permission.POST_NOTIFICATIONS || true
# a few messages in the SMS store
adb emu sms send 5551234 "Hello from the emulator"
adb emu sms send 5559876 "مرحبا من المحاكي"
sleep 5
report permissions

adb shell cmd role add-role-holder android.app.role.SMS "$PKG" 0 && echo "role SMS granted"
adb emu sms send 5551234 "Second message while default"
sleep 5
report default_sms_app
exit 0
