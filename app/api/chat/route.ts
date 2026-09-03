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
  sourceText: z.string().min(1).max(8000),
  level: z.enum(LEVELS).default("beginner"),
  history: z.array(HistoryItem).max(30).default([]),
  userMessage: z.string().max(2000).optional(),
  vocabularyBank: z.array(z.string()).max(300).default([]),
  grammarNotes: z.array(z.string()).max(50).default([]),
});

const ChatTurn = z.object({
  reply: z.string().default(""),
  reply_translation_ja: z.string().default(""),
  correction_fr: z.string().nullable().default(null),
  correction_note_ja: z.string().nullable().default(null),
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

    const systemPrompt = `あなたは日本語話者のフランス語学習者と一対一で会話練習をする、親切なフランス人の会話パートナーです。
必ず JSON のみを返してください。

進め方のルール:
- ユーザーがアップロードしたテキスト（下記「教材テキスト」）を話題・語彙のベースとして会話を組み立てる。教材の内容について質問したり、関連する話題を広げたりする。
- 会話のレベルは「${levelLabel[body.level]}」に合わせる。
- あなたの返答（reply）は必ずフランス語で、1〜3文程度の短い自然な会話文にする。世間話のように、最後は質問で終えて会話を続けやすくする。
- reply_translation_ja には reply の自然な日本語訳を入れる。
- ユーザーからの直近の発言（userMessage）がある場合、文法・語彙・スペルの誤りがあれば correction_fr に自然なフランス語の訂正例を、correction_note_ja に何をどう直したかの短い日本語説明を入れる。誤りがなければ両方 null にする。
- userMessage が無い最初のターンでは、correction_fr と correction_note_ja は必ず null にし、教材テキストの内容に基づいた自然な会話の切り出し（挨拶＋質問など）を reply に入れる。
- 難しい語彙を使う場合は、reply の中で simple に言い換えるか短く補足してもよい。
- 「これまで学習した語彙」が渡されている場合、それは過去にアップロードした教材から蓄積された復習用のリストです。今日の教材の話題を壊さない範囲で、レベルに合ったものを1〜2個ほど自然に会話に混ぜて復習の機会を作ってください（無理に全部使う必要はありません）。
- 「これまでの文法解説」が渡されている場合、それは教材（教科書の Grammaire 欄など）から抽出した文法ポイントです。correction_note_ja でユーザーの間違いを説明する際、関連する文法解説があればその内容と用語を使って日本語で説明してください（例:「これは名詞の性の一致のルールです。教材にもあった通り…」のように）。関連するものが無ければ通常通り説明してください。

JSON の形式:
{"reply":"","reply_translation_ja":"","correction_fr":null,"correction_note_ja":null}`;

    const vocabSection = body.vocabularyBank.length
      ? `\n\nこれまで学習した語彙（復習用、過去にアップロードした教材から蓄積）:\n${body.vocabularyBank
          .slice(-150)
          .join("\n")}`
      : "";

    const grammarSection = body.grammarNotes.length
      ? `\n\nこれまでの文法解説（教材から抽出、日本語）:\n${body.grammarNotes.slice(-50).join("\n")}`
      : "";

    const userContent = [
      `教材テキスト:\n"""\n${body.sourceText.slice(0, 6000)}\n"""${vocabSection}${grammarSection}`,
      body.userMessage
        ? `ユーザーの直近の発言（フランス語）: "${body.userMessage}"`
        : "これは会話の最初のターンです。教材テキストに基づいて会話を切り出してください。",
    ].join("\n\n");

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
    const parsed = ChatTurn.parse(JSON.parse(text));
    return NextResponse.json(parsed);
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Chat error" }, { status: 500 });
  }
}
