"""Static analysis of existing pytest API tests (requests / httpx / sessions), no AI.

Called by api-test-agent with a JSON list of files on stdin; prints JSON on stdout in the same
shape as the Playwright analyser: tests (calls, asserted statuses, preconditions), data-flow
edges and quality issues. Uses only the standard library (ast), Python 3.9+.
"""
from __future__ import annotations

import ast
import json
import re
import sys
from pathlib import Path

HTTP = {"get", "post", "put", "patch", "delete", "head"}
REQUESTISH = re.compile(r"request|session|client|api|http|^s$|req", re.I)
NOT_REQUEST = {"dict", "os", "environ", "headers", "params", "json", "data", "kwargs", "config", "cache", "self.headers"}
SECRET = re.compile(r"Bearer\s+[A-Za-z0-9._~+/-]{12,}|^(sk|pk|api|key|token)[-_][A-Za-z0-9]{16,}$")
ABS_URL = re.compile(r"^https?://(?!localhost|127\.0\.0\.1)[\w.-]+")
CLEANUP_NAME = re.compile(r"delete|remove|cleanup|teardown|destroy", re.I)

_next_id = [1]


def new_id() -> int:
    _next_id[0] += 1
    return _next_id[0]


def unparse(node: ast.AST) -> str:
    try:
        return ast.unparse(node)
    except Exception:  # noqa: BLE001
        return "?"


def strip_quote(expr: str) -> str:
    m = re.match(r"^(?:urllib\.parse\.)?quote\((.*?)(?:,\s*safe=.*)?\)$", expr)
    expr = m.group(1) if m else expr
    m = re.match(r"^str\((.*)\)$", expr)
    return m.group(1) if m else expr


def url_template(node: ast.AST | None) -> str | None:
    if node is None:
        return None
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):
        out = ""
        for v in node.values:
            if isinstance(v, ast.Constant):
                out += str(v.value)
            elif isinstance(v, ast.FormattedValue):
                out += "{" + strip_quote(unparse(v.value)) + "}"
        return out
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left = url_template(node.left) or "{" + unparse(node.left) + "}"
        right = url_template(node.right) or "{" + unparse(node.right) + "}"
        return left + right
    if isinstance(node, ast.Call) and unparse(node.func).endswith("urljoin") and len(node.args) == 2:
        return url_template(node.args[1])
    return None


def names_in(node: ast.AST) -> list[str]:
    out = []
    for n in ast.walk(node):
        if isinstance(n, ast.Name):
            out.append(n.id)
        elif isinstance(n, ast.Attribute):
            out.append(n.attr)
    return out


def is_fixture(fn: ast.AST) -> tuple[bool, bool]:
    """(is fixture, autouse)"""
    for d in getattr(fn, "decorator_list", []):
        text = unparse(d)
        if "fixture" in text:
            return True, "autouse=True" in text
    return False, False


