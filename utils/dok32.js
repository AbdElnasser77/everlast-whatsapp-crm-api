// Read-only access to the clinic system (Dok32). It is a live, shared
// database we don't own: every query runs inside a READ ONLY transaction that
// is always rolled back, so nothing here can ever change clinic data. Only
// Everlast's schema ("196") is read.
//
// Connection: DOK32_DATABASE_URL (Postgres 10 behind PgBouncer, reached
// through the Cloudflare tunnel).

const { Pool } = require("pg");

const SCHEMA = '"196"';
let pool = null;

const isConfigured = () => Boolean(process.env.DOK32_DATABASE_URL);

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DOK32_DATABASE_URL,
      max: 3,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 8_000,
    });
    // An idle connection dropped by the tunnel must not crash the server.
    pool.on("error", (err) => console.error("[Dok32] idle connection error:", err.message));
  }
  return pool;
}

class Dok32Unavailable extends Error {
  constructor(cause) {
    super(`The clinic system can't be reached right now (${cause?.message || cause})`);
    this.code = "DOK32_UNAVAILABLE";
  }
}

/** One read-only query. `sql` may use the {schema} placeholder. */
async function query(sql, params = []) {
  if (!isConfigured()) throw new Dok32Unavailable("not configured");
  let client;
  try {
    client = await getPool().connect();
  } catch (err) {
    throw new Dok32Unavailable(err);
  }
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    // PgBouncer refuses startup parameters, so the timeout is per transaction.
    await client.query("SET LOCAL statement_timeout = '15s'");
    const { rows } = await client.query(sql.replaceAll("{schema}", SCHEMA), params);
    return rows;
  } catch (err) {
    throw new Dok32Unavailable(err);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}

module.exports = { query, isConfigured, Dok32Unavailable };
