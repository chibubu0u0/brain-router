// =====================================================================
// Magnific 背景輪詢 — cron 端點
// 放到:app/api/magnific/poll/route.ts
//
// 由 Vercel Cron 定時呼叫(見 vercel.json)。它會把還沒完成的生圖任務
// 逐一查詢,完成的就主動貼回 Slack。
//
// 需在 Vercel 設環境變數:CRON_SECRET=(自己取一組長字串)
// =====================================================================

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { processMagnificJob } from "@/lib/tools/magnific/generate";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  // Vercel Cron 會帶 Authorization: Bearer <CRON_SECRET>
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");

  if (secret && auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const { data: jobs } = await supabaseAdmin
    .from("magnific_jobs")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(10);

  let processed = 0;
  let finished = 0;

  for (const job of jobs || []) {
    // 超過 10 分鐘還沒完成 → 標記 timeout,不再查
    if (Date.now() - new Date(job.created_at).getTime() > 10 * 60 * 1000) {
      await supabaseAdmin
        .from("magnific_jobs")
        .update({ status: "timeout", updated_at: new Date().toISOString() })
        .eq("id", job.id);
      continue;
    }

    processed++;
    const done = await processMagnificJob(job);
    if (done) finished++;
  }

  return NextResponse.json({ ok: true, processed, finished });
}
