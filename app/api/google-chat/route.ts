import { NextRequest, NextResponse } from "next/server";
import { runBrainRouter } from "@/lib/brain-router";

export const runtime = "nodejs";

function extractGoogleChatMessage(event: any) {
  const text =
    event?.message?.argumentText ||
    event?.message?.text ||
    "";

  return text
    .replace(/^@\S+\s*/, "")
    .trim();
}

export async function POST(req: NextRequest) {
  try {
    const event = await req.json();

    if (event.type === "ADDED_TO_SPACE") {
      return NextResponse.json({
        text:
          "Brain Router 已加入。\n\n你可以直接輸入：\n「評估：我們要不要做 AI 攝影服務？」\n\n我會判斷該詢問哪些 expert brain，並整理回覆。",
      });
    }

    if (event.type !== "MESSAGE") {
      return NextResponse.json({
        text: "Brain Router 已收到事件，但目前只處理文字訊息。",
      });
    }

    const message = extractGoogleChatMessage(event);

    if (!message) {
      return NextResponse.json({
        text: "請輸入要讓 Brain Router 評估的內容。",
      });
    }

    const result = await runBrainRouter(message);

    return NextResponse.json({
      text: result.finalAnswer,
    });
  } catch (error: any) {
    return NextResponse.json({
      text: `Brain Router 發生錯誤：${error.message || "Unknown error"}`,
    });
  }
}