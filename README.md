# RainSettle

**Parametric crop cover as a settlement engine on GenLayer Studio Network.**

RainSettle turns one published rainfall bulletin into a payout decision that a
treasury can audit line by line. A policy names one weather station page, one
crop, one covered peril, a rainfall threshold, a payout amount and one epoch.
One consensus round reads the page, two bounded values are agreed, and the
contract - not the model - decides whether the policy triggered.

No funds are held and no funds move. RainSettle is the settlement layer a
treasury can trust: deterministic trigger rules, a payout ledger, and a hard
refusal of duplicate epochs.

## Live artifacts

| Item | Link |
| --- | --- |
| Application | <https://rainsettle-genlayer.surge.sh> |
| Contract (Studio Network) | <https://explorer-studio.genlayer.com/address/0xd305602Bd6ffd6200f7A9DFDd82829Df3042a424> |
| Deploy transaction | <https://explorer-studio.genlayer.com/tx/0xd4edc9cce5f1ad66dc311cf129e1b88ad82b3fb50c3d9b398edd113e0c112f65> |
| Source | <https://github.com/Baophan00/rain-settle-genlayer> |
| Demo bulletins | <https://rainsettle-genlayer.surge.sh/demo/station-dry.html> |

Synthetic station bulletins (fixed values, no real weather data):

- `demo/station-dry.html` - classification DRY, 12 mm
- `demo/station-normal.html` - classification NORMAL, 74 mm
- `demo/station-wet.html` - classification WET, 168 mm
- `demo/station-malformed.html` - no classification and no rainfall total

## Use case

A cooperative insures a maize field against a dry spell and a rice field
against excess rain. Neither policy needs a claims adjuster: both name a
station that already publishes a bulletin, and both name the number that
decides a payout. At the end of the epoch anyone may ask the contract to
settle it. The contract reads the one designated bulletin through consensus,
compares the agreed reading with the stored threshold, and appends a ledger
entry when the policy triggers.

The product boundary is deliberate: RainSettle does not custody money. A
treasury contract can read `payouts_of(policy_id)` or `all_payouts()` and pay
against those entries, while the settlement logic stays independent, small,
and reproducible.

## Architecture

```
station bulletin (untrusted HTML)
        |
        |  gl.nondet.web.render(url, mode="text")   inside the callback
        v
gl.nondet.exec_prompt(..., response_format="json")
        |   bucket in {DRY,NORMAL,WET}, mm in [0,2000]
        v
gl.eq_principle.prompt_comparative(ask, principle=canonical JSON over both fields)
        |
        v
RainSettle contract: compare with stored threshold -> payout ledger
        |
        v
static app (genlayer-js, Studio Network): views + two write paths
```

| Layer | File | Responsibility |
| --- | --- | --- |
| Settlement engine | `contracts/rain_settle.py` | Policy registry, consensus read, trigger rules, payout ledger, views |
| Direct-mode suite | `tests/direct/` | 30 offline tests against the real contract, including guard and refusal paths |
| Deployment | `scripts/deploy_studionet.js` | Key handling, deploy, receipt, explorer check, on-chain source comparison |
| End-to-end | `scripts/e2e_studionet.js` | Real consensus rounds over public bulletins, negative controls, evidence artifact |
| Frontend | `app/index.html`, `app/src.js`, `app/bundle.js` | Chain views, policy registration, epoch settlement, audit table |

The entire station fetch and model call live **inside** the equivalence-principle
callback. Every validator fetches the page for itself during the round; the
contract never accepts a leader-only copy of the bulletin.

### Consensus design

The callback returns canonical JSON of exactly two fields, or the token
`null`:

```json
{"bucket":"DRY","mm":12}
```

The principle binds both fields: `bucket` must be identical and one of
`DRY`, `NORMAL`, `WET`; `mm` must be the same whole number from `0` to `2000`;
`null` matches only `null`. Wording, excerpts and reasoning are free to
differ. The contract then re-parses the agreed answer strictly: a missing
key, an unknown bucket, a non-integer millimetre value or an out-of-range
number all refuse the settlement and store nothing.

Trigger rules are computed in contract code from stored policy fields:

| Cover | Bucket | Millimetre condition | Result |
| --- | --- | --- | --- |
| DROUGHT | DRY | `mm <= threshold` | payout |
| EXCESS | WET | `mm >= threshold` | payout |
| any | NORMAL | any | no payout |
| DROUGHT | WET | any | no payout |
| EXCESS | DRY | any | no payout |

