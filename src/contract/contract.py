"""Response contract validator for generated pytest suites.

Copied verbatim by api-test-agent into tests/api/_support/. Self-contained: needs only
`jsonschema` (and `requests` responses as input). Mirrors src/contract/validator.ts.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

from jsonschema import Draft7Validator, Draft202012Validator, FormatChecker

_UNPARSEABLE = object()


def _esc(part: str) -> str:
    return part.replace("~", "~0").replace("/", "~1")


def _unesc(part: str) -> str:
    return part.replace("~1", "/").replace("~0", "~")


def _resolve(doc: Any, pointer: str, depth: int = 0) -> tuple[Any, str]:
    """Resolve a JSON pointer, following whole-object local $refs. Returns (node, final pointer)."""
    node, current = doc, ""
    for raw in pointer.split("/")[1:]:
        if isinstance(node, dict) and isinstance(node.get("$ref"), str) and depth < 20:
            node, current = _resolve(doc, node["$ref"][1:], depth + 1)
        if node is None:
            return None, current
        part = _unesc(raw)
        node = node.get(part) if isinstance(node, dict) else None
        current += "/" + _esc(part)
    if isinstance(node, dict) and isinstance(node.get("$ref"), str) and depth < 20:
        return _resolve(doc, node["$ref"][1:], depth + 1)
    return node, current


def _nullable(node: Any) -> Any:
    """OpenAPI 3.0 `nullable: true` -> JSON Schema `type: [T, "null"]`."""
    if isinstance(node, list):
        return [_nullable(n) for n in node]
    if not isinstance(node, dict):
        return node
    out = {k: _nullable(v) for k, v in node.items()}
    if out.get("nullable") is True:
        out.pop("nullable")
        if isinstance(out.get("type"), str):
            out["type"] = [out["type"], "null"]
        if isinstance(out.get("enum"), list) and None not in out["enum"]:
            out["enum"] = [*out["enum"], None]
        if "type" not in out and "enum" not in out and any(k in out for k in ("allOf", "oneOf", "anyOf", "$ref")):
            return {"anyOf": [out, {"type": "null"}]}
    return out


def read_pointer(body: Any, pointer: str) -> Any:
    node = body
    for raw in pointer.split("/")[1:]:
        if node is None:
            return None
        key = _unesc(raw)
        if isinstance(node, list):
            node = node[int(key)] if key.isdigit() and int(key) < len(node) else None
        else:
            node = node.get(key) if isinstance(node, dict) else None
    return node


def _body(res: Any) -> tuple[str | None, Any]:
    content_type = res.headers.get("content-type")
    if content_type and "json" in content_type:
        if not res.content:
            return content_type, None
        try:
            return content_type, res.json()
        except ValueError:
            return content_type, _UNPARSEABLE
    return content_type, res.text


class ContractValidator:
    def __init__(self, doc: dict) -> None:
        self.is31 = str(doc.get("openapi", "")).startswith(("3.1", "3.2"))  # both use JSON Schema 2020-12
        self.doc = copy.deepcopy(doc) if self.is31 else _nullable(doc)
        self._cache: dict[str, Any] = {}

    @classmethod
    def from_file(cls, path: str | Path) -> "ContractValidator":
        return cls(json.loads(Path(path).read_text(encoding="utf-8")))

    def validate(self, method: str, path: str, status: int, content_type: str | None, body: Any) -> tuple[bool, str | None, list[str]]:
        op_ptr = f"/paths/{_esc(path)}/{method.lower()}"
        responses, _ = _resolve(self.doc, f"{op_ptr}/responses")
        responses = responses or {}
        code = str(status)
        matched = next((k for k in (code, f"{code[0]}XX", f"{code[0]}xx", "default") if k in responses), None)
        if matched is None:
            return False, "undocumented-status", [f"Status {code} is not documented (documented: {', '.join(responses) or 'none'})"]
        resp, resp_ptr = _resolve(self.doc, f"{op_ptr}/responses/{_esc(matched)}")
        content = (resp or {}).get("content") or {}
        if not content:
            return True, None, []
        actual = (content_type or "").split(";")[0].strip().lower()
        # Compare without parameters: "application/json; v=1.0" documents "application/json".
        base = lambda m: m.split(";")[0].strip().lower()  # noqa: E731
        media = next((k for k in content if base(k) == actual), None)
        if media is None:
            kind = actual.split("/")[0]
            media = next((k for k in content if base(k) == f"{kind}/*"), None) or next((k for k in content if base(k) == "*/*"), None)
        if media is None:
            return False, "content-type", [f'Content-Type "{actual or "none"}" is not documented for {matched} (documented: {", ".join(content)})']
        if "json" not in media or not (content.get(media) or {}).get("schema"):
            return True, None, []
        if body is _UNPARSEABLE:
            return False, "unparseable-body", ["Body is not valid JSON"]
        schema_ptr = f"{resp_ptr}/content/{_esc(media)}/schema"
        validator = self._cache.get(schema_ptr)
        if validator is None:
            # The whole document is the root, so "#/components/..." refs resolve; "$ref" selects the response schema.
            root = {**self.doc, "$ref": "#" + schema_ptr}
            cls = Draft202012Validator if self.is31 else Draft7Validator
            validator = self._cache[schema_ptr] = cls(root, format_checker=FormatChecker())
        errors = sorted(validator.iter_errors(body), key=lambda e: list(e.absolute_path))
        msgs = [f"/{'/'.join(str(p) for p in e.absolute_path) or '(root)'} {e.message}" for e in errors]
        return not msgs, ("schema" if msgs else None), msgs

    def expect(self, res: Any, method: str, path: str) -> Any:
        """Status, content type and body must match the spec. Failures are tagged CONTRACT_MISMATCH."""
        content_type, body = _body(res)
        ok, kind, errors = self.validate(method, path, res.status_code, content_type, body)
        assert ok, f"CONTRACT_MISMATCH {method.upper()} {path} ({kind}): {'; '.join(errors)}"
        return None if body is _UNPARSEABLE else body

    def expect_rejected(self, res: Any, documented: list[str], method: str, path: str) -> Any:
        """The request must be rejected with a documented status ("400", "422", "4XX"...), then match the contract."""
        s = str(res.status_code)
        ok = any(c == s or (c[1:].upper() == "XX" and c[0] == s[0]) for c in documented)
        assert ok, f"CONTRACT_MISMATCH {method.upper()} {path}: expected documented rejection {'/'.join(documented)}, got {s}"
        return self.expect(res, method, path)
