// The campaign checks create campaigns in the shared database and "crash"
// send loops on purpose. A backend running against the same database has a
// minute-by-minute recovery sweep that takes those campaigns over (and,
// lacking the checks' fake tokens, pauses them) — results then depend on
// timing. So the checks refuse to run while one is up.
const net = require("net");

function backendIsUp(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port: Number(port), host: "127.0.0.1" });
    socket.setTimeout(1000);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => resolve(false));
  });
}

async function requireNoLiveBackend() {
  const port = process.env.PORT || 8000;
  if (await backendIsUp(port)) {
    console.log(`\x1b[33mRefusing to run: a backend is listening on port ${port}.\x1b[0m`);
    console.log("\x1b[90mIts recovery sweep would take over this check's campaigns. Stop it, run the check, then start it again.\x1b[0m");
    process.exit(2);
  }
}

module.exports = { requireNoLiveBackend };
