#!/usr/bin/env node
/**
 * Deploy RainSettle to GenLayer Studio Network and verify the published bytes.
 *
 *   node scripts/deploy_studionet.js
 *
 * The signing key is generated once into scripts/.rain-settle-keys.json with
 * mode 0600 and is gitignored. This script never prints key material - only
 * the public address. The full deploy log belongs in /tmp/rain_deploy.log so
 * the transaction hash survives terminal truncation.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { createClient, createAccount, generatePrivateKey } = require("genlayer-js");
const { studionet } = require("genlayer-js/chains");

const ROOT = path.resolve(__dirname, "..");
const KEY_PATH = path.join(__dirname, ".rain-settle-keys.json");
const ARTIFACT = path.join(ROOT, "artifacts", "deploy.json");
const SOURCE_PATH = path.join(ROOT, "contracts", "rain_settle.py");
const EXPLORER = "https://explorer-studio.genlayer.com";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const HICCUP = /DOCTYPE|fetch failed|ECONNRESET|timeout|temporarily unavailable|not available|bad gateway|service unavailable/i;

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

function loadKeys() {
  let keys;
  if (fs.existsSync(KEY_PATH)) {
    keys = JSON.parse(fs.readFileSync(KEY_PATH, "utf8"));
    fs.chmodSync(KEY_PATH, 0o600);
  } else {
    keys = { creator: generatePrivateKey() };
    fs.writeFileSync(KEY_PATH, JSON.stringify(keys, null, 2), { mode: 0o600 });
    fs.chmodSync(KEY_PATH, 0o600);
  }
  if (!keys.creator) throw new Error("the local key file has no creator entry");
  return keys;
}

async function verifyExplorer(address, deployTx) {
  for (const suffix of [`/address/${address}`, `/tx/${deployTx}`]) {
    const url = EXPLORER + suffix;
    let status = 0;
    for (let i = 0; i < 8; i += 1) {
      try {
        const response = await fetch(url, { redirect: "follow" });
        status = response.status;
        if (status === 200) break;
      } catch (error) {
        status = 0;
      }
      await sleep(4000);
    }
    if (status !== 200) throw new Error(`explorer returned ${status} for ${url}`);
    console.log(`  explorer 200  ${url}`);
  }
}

function stripCliWrapper(raw) {
  const marker = "Result:\n";
  const start = raw.indexOf(marker);
  if (start < 0) throw new Error("genlayer code printed no Result: block");
  let code = raw.slice(start + marker.length);
  const footers = [
    "\n✔ Contract code retrieved successfully",
    "\nContract code retrieved successfully",
  ];
  for (const footer of footers) {
    const index = code.indexOf(footer);
    if (index >= 0) {
      code = code.slice(0, index);
      break;
    }
  }
  return code.trimEnd();
}

function verifyDeployedCode(address, localSource) {
  const env = Object.assign({}, process.env, {
    PATH: `${process.env.HOME}/.npm-global/bin:${process.env.PATH || ""}`,
  });
  const raw = execFileSync("genlayer", ["code", address], {
    cwd: ROOT,
    env,
    encoding: "utf8",
    timeout: 180000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const deployed = stripCliWrapper(raw);
  const expected = localSource.trimEnd();
  if (deployed !== expected) {
    let offset = 0;
    while (offset < Math.min(deployed.length, expected.length) && deployed[offset] === expected[offset]) {
      offset += 1;
    }
    throw new Error(
      `deployed source differs from local at byte ${offset} ` +
      `(on chain ${deployed.length} bytes, local ${expected.length} bytes)`
    );
  }
  console.log(`  source match genlayer code == ${SOURCE_PATH} (${expected.length} bytes)`);
}

(async () => {
  const keys = loadKeys();
  const account = createAccount(keys.creator);
  const client = createClient({ chain: studionet, account });
  const sourceText = fs.readFileSync(SOURCE_PATH, "utf8");
  const source = new Uint8Array(Buffer.from(sourceText, "utf8"));

  console.log("RainSettle deploy - Studio Network");
  console.log(`creator ${account.address}`);
  console.log(`source  ${SOURCE_PATH} (${source.length} bytes)`);

  const hash = await retrying("deploy", () => client.deployContract({ code: source, args: [] }));
  console.log(`deploy tx ${hash}`);

  const receipt = await retrying("receipt", () =>
    client.waitForTransactionReceipt({ hash, status: "FINALIZED", retries: 240, interval: 3000 })
  );
  const address =
    (receipt.data && (receipt.data.contract_address || receipt.data.contractAddress)) ||
    (receipt.txDataDecoded && receipt.txDataDecoded.contractAddress);
  if (!address) {
    throw new Error(`no contract address in receipt: ${JSON.stringify(receipt).slice(0, 600)}`);
  }
  console.log(`contract ${address}`);

  // A deploy can be FINALIZED while __init__ raised. A view is the proof.
  const stats = await retrying("stats", () =>
    client.readContract({ address, functionName: "stats", args: [] })
  );
  console.log(`stats   ${JSON.stringify(stats)}`);

  console.log("verifying explorer and deployed source");
  await verifyExplorer(address, hash);
  verifyDeployedCode(address, sourceText);

  fs.mkdirSync(path.dirname(ARTIFACT), { recursive: true });
  fs.writeFileSync(ARTIFACT, JSON.stringify({
    address,
    deployTx: hash,
    creator: account.address,
    deployedAt: new Date().toISOString(),
    code: sourceText,
  }, null, 2));
  console.log(`artifact ${path.relative(ROOT, ARTIFACT)}`);
  console.log(`RESULT: deployed and verified ${address}`);
  console.log(`next: node scripts/e2e_studionet.js ${address}`);
})().catch((error) => {
  console.error("FAILED:", (error && error.message) || String(error));
  if (error && error.cause) console.error(String(error.cause).slice(0, 900));
  process.exit(1);
});
