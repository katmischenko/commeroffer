#!/usr/bin/env python3
"""Structural validation for the supplementary diagnostic question pool.

This validates structure, taxonomy mapping and exact-stem duplication only.
It does not certify pedagogical quality or curriculum alignment.
"""
from __future__ import annotations
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DIAG = ROOT / "edu" / "diagnostics"
POOL = DIAG / "skill-question-pool-draft.json"


def normalize(text: str) -> str:
    return re.sub(r"\\s+", " ", str(text).strip().casefold())


def group_for(taxonomy: dict, direction_id: str, label: str):
    direction = taxonomy.get("directions", {}).get(direction_id, {})
    normalized = normalize(label)
    for rule in direction.get("rules", []):
        if any(normalize(part) in normalized for part in rule.get("containsAny", [])):
            return rule.get("groupId")
    return None


def topic_group_for(taxonomy: dict, direction_id: str, label: str):
    direction = taxonomy.get("directions", {}).get(direction_id, {})
    normalized = normalize(label)
    for rule in direction.get("rules", []):
        if any(normalize(part) in normalized for part in rule.get("containsAny", [])):
            return rule.get("groupId")
    return None


def main():
    errors = []
    pool = json.loads(POOL.read_text(encoding="utf-8"))
    skills = json.loads((DIAG / "SKILL_TAXONOMY_DRAFT.json").read_text(encoding="utf-8"))
    topics = json.loads((DIAG / "TOPIC_TAXONOMY_DRAFT.json").read_text(encoding="utf-8"))
    questions = pool.get("questions")
    if pool.get("status") != "teacher_review_draft" or pool.get("reviewStatus") != "teacher_review_draft":
        errors.append("pool must remain teacher_review_draft")
    if not isinstance(questions, list) or not questions:
        errors.append("pool must contain a non-empty questions array")
        questions = []

    active_stems = set()
    active_ids = set()
    for path in DIAG.glob("question-bank-*.json"):
        bank = json.loads(path.read_text(encoding="utf-8"))
        for q in bank.get("questions", []):
            active_stems.add(normalize(q.get("question", "")))
            active_ids.add(q.get("id"))

    seen_ids = set()
    seen_stems = set()
    group_counts = {}
    for index, q in enumerate(questions, 1):
        prefix = f"pool question {index}"
        if not isinstance(q, dict):
            errors.append(f"{prefix}: must be an object")
            continue
        for field in ("id", "directionId", "direction", "class", "curriculumId", "topic", "skill", "groupId", "difficulty", "type", "question", "correctText", "explanation"):
            if field not in q or q[field] in (None, ""):
                errors.append(f"{prefix}: missing {field}")
        qid = q.get("id")
        if qid in seen_ids or qid in active_ids:
            errors.append(f"{prefix}: duplicate ID {qid!r}")
        seen_ids.add(qid)
        stem = normalize(q.get("question", ""))
        if stem in seen_stems or stem in active_stems:
            errors.append(f"{prefix}: duplicate question stem")
        seen_stems.add(stem)

        direction_id = q.get("directionId", "")
        mapped_skill = group_for(skills, direction_id, q.get("skill", ""))
        if not mapped_skill:
            errors.append(f"{prefix}: skill is not mapped in SKILL_TAXONOMY_DRAFT.json")
        elif mapped_skill != q.get("groupId"):
            errors.append(f"{prefix}: groupId {q.get('groupId')!r} does not match taxonomy group {mapped_skill!r}")
        mapped_topic = topic_group_for(topics, direction_id, q.get("topic", ""))
        if not mapped_topic:
            errors.append(f"{prefix}: topic is not mapped in TOPIC_TAXONOMY_DRAFT.json")

        if q.get("difficulty") not in {"basic", "medium", "advanced"}:
            errors.append(f"{prefix}: invalid difficulty")
        qtype = q.get("type")
        if qtype in {"choice", "analysis"}:
            options = q.get("options")
            correct_index = q.get("correctIndex")
            if not isinstance(options, list) or len(options) < 2:
                errors.append(f"{prefix}: choice needs at least two options")
            elif not isinstance(correct_index, int) or isinstance(correct_index, bool) or not 0 <= correct_index < len(options):
                errors.append(f"{prefix}: invalid correctIndex")
            elif q.get("correctText") != options[correct_index]:
                errors.append(f"{prefix}: correctText must match options[correctIndex]")
        elif qtype == "short":
            if not isinstance(q.get("acceptedAnswers"), list) or not q["acceptedAnswers"]:
                errors.append(f"{prefix}: short question needs acceptedAnswers")
        else:
            errors.append(f"{prefix}: unsupported type {qtype!r}")
        group_counts[q.get("groupId", "unknown")] = group_counts.get(q.get("groupId", "unknown"), 0) + 1

    if len(questions) != 14:
        errors.append(f"expected 14 draft questions, got {len(questions)}")
    if len(group_counts) != 7 or any(count != 2 for count in group_counts.values()):
        errors.append(f"expected exactly 2 questions in each of 7 groups, got {group_counts}")

    if errors:
        print(f"FAILED ({len(errors)} errors):")
        for error in errors:
            print(" - " + error)
        raise SystemExit(1)
    print(f"Supplementary pool structure passed: {len(questions)} questions across {len(group_counts)} groups.")
    print("No exact question-stem duplicates found against active banks.")
    print("Pedagogical review and curriculum alignment are still required.")


if __name__ == "__main__":
    main()