The bucket and the number must both agree with the cover. A station that
labels a period DRY but reports 1800 mm therefore pays nothing: the two
fields are a cross-check, not alternatives.

## Contract API

| Method | Kind | Arguments | Returns |
| --- | --- | --- | --- |
| `register_policy` | write | `policy_id, station_url, crop, cover, threshold_mm, payout_units, epoch` | stored policy |
| `request_reading` | write | `policy_id, epoch` | reading with `triggered` and `payout_count` |
| `normalize_extraction` | view | `raw_json` | canonical `{bucket, mm}`, refuses invalid input |
| `get_policy` | view | `policy_id` | stored policy |
| `list_policies` | view | `offset, limit` | policies, newest first |
| `readings_of` | view | `policy_id` | all readings for a policy |
| `get_reading` | view | `policy_id, epoch` | one reading or `null` |
| `latest` | view | `policy_id` | newest reading or `null` |
| `payouts_of` | view | `policy_id` | ledger entries for a policy |
| `all_payouts` | view | `offset, limit` | ledger entries |
| `stats` | view | none | policy, reading, trigger, payout and unit totals |

Validation rules: policy id 1-64 characters and unique; one `http(s)` station
URL; crop 1-48 characters; cover exactly `DROUGHT` or `EXCESS`; threshold
1-2000 mm; payout units 1-1000000; epoch a short ASCII token of letters,
digits, dash, dot or underscore. An epoch may be settled once per policy;
a second request is refused before any consensus round runs.

Storage uses `TreeMap[str, Policy]`, `TreeMap[str, DynArray[Reading]]`,
`TreeMap[str, bool]` for settled epochs, a `DynArray[str]` of policy ids and a
global `DynArray[Payout]` with a monotonic sequence. All numeric dataclass
fields are `u256`.

## Tests

```
env -u PYTHONPATH -u VIRTUAL_ENV -u PYTHONHOME \
  ~/agent-escrow-genlayer/.venv/bin/python -m pytest tests/direct -q
```

**Result: 30 passed.** The suite covers policy registration rules (duplicate
ids, URL shape, crop, cover, threshold and payout bounds, epoch token), strict
extraction parsing (JSON text, buckets, ranges, malformed answers), drought
and excess triggers, both no-trigger directions, the `NORMAL` case, inclusive
threshold boundaries, duplicate-epoch refusal, malformed and unreachable
bulletins, payout ledger monotonicity, every view, and a static AST check that
every contract method takes `self` and declares a return type.

Station pages and model answers are mocked; the contract, its validation and
its state transitions are not.

## Deployment and verification

`node scripts/deploy_studionet.js` creates a local key file with mode `0600`
(gitignored, never printed), deploys with `genlayer-js` on `studionet`, waits
for `FINALIZED`, calls `stats()` to prove the contract executed, then:

1. requires HTTP 200 from both the explorer address and transaction pages;
2. reads `genlayer code <address>` and compares the stripped CLI output with
   the local source byte for byte.

The receipt is written to `evidence/deploy.json`, including the deploy hash,
so evidence never depends on terminal scrollback.

## End-to-end run

`node scripts/e2e_studionet.js` publishes no pages itself: it first checks that
all four bulletins are reachable and readable, registers four policies, then
runs real consensus rounds. It always reads a view after a write, because a
FINALIZED receipt alone does not prove the contract applied the change.

Scenarios: a dry bulletin pays 500 units on drought cover; a wet bulletin
pays 900 units on excess cover; a normal bulletin with excess cover pays
nothing; a malformed bulletin is refused and stores no reading; a duplicate
epoch is refused and adds no ledger entry. The script prints `RESULT:` and
every transaction hash, and writes `evidence/e2e.json`.

## Evidence transactions

All hashes below were read back from a `FINALIZED` receipt during the e2e run
and are stored in `evidence/e2e.json`. "Refused" means the leader receipt
reported an execution error and a view read confirmed that no state changed.

