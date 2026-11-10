#!/usr/bin/env python3
"""Structural validation for the Mischenko Edu diagnostic banks.

This deliberately does not claim pedagogical validation: subject accuracy,
curriculum alignment and age appropriateness still require expert review.
"""
from __future__ import annotations

import json
import re
import subprocess
import tempfile
from collections import Counter, defaultdict
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DIAG = ROOT / "edu" / "diagnostics"
HTML = ROOT / "edu" / "diagnostika.html"
EXPECTED_DISTRIBUTION = {"basic": 5, "medium": 7, "advanced": 3}
EXPECTED_COUNT = 15


class ScriptExtractor(HTMLParser):
    def __init__(self):
        super().__init__()
        self.in_script = False
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag.lower() == "script":
            self.in_script = True

    def handle_endtag(self, tag):
        if tag.lower() == "script":
            self.in_script = False

    def handle_data(self, data):
        if self.in_script:
            self.parts.append(data)


def fail(errors, message):
    errors.append(message)


def validate_bank(path: Path, errors: list[str], stems_by_direction):
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        fail(errors, f"{path.name}: invalid JSON ({exc})")
        return None

    questions = data.get("questions") if isinstance(data, dict) else None
    if not isinstance(questions, list):
        fail(errors, f"{path.name}: missing questions array")
        return None
    if len(questions) != EXPECTED_COUNT:
        fail(errors, f"{path.name}: expected 15 questions, got {len(questions)}")

    counts = Counter(q.get("difficulty") for q in questions if isinstance(q, dict))
    if dict(counts) != EXPECTED_DISTRIBUTION:
        fail(errors, f"{path.name}: difficulty distribution is {dict(counts)}")

    seen_ids, seen_stems = set(), set()
    direction = data.get("direction", path.name.split("-")[2])
    for number, q in enumerate(questions, 1):
        prefix = f"{path.name} Q{number}"
        if not isinstance(q, dict):
            fail(errors, f"{prefix}: question is not an object")
            continue
        for field in ("id", "topic", "skill", "difficulty", "type", "question", "explanation"):
            if not isinstance(q.get(field), str) or not q[field].strip():
                fail(errors, f"{prefix}: missing/empty {field}")
        qid = q.get("id")
        if qid in seen_ids:
            fail(errors, f"{prefix}: duplicate id {qid}")
        seen_ids.add(qid)

        stem = re.sub(r"\\s+", " ", str(q.get("question", "")).strip().lower())
        if stem in seen_stems:
            fail(errors, f"{prefix}: duplicate question inside bank")
        seen_stems.add(stem)
        stems_by_direction[direction][stem].append(path.name)

        qtype = q.get("type")
        if qtype in ("choice", "analysis"):
            options = q.get("options")
            index = q.get("correctIndex")
            if not isinstance(options, list) or len(options) < 2:
                fail(errors, f"{prefix}: choice question needs at least two options")
            elif not isinstance(index, int) or isinstance(index, bool) or not 0 <= index < len(options):
                fail(errors, f"{prefix}: correctIndex is outside options")
            if not isinstance(q.get("correctText"), str) or not q["correctText"].strip():
                fail(errors, f"{prefix}: missing correctText")
        elif qtype == "short":
            accepted = q.get("acceptedAnswers")
            if not isinstance(accepted, list) or not accepted:
                fail(errors, f"{prefix}: short question needs acceptedAnswers")
            if not isinstance(q.get("correctText"), str) or not q["correctText"].strip():
                fail(errors, f"{prefix}: missing correctText")
        else:
            fail(errors, f"{prefix}: unsupported question type {qtype!r}")

    return data


