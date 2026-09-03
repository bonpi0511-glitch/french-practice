import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { z } from "zod";

export const runtime = "nodejs";
export const maxDuration = 60;

const RequestBody = z.object({
  text: z.string().min(1).max(8000),
});

const GrammarPoint = z.object({
  title: z.string(),
  explanation_ja: z.string(),
  examples: z.array(z.string()).max(5).default([]),
});

const Extraction = z.object({
  grammarPoints: z.array(GrammarPoint).max(10).default([]),
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

    const prompt = `以下はフランス語学習者がアップロードした教材テキストです（教科書の「Grammaire」欄などを含む場合があります）。
このテキストに含まれる文法ポイント（名詞の性・数、冠詞、疑問文の作り方、量の表現など、教材中に明示的な文法解説がある場合はそれを優先して使う。無ければテキストの内容から重要な文法事項を最大5個推測して補ってもよい）を抽出し、日本語話者向けにやさしい日本語で解説してください。

各項目について:
- title: 文法項目名（短く、例:「名詞の性と数」）
- explanation_ja: 日本語でのわかりやすい解説（2〜4文程度）
- examples: 教材中の例文があればそのまま2〜3個引用（フランス語のみ、日本語訳は不要）

教材に明確な文法解説が見当たらない場合は grammarPoints を空配列にしてください。
JSON のみで返してください: {"grammarPoints":[{"title":"","explanation_ja":"","examples":[]}]}

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
    return NextResponse.json({ error: e.message || "Grammar extraction error" }, { status: 500 });
  }
}
