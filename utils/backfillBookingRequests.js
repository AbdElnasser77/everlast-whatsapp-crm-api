// One-off: turn booking-flow answers collected before booking requests existed
// into requests, so recent ones land on the agents' list.
//
// Only the last 7 days: older requests are history, not work — flooding the
// queue with them would bury today's. A run that already has a request is
// skipped, so running this twice is harmless.
//
//   node utils/backfillBookingRequests.js           (dry run: counts only)
//   node utils/backfillBookingRequests.js --apply

require("dotenv").config({ path: __dirname + "/../config.env", quiet: true });
const prisma = require("../config/prisma");
const { isBookingAnswers, answersOf, createFromFlowRun } = require("./bookingRequests");

const DAYS = 7;

async function main() {
  const apply = process.argv.includes("--apply");
  const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);
  const runs = await prisma.flowRun.findMany({
    where: { status: { in: ["COMPLETED", "HANDED_OFF"] }, updatedAt: { gte: since } },
    select: { id: true, data: true },
  });
  const candidates = runs.filter((r) => isBookingAnswers(answersOf(r.data)));
  const existing = new Set(
    (await prisma.bookingRequest.findMany({ where: { flowRunId: { in: candidates.map((r) => r.id) } }, select: { flowRunId: true } })).map((r) => r.flowRunId),
  );
  const todo = candidates.filter((r) => !existing.has(r.id));
  console.log(`${runs.length} finished flow runs in ${DAYS} days, ${candidates.length} with booking answers, ${todo.length} without a request yet.`);
  if (!apply) {
    console.log("Dry run — nothing written. Add --apply to create them.");
  } else {
    let made = 0;
    for (const r of todo) if (await createFromFlowRun(r.id)) made++;
    console.log(`Created ${made} booking request(s).`);
  }
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
