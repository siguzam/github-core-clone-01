// How this entry talks to the trial environment. The program starts the forge
// on a port the kernel picks, tells the environment which port that is, and
// then keeps asking the environment whether the trial has finished. When the
// environment answers yes, the program shuts the server down and leaves.
//
// The sequence, in order:
//   - read MAKEFUN_ENV_URL; an empty value means there is no environment, so
//     the program gives up right away with status 1.
//   - build the server and let it listen on port 0, so the kernel hands out
//     a free port. Port 8080 is never used here: it belongs to the env.
//   - POST the chosen port to <env>/register, retrying until the env takes
//     it. A 200 or a 409 both count as accepted; a 400 or 405 is a contract
//     error and ends the run; anything else is retried.
//   - GET <env>/done again and again until the answer is {"done": true}.
//   - close the server and exit 0.

import { createApp } from "./app.ts";

// The env origin, with any trailing slashes removed.
const envOrigin = (process.env.MAKEFUN_ENV_URL ?? "").replace(/\/+$/, "");
if (envOrigin.length === 0) {
  process.stderr.write("[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n");
  process.exit(1);
}

// One request may take at most this long before it is dropped and retried.
const REQUEST_BUDGET_MS = 30_000;
// Backoff starts here and doubles after each failure, up to a ceiling.
const BACKOFF_FIRST_MS = 250;
const BACKOFF_CEILING_MS = 2_000;

const pause = (ms: number): Promise<void> =>
  new Promise((wake) => setTimeout(wake, ms));

// How long to wait after `failures` failed attempts: exponential, capped.
function backoffFor(failures: number): number {
  const exponent = Math.min(failures, 8);
  return Math.min(BACKOFF_CEILING_MS, BACKOFF_FIRST_MS * 2 ** exponent);
}

// Tell the env which port the server bound, retrying until it is accepted.
// A 200 means the env recorded the port; a 409 means another entry already
// registered first, which is fine too. A 400 or 405 is a contract error and
// stops the program; any other failure is retried, since the env may still
// be coming up.
async function announcePort(port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const reply = await fetch(`${envOrigin}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
      });
      if (reply.status === 200 || reply.status === 409) return;
      if (reply.status === 400 || reply.status === 405) {
        throw new Error(`register answered HTTP ${reply.status}: ${await reply.text()}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("register answered HTTP ")) {
        throw error;
      }
    }
    await pause(backoffFor(failures));
    failures += 1;
  }
}

// Ask the env whether the trial is over, and keep asking until it says yes.
// A request that fails or times out just means "not yet": it is retried.
async function waitUntilDone(): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const reply = await fetch(`${envOrigin}/done`, {
        signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
      });
      if (reply.ok) {
        const payload = (await reply.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // The env is not answering, or the request timed out: poll again.
    }
    await pause(backoffFor(failures));
    failures += 1;
  }
}

// Start the server, announce its port, wait for the trial to end, then stop.
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((ready, failed) => {
    server.once("error", failed);
    server.listen(0, () => ready());
  });
  const bound = server.address();
  if (bound === null || typeof bound === "string") {
    throw new Error("the server did not bind an ephemeral TCP port");
  }
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);

  await announcePort(bound.port);
  process.stdout.write("[entry] registered; waiting for the env to say done\n");

  await waitUntilDone();
  server.close();
  process.stdout.write("[entry] done\n");
}

try {
  await run();
  process.exit(0);
} catch (error) {
  process.stderr.write(`[entry] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