def main():
    errors = []
    stems_by_direction = defaultdict(lambda: defaultdict(list))
    profile_path = DIAG / "profiles.json"
    profiles = json.loads(profile_path.read_text(encoding="utf-8"))
    expected = {p["profileId"] for p in profiles.get("profiles", [])}
    files = sorted(DIAG.glob("question-bank-*.json"))
    found = {p.stem.removeprefix("question-bank-") for p in files}
    if found != expected:
        fail(errors, f"profile/file mismatch: missing={sorted(expected-found)}, extra={sorted(found-expected)}")

    for path in files:
        validate_bank(path, errors, stems_by_direction)

    # Cross-grade duplicates are warnings, not failures: some foundational skills
    # legitimately recur, but the author should verify that the task itself changes.
    warnings = []
    for direction, stems in stems_by_direction.items():
        for stem, filenames in stems.items():
            unique_files = sorted(set(filenames))
            if len(unique_files) > 1:
                warnings.append(f"{direction}: repeated stem in {', '.join(unique_files)} — {stem[:100]}")

    for html_path in (HTML, DIAG / "archive.html"):
        if not html_path.exists():
            fail(errors, f"missing {html_path.relative_to(ROOT)}")
            continue
        parser = ScriptExtractor()
        parser.feed(html_path.read_text(encoding="utf-8"))
        js = "\\n".join(parser.parts)
        if not js.strip():
            fail(errors, f"no inline JavaScript found in {html_path.relative_to(ROOT)}")
            continue
        with tempfile.NamedTemporaryFile("w", suffix=".js", encoding="utf-8", delete=False) as tmp:
            tmp.write(js)
            temp_name = tmp.name
        try:
            check = subprocess.run(["node", "--check", temp_name], capture_output=True, text=True)
            if check.returncode:
                fail(errors, f"JavaScript syntax check failed in {html_path.name}: " + (check.stderr.strip() or check.stdout.strip()))
        except FileNotFoundError:
            warnings.append("Node.js is unavailable; skipped JavaScript syntax checks")
        finally:
            Path(temp_name).unlink(missing_ok=True)

    worker = DIAG / "worker.js"
    if worker.exists():
        with tempfile.NamedTemporaryFile("w", suffix=".mjs", encoding="utf-8", delete=False) as tmp:
            tmp.write(worker.read_text(encoding="utf-8"))
            worker_temp = tmp.name
        try:
            check = subprocess.run(["node", "--check", worker_temp], capture_output=True, text=True)
            if check.returncode:
                fail(errors, "Worker JavaScript syntax check failed: " + (check.stderr.strip() or check.stdout.strip()))
        except FileNotFoundError:
            warnings.append("Node.js is unavailable; skipped Worker syntax check")
        finally:
            Path(worker_temp).unlink(missing_ok=True)

    frontend = HTML.read_text(encoding="utf-8") if HTML.exists() else ""
    required_guards = (
        "experience=p.direction.experience?$('experience').value:''",
        "$('experience').value='';",
        "$('question').textContent=q.question;",
        "Array.isArray(data.questions)",
        "function selectedCurriculum()",
        "curriculumId,curriculumName,curriculumDetail,curriculumLevel",
        "telegramConsent:$('telegram-consent').checked",
        "curriculum-level-wrap",
        "curriculumLevel: clean(p.curriculumLevel, 20)",
        "async function saveAttempt(payload)",
        "CONSENT_VERSION",
    )
    for guard in required_guards:
        if guard not in frontend:
            fail(errors, f"frontend regression guard missing: {guard}")
    if "Тест-диагностика по информатике" in frontend:
        fail(errors, "obsolete informatics-only diagnostic title remains")

    worker_path = DIAG / "worker.js"
    archive_path = DIAG / "archive.html"
    privacy_path = DIAG / "privacy.html"
    migration_path = DIAG / "migrations" / "0003_curriculum_and_consent.sql"
    level_migration_path = DIAG / "migrations" / "0004_curriculum_level.sql"
    for required in (worker_path, archive_path, privacy_path, migration_path, level_migration_path):
        if not required.exists():
            fail(errors, f"missing required diagnostics component: {required.relative_to(ROOT)}")
    if worker_path.exists():
        worker_text = worker_path.read_text(encoding="utf-8")
        for required in ('curriculum_id', 'curriculum_name', 'telegramConsent', 'telegramNotRequested', 'DELETE', 'async scheduled'):
            if required not in worker_text:
                fail(errors, f"Worker missing required feature marker: {required}")
    if archive_path.exists():
        archive_text = archive_path.read_text(encoding="utf-8")
        for required in ('data-compare', 'data-delete', 'compareAttempts', 'curriculum_name'):
            if required not in archive_text:
                fail(errors, f"archive missing required feature marker: {required}")
    if privacy_path.exists():
        privacy_text = privacy_path.read_text(encoding="utf-8")
        if '180 дней' not in privacy_text or '@katerin_mischenko' not in privacy_text:
            fail(errors, "privacy notice is missing retention or contact information")

    print(f"Checked {len(files)} question banks.")
    print(f"Expected profile count: {len(expected)}.")
    if warnings:
        print(f"Warnings ({len(warnings)}):")
        for warning in warnings[:100]:
            print(" - " + warning)
    if errors:
        print(f"FAILED ({len(errors)} errors):")
        for error in errors:
            print(" - " + error)
        raise SystemExit(1)
    print("Structural checks passed. Pedagogical review is still required.")


if __name__ == "__main__":
    main()