| Step | Outcome | Transaction |
| --- | --- | --- |
| Deploy | contract + source verified | `0xd4edc9cce5f1ad66dc311cf129e1b88ad82b3fb50c3d9b398edd113e0c112f65` |
| Register `rain-dry-2026` (drought, 40 mm, 500 units) | executed | `0x99b61a4bd38c285fc2c7adfaca4f03c2ade2ca914d15aae12244be9cff98db56` |
| Register `rain-wet-2026` (excess, 100 mm, 900 units) | executed | `0x9b61a3e6d340db98ae13a11af9288e58eac2539feeb6ad13b914ebf2e78f708f` |
| Register `rain-normal-2026` (excess, 40 mm, 700 units) | executed | `0xbcf248c8c8a4b1ab0c505362d7ba47c3bf00867d01332a3536f5bfd0e4979d89` |
| Register `rain-bad-2026` (malformed station) | executed | `0x28bd7ed1baee4fb47a3b8e531cb761d8fed4cb0b6c268aefce48870e367c7979` |
| `request_reading("rain-dry-2026", "2026-11")` | DRY 12 mm, triggered, 500 units | `0xf92fa99deb809e962bcb281879e501035aac40146c642b76f5932929378fc953` |
| `request_reading("rain-wet-2026", "2026-11")` | WET 168 mm, triggered, 900 units | `0xf25cc86a8a10e40c125a59785cfa73ed5f2b522d3cf118813edbf8faf1c3ec72` |
| `request_reading("rain-normal-2026", "2026-11")` | NORMAL 74 mm, no payout | `0x3a61712b3c8f352466f19b2235a3ffdeb944f7528d1ae31735bc5df665ad38b8` |
| `request_reading("rain-bad-2026", "2026-11")` | refused, 0 readings stored | `0x3ee47f67f1daf9fa45b8c8e32963deb5e780183cd5879d0205c7f5d66e310050` |
| Duplicate `request_reading("rain-dry-2026", "2026-11")` | refused, ledger unchanged | `0xb2df06457dfbda1df5b927d671aa6faaef0b8c3b05c59fac8dc514614ab806af` |

At the end of the e2e run, on-chain state was: 4 policies, 3 settled
readings, 2 triggered, 2 payouts, 1400 payout units. The run printed
`RESULT: PASS - 2 payouts of 500 and 900 units; 1 no-trigger; 2 refusals; 9 transactions`
and exited 0.

Separately, the shipped browser app registered `browser-write-2026` through
its own form and signer (transaction
`0x6a34b9e97d6ecb3b230511dd7d8ccef0cc8616de7f56f9234ad4ab3024bbdb58`).
The policy count moved from 4 to 5 and the new card appeared after the
receipt finalized, which proves the frontend write path against the live
contract.

## Why this is not the other project types

- **Not a median oracle.** SourceMedian reads several sources and computes a
  median with a spread. RainSettle reads exactly one named station, takes no
  median and has no cross-source tolerance. Its second field is a categorical
  bucket, and the agreement is over a canonical two-field JSON object.
- **Not exact-token attestation.** DomainAttest proves control of a path by
  comparing a whole artifact with an expected token. RainSettle proves
  nothing about control and compares no token: it extracts a bounded reading
  and compares it against a stored threshold in code.
- **Not an escrow project.** No value is deposited, locked or released. There
  is no balance assertion and no payable path. The contract is a settlement
  engine whose ledger a separate treasury can consume.
- **Not a tender or sealed-bid project.** There are no commitments, reveals,
  bids, deadlines or winner selection. Every policy's rules are public from
  the moment it is registered, and the only secret material is a demo browser
  signer used to submit transactions.

## Reproducing

```bash
npm install
npm run build                     # rebuild app/bundle.js from app/src.js
node scripts/deploy_studionet.js  # or read evidence/deploy.json
node scripts/e2e_studionet.js     # uses the deployed address
```

The browser app needs no build step to run; the checked-in bundle is what
Surge serves. `CNAME` pins `rainsettle-genlayer.surge.sh`.

## Security notes

- Bulletin text is explicitly marked untrusted; a page that instructs the
  model to report a different value is treated as content.
- Millimetres are bounded to `0..2000`, buckets are a strict three-value
  enumeration, and malformed answers fail closed.
- Duplicate epochs are refused in storage before a consensus round is spent.
- The frontend renders contract-derived data with `createElement` and
  `textContent` only, validates URLs before using them as links, and never
  polls the public RPC. It caches the last successful read and labels it with
  its read time when the RPC is unavailable.
- The browser signer is a throwaway demo key stored in `localStorage`; never
  put a real wallet or funds into it.
