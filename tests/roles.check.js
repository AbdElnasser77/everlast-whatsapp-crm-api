// Role / permission check.
//
// For every guarded endpoint this file states the ONE permission it should
// require. Expected access for each role is then derived from
// config/permissions.js — never typed out per role — and the real HTTP route is
// called as each role to confirm it agrees. So the check fails if a route
// enforces the wrong permission, forgets its guard, or goes back to a
// hard-coded "admin only" check.
//
// Every request is built so that, once past the permission guard, it fails
// harmlessly on validation (empty body -> 400) or on a nonexistent id (-> 404).
// Nothing is sent, created or deleted. The only thing that matters is whether
// the answer is 403 (denied by the guard) or anything else (let through).
//
// Runs the app in-process on a random port and signs short-lived tokens for
// three throwaway users, so it needs no running server and does not touch the
// login rate limiter. Throwaway users are removed in a finally block.
//
//   npm run check:roles

require("dotenv").config({ path: __dirname + "/../config.env", quiet: true });
const http = require("http");
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const prisma = require("../config/prisma");
const { roleHasPermission, ROLES } = require("../config/permissions");
const app = require("../app");

const RESET = "\x1b[0m", G = "\x1b[32m", R = "\x1b[31m", D = "\x1b[90m";
const NOPE = 999999999; // an id no row will ever have

// [method, path, permission it should require]
const ENDPOINTS = [
  // audit
  ["GET", "/api/audit", "audit:read"],
  // campaigns
  ["GET", "/api/campaigns", "campaign:read"],
  ["GET", "/api/campaigns/active-progress", "campaign:read"],
  ["GET", `/api/campaigns/${NOPE}`, "campaign:read"],
  ["GET", `/api/campaigns/${NOPE}/replies`, "campaign:read"],
  ["POST", "/api/campaigns", "campaign:write"],
  ["PUT", `/api/campaigns/${NOPE}`, "campaign:write"],
  ["DELETE", `/api/campaigns/${NOPE}`, "campaign:write"],
  ["POST", `/api/campaigns/${NOPE}/submit`, "campaign:write"],
  ["POST", `/api/campaigns/${NOPE}/refresh-audience`, "campaign:write"],
  ["POST", "/api/campaigns/test-send", "campaign:write"],
  ["POST", `/api/campaigns/${NOPE}/approve`, "campaign:send"],
  ["POST", `/api/campaigns/${NOPE}/reject`, "campaign:send"],
  ["POST", `/api/campaigns/${NOPE}/send`, "campaign:send"],
  ["POST", `/api/campaigns/${NOPE}/pause`, "campaign:control"],
  ["POST", `/api/campaigns/${NOPE}/resume`, "campaign:control"],
  ["POST", `/api/campaigns/${NOPE}/cancel`, "campaign:control"],
  ["POST", "/api/campaigns/bulk-delete", "campaign:control"],
  // contacts
  ["GET", "/api/customers", "contact:read"],
  ["GET", `/api/customers/${NOPE}`, "contact:read"],
  ["POST", "/api/customers", "contact:write"],
  ["PUT", `/api/customers/${NOPE}`, "contact:write"],
  ["DELETE", `/api/customers/${NOPE}`, "contact:delete"],
  ["POST", "/api/customers/bulk-delete", "contact:bulk_delete"],
  ["POST", "/api/customers/import/validate", "contact:import"],
  // lists
  ["GET", "/api/lists", "list:read"],
  ["GET", `/api/lists/${NOPE}`, "list:read"],
  ["POST", "/api/lists", "list:write"],
  ["PUT", `/api/lists/${NOPE}`, "list:write"],
  ["DELETE", `/api/lists/${NOPE}`, "list:write"],
  ["POST", `/api/lists/${NOPE}/members`, "list:write"],
  // segments (already on the permission model before this change)
  ["GET", "/api/segments", "segment:read"],
  ["POST", "/api/segments", "segment:write"],
  // templates
  ["GET", "/api/templates", "template:read"],
  ["POST", "/api/templates", "template:write"],
  ["PUT", `/api/templates/${NOPE}`, "template:write"],
  ["DELETE", `/api/templates/${NOPE}`, "template:write"],
  ["POST", `/api/templates/${NOPE}/submit`, "template:write"],
  ["POST", `/api/templates/conversations/${NOPE}/send-template`, "message:send"],
  // inbox
  ["GET", "/api/conversations", "conversation:read"],
  ["GET", "/api/conversations?view=unassigned", "conversation:read"],
  ["GET", "/api/conversations/counts", "conversation:read"],
  ["GET", `/api/conversations/${NOPE}/messages`, "conversation:read"],
  ["POST", "/api/conversations", "conversation:write"],
  ["POST", `/api/conversations/${NOPE}/read`, "conversation:write"],
  ["PUT", `/api/conversations/${NOPE}/status`, "conversation:write"],
  ["PUT", `/api/conversations/${NOPE}/assign`, "conversation:assign"],
  ["GET", "/api/messages/search", "conversation:read"],
  ["POST", "/api/messages/send", "message:send"],
  ["DELETE", `/api/messages/${NOPE}`, "message:delete_own"],
  // media
  ["GET", "/api/media-library", "media:read"],
  ["POST", "/api/media-library", "media:write"],
  ["PUT", `/api/media-library/${NOPE}`, "media:write"],
  ["DELETE", `/api/media-library/${NOPE}`, "media:write"],
  ["POST", "/api/media/upload", "media:upload"],
  // reporting
  ["GET", "/api/stats/overview", "stats:read"],
  // team
  ["GET", "/api/users", "user:read"],
  // The agent picker's list — open to anyone who can assign, which includes
  // agents, who don't hold user:read.
  ["GET", "/api/users/assignable", "conversation:assign"],
  ["GET", `/api/users/${NOPE}`, "user:read"],
  ["POST", "/api/users", "user:write"],
  ["PUT", `/api/users/${NOPE}`, "user:write"],
  ["PUT", `/api/users/${NOPE}/password`, "user:write"],
  ["DELETE", `/api/users/${NOPE}`, "user:write"],
  // whatsapp
  ["GET", "/api/whatsapp/my-numbers", "number:read"],
];