class Analyzer:
    def __init__(self) -> None:
        self.helpers: dict[str, dict] = {}  # name -> {calls, returns, fixture, autouse, file}

    # ------------------------------------------------------------- function analysis
    def analyze_function(self, fn: ast.AST, file: str, via: str | None, taint: dict, edges: list, cleanup_ctx: bool = False) -> dict:
        calls: list[dict] = []
        asserted: list[dict] = []
        body_assertions = 0
        returns = None
        after_yield = [False]
        locals_: set[str] = {a.arg for a in getattr(getattr(fn, "args", None), "args", [])}
        assigned_globals: set[str] = set()
        read_vars: set[str] = set()
        global_names: set[str] = set()
        call_of: dict[int, dict] = {}  # id(ast.Call) -> call

        def source_of(node: ast.AST):
            for n in ast.walk(node):
                if isinstance(n, ast.Call) and id(n) in call_of:
                    return call_of[id(n)]
                if isinstance(n, ast.Name) and n.id in taint:
                    return taint[n.id]
                if isinstance(n, ast.Attribute) and n.attr in taint and isinstance(n.value, ast.Name) and n.value.id in ("self", "cls"):
                    return taint[n.attr]
            return None

        def visit_call(node: ast.Call, in_finally: bool) -> None:
            nonlocal body_assertions
            func = node.func
            name = func.attr if isinstance(func, ast.Attribute) else func.id if isinstance(func, ast.Name) else None
            obj = unparse(func.value) if isinstance(func, ast.Attribute) else ""
            # Direct HTTP call
            method = None
            url_node = node.args[0] if node.args else next((k.value for k in node.keywords if k.arg == "url"), None)
            if name in HTTP:
                method = name.upper()
            elif name == "request" and len(node.args) >= 2 and isinstance(node.args[0], ast.Constant):
                method, url_node = str(node.args[0].value).upper(), node.args[1]
            if method:
                url = url_template(url_node)
                obj_last = obj.split(".")[-1]
                plausible = url is not None and obj not in NOT_REQUEST and obj_last not in NOT_REQUEST and (REQUESTISH.search(obj_last or "") or "/" in url or obj in ("requests", "httpx"))
                if plausible:
                    call = {"id": new_id(), "method": method, "path": url, "line": node.lineno, "via": via, "cleanup": cleanup_ctx or in_finally or after_yield[0]}
                    calls.append(call)
                    call_of[id(node)] = call
                    for v in names_in(url_node):
                        read_vars.add(v)
                        src = taint.get(v)
                        if src and src is not call:
                            edges.append({"from": src["id"], "to": call["id"], "variable": v})
                    return
            # Helper / fixture function called directly
            helper = self.helpers.get(name or "")
            if helper and name != via and not helper["fixture"]:
                cleanup = cleanup_ctx or in_finally or after_yield[0] or bool(CLEANUP_NAME.search(name))
                copies = [{**c, "id": new_id(), "via": name, "cleanup": cleanup or c["cleanup"]} for c in helper["calls"]]
                for arg in [*node.args, *(k.value for k in node.keywords)]:
                    for v in names_in(arg):
                        src = taint.get(v)
                        if src:
                            for c in copies:
                                if "{" in c["path"]:
                                    edges.append({"from": src["id"], "to": c["id"], "variable": v})
                calls.extend(copies)
                if helper["returns"] is not None:
                    idx = next((i for i, c in enumerate(helper["calls"]) if c["id"] == helper["returns"]["id"]), None)
                    if idx is not None:
                        call_of[id(node)] = copies[idx]
            # raise_for_status() asserts a 2xx
            if name == "raise_for_status":
                target = source_of(func.value) if isinstance(func, ast.Attribute) else None
                if target:
                    asserted.append({"call": target["id"], "statuses": [200]})
            # api-test-agent contract helpers
            if name in ("expect", "expect_rejected") and node.args:
                target = source_of(node.args[0])
                if target:
                    body_assertions += 1
                    if name == "expect_rejected":
                        asserted.append({"call": target["id"], "statuses": [400]})
                    elif not any(a["call"] == target["id"] for a in asserted):
                        asserted.append({"call": target["id"], "statuses": [200]})

        def status_numbers(node: ast.AST) -> list[int]:
            out = []
            for n in ast.walk(node):
                if isinstance(n, ast.Constant) and isinstance(n.value, int) and 100 <= n.value < 600:
                    out.append(n.value)
            return out

        def visit_assert(node: ast.Assert) -> None:
            nonlocal body_assertions
            test = node.test
            text = unparse(test)
            if re.search(r"status_code|\.ok\b|\.status\b|is_success", text):
                target = source_of(test)
                nums = status_numbers(test)
                if target:
                    asserted.append({"call": target["id"], "statuses": nums or [200]})
                return
            body_assertions += 1

        class Visitor(ast.NodeVisitor):
            def __init__(self) -> None:
                self.finally_depth = 0

            def visit_Try(self, node: ast.Try) -> None:  # noqa: N802
                for stmt in [*node.body, *node.orelse]:
                    self.visit(stmt)
                for h in node.handlers:
                    self.visit(h)
                self.finally_depth += 1
                for stmt in node.finalbody:
                    self.visit(stmt)
                self.finally_depth -= 1

            def visit_FunctionDef(self, node):  # noqa: N802 - nested defs are analysed with their parent
                self.generic_visit(node)

            def visit_Global(self, node: ast.Global) -> None:  # noqa: N802
                global_names.update(node.names)

            def visit_Call(self, node: ast.Call) -> None:  # noqa: N802
                self.generic_visit(node)  # inner calls first (argument values)
                visit_call(node, self.finally_depth > 0)

            def visit_Assert(self, node: ast.Assert) -> None:  # noqa: N802
                self.generic_visit(node)
                visit_assert(node)

            def _assign(self, targets: list[ast.AST], value: ast.AST | None) -> None:
                if value is None:
                    return
                self.visit(value)
                src = source_of(value)
                for t in targets:
                    names = [t.attr] if isinstance(t, ast.Attribute) else [n.id for n in ast.walk(t) if isinstance(n, ast.Name)]
                    for n in names:
                        if isinstance(t, ast.Name) and n not in global_names:
                            locals_.add(n)
                        elif n in global_names or isinstance(t, ast.Attribute):
                            assigned_globals.add(n)
                        if src:
                            taint[n] = src

            def visit_Assign(self, node: ast.Assign) -> None:  # noqa: N802
                self._assign(node.targets, node.value)

            def visit_AnnAssign(self, node: ast.AnnAssign) -> None:  # noqa: N802
                self._assign([node.target], node.value)

            def visit_Return(self, node: ast.Return) -> None:  # noqa: N802
                nonlocal returns
                if node.value is not None:
                    self.visit(node.value)
                    returns = source_of(node.value) or returns

            def visit_Expr(self, node: ast.Expr) -> None:  # noqa: N802
                nonlocal returns
                if isinstance(node.value, (ast.Yield, ast.YieldFrom)):
                    if node.value.value is not None:
                        self.visit(node.value.value)
                        returns = source_of(node.value.value) or returns
                    after_yield[0] = True  # everything after yield in a fixture is teardown
                    return
                self.generic_visit(node)

        v = Visitor()
        for stmt in getattr(fn, "body", []):
            v.visit(stmt)
        return {"calls": calls, "asserted": asserted, "body": body_assertions, "returns": returns, "assigned": assigned_globals, "read": read_vars}

    # ------------------------------------------------------------- pass 1: helpers and fixtures
    def index(self, file: str, tree: ast.Module) -> None:
        def add(fn, prefix=""):
            fixture, autouse = is_fixture(fn)
            r = self.analyze_function(fn, file, fn.name, {}, [], False)
            if r["calls"]:
                self.helpers[fn.name] = {
                    "calls": r["calls"],
                    "returns": r["returns"] or next((c for c in r["calls"] if c["method"] == "POST" and not c["cleanup"]), None) or (r["calls"][-1] if not fixture else None),
                    "fixture": fixture,
                    "autouse": autouse,
                    "file": file,
                }

        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and not node.name.startswith("test_"):
                add(node)
            elif isinstance(node, ast.ClassDef):
                for m in node.body:
                    if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef)) and not m.name.startswith("test_") and not m.name.startswith(("setup", "teardown")):
                        add(m)

    # ------------------------------------------------------------- pass 2: tests
    def analyze_file(self, file: str, tree: ast.Module, conftest_autouse: list[str]) -> dict:
        edges: list[dict] = []
        tests: list[dict] = []
        issues: list[dict] = []
        writers: dict[str, str] = {}
        module_autouse = [n.name for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and is_fixture(n)[1]]

        def fixture_pre(params: list[str], taint: dict) -> list[dict]:
            pre = []
            for name in [*conftest_autouse, *module_autouse, *params]:
                h = self.helpers.get(name)
                if not h or not h["fixture"]:
                    continue
                copies = [{**c, "id": new_id(), "via": name} for c in h["calls"]]
                pre.extend(copies)
                if h["returns"] is not None:
                    idx = next((i for i, c in enumerate(h["calls"]) if c["id"] == h["returns"]["id"]), None)
                    if idx is not None:
                        taint[name] = copies[idx]
            return pre

        def run_test(fn, title: str, base_taint: dict, hook_calls: list[dict]) -> None:
            taint = dict(base_taint)
            params = [a.arg for a in fn.args.args if a.arg not in ("self", "cls")]
            pre = [*[c for c in hook_calls if not c["cleanup"]], *fixture_pre(params, taint)]
            r = self.analyze_function(fn, file, None, taint, edges)
            for v in r["assigned"]:
                writers.setdefault(v, title)
            for v in r["read"]:
                w = writers.get(v)
                if w and w != title:
                    issues.append({"file": file, "line": fn.lineno, "code": "order-dependent", "message": f'"{title}" uses "{v}" set by another test ("{w}"): it fails when run alone or in parallel.'})
            first = r["asserted"][0]["statuses"] if r["asserted"] else []
            polarity = "negative" if any(400 <= s < 500 for s in first) else "positive" if any(200 <= s < 300 for s in first) else "unknown"
            if r["calls"] and not r["asserted"] and not r["body"]:
                issues.append({"file": file, "line": fn.lineno, "code": "no-assertion", "message": f'"{title}" calls the API but asserts nothing.'})
            elif r["calls"] and r["asserted"] and not r["body"] and polarity != "negative":
                issues.append({"file": file, "line": fn.lineno, "code": "status-only", "message": f'"{title}" checks only the status code, not the response body.'})
            tests.append({"file": file, "title": title, "line": fn.lineno, "calls": r["calls"], "preconditions": pre, "asserted": r["asserted"], "polarity": polarity, "bodyAssertions": r["body"]})

        hook_seen: list[dict] = []  # setup/teardown calls, for the cleanup check
        module_taint: dict = {}
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith("test_"):
                run_test(node, node.name, module_taint, [])
            elif isinstance(node, ast.ClassDef) and node.name.startswith("Test"):
                class_taint = dict(module_taint)
                hook_calls: list[dict] = []
                methods = [m for m in node.body if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef))]
                for m in methods:
                    if m.name in ("setup_class", "setup_method", "setup", "setUp", "setUpClass"):
                        hook_calls.extend(self.analyze_function(m, file, None, class_taint, edges)["calls"])
                    elif m.name in ("teardown_class", "teardown_method", "teardown", "tearDown", "tearDownClass"):
                        hook_calls.extend(self.analyze_function(m, file, None, class_taint, edges, cleanup_ctx=True)["calls"])
                hook_seen.extend(hook_calls)
                for m in methods:
                    if m.name.startswith("test_"):
                        run_test(m, f"{node.name}::{m.name}", class_taint, hook_calls)

        # File-level issues
        for n in ast.walk(tree):
            if isinstance(n, ast.Call) and unparse(n.func) in ("time.sleep", "sleep"):
                issues.append({"file": file, "line": n.lineno, "code": "wait-for-timeout", "message": "time.sleep: fixed wait, poll for a condition instead."})
            if isinstance(n, ast.Constant) and isinstance(n.value, str):
                if SECRET.search(n.value):
                    issues.append({"file": file, "line": n.lineno, "code": "hardcoded-secret", "message": "Hard-coded token/key: read it from an environment variable."})
                if ABS_URL.match(n.value):
                    issues.append({"file": file, "line": n.lineno, "code": "hardcoded-url", "message": f"Hard-coded URL {n.value[:60]}: use API_BASE_URL."})
        all_calls = [*hook_seen, *[c for t in tests for c in [*t["calls"], *t["preconditions"]]]]
        # A create that the test expects to be REJECTED (4xx) creates nothing.
        rejected = {a["call"] for t in tests for a in t["asserted"] if a["statuses"] and all(s >= 400 for s in a["statuses"])}
        creates = [c for c in all_calls if c["method"] == "POST" and not c["cleanup"] and c["id"] not in rejected]
        if creates and not any(c["method"] == "DELETE" for c in all_calls):
            # Also count deletes in fixtures used by these tests (teardown after yield).
            issues.append({"file": file, "line": creates[0]["line"], "code": "no-cleanup", "message": f'Creates data ({creates[0]["method"]} {creates[0]["path"]}) but never deletes it: leftovers accumulate and tests interfere.'})
        seen = set()
        unique = []
        for i in issues:
            k = (i["code"], i.get("line"), i["message"])
            if k not in seen:
                seen.add(k)
                unique.append(i)
        return {"tests": tests, "edges": edges, "issues": unique}


def main() -> None:
    req = json.load(sys.stdin)
    root = Path(req["root"])
    analyzer = Analyzer()
    trees: dict[str, ast.Module] = {}
    issues: list[dict] = []
    for f in [*req["support"], *req["tests"]]:
        try:
            trees[f] = ast.parse((root / f).read_text(encoding="utf-8"), filename=f)
        except Exception as e:  # noqa: BLE001
            issues.append({"file": f, "code": "parse-error", "message": str(e)})
    for _ in range(2):  # helpers that call helpers
        for f, tree in trees.items():
            analyzer.index(f, tree)
    autouse = [name for name, h in analyzer.helpers.items() if h["autouse"] and Path(h["file"]).name == "conftest.py"]
    out = {"tests": [], "edges": [], "issues": issues}
    for f in req["tests"]:
        if f not in trees:
            continue
        r = analyzer.analyze_file(f, trees[f], autouse)
        out["tests"].extend(r["tests"])
        out["edges"].extend(r["edges"])
        out["issues"].extend(r["issues"])
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
