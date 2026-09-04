import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { z } from "zod";

export const runtime = "nodejs";
export const maxDuration = 60;

const LEVELS = ["beginner", "intermediate", "advanced"] as const;
type Level = (typeof LEVELS)[number];

const levelLabel: Record<Level, string> = {
  beginner: "初級（簡単な単語・短い文）",
  intermediate: "中級（一般的な語彙・やや長い文）",
  advanced: "上級（自然な言い回し・慣用表現も可）",
};

const HistoryItem = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});

const RequestBody = z.object({
  sourceText: z.string().min(1).max(20000),
  level: z.enum(LEVELS).default("beginner"),
  history: z.array(HistoryItem).max(30).default([]),
  roleSwapped: z.boolean().default(false),
  aiRoleLabel: z.string().max(80).optional(),
  userRoleLabel: z.string().max(80).optional(),
});

const Suggestion = z.object({
  suggestion_fr: z.string().default(""),
  suggestion_ja: z.string().default(""),
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

    const roleSection = `\n\n話者ラベル:\nAI役（${body.aiRoleLabel || "不明"}）\nユーザー役（${body.userRoleLabel || "不明"}）`;

    const systemPrompt = `あなたはフランス語学習アプリの補助教師です。まだ何も話せない初心者のユーザーのために、これから会話で言うべき返答の「見本（例文）」を1つだけ提案します。
必ず JSON のみを返してください。

ルール:
- 下記「教材テキスト」と「これまでの会話」の流れを踏まえ、ユーザー（${body.userRoleLabel || "もう一方の話者"}役）が次に言う自然な返答の例を1つ考える。
- 教材テキストに実際の会話文がある場合は、その中の対応する箇所の表現をできるだけそのまま使う（新しく作らない）。対応する箇所が無い場合のみ、教材の内容に沿った自然な例文を新しく考える。
- レベルは「${levelLabel[body.level]}」に合わせ、初心者でも読んで真似できるくらい短く簡単な文にする（1文、長くても2文まで）。
- suggestion_fr にはフランス語の例文、suggestion_ja にはその自然な日本語訳を入れる。

JSON の形式:
{"suggestion_fr":"","suggestion_ja":""}`;

    const userContent = `教材テキスト:\n"""\n${body.sourceText.slice(0, 6000)}\n"""${roleSection}`;

    const history = body.history.slice(-16).map((h) => ({
      role: h.role,
      content: [
        {
          type: h.role === "user" ? "input_text" : "output_text",
          text: h.content,
        },
      ],
    }));

    const response = await client.responses.create({
      model: process.env.OPENAI_CHAT_MODEL || process.env.OPENAI_VISION_MODEL || "gpt-4.1",
      input: [
        { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
        ...(history as any),
        { role: "user", content: [{ type: "input_text", text: userContent }] },
      ],
      text: { format: { type: "json_object" } },
    });

    const text = getTextFromResponse(response);
    const parsed = Suggestion.parse(JSON.parse(text));
    return NextResponse.json(parsed);
  } catch (e: any) {
    const detail = { status: (e as any)?.status, code: (e as any)?.code, type: (e as any)?.type, param: (e as any)?.param };
    console.error("Suggestion error:", e?.message, detail);
    const hasDetail = detail.status || detail.code || detail.param;
    const message = hasDetail
      ? (e.message || "Suggestion error") + " (status:" + (detail.status ?? "-") + " code:" + (detail.code ?? "-") + " param:" + (detail.param ?? "-") + ")"
      : e.message || "Suggestion error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
