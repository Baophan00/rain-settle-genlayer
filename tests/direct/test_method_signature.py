import ast
from pathlib import Path

CONTRACT = Path(__file__).resolve().parents[2] / "contracts" / "rain_settle.py"


def test_every_contract_method_takes_self_and_returns_a_type():
    tree = ast.parse(CONTRACT.read_text(encoding="utf8"))
    cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "RainSettle")
    bad = []
    for node in cls.body:
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        args = [a.arg for a in node.args.args]
        if not args or args[0] != "self":
            bad.append(f"{node.name}: missing self")
        if node.returns is None:
            bad.append(f"{node.name}: missing return annotation")
    assert not bad, "; ".join(bad)


def test_only_one_contract_class_and_the_required_pragma_are_present():
    text = CONTRACT.read_text(encoding="utf8")
    tree = ast.parse(text)
    classes = [n.name for n in tree.body if isinstance(n, ast.ClassDef)]
    assert classes == ["Policy", "Reading", "Payout", "RainSettle"]
    assert text.startswith('# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }')
