// Runs ONE campaign send loop in its own process, against the fake Meta, for
// tests/campaigns.check.js. Being a separate process is the point: the parent
// can SIGKILL it mid-send (a crash or a deploy), or start two of them at once
// (two server instances), and then count what Meta actually received.
//
//   node tests/campaigns.child.js <campaignId>
//
// Configured entirely through env by the parent (see tests/support/fakeMeta.js).

const fakeMeta = require("./support/fakeMeta");
fakeMeta.install();
require("dotenv").config({ path: __dirname + "/../config.env", quiet: true });

const prisma = require("../config/prisma");
const { processCampaign } = require("../modules/campaigns/campaign.controller");

const campaignId = Number(process.argv[2]);

processCampaign(campaignId)
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(`[child ${process.pid}] send loop failed:`, err.message);
    await prisma.$disconnect();
    process.exit(2);
  });
