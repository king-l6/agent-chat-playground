#!/usr/bin/env python3
"""独立检索脚本：验证 Node 写出的本地向量库（server/data/index.json）。

不替换线上检索。Python 只做三件事：
  1. 读已经编码好的 chunk 向量
  2. query 仍走同一套 BGE（scripts/embed_query.ts），保证同一向量空间
  3. 自己算余弦 TopK，对黄金集打 Recall@K

用法：
  python3 scripts/eval_retrieve.py
  python3 scripts/eval_retrieve.py --query "这个项目技术栈是什么？"
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INDEX_PATH = ROOT / "server" / "data" / "index.json"
GOLD_PATH = ROOT / "server" / "eval" / "gold.json"
EMBED_CLI = ROOT / "scripts" / "embed_query.ts"
TSX = ROOT / "node_modules" / ".bin" / "tsx"

# 和 retrieve.ts 的 MIN_COSINE 对齐
MIN_COSINE = 0.32


def cosine(a: list[float], b: list[float]) -> float:
    n = min(len(a), len(b))
    dot = na = nb = 0.0
    for i in range(n):
        dot += a[i] * b[i]
        na += a[i] * a[i]
        nb += b[i] * b[i]
    denom = math.sqrt(na) * math.sqrt(nb)
    return 0.0 if denom == 0 else dot / denom


def load_index(path: Path) -> list[dict]:
    if not path.exists():
        sys.exit(f"没有 {path}。先 npm run dev 等索引建完，或跑过一次能编码的检索。")
    data = json.loads(path.read_text(encoding="utf-8"))
    items = data.get("items") or []
    if not items:
        sys.exit(f"{path} 是空索引")
    print(
        f"[eval:py] index={path.relative_to(ROOT)}  "
        f"model={data.get('embeddingModel')}  chunks={len(items)}  "
        f"dim={len(items[0]['embedding'])}",
        flush=True,
    )
    return items


def parse_vectors(stdout: str) -> list[list[float]]:
    """embed.ts 可能往 stdout 打过日志；从末尾找到能 parse 的 JSON 数组。"""
    for line in reversed(stdout.splitlines()):
        line = line.strip()
        if not line.startswith("["):
            continue
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(data, list):
            return data
    sys.stderr.write(stdout)
    sys.exit("embed_query 没有输出 JSON 向量")


def embed_queries(queries: list[str]) -> list[list[float]]:
    if not TSX.exists():
        sys.exit("找不到 tsx，先在仓库根目录 npm install")
    proc = subprocess.run(
        [str(TSX), str(EMBED_CLI)],
        input=json.dumps(queries, ensure_ascii=False),
        capture_output=True,
        text=True,
        cwd=ROOT,
        check=False,
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr or proc.stdout)
        sys.exit(f"embed_query 失败 exit={proc.returncode}")
    vectors = parse_vectors(proc.stdout)
    if len(vectors) != len(queries):
        sys.exit(f"向量条数 {len(vectors)} ≠ 问句 {len(queries)}")
    return vectors


def search_vectors(
    qv: list[float],
    items: list[dict],
    top_k: int,
    min_cosine: float = MIN_COSINE,
) -> list[dict]:
    scored = []
    for item in items:
        score = cosine(qv, item["embedding"])
        if score >= min_cosine:
            scored.append((score, item))
    scored.sort(key=lambda x: x[0], reverse=True)
    hits = []
    for i, (score, item) in enumerate(scored[:top_k], start=1):
        hits.append(
            {
                "id": item["id"],
                "docId": item["docId"],
                "title": item["title"],
                "text": item["text"],
                "score": round(score, 3),
                "citation": i,
            }
        )
    return hits


def is_hit(case: dict, hits: list[dict]) -> bool:
    needle = case["contains"].lower()
    return any(
        h["docId"] == case["docId"]
        and needle in f"{h['title']}\n{h['text']}".lower()
        for h in hits
    )


def print_hits(query: str, hits: list[dict]) -> None:
    print(f"\nquery: {query}")
    if not hits:
        print("  （空）")
        return
    for h in hits:
        preview = h["text"].replace("\n", " ")[:72]
        print(f"  [{h['citation']}] {h['docId']}/{h['title']}  {h['score']}  {preview}")


def run_gold(items: list[dict], top_k: int) -> None:
    gold = json.loads(GOLD_PATH.read_text(encoding="utf-8"))
    cases = gold["cases"]
    k = top_k or gold.get("topK") or 3
    print(f"[eval:py] {len(cases)} 条黄金问题  topK={k}  只测 vector（验证向量库，不测 hybrid/rerank）")

    queries = [c["query"] for c in cases]
    print("[eval:py] 编码 query…", flush=True)
    qvs = embed_queries(queries)

    ok = 0
    misses: list[str] = []
    for case, qv in zip(cases, qvs):
        hits = search_vectors(qv, items, k)
        if is_hit(case, hits):
            ok += 1
            continue
        top = hits[0] if hits else None
        top_s = f"{top['docId']}/{top['title']} ({top['score']})" if top else "空"
        misses.append(f"  ✗ {case['id']} 期望 {case['docId']}∋{case['contains']}；top1={top_s}")

    recall = ok / len(cases)
    print(f"[eval:py] vector Recall@{k} = {ok}/{len(cases)} = {recall * 100:.0f}%")
    if misses:
        print("\n".join(misses))


def main() -> None:
    p = argparse.ArgumentParser(description="用 Python 检索验证本地向量库")
    p.add_argument("--query", help="临时查一句，不跑黄金集")
    p.add_argument("--topK", type=int, default=0)
    p.add_argument("--index", type=Path, default=INDEX_PATH)
    args = p.parse_args()

    items = load_index(args.index)
    if args.query:
        top_k = args.topK or 3
        qv = embed_queries([args.query])[0]
        print_hits(args.query, search_vectors(qv, items, top_k))
        return
    run_gold(items, args.topK)


if __name__ == "__main__":
    main()
