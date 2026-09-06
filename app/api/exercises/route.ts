import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { z } from "zod";

export const runtime = "nodejs";
export const maxDuration = 60;

const RequestBody = z.object({
  text: z.string().min(1).max(20000),
});

// 「複数選択」の設問などで、AIが answer を配列で返してくることがあるため、
// 文字列・文字列配列のどちらで来ても壊れないよう吸収する
const stringish = z
  .union([z.string(), z.array(z.string())])
  .transform((v) => (Array.isArray(v) ? v.filter(Boolean).join("、") : v))
  .catch("");

const ExerciseItem = z.object({
  prompt: stringish,
  group_title: stringish,
  answer: stringish,
  explanation_ja: stringish,
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

教材には、1つの大問（例:「2 Complétez par « un », « une », « des ».」）の下に複数の小問（1. ___ baguette / 2. ___ glace / ...）がぶら下がっている構成がよくあります。この場合、小問1つ1つを別々の設問として抽出しつつ、それぞれの prompt の先頭に、その小問が属する大問の指示文（何を答えればよいかの説明）を必ず含めてください。小問の番号や文だけを見ても何をすればよいか分からない状態にしないでください。

その設問部分を見つけ、1問ずつ以下の形式に整理してください:
- prompt: 設問文（例:「Complétez par « un », « une » ou « des ». 1. ___ baguette」のように、その小問が属する大問の指示文＋元の番号・空欄（___）をセットで含める。「Vrai ou faux ? 1. La cliente achète du pain.」のように大問の指示（Vrai ou faux ?）も同様に含める。ただし選択肢そのものはここに含めず choices に分ける）
- group_title: prompt の先頭に含めた「大問の指示文」の部分だけを、そのまま入れる（例:「Complétez par « un », « une » ou « des ».」「Relisez le dialogue ci-contre. Vrai ou faux ?」）。同じ大問に属する小問は、すべて同じ group_title（一字一句同じ文字列）にすること。大問に属さない独立した設問の場合は空文字にする。
- answer: 正解（教材の会話文や文法解説の内容から判断できる場合はそれを使う。フランス語の単語・文・Vrai/Fauxなど、簡潔に。choice タイプの場合は choices のいずれかと完全に一致させる。正解が複数ある設問（複数選択など）の場合も、配列ではなく「、」で区切った1つの文字列にすること）
- explanation_ja: なぜその答えになるか、日本語で短く（1〜2文）説明
- qtype: 回答形式。以下のいずれか:
  - "choice": 正誤問題（Vrai/Faux）や、選択肢が明示されている選択問題。この場合 choices に選べる選択肢をすべて入れる（Vrai/Fauxなら choices は ["Vrai","Faux"]）
  - "text": 穴埋め問題や自由記述問題など、選択肢が無く自分で単語・文を書いて答える形式。この場合 choices は空配列にする
- choices: qtype が "choice" のときの選択肢一覧（フランス語のまま）。"text" のときは空配列

教材テキスト中の小問の番号（1, 2, 3...）は、そのテキストに書かれている番号をそのまま使い、抽出する順序も元のテキストに現れる番号順（1→2→3...）にすること。番号を勝手に振り直したり、他の小問と入れ替えたりしない。

設問が教材中に無い場合は exercises を空配列にしてください。設問ではない部分（会話文や語彙リストそのもの）は含めないでください。最大30問まで。
JSON のみで返してください: {"exercises":[{"prompt":"","group_title":"","answer":"","explanation_ja":"","qtype":"text","choices":[]}]}

教材テキスト:
"""
${body.text.slice(0, 20000)}
"""`;

    const response = await client.responses.create({
      model: process.env.OPENAI_CHAT_MODEL || process.env.OPENAI_VISION_MODEL || "gpt-4.1",
      input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
      text: { format: { type: "json_object" } },
      // 設問数が多い教材（最大30問、各問に日本語の説明も付く）でも出力が途中で切れないよう、
      // 出力トークン数を十分に確保する（30問 × 説明文込みでも収まる余裕を持たせる）
      max_output_tokens: 12000,
      // group_title（大問の指示文）が小問ごとに表記ゆれ（空白・引用符など）で
      // バラバラにならないよう、温度を下げて安定した出力にする
      temperature: 0.1,
    });

    const text = getTextFromResponse(response);
    const parsed = Extraction.parse(JSON.parse(text));
    // クライアント側の型（groupTitle）に合わせて変換して返す
    const exercises = parsed.exercises.map((ex) => ({
      prompt: ex.prompt,
      groupTitle: ex.group_title,
      answer: ex.answer,
      explanation_ja: ex.explanation_ja,
      qtype: ex.qtype,
      choices: ex.choices,
    }));
    return NextResponse.json({ exercises });
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
