#!/usr/bin/env node
/**
 * RainSettle end-to-end run against GenLayer Studio Network.
 *
 *   node scripts/e2e_studionet.js [contractAddress]
 *
 * Every reading below is produced by a real consensus round over a public
 * station bulletin. Each write is followed by a view read: a receipt alone
 * is not proof that the contract applied the state change.
 */
const fs = require("fs");
const path = require("path");
const { createClient, createAccount, generatePrivateKey } = require("genlayer-js");
const { studionet } = require("genlayer-js/chains");

const ROOT = path.resolve(__dirname, "..");
const ARTIFACT = path.join(ROOT, "artifacts", "deploy.json");
const OUT = path.join(ROOT, "artifacts", "e2e.json");
const KEY_PATH = process.env.RS_KEYS || path.join(__dirname, ".rain-settle-keys.json");
const keys = JSON.parse(fs.readFileSync(KEY_PATH, "utf8"));
const deployInfo = JSON.parse(fs.readFileSync(ARTIFACT, "utf8"));
const ADDRESS = process.argv[2] || deployInfo.address;
if (!ADDRESS) {
  console.error("usage: node scripts/e2e_studionet.js <contractAddress>");
  process.exit(1);
}

const BASE = process.env.RS_BASE || "https://rainsettle-genlayer.surge.sh/demo";
const PAGES = {
  dry: `${BASE}/station-dry.html`,
  normal: `${BASE}/station-normal.html`,
  wet: `${BASE}/station-wet.html`,
  malformed: `${BASE}/station-malformed.html`,
};
const EPOCH = "2026-11";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const HICCUP = /DOCTYPE|fetch failed|ECONNRESET|timeout|temporarily unavailable|not available|bad gateway|service unavailable/i;

const creator = createClient({ chain: studionet, account: createAccount(keys.creator) });
const watcher = createClient({ chain: studionet, account: createAccount(generatePrivateKey()) });
const txs = [];

