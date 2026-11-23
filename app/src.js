import { createClient, createAccount, generatePrivateKey } from "genlayer-js";
import { studionet } from "genlayer-js/chains";

const CONTRACT = "0xd305602Bd6ffd6200f7A9DFDd82829Df3042a424";
const EXPLORER = "https://explorer-studio.genlayer.com";
const REPO = "https://github.com/Baophan00/rain-settle-genlayer";
const CACHE_SLOT = "rainsettle.cache.v1";
const KEY_SLOT = "rainsettle.demo.signer.v1";

const STATIONS = [
  ["DRY bulletin - 12 mm", "https://rainsettle-genlayer.surge.sh/demo/station-dry.html"],
  ["NORMAL bulletin - 74 mm", "https://rainsettle-genlayer.surge.sh/demo/station-normal.html"],
  ["WET bulletin - 168 mm", "https://rainsettle-genlayer.surge.sh/demo/station-wet.html"],
  ["Malformed bulletin - no figures", "https://rainsettle-genlayer.surge.sh/demo/station-malformed.html"],
];

const $ = (id) => document.getElementById(id);
const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
const str = (value) => (value === null || value === undefined ? "" : String(value));
const httpUrl = (value) => (/^https?:\/\//i.test(str(value)) ? str(value) : "");

let signerKey = "";
try {
  signerKey = JSON.parse(localStorage.getItem(KEY_SLOT) || "null");
} catch (error) {
  signerKey = null;
}
if (!signerKey) {
  signerKey = generatePrivateKey();
  localStorage.setItem(KEY_SLOT, JSON.stringify(signerKey));
}
const writer = createClient({ chain: studionet, account: createAccount(signerKey) });
const reader = createClient({ chain: studionet, account: createAccount(generatePrivateKey()) });
const writerAddress = str(writer.account && writer.account.address);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function setStatus(message, kind) {
  const node = $("form-status");
  node.textContent = message;
  node.className = "status" + (kind ? " " + kind : "");
}

function showBanner(message) {
  $("banner-text").textContent = message;
  $("banner").classList.remove("hidden");
}

function hideBanner() {
  $("banner").classList.add("hidden");
}

function setBusy(busy) {
  $("submit-policy").disabled = busy;
  $("refresh").disabled = busy;
}

function txLink(hash) {
  const anchor = el("a", "", hash.slice(0, 12) + "...");
  anchor.href = EXPLORER + "/tx/" + hash;
  anchor.target = "_blank";
  anchor.rel = "noopener";
  return anchor;
}

function read(fn, args) {
  return reader.readContract({ address: CONTRACT, functionName: fn, args });
}

async function send(fn, args) {
  const hash = await writer.writeContract({ address: CONTRACT, functionName: fn, args, value: 0n });
  const receipt = await writer.waitForTransactionReceipt({
    hash, status: "FINALIZED", retries: 240, interval: 3000,
  });
  const leader = (receipt.consensus_data && receipt.consensus_data.leader_receipt) || [];
  const failed = String(leader[0] && leader[0].execution_result).toUpperCase() === "ERROR";
  return { hash, failed };
}

function renderStats(stats) {
  $("s-policies").textContent = num(stats && stats.policies);
  $("s-readings").textContent = num(stats && stats.readings);
  $("s-triggered").textContent = num(stats && stats.triggered);
  $("s-units").textContent = num(stats && stats.payout_units).toLocaleString("en-US");
}

function renderPolicies(policies, readings) {
  const host = $("policy-list");
  host.replaceChildren();
  if (!Array.isArray(policies) || policies.length === 0) {
    host.appendChild(el("p", "empty", "No policies on chain yet. Register one above."));
    return;
  }
  for (const policy of policies) {
    const id = str(policy.policy_id);
    const epoch = str(policy.epoch);
    const cover = str(policy.cover).toUpperCase();
    const reading = readings[id] || null;
    const card = el("article", "policy");
    const top = el("div", "policy-top");
    top.appendChild(el("h3", "", id));
    top.appendChild(el("span", "pill " + (cover === "EXCESS" ? "excess" : "drought"), cover || "COVER"));
    card.appendChild(top);

    const meta = el("div", "meta");
    const fields = [
      ["Crop", str(policy.crop)],
      ["Threshold", num(policy.threshold_mm) + " mm"],
      ["Epoch", epoch],
      ["Payout", num(policy.payout_units) + " units"],
    ];
    for (const [label, value] of fields) {
      const cell = el("div");
      cell.appendChild(el("span", "", label));
      cell.appendChild(el("strong", "", value));
      meta.appendChild(cell);
    }
    card.appendChild(meta);

    const station = httpUrl(policy.station_url);
    if (station) {
      const link = el("a", "station", station);
      link.href = station;
      link.target = "_blank";
      link.rel = "noopener";
      card.appendChild(link);
    }

    if (reading) {
      const line = str(reading.bucket) + " | " + num(reading.mm) + " mm | " +
        (reading.triggered ? "triggered" : "no trigger") + " | " +
        num(reading.payout_units) + " units owed";
      card.appendChild(el("p", "reading" + (reading.triggered ? " triggered" : ""), line));
      const settled = el("span", "pill settled", "epoch settled");
      card.appendChild(settled);
    } else {
      card.appendChild(el("span", "pill pending", "awaiting settlement"));
      const button = el("button", "btn primary small", "Settle this epoch");
      button.type = "button";
      button.addEventListener("click", () => settleEpoch(id, epoch, button));
      card.appendChild(el("div", "", " "));
      card.lastChild.appendChild(button);
    }
    host.appendChild(card);
  }
}

function renderLedger(payouts) {
  const body = $("ledger-body");
  body.replaceChildren();
  if (!Array.isArray(payouts) || payouts.length === 0) {
    const row = el("tr");
    const cell = el("td", "empty", "No payouts recorded yet. Triggered policies append entries here.");
    cell.colSpan = 6;
    row.appendChild(cell);
    body.appendChild(row);
    return;
  }
  for (const payout of payouts) {
    const row = el("tr");
    row.appendChild(el("td", "", str(payout.payout_id)));
    row.appendChild(el("td", "", str(payout.policy_id)));
    row.appendChild(el("td", "", str(payout.epoch)));
    row.appendChild(el("td", "bucket " + str(payout.bucket), str(payout.bucket)));
    row.appendChild(el("td", "num", num(payout.mm) + " mm"));
    row.appendChild(el("td", "num", num(payout.units).toLocaleString("en-US")));
    body.appendChild(row);
  }
}

function render(snapshot) {
  renderStats(snapshot.stats);
  renderPolicies(snapshot.policies, snapshot.readings || {});
  renderLedger(snapshot.payouts);
}

async function readChain() {
  const [stats, policies, payouts] = await Promise.all([
    read("stats", []),
    read("list_policies", [0, 50]),
    read("all_payouts", [0, 50]),
  ]);
  const readings = {};
  for (const policy of policies) {
    readings[str(policy.policy_id)] = await read("get_reading", [str(policy.policy_id), str(policy.epoch)]);
  }
  return { readAt: Date.now(), stats, policies, payouts, readings };
}

async function refresh() {
  setBusy(true);
  try {
    const snapshot = await readChain();
    localStorage.setItem(CACHE_SLOT, JSON.stringify(snapshot));
    hideBanner();
    render(snapshot);
  } catch (error) {
    const message = String((error && error.message) || error);
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem(CACHE_SLOT) || "null"); } catch (ignored) {}
    if (cached && cached.readAt) {
      render(cached);
      showBanner("Studio RPC is unavailable (" + message.slice(0, 90) + "). Showing state read at " +
        new Date(cached.readAt).toLocaleString("en-US") + ". Use Retry read to try again.");
    } else {
      showBanner("Studio RPC is unavailable (" + message.slice(0, 90) +
        "). No cached state is available yet. Use Retry read.");
    }
  } finally {
    setBusy(false);
  }
}

