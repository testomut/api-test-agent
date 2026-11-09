"""Response contract validator for generated pytest suites.

Copied verbatim by api-test-agent into tests/api/_support/. Self-contained: needs only
`jsonschema` (and `requests` responses as input). Mirrors src/contract/validator.ts.
"""
from __future__ import annotations

import copy
import json
import os
import sys
import warnings
from pathlib import Path
from typing import Any

from jsonschema import Draft7Validator, Draft202012Validator, FormatChecker, ValidationError, validators

_UNPARSEABLE = object()


def report_cleanup_failure(operation: str, resource_id: str, status: Any) -> None:
    """Test data that cleanup could not remove (it stays on the target). Never fails the test:
    the agent sets API_AGENT_CLEANUP_LOG and lists these in its report; a standalone run prints a warning."""
    log = os.environ.get("API_AGENT_CLEANUP_LOG")
    if log:
        with open(log, "a", encoding="utf-8") as f:
            f.write(json.dumps({"operation": operation, "id": str(resource_id), "status": status}) + "\n")
    else:
        print(f"cleanup failed: {operation} {resource_id} -> {status} (test data left on the target)", file=sys.stderr)


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


def fill_vars(value: Any, saved: dict) -> Any:
    """Scenario values: "{name}" alone is replaced by the saved value itself, inside a longer string by its text."""
    import re

    if isinstance(value, str):
        whole = re.fullmatch(r"\{([A-Za-z_]\w*)\}", value)
        if whole:
            return saved.get(whole.group(1))
        return re.sub(r"\{([A-Za-z_]\w*)\}", lambda m: str(saved.get(m.group(1))), value)
    if isinstance(value, list):
        return [fill_vars(v, saved) for v in value]
    if isinstance(value, dict):
        return {k: fill_vars(v, saved) for k, v in value.items()}
    return value


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


def _body(res: Any) -> tuple[str | None, Any, str]:
    content_type = res.headers.get("content-type")
    raw = res.text if res.content else ""
    if content_type and "json" in content_type:
        if not res.content:
            return content_type, None, raw
        try:
            return content_type, res.json(), raw
        except ValueError:
            return content_type, _UNPARSEABLE, raw
    return content_type, raw, raw


# Statuses that never carry a body (RFC 9110).
_NO_BODY_STATUS = {204, 205, 304}


def _drop_write_only_from_required(node: Any, seen: set | None = None) -> None:
    """Responses only: a writeOnly property is never sent back, so it is never required in a response."""
    seen = seen if seen is not None else set()
    if id(node) in seen:
        return
    if isinstance(node, list):
        seen.add(id(node))
        for n in node:
            _drop_write_only_from_required(n, seen)
        return
    if not isinstance(node, dict):
        return
    seen.add(id(node))
    props = node.get("properties")
    if isinstance(node.get("required"), list) and isinstance(props, dict):
        node["required"] = [n for n in node["required"] if not (isinstance(props.get(n), dict) and props[n].get("writeOnly") is True)]
    for v in node.values():
        _drop_write_only_from_required(v, seen)


def _write_only(validator: Any, write_only: Any, instance: Any, schema: Any):
    """writeOnly properties must not appear in a response."""
    if write_only is True:
        yield ValidationError("is writeOnly and must not appear in a response")


def _header_value(schema: Any, value: str) -> Any:
    """A header value as its schema expects it: numbers, booleans and comma-separated arrays (style: simple)."""
    types = schema.get("type", []) if isinstance(schema, dict) else []
    types = types if isinstance(types, list) else [types]

    def scalar(v: str, t: list) -> Any:
        if ("integer" in t or "number" in t) and v.strip():
            try:
                n = float(v)
                return int(n) if n.is_integer() and "integer" in t else n
            except ValueError:
                return v
        if "boolean" in t and v in ("true", "false"):
            return v == "true"
        return v

    if "array" in types:
        items = schema.get("items") or {}
        it = items.get("type", []) if isinstance(items, dict) else []
        it = it if isinstance(it, list) else [it]
        return [scalar(x.strip(), it) for x in value.split(",")]
    return scalar(value, types)


