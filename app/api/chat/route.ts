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
  userMessage: z.string().max(2000).optional(),
  vocabularyBank: z.array(z.string()).max(300).default([]),
  grammarNotes: z.array(z.string()).max(50).default([]),
  roleSwapped: z.boolean().default(false),
  aiRoleLabel: z.string().max(80).optional(),
  userRoleLabel: z.string().max(80).optional(),
  beginnerMode: z.boolean().default(false),
  // クライアント側で教材の会話文から機械的に抽出した「次のセリフ」。
  // 指定されている場合、reply は必ずこの文字列にする（AIによるアレンジを完全に排除するため）
  forcedReply: z.string().max(2000).optional(),
});

const ChatTurn = z.object({
  reply: z.string().default(""),
  reply_translation_ja: z.string().default(""),
  correction_fr: z.string().nullable().default(null),
  correction_note_ja: z.string().nullable().default(null),
  ai_role_label: z.string().default(""),
  user_role_label: z.string().default(""),
  is_finished: z.boolean().default(false),
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
- 教材の会話文には基本的に2人の話者がいます。現在のモードは「${
      body.roleSwapped
        ? "役割交代：ユーザーが1人目（先に話す側）の役、あなたが2人目の役"
        : "通常：あなたが1人目（先に話す側）の役、ユーザーが2人目の役"
    }」です。あなたは会話全体を通して、自分が演じる側の人物・立場（店員なら店員、客なら客など）を一貫して保ち、ユーザーが演じるもう一方の人物として自然に受け答えしてください。
- あなたの返答（reply）は必ずフランス語で、1〜3文程度の短い自然な会話文にする。世間話のように、最後は質問で終えて会話を続けやすくする。
- reply_translation_ja には reply の自然な日本語訳を入れる。
- ユーザーからの直近の発言（userMessage）がある場合、文法・語彙・スペルの誤りがあれば correction_fr に自然なフランス語の訂正例を、correction_note_ja に何をどう直したかの短い日本語説明を入れる。誤りがなければ両方 null にする。
- userMessage が無い最初のターンでは、correction_fr と correction_note_ja は必ず null にする。reply には、教材テキスト中の会話文（Dialogue）部分をできるだけそのまま一字一句コピーして入れること（意訳・要約・言い換え・新しい文の生成はしない。教材に会話が複数ある場合は最初の一つをそのまま使う）。教材に会話文が見つからない場合（語彙リストや文法解説のみの場合）に限り、教材の内容に基づいた自然な会話の切り出し（挨拶＋質問など）を新しく作って reply に入れる。
- 難しい語彙を使う場合は、reply の中で simple に言い換えるか短く補足してもよい。
- 「これまで学習した語彙」が渡されている場合、それは過去にアップロードした教材から蓄積された復習用のリストです。今日の教材の話題を壊さない範囲で、レベルに合ったものを1〜2個ほど自然に会話に混ぜて復習の機会を作ってください（無理に全部使う必要はありません）。
- 「これまでの文法解説」が渡されている場合、それは教材（教科書の Grammaire 欄など）から抽出した文法ポイントです。correction_note_ja でユーザーの間違いを説明する際、関連する文法解説があればその内容と用語を使って日本語で説明してください（例:「これは名詞の性の一致のルールです。教材にもあった通り…」のように）。関連するものが無ければ通常通り説明してください。
- ai_role_label には、あなたが演じているキャラクターを表す短いラベルを入れる。教材の会話文に話者表記（例:「L'employé」「La cliente」「Monsieur」など）があればそれをそのまま使う。無ければ会話の内容から適切な短いフランス語のラベルを考える（例:「Le vendeur」「La touriste」など）。
- user_role_label には、ユーザーが演じているもう一方のキャラクターの同様のラベルを入れる。
- ai_role_label と user_role_label は、会話が続く間は毎回同じ表記に統一すること（前のターンで使ったラベルがあれば、それと完全に同じ文字列を使う）。
${
  body.beginnerMode
    ? `- 初心者モードです。以下を厳守してください:
  - あなたの reply は、教材テキストの会話文（Dialogue）の中の、まだ「これまでの会話」で使っていない次のセリフを一字一句そのまま使うこと。言い換え・アレンジ・要約・新しい文の作成は一切禁止。教材の原文をそのままコピーする。
  - 「これまでの会話」に既に登場した文（あなた自身の発言も含む）と同じ文を絶対に繰り返さないこと。
  - 教材の会話文をすべて使い終えた場合、新しいセリフを作らず reply には代わりに会話が終わったことを伝える短いフランス語の一言（例:「Merci beaucoup, c'est tout pour aujourd'hui !」）を入れ、reply_translation_ja にその日本語訳を入れる。この場合 is_finished を true にする。
  - それ以外の場合（まだ教材のセリフが残っている場合）は is_finished を false にする。`
    : `- is_finished は常に false にする（このモードでは会話を打ち切らない）。`
}
${
  body.forcedReply
    ? `- 【最優先・絶対厳守】reply には次のテキストを一字一句そのまま入れてください。言い換え・アレンジ・追加は一切禁止です: "${body.forcedReply}"\n- reply_translation_ja には、そのテキストの自然な日本語訳を入れてください。`
    : ""
}

JSON の形式:
{"reply":"","reply_translation_ja":"","correction_fr":null,"correction_note_ja":null,"ai_role_label":"","user_role_label":"","is_finished":false}`;

    const vocabSection = body.vocabularyBank.length
      ? `\n\nこれまで学習した語彙（復習用、過去にアップロードした教材から蓄積）:\n${body.vocabularyBank
          .slice(-150)
          .join("\n")}`
      : "";

    const grammarSection = body.grammarNotes.length
      ? `\n\nこれまでの文法解説（教材から抽出、日本語）:\n${body.grammarNotes.slice(-50).join("\n")}`
      : "";

    const roleLabelSection =
      body.aiRoleLabel || body.userRoleLabel
        ? `\n\nこれまで使ってきた話者ラベル（今回も必ず同じ文字列を使うこと）:\nあなた: ${body.aiRoleLabel || "(未設定)"}\nユーザー: ${body.userRoleLabel || "(未設定)"}`
        : "";

    const userContent = [
      `教材テキスト:\n"""\n${body.sourceText.slice(0, 20000)}\n"""${vocabSection}${grammarSection}${roleLabelSection}`,
      body.userMessage
        ? `ユーザーの直近の発言（フランス語）: "${body.userMessage}"`
        : "これは会話の最初のターンです。教材テキスト中の会話文をそのまま一字一句コピーして reply に入れてください（新しく文章を作らないこと）。",
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
    // forcedReply が指定されている場合、AIが何を返してきても reply はこちらで強制的に
    // 上書きする（プロンプトの指示だけに頼らず、確実に教材の原文どおりにするため）
    if (body.forcedReply) {
      parsed.reply = body.forcedReply;
    }
    return NextResponse.json(parsed);
  } catch (e: any) {
    const detail = { status: (e as any)?.status, code: (e as any)?.code, type: (e as any)?.type, param: (e as any)?.param };
    console.error("Chat error:", e?.message, detail);
    const hasDetail = detail.status || detail.code || detail.param;
    const message = hasDetail
      ? (e.message || "Chat error") + " (status:" + (detail.status ?? "-") + " code:" + (detail.code ?? "-") + " param:" + (detail.param ?? "-") + ")"
      : e.message || "Chat error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