let pass = 0, fail = 0;
const failures = [];

function request(port, method, urlPath, token) {
  return new Promise((resolve, reject) => {
    const body = method === "GET" || method === "DELETE" ? null : "{}";
    const req = http.request(
      {
        host: "127.0.0.1", port, method, path: urlPath,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {}),
        },
      },
      (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// Static half: the role-name checks this change removed must not creep back.
function staticChecks() {
  const offenders = [];
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else if (f.name.endsWith(".js")) {
        // Comments stripped first: prose explaining the old approach is fine,
        // only code that still uses it is not.
        const src = fs
          .readFileSync(p, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/(^|[^:])\/\/.*$/gm, "$1");
        if (/requireRole\s*\(/.test(src)) offenders.push(`${p}: requireRole(...)`);
        if (/role\s*[!=]==\s*"(ADMIN|MARKETING|AGENT)"/.test(src)) offenders.push(`${p}: role name comparison`);
      }
    }
  };
  walk(path.join(__dirname, "../modules"));
  walk(path.join(__dirname, "../middleware"));
  return offenders;
}

async function main() {
  const offenders = staticChecks();
  if (offenders.length) {
    fail++;
    console.log(`${R}FAIL${RESET} authorization decided by role name instead of permission:`);
    offenders.forEach((o) => console.log(`       ${o}`));
  } else {
    pass++;
    console.log(`${G}PASS${RESET} no route or controller decides access by role name`);
  }

  const created = [];
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  try {
    const tokens = {};
    for (const role of ROLES) {
      const u = await prisma.user.create({
        data: { username: `rc_${role.toLowerCase()}`.slice(0, 20), passwordHash: "x", role },
      });
      created.push(u.id);
      tokens[role] = jwt.sign({ id: u.id }, process.env.JWT_SECRET, { expiresIn: "5m" });
    }

    for (const [method, urlPath, perm] of ENDPOINTS) {
      const row = [];
      let rowOk = true;
      for (const role of ROLES) {
        const expected = roleHasPermission(role, perm);
        const status = await request(port, method, urlPath, tokens[role]);
        const allowed = status !== 403;
        const ok = allowed === expected;
        if (!ok) {
          rowOk = false;
          failures.push(`${method} ${urlPath} as ${role}: expected ${expected ? "allowed" : "403"}, got ${status}`);
        }
        row.push(`${role.slice(0, 4)}:${allowed ? "✓" : "✗"}${ok ? "" : "!"}`);
      }
      if (rowOk) pass++; else fail++;
      console.log(`${rowOk ? G + "PASS" : R + "FAIL"}${RESET} ${method.padEnd(6)} ${urlPath.padEnd(48)} ${D}${perm.padEnd(20)} ${row.join("  ")}${RESET}`);
    }
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: created } } });
    await new Promise((r) => server.close(r));
  }

  if (failures.length) {
    console.log(`\n${R}Mismatches:${RESET}`);
    failures.forEach((f) => console.log(`  ${f}`));
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(`${R}Check crashed:${RESET}`, err);
  await prisma.$disconnect();
  process.exit(1);
});
