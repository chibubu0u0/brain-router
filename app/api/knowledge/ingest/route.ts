// =====================================================================
// 知識庫 ingest API(多台電腦的共用入口)
// 放到:app/api/knowledge/ingest/route.ts
//
// 任何一台電腦/腳本都能把資料 POST 進共用大腦:
//
//   curl -X POST https://brain-router-0623.vercel.app/api/knowledge/ingest \
//     -H "Content-Type: application/json" \
//     -H "x-knowledge-secret: 你的KNOWLEDGE_INGEST_SECRET" \
//     -d '{"agent_key":"ryan","title":"定價原則","content":"我們的報價一律先抓成本三倍...","source":"api","source_ref":"我的筆電"}'
//
// 需在 Vercel 設環境變數:KNOWLEDGE_INGEST_SECRET=(自己取一組長字串)
// =====================================================================

import { NextRequest, NextResponse } from "next/server";
import { ingestKnowledge } from "@/lib/knowledge";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const secret = process.env.KNOWLEDGE_INGEST_SECRET;

    if (!secret) {
      return NextResponse.json(
        { ok: false, error: "Server missing KNOWLEDGE_INGEST_SECRET" },
        { status: 500 }
      );
    }

    if (req.headers.get("x-knowledge-secret") !== secret) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 }
      );
    }

    const body = await req.json();

    const agentKey = body.agent_key;
    const content = body.content;

    if (!agentKey || !content) {
      return NextResponse.json(
        { ok: false, error: "agent_key 與 content 為必填" },
        { status: 400 }
      );
    }

    const result = await ingestKnowledge({
      agentKey,
      content,
      title: body.title,
      source: body.source || "api",
      sourceRef: body.source_ref,
    });

    return NextResponse.json({
      ok: true,
      knowledge_id: result.knowledgeId,
      chunk_count: result.chunkCount,
    });
  } catch (error: any) {
    return NextResponse.json(
      { ok: false, error: error?.message || "Unknown error" },
      { status: 500 }
    );
  }
}
