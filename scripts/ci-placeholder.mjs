const command = process.argv[2];
const allowedCommands = new Set(["integration", "contract", "e2e"]);

if (!allowedCommands.has(command)) {
  console.error(`Unknown CI placeholder command: ${command ?? "(empty)"}`);
  process.exit(1);
}

console.log(`${command}: placeholder job for M0 scaffold; no implementation yet.`);
