import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { z } from "zod";

export const runtime = "nodejs";
export const maxDuration = 60;

const RequestBody = z.object({
  text: z.string().min(1).max(20000),
});

const ExerciseItem = z.object({
  prompt: z.string(),
  answer: z.string(),
  explanation_ja: z.string(),
  qtype: z.enum(["choice", "text"]).default("text"),
  choices: z.array(z.string()).max(6).default([]),
});

const Extraction = z.object({
  exercises: z.array(ExerciseItem).max(30).default([]),
});

function getTextFromResponse(response: any): string {
  if (response.output_text) return response.output_text;
  return (response.output || [])
    .flatMap((o: any) => o.content || [])
    .filter((c: any) => c.type === "output_text")
    .map((c: any) => c.text)
    .join("");
}

export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "OPENAI_API_KEY is missing. Please set it in .env.local." },
        { status: 500 }
      );
    }

    const json = await req.json();
    const body = RequestBody.parse(json);
    const client = new OpenAI({ apiKey });

    const prompt = `以下はフランス語学習者がアップロードした教材テキストです。会話文・語彙・文法解説に加えて、教科書の練習問題欄（「Activités」など、穴埋め問題・正誤問題・選択問題・並べ替え問題・自由回答問題など）の設問がそのまま含まれている場合があります。

その設問部分を見つけ、1問ずつ以下の形式に整理してください:
- prompt: 設問文そのもの（例:「1. ___ baguette」「Vrai ou faux ? La cliente achète du pain.」など、元の番号や空欄（___）も含めて。ただし選択肢そのものはここに含めず choices に分ける）
- answer: 正解（教材の会話文や文法解説の内容から判断できる場合はそれを使う。フランス語の単語・文・Vrai/Fauxなど、簡潔に。choice タイプの場合は choices のいずれかと完全に一致させる）
- explanation_ja: なぜその答えになるか、日本語で短く（1〜2文）説明
- qtype: 回答形式。以下のいずれか:
  - "choice": 正誤問題（Vrai/Faux）や、選択肢が明示されている選択問題。この場合 choices に選べる選択肢をすべて入れる（Vrai/Fauxなら choices は ["Vrai","Faux"]）
  - "text": 穴埋め問題や自由記述問題など、選択肢が無く自分で単語・文を書いて答える形式。この場合 choices は空配列にする
- choices: qtype が "choice" のときの選択肢一覧（フランス語のまま）。"text" のときは空配列

設問が教材中に無い場合は exercises を空配列にしてください。設問ではない部分（会話文や語彙リストそのもの）は含めないでください。最大30問まで。
JSON のみで返してください: {"exercises":[{"prompt":"","answer":"","explanation_ja":"","qtype":"text","choices":[]}]}

教材テキスト:
"""
${body.text.slice(0, 6000)}
"""`;

    const response = await client.responses.create({
      model: process.env.OPENAI_CHAT_MODEL || process.env.OPENAI_VISION_MODEL || "gpt-4.1",
      input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
      text: { format: { type: "json_object" } },
    });

    const text = getTextFromResponse(response);
    const parsed = Extraction.parse(JSON.parse(text));
    return NextResponse.json(parsed);
  } catch (e: any) {
    const detail = { status: (e as any)?.status, code: (e as any)?.code, type: (e as any)?.type, param: (e as any)?.param };
    console.error("Exercise extraction error:", e?.message, detail);
    const hasDetail = detail.status || detail.code || detail.param;
    const message = hasDetail
      ? (e.message || "Exercise extraction error") + " (status:" + (detail.status ?? "-") + " code:" + (detail.code ?? "-") + " param:" + (detail.param ?? "-") + ")"
      : e.message || "Exercise extraction error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
