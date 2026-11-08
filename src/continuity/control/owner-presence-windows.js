// The Windows owner-presence broker — spec V6.1.6-A.2.
//
// A tiny host-owned helper whose SOLE capability is: receive a host challenge,
// open the Windows verification UI, return what Windows said.
//
// It deliberately holds no authority store, no exception store, no HTTP
// listener, no network capability, no dispatch and no executor. The browser
// never invokes it — the privileged parent spawns it directly and reads the
// result over the parent/child channel.
//
// Two Windows APIs matter and they behave very differently:
//
//   CheckAvailabilityAsync   NON-interactive. Reports whether a verifier
//                            exists and is configured. Safe to call from an
//                            unattended tick.
//   RequestVerificationAsync INTERACTIVE. Opens the Windows Hello / PIN /
//                            fingerprint dialog. Never called from an
//                            unattended tick.
//
// Everything below keeps that separation explicit, because calling the second
// one by accident means putting a dialog in front of someone who did not ask
// for it.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";

/** Windows' own availability vocabulary, mapped to ours. */
const AVAILABILITY_MAP = {
  Available: "available",
  DeviceNotPresent: "unavailable",
  NotConfiguredForUser: "not_configured",
  DisabledByPolicy: "disabled",
  DeviceBusy: "unavailable",
};

const PS_PRELUDE = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
})[0]
`;

/**
 * How many times this process has actually reached the device.
 *
 * Counted HERE because here is the only place it can be counted honestly. An
 * external harness cannot do it: this module reaches PowerShell through an ESM
 * named import, and Node's builtin named exports do not follow mutation of the
 * CommonJS export object — so a reporter that patched `childProcess.execFile`
 * read zero whether or not anything called the device. A measurement that
 * cannot fail is not a measurement.
 *
 * It is a plain counter, not a policy. Nothing reads it to decide anything;
 * governance reporting reads it to state a fact it would otherwise be guessing.
 */
let deviceInvocations = 0;
export function deviceInvocationCount() { return deviceInvocations; }

/**
 * The process runner, injectable ONLY for measurement.
 *
 * Production passes nothing and gets `execFile`. A test may pass a counting or
 * refusing runner to prove the boundary works without putting a dialog on her
 * screen.
 */
const defaultRunner = (command, args, options, callback) =>
  execFile(command, args, options, callback);

const run = (script, timeoutMs, runner = defaultRunner) => new Promise((resolve) => {
  deviceInvocations += 1;
  runner(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { timeout: timeoutMs, windowsHide: true },
    (error, stdout) => resolve({ error, stdout: String(stdout || "").trim() }),
  );
});

/**
 * Build the Windows broker.
 *
 * `allowInteractive` gates the ONLY call that can put a dialog on screen. It
 * defaults to false so that importing this module, probing it, or running it in
 * CI cannot prompt anyone. A caller that genuinely has an owner in front of it
 * opts in explicitly.
 */
export function createWindowsOwnerPresenceBroker({ allowInteractive = false, timeoutMs = 60000, runner = defaultRunner } = {}) {
  return {
    platform: "windows",
    // Structural: this object exposes nothing but the two calls below.
    holdsAuthority: false,

    /** NON-interactive. Safe from an unattended tick. */
    async availability() {
      if (process.platform !== "win32") return "unavailable";
      const { error, stdout } = await run(`${PS_PRELUDE}
try {
  $op = [Windows.Security.Credentials.UI.UserConsentVerifier,Windows.Security.Credentials.UI,ContentType=WindowsRuntime]::CheckAvailabilityAsync()
  $task = $asTask.MakeGenericMethod([Windows.Security.Credentials.UI.UserConsentVerifierAvailability]).Invoke($null, @($op))
  $null = $task.Wait(10000)
  Write-Output $task.Result
} catch { Write-Output "Error" }`, 20000, runner);

      if (error) return "error";
      return AVAILABILITY_MAP[stdout] ?? "error";
    },

    /**
     * INTERACTIVE. Opens the Windows verification dialog.
     *
     * Refuses unless the caller explicitly opted in, so an unattended tick
     * cannot surprise her with a prompt. The challenge is echoed back so the
     * parent can tell its own verification from one some other process caused.
     */
    async verify({ challenge, purpose }) {
      if (!allowInteractive) {
        return { challenge, outcome: "failed", reason: "interactive verification was not permitted by the caller" };
      }
      if (process.platform !== "win32") {
        return { challenge, outcome: "unavailable", reason: "not a Windows host" };
      }
      // Single-quoted PowerShell literal with doubled quotes: the purpose is
      // host-derived, but it still never gets to terminate the string.
      const message = String(purpose || "Approve a DataScape owner action").replace(/'/g, "''");
      const { error, stdout } = await run(`${PS_PRELUDE}
try {
  $op = [Windows.Security.Credentials.UI.UserConsentVerifier,Windows.Security.Credentials.UI,ContentType=WindowsRuntime]::RequestVerificationAsync('${message}')
  $task = $asTask.MakeGenericMethod([Windows.Security.Credentials.UI.UserConsentVerificationResult]).Invoke($null, @($op))
  $null = $task.Wait(${timeoutMs})
  Write-Output $task.Result
} catch { Write-Output "Error" }`, timeoutMs + 10000, runner);

      if (error) return { challenge, outcome: "failed", reason: "the verifier broker did not complete" };
      const outcome = {
        Verified: "verified",
        Canceled: "cancelled",
        DeviceNotPresent: "unavailable",
        NotConfiguredForUser: "unavailable",
        DisabledByPolicy: "unavailable",
        DeviceBusy: "unavailable",
        RetriesExhausted: "failed",
      }[stdout] ?? "failed";
      return { challenge, outcome, raw: stdout };
    },
  };
}

/** Host-side challenge generation. Unforgeable, and never supplied by a caller. */
export function randomChallenge() {
  return `chal_${randomBytes(24).toString("hex")}`;
}

/**
 * A fake verifier for tests.
 *
 * Real Windows verification is never triggered in CI, so every automated test
 * drives this. It reproduces the parts that matter — the challenge echo and the
 * outcome vocabulary — and nothing about the dialog.
 */
export function createFakeOwnerPresenceBroker({ availability = "available", outcome = "verified", echoChallenge = true } = {}) {
  const calls = [];
  return {
    platform: "fake",
    holdsAuthority: false,
    calls,
    availability: async () => availability,
    verify: async ({ challenge, purpose }) => {
      calls.push({ challenge, purpose });
      return { challenge: echoChallenge ? challenge : "chal_someone_elses", outcome };
    },
  };
}
