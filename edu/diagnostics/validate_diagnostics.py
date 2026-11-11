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


def topic_group_for(taxonomy, direction: str, topic: str):
    direction_map = taxonomy.get("directions", {}).get(direction, {})
    normalized = str(topic).casefold().strip()
    for rule in direction_map.get("rules", []):
        if any(str(part).casefold() in normalized for part in rule.get("containsAny", [])):
            return rule.get("groupId")
    return None


def validate_bank(path: Path, errors: list[str], stems_by_direction, taxonomy):
    filename_match = re.match(r"question-bank-(informatics|physics|math|python|html-css|figma)-(\d+)(.*)\.json$", path.name)
    if not filename_match:
        fail(errors, f"{path.name}: unrecognized bank filename")
        return None
    direction, grade, suffix = filename_match.groups()
    is_variant = bool(suffix)
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

    if is_variant:
        for field in ("bankId", "curriculumId", "curriculumYear", "reviewStatus"):
            if not isinstance(data.get(field), str) or not data[field].strip():
                fail(errors, f"{path.name}: curriculum variant missing {field}")
    seen_ids, seen_stems = set(), set()
    choice_positions = Counter()
    choice_option_lengths = set()
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

        topic = str(q.get("topic", "")).strip()
        group_id = topic_group_for(taxonomy, direction, topic)
        if not group_id:
            fail(errors, f"{prefix}: topic label is not mapped in TOPIC_TAXONOMY_DRAFT.json: {topic!r}")
        else:
            allowed_groups = {
                group.get("id") if isinstance(group, dict) else group[0]
                for group in taxonomy.get("directions", {}).get(direction, {}).get("groups", [])
                if (isinstance(group, dict) and group.get("id")) or (isinstance(group, list) and group)
            }
            if group_id not in allowed_groups:
                fail(errors, f"{prefix}: topic rule points to unknown group {group_id!r}")

        stem = re.sub(r"\\s+", " ", str(q.get("question", "")).strip().lower())
        if stem in seen_stems:
            fail(errors, f"{prefix}: duplicate question inside bank")
        seen_stems.add(stem)
        stems_by_direction[direction][stem].append((grade, path.name))

        qtype = q.get("type")
        if qtype in ("choice", "analysis"):
            options = q.get("options")
            index = q.get("correctIndex")
            if not isinstance(options, list) or len(options) < 2:
                fail(errors, f"{prefix}: choice question needs at least two options")
            elif not isinstance(index, int) or isinstance(index, bool) or not 0 <= index < len(options):
                fail(errors, f"{prefix}: correctIndex is outside options")
            elif q.get("correctText") != options[index]:
                fail(errors, f"{prefix}: correctText does not match options[correctIndex]")
            if isinstance(options, list) and isinstance(index, int) and not isinstance(index, bool) and 0 <= index < len(options):
                choice_positions[index] += 1
                choice_option_lengths.add(len(options))
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

    if not is_variant and len(choice_positions) >= 8 and choice_option_lengths == {4}:
        position_counts = [choice_positions.get(i, 0) for i in range(4)]
        if min(position_counts) == 0 or max(position_counts) - min(position_counts) > 1:
            fail(errors, f"{path.name}: correct answer positions are unbalanced: {position_counts}")

    return data


