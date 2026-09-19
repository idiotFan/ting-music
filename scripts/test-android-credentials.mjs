// Run after building/installing the matching debug app and instrumentation APK.
// Uses isolated synthetic records, never logs in/out of either real account.
import { execFileSync } from 'node:child_process';

const serial = process.argv[2] || process.env.ANDROID_SERIAL;
if (!serial) throw new Error('Usage: node scripts/test-android-credentials.mjs <adb-device-serial>');
const testClass = 'com.ting.music.demo.CredentialStoreTest';
const runner = 'com.ting.music.demo.test/androidx.test.runner.AndroidJUnitRunner';
function run(methods, phase) {
  const args = ['-s', serial, 'shell', 'am', 'instrument', '-w', '-r',
    '-e', 'class', methods.map(method => `${testClass}#${method}`).join(',')];
  if (phase) args.push('-e', 'phase', phase);
  const output = execFileSync('adb', [...args, runner], {
    encoding: 'utf8', timeout: 60_000,
  });
  // `am instrument` can exit zero even when assertions fail.
  if (!output.includes(`OK (${methods.length} test`) || /FAILURES|INSTRUMENTATION_FAILED/.test(output)) {
    throw new Error(output);
  }
  console.log(`Passed: ${methods.join(', ')}`);
}

run(['encryptedRoundTripAndIndependentLogout', 'tamperFailsWithoutErasingRecord',
  'providerSwapFailsAuthentication', 'failedWriteRetainsPreviousRecord',
  'missingKeyDoesNotEraseOrRegenerateOnRead']);
run(['seedAcrossProcess'], 'seed');
// Separate instrumentation invocations start separate application processes;
// the test asserts their PIDs differ and reads both previously written records.
run(['restoreAcrossProcess'], 'restore');
