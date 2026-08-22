// Standalone acceptance world for the ruling-tray E2E.
//
// Spins the REAL live-host server (fake broker, isolated temp store) and
// seeds it with exceptions whose ids MATCH three real blocked-on-owner items,
// so the production briefing JSON the SPA renders lines up with acts the
// server will accept. Prints the port and waits; Ctrl-C tears down.
import { acceptanceWorld, fixture } from "./prb-world.mjs";

const world = await acceptanceWorld();
world.broker.outcomeValue = "verified";
world.broker.echoChallenge = true;

for (const id of process.argv.slice(2)) fixture(world, { id });

console.log(JSON.stringify({ port: world.port, inbox: world.inbox }));

// report state on demand so the driver can assert server-side effects
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 60000);
