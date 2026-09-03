import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { z } from "zod";

export const runtime = "nodejs";
export const maxDuration = 60;

const RequestBody = z.object({
  text: z.string().min(1).max(8000),
});

const VocabItem = z.object({
  fr: z.string(),
  ja: z.string(),
});

const Extraction = z.object({
  vocabulary: z.array(VocabItem).max(40).default([]),
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

    const prompt = `以下はフランス語学習者がアップロードした教材テキストです。
この中から、会話練習で覚える価値のある単語・熟語・決まり文句を最大30個選び、それぞれ短い日本語訳を付けてください。
重複や、あまりに基礎的すぎる単語（je, tu, le, la など）は除外してください。
JSON のみで返してください: {"vocabulary":[{"fr":"mot ou expression","ja":"日本語訳"}]}

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
    return NextResponse.json({ error: e.message || "Vocabulary extraction error" }, { status: 500 });
  }
}
