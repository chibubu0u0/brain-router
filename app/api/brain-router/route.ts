import { NextRequest, NextResponse } from "next/server";
import { runBrainRouter } from "@/lib/brain-router";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const message = body.message;

    if (!message || typeof message !== "string") {
      return NextResponse.json(
        {
          ok: false,
          error:
            'Missing message. Example: { "message": "評估：我們要不要做 AI 攝影服務？" }',
        },
        { status: 400 }
      );
    }

    const result = await runBrainRouter(message);

    return NextResponse.json({
      ok: true,
      routing: result.routing,
      answer: result.finalAnswer,
      expertResponses: result.expertResponses,
    });
  } catch (error: any) {
    return NextResponse.json(
      {
        ok: false,
        error: error.message || "Unknown error",
      },
      { status: 500 }
    );
  }
}