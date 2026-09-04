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

ルール（最優先・厳守）:
- 教材テキストの会話文（Dialogue）の中に、ユーザー（${body.userRoleLabel || "もう一方の話者"}役）が言うセリフとして、まだ「これまでの会話」で使っていないものがあれば、それを一字一句そのまま使うこと。言い換え・要約・アレンジ・単語の入れ替えは一切しない。教材の原文をそのままコピーする。
- 「これまでの会話」を必ず確認し、そこで既に登場した文（ユーザー・AIどちらの発言でも）と同じ文を絶対に提案しないこと。同じセリフの繰り返しは禁止。
- 教材のセリフが会話の中で全て使われてしまった場合、または直前のAIの発言（会話の一番最後の発言）の内容に教材のどのセリフも自然につながらない場合は、教材のセリフをそのまま繰り返すのではなく、直前のAIの発言に対する自然な返答を新しく考えること（教材で使われている語彙・言い回しを参考にする）。
- レベルは「${levelLabel[body.level]}」を参考にしつつ、教材の原文がある場合はそれを優先する。
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
