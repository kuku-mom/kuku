#!/usr/bin/env python3
"""Isolated SDK feasibility probe; synthetic inputs only, never production memory.

Run with Python 3.12 and hy-memory==2.0.4. For an actual model trial configure
MEMORY_LLM_API_KEY/BASE_URL/MODEL and MEMORY_EMBEDDER_API_KEY/BASE_URL/MODEL.
No credentials or raw model output are emitted. This is NOT a quality score.
"""
import importlib.metadata
import json
import os
from pathlib import Path
import tempfile
import time

PIN = "2.0.4"

def main():
    report = {"candidate": "hy-memory", "pinned_version": PIN, "quality_comparison": "not_run"}
    try:
        report["installed_version"] = importlib.metadata.version("hy-memory")
    except importlib.metadata.PackageNotFoundError:
        report["status"] = "not_installed"
        return report
    if report["installed_version"] != PIN:
        report["status"] = "version_mismatch"
        return report
    with tempfile.TemporaryDirectory(prefix="kuku-hy-probe-") as root:
        os.environ["MEMORY_DATA_DIR"] = root
        os.environ["ANONYMIZED_TELEMETRY"] = "False"
        os.environ["MEMORY_ENABLE_GRAPH"] = "false"
        started = time.monotonic()
        try:
            from hy_memory import HyMemoryClient
            report["import"] = "passed"
        except Exception as exc:
            report.update(status="import_failed", error_type=type(exc).__name__)
            return report
        if not (os.environ.get("MEMORY_LLM_API_KEY") and os.environ.get("MEMORY_EMBEDDER_API_KEY")):
            report["status"] = "model_credentials_required"
            return report
        client = None
        try:
            # The SDK can swallow provider errors and return empty results. Check
            # both endpoints first; an empty result must never certify success.
            from openai import OpenAI
            report["llm_model"] = os.environ.get("MEMORY_LLM_MODEL", "gpt-6-luna")
            report["embedding_model"] = os.environ.get("MEMORY_EMBEDDER_MODEL", "text-embedding-3-small")
            for purpose, model, prefix in [
                ("llm", report["llm_model"], "MEMORY_LLM"),
                ("embedding", report["embedding_model"], "MEMORY_EMBEDDER"),
            ]:
                with OpenAI(api_key=os.environ[prefix + "_API_KEY"],
                            base_url=os.environ.get(prefix + "_BASE_URL"),
                            timeout=30, max_retries=0) as api:
                    try:
                        if purpose == "llm":
                            api.chat.completions.create(model=model,
                                messages=[{"role":"user", "content":"Reply with OK."}],
                                reasoning_effort="none", max_completion_tokens=16)
                        else:
                            api.embeddings.create(model=model, input="Synthetic memory evaluation")
                        report[purpose + "_access"] = "passed"
                    except Exception as exc:
                        report.update(status="provider_access_failed", failed_provider=purpose,
                                      error_type=type(exc).__name__,
                                      http_status=getattr(exc, "status_code", None))
                        return report
            # Hy-Memory interprets this as total attempts, unlike OpenAI retries.
            os.environ.setdefault("MEMORY_LLM_MAX_RETRIES", "1")
            client = HyMemoryClient(mode="pro")
            cases = json.loads((Path(__file__).parents[2] / "tests/fixtures/memory/checkpoints.json").read_text())
            case = cases[0]
            record = case["record"]
            trace = [
                {"role":"user", "content":record["goal"]},
                {"role":"assistant", "content":"", "tool_calls":[{"id":"qa-1","type":"function","function":{"name":"verification","arguments":"{}"}}]},
                {"role":"tool","tool_call_id":"qa-1","content":record["state"]},
            ]
            client.add(trace, scene="working", user_id="synthetic-qa", workspace_id=case["scope"])
            result = client.search(record["goal"], scene="working", user_ids=["synthetic-qa"], workspace_id=case["scope"], limit=5)
            facts = len(result.get("facts", []))
            experiences = len(result.get("experiences", []))
            report.update(status="smoke_completed" if facts else "smoke_no_facts",
                          facts=facts, experiences=experiences)
        except Exception as exc:
            report.update(status="smoke_failed", error_type=type(exc).__name__)
        finally:
            if client is not None:
                client.close()
            report["elapsed_seconds"] = round(time.monotonic()-started,3)
    return report

if __name__ == "__main__":
    print(json.dumps(main(), ensure_ascii=False, indent=2))