async function retrying(label, fn, attempts = 40) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (error) {
      const message = String((error && error.message) || error);
      if (!HICCUP.test(message)) throw error;
      last = error;
      const wait = 5000 + Math.min(i, 8) * 2000;
      console.log(`  ${label}: rpc hiccup, retry ${i + 1} in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
  throw last;
}

const view = (fn, args) =>
  retrying("read", () => watcher.readContract({ address: ADDRESS, functionName: fn, args }));

function executionFailed(receipt) {
  const leader = (receipt.consensus_data && receipt.consensus_data.leader_receipt) || [];
  return String(leader[0] && leader[0].execution_result).toUpperCase() === "ERROR";
}

async function call(fn, args) {
  console.log(`\n[write] ${fn}(${args.map((a) => JSON.stringify(a).slice(0, 70)).join(", ")})`);
  const hash = await retrying("send", () =>
    creator.writeContract({ address: ADDRESS, functionName: fn, args, value: 0n })
  );
  console.log(`  tx ${hash}`);
  txs.push({ label: fn + ":" + String(args[0]), hash });
  const receipt = await retrying("receipt", () =>
    creator.waitForTransactionReceipt({ hash, status: "FINALIZED", retries: 240, interval: 3000 })
  );
  const failed = executionFailed(receipt);
  console.log(`  ${receipt.status_name || receipt.status} - ${failed ? "refused by the contract" : "executed"}`);
  return { hash, failed, receipt };
}

async function mustWrite(fn, args) {
  const out = await call(fn, args);
  if (out.failed) throw new Error(`${fn} was refused by the contract`);
  return out.hash;
}

async function preflight() {
  console.log("checking demo bulletins");
  for (const [name, url] of Object.entries(PAGES)) {
    let body = "";
    for (let i = 0; i < 5; i += 1) {
      try {
        const response = await fetch(url, { redirect: "follow" });
        if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
        body = await response.text();
        break;
      } catch (error) {
        if (i === 4) throw new Error(`bulletin ${name} is not reachable: ${error.message}`);
        await sleep(3000);
      }
    }
    if (name !== "malformed" && !body.includes("Measured rainfall total")) {
      throw new Error(`bulletin ${name} does not state a rainfall total`);
    }
    console.log(`  200 ${url}`);
  }
}

const POLICIES = [
  { id: "rain-dry-2026", url: PAGES.dry, crop: "Maize", cover: "DROUGHT", threshold: 40, units: 500, expect: true },
  { id: "rain-wet-2026", url: PAGES.wet, crop: "Rice", cover: "EXCESS", threshold: 100, units: 900, expect: true },
  { id: "rain-normal-2026", url: PAGES.normal, crop: "Maize", cover: "EXCESS", threshold: 40, units: 700, expect: false },
  { id: "rain-bad-2026", url: PAGES.malformed, crop: "Maize", cover: "DROUGHT", threshold: 40, units: 300, expect: null },
];

async function registerAll() {
  for (const p of POLICIES) {
    let existing = null;
    try {
      existing = await view("get_policy", [p.id]);
    } catch (error) {
      if (HICCUP.test(String(error && error.message))) throw error;
    }
    if (existing) {
      console.log(`\n[skip] ${p.id} is already registered`);
      continue;
    }
    await mustWrite("register_policy", [
      p.id, p.url, p.crop, p.cover, p.threshold, p.units, EPOCH,
    ]);
    const stored = await view("get_policy", [p.id]);
    if (stored.station_url !== p.url || stored.cover !== p.cover) {
      throw new Error(`${p.id} was not registered as intended`);
    }
  }
}

(async () => {
  console.log("RainSettle e2e - Studio Network");
  console.log(`contract ${ADDRESS}`);
  console.log(`pages   ${BASE}`);
  await preflight();
  await registerAll();

  const readings = {};
  for (const p of POLICIES.filter((item) => item.expect !== null)) {
    const before = await view("payouts_of", [p.id]);
    await mustWrite("request_reading", [p.id, EPOCH]);
    const row = await view("get_reading", [p.id, EPOCH]);
    if (!row) throw new Error(`${p.id}: the read did not store a reading`);
    const after = await view("payouts_of", [p.id]);
    console.log(`  reading ${p.id}: ${row.bucket} ${row.mm} mm, triggered=${row.triggered}, paid=${row.payout_units}`);
    if (row.triggered !== p.expect) throw new Error(`${p.id}: expected triggered=${p.expect}`);
    if (after.length - before.length !== (p.expect ? 1 : 0)) {
      throw new Error(`${p.id}: the payout ledger did not change as expected`);
    }
    readings[p.id] = row;
  }

  console.log("\n[negative] malformed bulletin must be refused");
  const badBefore = await view("readings_of", ["rain-bad-2026"]);
  const bad = await call("request_reading", ["rain-bad-2026", EPOCH]);
  if (!bad.failed) throw new Error("the malformed bulletin was accepted");
  const badAfter = await view("readings_of", ["rain-bad-2026"]);
  if (badAfter.length !== badBefore.length) throw new Error("a refused read stored a reading");
  console.log(`  refused; stored readings ${badAfter.length}`);

  console.log("\n[negative] a duplicate epoch must be refused");
  const dupBefore = await view("payouts_of", ["rain-dry-2026"]);
  const dup = await call("request_reading", ["rain-dry-2026", EPOCH]);
  if (!dup.failed) throw new Error("a duplicate epoch was accepted");
  const dupAfter = await view("payouts_of", ["rain-dry-2026"]);
  if (dupAfter.length !== dupBefore.length) throw new Error("a duplicate epoch wrote a payout");
  console.log(`  refused; payout entries still ${dupAfter.length}`);

  const stats = await view("stats", []);
  const payouts = await view("all_payouts", [0, 50]);
  console.log("\nstats:");
  console.log(JSON.stringify(stats, null, 2));
  console.log("payout ledger:");
  for (const p of payouts) {
    console.log(`  ${p.payout_id} ${p.policy_id} ${p.bucket} ${p.mm}mm -> ${p.units} units`);
  }
  if (stats.policies < 4 || stats.readings !== 3 || stats.triggered !== 2 || stats.payouts !== 2) {
    throw new Error("final statistics do not match the e2e story");
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    address: ADDRESS,
    result: "PASS: 2 triggered settlements, 1 clean no-trigger, 1 refused malformed bulletin, 1 refused duplicate epoch",
    stats,
    readings,
    payouts,
    txs,
    finishedAt: new Date().toISOString(),
  }, null, 2));

  console.log("\nTransaction hashes:");
  for (const item of txs) console.log(`  ${item.label} ${item.hash}`);
  console.log(`\nexplorer https://explorer-studio.genlayer.com/address/${ADDRESS}`);
  console.log(`RESULT: PASS - 2 payouts of 500 and 900 units; 1 no-trigger; 2 refusals; ${txs.length} transactions`);
})().catch((error) => {
  console.error("\nFAILED:", (error && error.message) || String(error));
  if (error && error.cause) console.error(String(error.cause).slice(0, 900));
  process.exit(1);
});
