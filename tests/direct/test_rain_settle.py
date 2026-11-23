"""Direct-mode tests for RainSettle.

Run with the project's pinned interpreter:

    env -u PYTHONPATH -u VIRTUAL_ENV -u PYTHONHOME \
        ~/agent-escrow-genlayer/.venv/bin/python -m pytest tests/direct -q

The station pages and the model answers are mocked. The contract is not.
"""

import json
import re

CONTRACT = "contracts/rain_settle.py"

STATION = "https://station-rain.example.org/bulletin.html"
OTHER = "https://station-other.example.org/bulletin.html"
BROKEN = "https://station-broken.example.org/bulletin.html"

BODIES = {
    "dry": "RAINSETTLE STATION BULLETIN RS-N01 classification: DRY total rainfall: 12 mm period 2026-11",
    "wet": "RAINSETTLE STATION BULLETIN RS-N01 classification: WET total rainfall: 168 mm period 2026-11",
    "normal": "RAINSETTLE STATION BULLETIN RS-N01 classification: NORMAL total rainfall: 74 mm period 2026-11",
    "edge": "RAINSETTLE STATION BULLETIN RS-N01 classification: DRY total rainfall: 40 mm period 2026-11",
    "malformed": "RAINSETTLE STATION BULLETIN RS-N01 the printer ran out of paper; no figures today",
}


def who(addr):
    from genlayer import Address

    return str(Address(bytes(addr))).lower()


def deploy(direct_deploy):
    return direct_deploy(CONTRACT)


def register(contract, direct_vm, sender, policy_id="maize-dry", url=STATION,
             crop="Maize", cover="DROUGHT", threshold=40, units=500, epoch="2026-11"):
    direct_vm.sender = sender
    return contract.register_policy(policy_id, url, crop, cover, threshold, units, epoch)


def mock_read(direct_vm, body_key, answer, url=STATION):
    """Serve one bulletin and the extraction the model is mocked to return."""
    direct_vm.clear_mocks()
    body = BODIES[body_key]
    direct_vm.mock_web(re.escape(url), {"status": 200, "body": body})
    payload = answer if isinstance(answer, str) else json.dumps(answer)
    direct_vm.mock_llm(re.escape(body), payload)


def mock_unreachable(direct_vm):
    direct_vm.clear_mocks()


def settle(contract, direct_vm, sender, body_key, bucket, mm,
           policy_id="maize-dry", epoch="2026-11", url=STATION):
    mock_read(direct_vm, body_key, {"bucket": bucket, "mm": mm}, url=url)
    direct_vm.sender = sender
    return contract.request_reading(policy_id, epoch)