class ContractValidator:
    def __init__(self, doc: dict) -> None:
        self.is31 = str(doc.get("openapi", "")).startswith(("3.1", "3.2"))  # both use JSON Schema 2020-12
        self.doc = copy.deepcopy(doc) if self.is31 else _nullable(doc)
        _drop_write_only_from_required(self.doc)
        base = Draft202012Validator if self.is31 else Draft7Validator
        self._cls = validators.extend(base, {"writeOnly": _write_only})
        self._cache: dict[str, Any] = {}
        self.notes: list[str] = []

    def _validator(self, pointer: str) -> Any:
        v = self._cache.get(pointer)
        if v is None:
            # The whole document is the root, so "#/components/..." refs resolve; "$ref" selects the schema.
            v = self._cache[pointer] = self._cls({**self.doc, "$ref": "#" + pointer}, format_checker=FormatChecker())
        return v

    @staticmethod
    def _messages(validator: Any, instance: Any, prefix: str = "") -> list[str]:
        errors = sorted(validator.iter_errors(instance), key=lambda e: list(e.absolute_path))
        return [f"{prefix}/{'/'.join(str(p) for p in e.absolute_path) or '(root)'} {e.message}" for e in errors]

    @classmethod
    def from_file(cls, path: str | Path) -> "ContractValidator":
        return cls(json.loads(Path(path).read_text(encoding="utf-8")))

    def validate(self, method: str, path: str, status: int, content_type: str | None, body: Any, raw_text: str | None = None, headers: Any = None) -> tuple[bool, str | None, list[str]]:
        """Same rules as validator.ts. Notes on what was not checked go to self.notes."""
        op_ptr = f"/paths/{_esc(path)}/{method.lower()}"
        responses, _ = _resolve(self.doc, f"{op_ptr}/responses")
        responses = responses or {}
        code = str(status)
        matched = next((k for k in (code, f"{code[0]}XX", f"{code[0]}xx", "default") if k in responses), None)
        if matched is None:
            return False, "undocumented-status", [f"Status {code} is not documented (documented: {', '.join(responses) or 'none'})"]
        resp, resp_ptr = _resolve(self.doc, f"{op_ptr}/responses/{_esc(matched)}")
        resp = resp or {}

        # Response headers: required ones present, every documented one matching its schema.
        got = {k.lower(): v for k, v in (headers or {}).items()}
        header_errors: list[str] = []
        for name, raw_def in (resp.get("headers") or {}).items():
            if name.lower() == "content-type":
                continue  # OpenAPI: ignored, the media type decides
            hdef, hptr = _resolve(self.doc, f"{resp_ptr}/headers/{_esc(name)}")
            hdef = hdef or {}
            value = got.get(name.lower())
            if value is None:
                if hdef.get("required"):
                    header_errors.append(f'Required response header "{name}" is missing')
                continue
            if headers is None or not hdef.get("schema"):
                continue
            schema, _ = _resolve(self.doc, f"{hptr}/schema")
            header_errors += self._messages(self._validator(f"{hptr}/schema"), _header_value(schema or {}, value), f'header "{name}" ')
        if header_errors:
            return False, "header", header_errors

        # Without the raw text, the parsed body stands for it (JSON null is the text "null", not an empty body).
        raw = raw_text if raw_text is not None else ("" if body is _UNPARSEABLE else (body if isinstance(body, str) else json.dumps(body)))
        content = resp.get("content") or {}
        head = method.lower() == "head"
        # 204 / 205 / 304 and HEAD never carry a body (RFC 9110): one that arrives breaks the contract.
        if status in _NO_BODY_STATUS or head:
            if raw.strip() and not head:
                return False, "unexpected-body", [f"A body was returned but status {code} has no body ({len(raw)} bytes)"]
            return True, None, []
        # No content documented means "not described", not "no body": the body is not checked, and that is said.
        if not content:
            if raw.strip():
                self.notes.append(f"{matched}: no content documented, body not checked ({len(raw)} bytes)")
            return True, None, []
        actual = (content_type or "").split(";")[0].strip().lower()
        # Compare without parameters: "application/json; v=1.0" documents "application/json".
        base = lambda m: m.split(";")[0].strip().lower()  # noqa: E731
        media = next((k for k in content if base(k) == actual), None)
        if media is None:
            kind = actual.split("/")[0]
            media = next((k for k in content if base(k) == f"{kind}/*"), None) or next((k for k in content if base(k) == "*/*"), None)
        # A declared but undocumented Content-Type is the more precise problem; an empty body comes next.
        if not raw.strip() and (not actual or media is not None):
            if any((m or {}).get("schema") for m in content.values()):
                return False, "empty-body", [f"The body is empty but {matched} documents {', '.join(content)}"]
            return True, None, []
        if media is None:
            return False, "content-type", [f'Content-Type "{actual or "none"}" is not documented for {matched} (documented: {", ".join(content)})']
        schema_ptr = f"{resp_ptr}/content/{_esc(media)}/schema"
        if not (content.get(media) or {}).get("schema"):
            self.notes.append(f"{matched} {media}: no schema documented, body not checked")
            return True, None, []
        if base(media).startswith("text/"):
            msgs = self._messages(self._validator(schema_ptr), raw)
            return not msgs, ("schema" if msgs else None), msgs
        if "json" not in base(media):
            self.notes.append(f"{matched} {media}: media type not supported by the validator, body not checked")
            return True, None, []
        if body is _UNPARSEABLE:
            return False, "unparseable-body", ["Body is not valid JSON"]
        msgs = self._messages(self._validator(schema_ptr), body)
        return not msgs, ("schema" if msgs else None), msgs

    def expect(self, res: Any, method: str, path: str) -> Any:
        """Status, headers, content type and body must match the spec. Failures are tagged CONTRACT_MISMATCH."""
        content_type, body, raw = _body(res)
        self.notes = []
        ok, kind, errors = self.validate(method, path, res.status_code, content_type, body, raw, dict(res.headers))
        for note in self.notes:
            warnings.warn(f"contract note: {note}", stacklevel=2)
        assert ok, f"CONTRACT_MISMATCH {method.upper()} {path} ({kind}): {'; '.join(errors)}"
        return None if body is _UNPARSEABLE else body

    def expect_rejected(self, res: Any, documented: list[str], method: str, path: str) -> Any:
        """The request must be rejected with a documented status ("400", "422", "4XX"...), then match the contract."""
        s = str(res.status_code)
        ok = any(c == s or (c[1:].upper() == "XX" and c[0] == s[0]) for c in documented)
        assert ok, f"CONTRACT_MISMATCH {method.upper()} {path}: expected documented rejection {'/'.join(documented)}, got {s}"
        return self.expect(res, method, path)