def main():
    errors = []
    stems_by_direction = defaultdict(lambda: defaultdict(list))
    profile_path = DIAG / "profiles.json"
    taxonomy_path = DIAG / "TOPIC_TAXONOMY_DRAFT.json"
    if not taxonomy_path.exists():
        fail(errors, "missing required diagnostics file: edu/diagnostics/TOPIC_TAXONOMY_DRAFT.json")
        taxonomy = {"directions": {}}
    else:
        taxonomy = json.loads(taxonomy_path.read_text(encoding="utf-8"))
    profiles = json.loads(profile_path.read_text(encoding="utf-8"))
    expected = {p["profileId"] for p in profiles.get("profiles", [])}
    if profiles.get("experienceSelectionImplemented") is not False:
        fail(errors, "experience selection must not be marked implemented until the form supports it")
    if "experienceRequiredFor" in profiles or any(d.get("experienceRequired") for d in profiles.get("directions", [])):
        fail(errors, "profiles.json must not claim experience is required while the form does not collect it")
    files = sorted(DIAG.glob("question-bank-*.json"))
    general_pattern = re.compile(r"question-bank-(informatics|physics|math|python|html-css|figma)-\d+\.json$")
    general_files = [p for p in files if general_pattern.fullmatch(p.name)]
    found = {p.stem.removeprefix("question-bank-") for p in general_files}
    if found != expected:
        fail(errors, f"profile/file mismatch: missing={sorted(expected-found)}, extra={sorted(found-expected)}")

    bank_data_by_id = {}
    for path in files:
        data = validate_bank(path, errors, stems_by_direction, taxonomy)
        if isinstance(data, dict) and data.get("bankId"):
            bank_data_by_id[data["bankId"]] = path.name

    expected_variants = {
        item.get("bankId") for item in profiles.get("curriculumVariants", [])
        if isinstance(item, dict) and item.get("bankId")
    }
    missing_variants = sorted(expected_variants - set(bank_data_by_id))
    if missing_variants:
        fail(errors, "curriculum variants missing bank files: " + ", ".join(missing_variants))
    if len(expected_variants) != len(profiles.get("curriculumVariants", [])):
        fail(errors, "curriculumVariants contains an entry without bankId")

    warnings = []
    for direction, stems in stems_by_direction.items():
        for stem, entries in stems.items():
            grades = sorted({grade for grade, _ in entries})
            if len(grades) > 1:
                filenames = sorted({filename for _, filename in entries})
                warnings.append(f"{direction}: repeated stem across grades {', '.join(grades)} in {', '.join(filenames)} — {stem[:100]}")

    worker_path = DIAG / "worker.js"
    archive_path = DIAG / "archive.html"
    privacy_path = DIAG / "privacy.html"
    migration_path = DIAG / "migrations" / "0003_curriculum_and_consent.sql"
    level_migration_path = DIAG / "migrations" / "0004_curriculum_level.sql"
    year_migration_path = DIAG / "migrations" / "0005_curriculum_year.sql"
    consent_migration_path = DIAG / "migrations" / "0006_explicit_telegram_consent.sql"
    schema_path = DIAG / "schema.sql"
    worker_test_path = DIAG / "worker.test.mjs"
    frontend_test_path = DIAG / "frontend.smoke.test.mjs"
    for required in (worker_path, archive_path, privacy_path, migration_path, level_migration_path, year_migration_path, consent_migration_path, schema_path, worker_test_path, frontend_test_path, taxonomy_path):
        if not required.exists():
            fail(errors, f"missing required diagnostics file: {required.relative_to(ROOT)}")

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

    schema_text = schema_path.read_text(encoding="utf-8") if schema_path.exists() else ""
    if "telegram_consent INTEGER NOT NULL DEFAULT 0" not in schema_text:
        fail(errors, "schema must default telegram_consent to false")
    consent_migration = consent_migration_path.read_text(encoding="utf-8") if consent_migration_path.exists() else ""
    if "telegram_consent = 0" not in consent_migration or "consent_version = 'legacy'" not in consent_migration:
        fail(errors, "migration 0006 must clear implied Telegram consent on legacy rows")

    frontend = HTML.read_text(encoding="utf-8") if HTML.exists() else ""
    required_guards = (
        "$('question').textContent=q.question;",
        "Array.isArray(data.questions)",
        "$('grade').addEventListener('change',()=>{checkReady();updateCurriculumControls();});",
        "const specificPath=curriculumBankPath(p);",
        "studentName:student,studentClass:String(grade),direction,experience:''",
        "telegramConsent:$('telegram-consent').checked",
        "async function saveAttempt(payload)",
        "CONSENT_VERSION",
        "REMOTE_SAVE_ENABLED",
        "bankProgramMatched:matched",
        "Выбран профиль «'+escapeHtml(bankMeta.curriculumName)+'», но отдельного банка пока нет.",
    )
    for guard in required_guards:
        if guard not in frontend:
            fail(errors, f"frontend regression guard missing: {guard}")
    for obsolete in ("curriculum-wrap", "curriculum-year-wrap", "curriculum-level-wrap", "experience-wrap", "selectedCurriculum()"):
        if obsolete in frontend:
            fail(errors, f"simple diagnostic form must not contain: {obsolete}")
    if "Тест-диагностика по информатике" in frontend:
        fail(errors, "obsolete informatics-only diagnostic title remains")

    worker_path = DIAG / "worker.js"
    archive_path = DIAG / "archive.html"
    privacy_path = DIAG / "privacy.html"
    migration_path = DIAG / "migrations" / "0003_curriculum_and_consent.sql"
    level_migration_path = DIAG / "migrations" / "0004_curriculum_level.sql"
    year_migration_path = DIAG / "migrations" / "0005_curriculum_year.sql"
    consent_migration_path = DIAG / "migrations" / "0006_explicit_telegram_consent.sql"
    schema_path = DIAG / "schema.sql"
    worker_test_path = DIAG / "worker.test.mjs"
    frontend_test_path = DIAG / "frontend.smoke.test.mjs"
    for required in (worker_path, archive_path, privacy_path, migration_path, level_migration_path, year_migration_path, consent_migration_path, schema_path, worker_test_path, frontend_test_path):
        if not required.exists():
            fail(errors, f"missing required diagnostics component: {required.relative_to(ROOT)}")
    if worker_path.exists():
        worker_text = worker_path.read_text(encoding="utf-8")
        for required in ('curriculum_id', 'curriculum_name', 'curriculum_year', 'const curriculumLevel = clean(p.curriculumLevel, 20)', 'telegramConsent', 'telegramNotRequested', 'DELETE', 'async scheduled'):
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
    print("Topic taxonomy coverage: every question topic label must map to a declared group.")
    if warnings:
        fail(errors, f"cross-grade duplicate question stems found: {len(warnings)}")
        by_direction = Counter()
        for warning in warnings:
            match = re.match(r"([^:]+): repeated stem", warning)
            if match:
                by_direction[match.group(1)] += 1
        print(f"Cross-grade duplicate stems: {len(warnings)}")
        print("By direction: " + ", ".join(f"{name}={count}" for name, count in sorted(by_direction.items())))
        print(f"Warnings (first {min(100, len(warnings))}):")
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