async function settleEpoch(id, epoch, button) {
  button.disabled = true;
  const status = $("form-status");
  status.textContent = "Running consensus for " + id + " ... this takes about a minute.";
  status.className = "status";
  try {
    const result = await send("request_reading", [id, epoch]);
    if (result.failed) {
      setStatus("The contract refused this settlement. Tx ", "error");
      $("form-status").appendChild(txLink(result.hash));
      return;
    }
    setStatus("Settlement written. Tx ", "ok");
    $("form-status").appendChild(txLink(result.hash));
    await refresh();
  } catch (error) {
    setStatus("Write failed: " + String((error && error.message) || error).slice(0, 180), "error");
  } finally {
    button.disabled = false;
  }
}

async function init() {
  for (const [label, url] of STATIONS) {
    const option = el("option", "", label);
    option.value = url;
    $("f-station").appendChild(option);
  }
  const short = writerAddress.length > 12
    ? writerAddress.slice(0, 6) + "..." + writerAddress.slice(-4)
    : writerAddress;
  $("signer").textContent = "Demo signer: " + short +
    " - stored only in this browser, never use a real wallet here.";
  const footer = $("foot-links");
  const explorerLink = el("a", "", "Contract on explorer");
  explorerLink.href = EXPLORER + "/address/" + CONTRACT;
  explorerLink.target = "_blank";
  explorerLink.rel = "noopener";
  const repoLink = el("a", "", "Source repository");
  repoLink.href = REPO;
  repoLink.target = "_blank";
  repoLink.rel = "noopener";
  footer.appendChild(explorerLink);
  footer.appendChild(document.createTextNode("  |  "));
  footer.appendChild(repoLink);

  $("refresh").addEventListener("click", refresh);
  $("banner-retry").addEventListener("click", refresh);

  $("policy-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const id = $("f-id").value.trim();
    const crop = $("f-crop").value.trim();
    const epoch = $("f-epoch").value.trim();
    const cover = $("f-cover").value;
    const station = $("f-station").value;
    const threshold = Number($("f-threshold").value);
    const units = Number($("f-units").value);
    if (!/^[A-Za-z0-9 ._-]{1,64}$/.test(id) || !/^[A-Za-z0-9._-]{1,32}$/.test(epoch) ||
        !crop || !httpUrl(station) || !Number.isInteger(threshold) || !Number.isInteger(units) ||
        threshold < 1 || threshold > 2000 || units < 1 || units > 1000000) {
      setStatus("Check the fields: ID allows letters, digits, space, dot, dash; epoch is a short token; threshold 1-2000 mm; units 1-1000000.", "error");
      return;
    }
    setBusy(true);
    try {
      const result = await send("register_policy", [id, station, crop, cover, threshold, units, epoch]);
      if (result.failed) {
        setStatus("The contract refused the policy. Tx ", "error");
        $("form-status").appendChild(txLink(result.hash));
        return;
      }
      setStatus("Policy written. Tx ", "ok");
      $("form-status").appendChild(txLink(result.hash));
      await refresh();
    } catch (error) {
      setStatus("Write failed: " + String((error && error.message) || error).slice(0, 180), "error");
    } finally {
      setBusy(false);
    }
  });

  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(CACHE_SLOT) || "null"); } catch (ignored) {}
  if (cached && cached.readAt) render(cached);
  await refresh();
}

init().catch((error) => showBanner("Startup failed: " + String((error && error.message) || error)));