class TestRegisterPolicy:
    def test_registration_stores_every_field_and_the_views_read_it_back(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        row = register(contract, direct_vm, direct_alice)

        assert row == {
            "policy_id": "maize-dry",
            "station_url": STATION,
            "crop": "Maize",
            "cover": "DROUGHT",
            "threshold_mm": 40,
            "payout_units": 500,
            "epoch": "2026-11",
            "owner": who(direct_alice),
            "created_at": row["created_at"],
        }
        assert row["created_at"] > 0
        assert contract.get_policy("maize-dry")["station_url"] == STATION
        assert contract.readings_of("maize-dry") == []
        assert contract.latest("maize-dry") is None

    def test_a_policy_id_is_only_registered_once(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        register(contract, direct_vm, direct_alice)
        direct_vm.sender = direct_alice
        with direct_vm.expect_revert("is taken"):
            contract.register_policy("maize-dry", STATION, "Maize", "DROUGHT", 40, 500, "2026-11")

    def test_the_policy_id_has_a_bounded_length(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        direct_vm.sender = direct_alice
        with direct_vm.expect_revert("1 to 64 characters"):
            contract.register_policy("", STATION, "Maize", "DROUGHT", 40, 500, "2026-11")
        with direct_vm.expect_revert("1 to 64 characters"):
            contract.register_policy("x" * 65, STATION, "Maize", "DROUGHT", 40, 500, "2026-11")
        with direct_vm.expect_revert("1 to 64 characters"):
            contract.register_policy(7, STATION, "Maize", "DROUGHT", 40, 500, "2026-11")

    def test_the_station_must_be_one_http_url(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        direct_vm.sender = direct_alice
        with direct_vm.expect_revert("one http(s) station URL"):
            contract.register_policy("p", "station.example.org", "Maize", "DROUGHT", 40, 500, "e1")
        with direct_vm.expect_revert("one http(s) station URL"):
            contract.register_policy("p", STATION + " " + OTHER, "Maize", "DROUGHT", 40, 500, "e1")
        with direct_vm.expect_revert("one http(s) station URL"):
            contract.register_policy("p", 42, "Maize", "DROUGHT", 40, 500, "e1")
        assert contract.register_policy("ok", "http://station.example.org/x", "Maize",
                                        "DROUGHT", 40, 500, "e1")["station_url"] == "http://station.example.org/x"

    def test_the_crop_is_short_and_nonempty(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        direct_vm.sender = direct_alice
        with direct_vm.expect_revert("1 to 48 characters"):
            contract.register_policy("p", STATION, "   ", "DROUGHT", 40, 500, "e1")
        with direct_vm.expect_revert("1 to 48 characters"):
            contract.register_policy("p", STATION, "c" * 49, "DROUGHT", 40, 500, "e1")

    def test_cover_is_exactly_one_of_the_two_perils(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        direct_vm.sender = direct_alice
        with direct_vm.expect_revert("DROUGHT or EXCESS"):
            contract.register_policy("p", STATION, "Maize", "FLOOD", 40, 500, "e1")
        with direct_vm.expect_revert("DROUGHT or EXCESS"):
            contract.register_policy("p", STATION, "Maize", "drought", 40, 500, "e1")
        assert contract.register_policy("ok", STATION, "Maize", "EXCESS", 40, 500, "e1")["cover"] == "EXCESS"

    def test_the_threshold_is_a_bounded_whole_number_of_millimetres(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        direct_vm.sender = direct_alice
        with direct_vm.expect_revert("between 1 and 2000 mm"):
            contract.register_policy("p", STATION, "Maize", "DROUGHT", 0, 500, "e1")
        with direct_vm.expect_revert("between 1 and 2000 mm"):
            contract.register_policy("p", STATION, "Maize", "DROUGHT", 2001, 500, "e1")
        with direct_vm.expect_revert("whole number of millimetres"):
            contract.register_policy("p", STATION, "Maize", "DROUGHT", True, 500, "e1")
        with direct_vm.expect_revert("whole number of millimetres"):
            contract.register_policy("p", STATION, "Maize", "DROUGHT", "40 mm", 500, "e1")
        assert contract.register_policy("ok", STATION, "Maize", "DROUGHT", 2000, 500, "e1")["threshold_mm"] == 2000

    def test_payout_units_are_bounded_whole_numbers(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        direct_vm.sender = direct_alice
        with direct_vm.expect_revert("payout units are between 1 and 1000000"):
            contract.register_policy("p", STATION, "Maize", "DROUGHT", 40, 0, "e1")
        with direct_vm.expect_revert("payout units are between 1 and 1000000"):
            contract.register_policy("p", STATION, "Maize", "DROUGHT", 40, 1000001, "e1")
        with direct_vm.expect_revert("payout units must be a whole number"):
            contract.register_policy("p", STATION, "Maize", "DROUGHT", 40, False, "e1")

    def test_an_epoch_is_a_safe_short_token(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        direct_vm.sender = direct_alice
        with direct_vm.expect_revert("an epoch is a short token"):
            contract.register_policy("p", STATION, "Maize", "DROUGHT", 40, 500, "")
        with direct_vm.expect_revert("an epoch is a short token"):
            contract.register_policy("p", STATION, "Maize", "DROUGHT", 40, 500, "a#b")
        with direct_vm.expect_revert("an epoch is a short token"):
            contract.register_policy("p", STATION, "Maize", "DROUGHT", 40, 500, "x" * 33)
        assert register(contract, direct_vm, direct_alice)["epoch"] == "2026-11"


class TestExtraction:
    def test_valid_json_and_json_text_become_the_same_canonical_object(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        assert contract.normalize_extraction('{"bucket":"DRY","mm":12}') == {"bucket": "DRY", "mm": 12}
        assert contract.normalize_extraction({"bucket": "wet", "mm": "168"}) == {"bucket": "WET", "mm": 168}

    def test_bucket_is_uppercased_and_mm_accepts_integral_values(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        assert contract.normalize_extraction({"bucket": " normal ", "mm": "74"}) == {"bucket": "NORMAL", "mm": 74}

    def test_an_unknown_bucket_or_out_of_range_mm_is_refused(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        for answer in [
            {"bucket": "FLOOD", "mm": 12},
            {"bucket": "DRY", "mm": -1},
            {"bucket": "DRY", "mm": 2001},
        ]:
            with direct_vm.expect_revert("not a usable DRY/NORMAL/WET and mm extraction"):
                contract.normalize_extraction(json.dumps(answer))

    def test_malformed_or_missing_fields_are_refused(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        for answer in ["not json at all", "null", "[]", {"bucket": "DRY"}, {"mm": 12}]:
            with direct_vm.expect_revert("not a usable DRY/NORMAL/WET and mm extraction"):
                contract.normalize_extraction(answer if isinstance(answer, str) else json.dumps(answer))


class TestSettlement:
    def test_drought_triggers_and_writes_one_payout(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        register(contract, direct_vm, direct_alice)
        row = settle(contract, direct_vm, direct_bob, "dry", "DRY", 12)

        assert row["bucket"] == "DRY" and row["mm"] == 12
        assert row["triggered"] is True and row["payout_units"] == 500
        assert row["requester"] == who(direct_bob)
        assert row["payout_count"] == 1
        assert contract.latest("maize-dry")["triggered"] is True
        ledger = contract.all_payouts(0, 10)
        assert ledger[0]["payout_id"] == "P-000001"
        assert ledger[0]["units"] == 500 and ledger[0]["mm"] == 12
        assert ledger[0]["epoch"] == "2026-11"

    def test_excess_triggers_and_writes_one_payout(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        register(contract, direct_vm, direct_alice, "rice-wet", cover="EXCESS", threshold=100, units=900)
        row = settle(contract, direct_vm, direct_alice, "wet", "WET", 168, policy_id="rice-wet")

        assert row["triggered"] is True and row["payout_units"] == 900
        ledger = contract.payouts_of("rice-wet")
        assert len(ledger) == 1 and ledger[0]["units"] == 900 and ledger[0]["bucket"] == "WET"

    def test_a_bucket_that_does_not_match_the_peril_never_pays(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        register(contract, direct_vm, direct_alice, "drought", threshold=100, units=500)
        row = settle(contract, direct_vm, direct_alice, "dry", "DRY", 12, policy_id="drought")
        assert row["triggered"] is True

        register(contract, direct_vm, direct_alice, "excess", STATION, "Rice", "EXCESS", 100, 900, "2026-11")
        row = settle(contract, direct_vm, direct_alice, "dry", "DRY", 12, policy_id="excess")
        assert row["triggered"] is False and row["payout_units"] == 0

    def test_the_wrong_side_of_the_threshold_never_pays(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        register(contract, direct_vm, direct_alice, "drought", threshold=40, units=500)
        row = settle(contract, direct_vm, direct_alice, "wet", "WET", 168, policy_id="drought")
        assert row["triggered"] is False and row["payout_units"] == 0

    def test_a_normal_bucket_never_pays_for_either_peril(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        register(contract, direct_vm, direct_alice, "drought", threshold=40, units=500)
        register(contract, direct_vm, direct_alice, "excess", STATION, "Rice", "EXCESS", 40, 900, "2026-11")
        first = settle(contract, direct_vm, direct_alice, "normal", "NORMAL", 74, policy_id="drought")
        second = settle(contract, direct_vm, direct_alice, "normal", "NORMAL", 74, policy_id="excess")
        assert first["triggered"] is False and second["triggered"] is False
        assert contract.all_payouts(0, 10) == []

    def test_threshold_boundaries_are_inclusive_in_the_right_direction(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        register(contract, direct_vm, direct_alice, "drought", threshold=40, units=500)
        register(contract, direct_vm, direct_alice, "edge-excess", STATION, "Rice", "EXCESS", 40, 900, "2026-11")
        drought = settle(contract, direct_vm, direct_alice, "edge", "DRY", 40, policy_id="drought")
        excess = settle(contract, direct_vm, direct_alice, "edge", "WET", 40, policy_id="edge-excess")
        assert drought["triggered"] is True and excess["triggered"] is True
        assert [p["payout_id"] for p in contract.all_payouts(0, 10)] == ["P-000001", "P-000002"]

    def test_a_second_request_for_the_same_epoch_is_refused(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        register(contract, direct_vm, direct_alice)
        settle(contract, direct_vm, direct_alice, "dry", "DRY", 12)
        mock_read(direct_vm, "dry", {"bucket": "DRY", "mm": 12})
        direct_vm.sender = direct_alice
        with direct_vm.expect_revert("epoch already settled"):
            contract.request_reading("maize-dry", "2026-11")
        assert len(contract.readings_of("maize-dry")) == 1
        assert len(contract.all_payouts(0, 10)) == 1

    def test_malformed_bulletin_refuses_and_stores_nothing(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        register(contract, direct_vm, direct_alice)
        mock_read(direct_vm, "malformed", "null")
        direct_vm.sender = direct_alice
        with direct_vm.expect_revert("did not agree on a usable station reading"):
            contract.request_reading("maize-dry", "2026-11")
        assert contract.readings_of("maize-dry") == []
        assert contract.all_payouts(0, 10) == []
        assert contract.stats()["readings"] == 0

    def test_an_unreachable_bulletin_refuses_and_stores_nothing(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        register(contract, direct_vm, direct_alice)
        mock_unreachable(direct_vm)
        direct_vm.sender = direct_alice
        with direct_vm.expect_revert("did not agree on a usable station reading"):
            contract.request_reading("maize-dry", "2026-11")
        assert contract.readings_of("maize-dry") == []

    def test_a_wrong_epoch_or_unknown_policy_is_refused(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        register(contract, direct_vm, direct_alice)
        direct_vm.sender = direct_alice
        with direct_vm.expect_revert("covers epoch"):
            contract.request_reading("maize-dry", "2027-01")
        with direct_vm.expect_revert("no such policy"):
            contract.request_reading("missing", "2026-11")

    def test_anyone_may_request_a_reading(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        register(contract, direct_vm, direct_alice)
        row = settle(contract, direct_vm, direct_alice, "dry", "DRY", 12)
        assert row["requester"] == who(direct_alice)
        assert contract.get_policy("maize-dry")["owner"] == who(direct_alice)


class TestViews:
    def test_reading_views_and_the_stored_policy(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        register(contract, direct_vm, direct_alice)
        settle(contract, direct_vm, direct_alice, "dry", "DRY", 12)

        assert contract.get_policy("maize-dry")["threshold_mm"] == 40
        assert contract.get_reading("maize-dry", "2026-11")["mm"] == 12
        assert contract.get_reading("maize-dry", "2027-01") is None
        assert len(contract.readings_of("maize-dry")) == 1
        assert contract.latest("maize-dry")["bucket"] == "DRY"
        assert contract.readings_of("other") == []

    def test_list_policies_is_newest_first_and_pages(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        for name in ["p-a", "p-b", "p-c"]:
            register(contract, direct_vm, direct_alice, name)
        assert [p["policy_id"] for p in contract.list_policies(0, 10)] == ["p-c", "p-b", "p-a"]
        assert [p["policy_id"] for p in contract.list_policies(1, 10)] == ["p-b", "p-a"]
        assert [p["policy_id"] for p in contract.list_policies(0, 2)] == ["p-c", "p-b"]

    def test_payout_views_and_the_ledger(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        register(contract, direct_vm, direct_alice, "one", threshold=40, units=500)
        register(contract, direct_vm, direct_alice, "two", STATION, "Rice", "EXCESS", 100, 900, "2026-11")
        settle(contract, direct_vm, direct_alice, "dry", "DRY", 12, policy_id="one")
        settle(contract, direct_vm, direct_alice, "wet", "WET", 168, policy_id="two")

        assert [p["units"] for p in contract.payouts_of("one")] == [500]
        assert [p["units"] for p in contract.payouts_of("two")] == [900]
        assert contract.payouts_of("missing") == []
        assert [p["payout_id"] for p in contract.all_payouts(0, 1)] == ["P-000001"]
        assert [p["payout_id"] for p in contract.all_payouts(1, 10)] == ["P-000002"]

    def test_stats_counts_everything_the_contract_stored(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        assert contract.stats() == {
            "policies": 0, "readings": 0, "triggered": 0,
            "payouts": 0, "payout_units": 0, "settled_epochs": 0,
        }
        register(contract, direct_vm, direct_alice, "one", threshold=40, units=500)
        register(contract, direct_vm, direct_alice, "two", STATION, "Rice", "EXCESS", 100, 900, "2026-11")
        settle(contract, direct_vm, direct_alice, "dry", "DRY", 12, policy_id="one")
        settle(contract, direct_vm, direct_alice, "normal", "NORMAL", 74, policy_id="two")
        assert contract.stats() == {
            "policies": 2, "readings": 2, "triggered": 1,
            "payouts": 1, "payout_units": 500, "settled_epochs": 1,
        }
