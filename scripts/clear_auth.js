import { execSync } from 'node:child_process';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const stateDir = process.env.WEBMODEL_STATE_DIR || join(homedir(), '.webmodel');
const profileDir = join(stateDir, 'chrome-profile');
const authFile = join(stateDir, 'auth.json');

console.log('==================================================');
console.log('🧹 Clearing web-model-bridge logins and database');
console.log(`State Directory: ${stateDir}`);
console.log('==================================================');

// 1. Terminate any dedicated Chrome instances using this profile
if (platform() === 'win32') {
  try {
    const rawPids = execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name = \'chrome.exe\'\\" | Where-Object { $_.CommandLine -like \'*webmodel*\' } | Select-Object -ExpandProperty ProcessId"',
      { encoding: 'utf-8' }
    ).trim();

    if (rawPids) {
      const pids = rawPids.split(/\r?\n/).map(p => p.trim()).filter(Boolean);
      for (const pid of pids) {
        console.log(`[*] Terminating dedicated Chrome instance (PID: ${pid})...`);
        try {
          execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
        } catch {
          // Process might have already exited
        }
      }
    }
  } catch (err) {
    // PowerShell query failed or no processes
  }
} else {
  try {
    execSync('pkill -f "chrome.*webmodel"', { stdio: 'ignore' });
  } catch {
    // No processes
  }
}

// Small wait for OS file locks to release
execSync('powershell -NoProfile -Command "Start-Sleep -Milliseconds 600"');

// 2. Remove auth.json
if (existsSync(authFile)) {
  try {
    writeFileSync(authFile, JSON.stringify({}, null, 2));
    console.log('[+] Reset auth.json to empty state ({})');
  } catch (err) {
    console.warn(`[-] Could not reset auth.json: ${err.message}`);
  }
} else {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(authFile, JSON.stringify({}, null, 2));
  console.log('[+] Created empty auth.json');
}

// 3. Wipe chrome-profile directory (cookies, sessions, localStorage, web databases)
if (existsSync(profileDir)) {
  console.log(`[*] Removing browser profile and cookie store: ${profileDir}`);
  try {
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
    console.log('[+] Successfully deleted chrome-profile');
  } catch (err) {
    console.warn(`[-] Could not delete directory completely: ${err.message}`);
    // Fallback: PowerShell remove
    try {
      execSync(`powershell -NoProfile -Command "Remove-Item -Recurse -Force -LiteralPath '${profileDir}'"`, { stdio: 'ignore' });
      console.log('[+] Successfully deleted chrome-profile via PowerShell fallback');
    } catch (e) {
      console.error(`[-] Failed to remove profile: ${e.message}`);
    }
  }
}

// Recreate clean empty directory
mkdirSync(profileDir, { recursive: true });
console.log('[+] Recreated clean, empty chrome-profile directory');

console.log('--------------------------------------------------');
console.log('✓ All logins, cookies, auth statuses, and databases have been wiped.');
console.log('You are now completely logged out from all providers.');
console.log('--------------------------------------------------\n');
