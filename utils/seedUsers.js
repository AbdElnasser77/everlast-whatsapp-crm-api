// One seed account per role (`npm run seed`), for development and for trying
// the app as each role. Idempotent: an existing username is left untouched —
// its password and role are never overwritten.
//
// These passwords are public (they are in this file). Change or deactivate the
// accounts before the app faces real users.
require("../config/env");
const prisma = require("../config/prisma");
const bcryptjs = require("bcryptjs");

const SEED_USERS = [
  { username: "admin", name: "Admin", role: "ADMIN", password: "Admin@1234" },
  { username: "marketing", name: "Marketing", role: "MARKETING", password: "Marketing@1234" },
  { username: "agent", name: "Agent", role: "AGENT", password: "Agent@1234" },
];

const seed = async () => {
  for (const u of SEED_USERS) {
    const existing = await prisma.user.findUnique({ where: { username: u.username } });
    if (existing) {
      console.log(`${u.role.padEnd(9)} ${u.username.padEnd(10)} already exists — skipped`);
      continue;
    }
    const passwordHash = await bcryptjs.hash(u.password, 12);
    await prisma.user.create({
      data: { username: u.username, name: u.name, passwordHash, role: u.role },
    });
    console.log(`${u.role.padEnd(9)} ${u.username.padEnd(10)} created — password: ${u.password}`);
  }
  await prisma.$disconnect();
  process.exit(0);
};

seed().catch((err) => {
  console.error("Seed failed:", err.message);
  prisma.$disconnect();
  process.exit(1);
});
