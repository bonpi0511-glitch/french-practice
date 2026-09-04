import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { z } from "zod";

export const runtime = "nodejs";
export const maxDuration = 90;

const Extraction = z.object({
  text: z.string().default(""),
});

async function fileToDataUrl(file: File) {
  const buffer = Buffer.from(await file.arrayBuffer());
  const mime = file.type || "application/octet-stream";
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

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

    const form = await req.formData();
    const files = form.getAll("files").filter((f): f is File => f instanceof File);
    if (!files.length) {
      return NextResponse.json({ error: "No files uploaded." }, { status: 400 });
    }

    const client = new OpenAI({ apiKey });

    const content: any[] = [
      {
        type: "input_text",
        text: `これはフランス語学習用テキスト（教科書のページなど）の写真です。これはOCR（文字起こし）タスクです。あなたの仕事は「内容を要約・言い換え・新しく作文すること」では決してなく、写真に写っている文字を一字一句そのまま書き写すことです。

絶対に守るルール（最優先）:
- 実際に写真に印刷されている文字だけを書き写す。存在しない文・単語を絶対に作らない・推測で補わない・言い換えない。
- 会話文（Dialogue）は特に重要です。話者名（L'employée / La cliente など、女性形・男性形の綴りも含めて正確に）とセリフを、句読点・アポストロフィ・省略記号（…）も含めて完全に一字一句そのまま書き写す。1行も省略せず、1語も変えない。
- 会話文（本文の対話）と、右ページなどにある練習問題（Activités）内の別の穴埋め対話例（例:「5 Complétez le dialogue suivant」など）を混同しない。それぞれ別のセクションとして、見た通りに書き写す。
- 文字が読み取りにくい・不鮮明な箇所があれば、無理に埋めず [判読不能] と書く（絶対に架空の単語で埋めない）。

書き起こす内容（写真に写っているものすべて、セクションごとに分けて）:
- 会話文（Dialogue） — 最優先で完全に正確に
- 語彙リスト「Vocabulaire」
- 決まり文句「Manières de dire」
- 文法解説「Grammaire」の見出し・ルール説明・例文
- 練習問題「Activités」欄の設問（例:「1. Complétez par « un », « une » ou « des ». 1. ___ baguette 2. ___ glace ...」「Vrai ou faux ? 1. La cliente achète du pain.」のように、番号・設問文・選択肢・空欄（___ で表す）をできるだけ元の構造のまま書き起こす。チェックボックスの記号自体は省略してよいが、設問の文章・番号・空欄・選択肢は省略しないこと）
「Grammaire」欄がある場合は、見出しと説明文・例文を省略せず、元の構造（箇条書きなど）が分かるように書き起こしてください。

書き起こし終えたら、会話文（Dialogue）部分を見直し、写真の文字と一字一句完全に一致しているか自分で確認してから出力してください。
JSON のみで返してください: {"text":"書き起こしたフランス語テキスト"}`,
      },
    ];

    for (const file of files) {
      const dataUrl = await fileToDataUrl(file);
      content.push({ type: "input_image", image_url: dataUrl });
    }

    const response = await client.responses.create({
      model: process.env.OPENAI_VISION_MODEL || "gpt-4.1",
      input: [{ role: "user", content }],
      text: { format: { type: "json_object" } },
      // OCRは「創作」ではなく「書き写し」なので、ハルシネーション（架空の文の生成）を
      // 抑えるために温度を低くする
      temperature: 0.1,
    });

    const text = getTextFromResponse(response);
    const parsed = Extraction.parse(JSON.parse(text));
    return NextResponse.json(parsed);
  } catch (e: any) {
    const detail = { status: (e as any)?.status, code: (e as any)?.code, type: (e as any)?.type, param: (e as any)?.param };
    const stackLine = typeof e?.stack === "string" ? e.stack.split("\n").slice(0, 4).join(" | ") : "";
    console.error("OCR error:", e?.name, e?.message, detail, e?.stack);
    const hasDetail = detail.status || detail.code || detail.param;
    const message = hasDetail
      ? (e.message || "OCR error") + " (status:" + (detail.status ?? "-") + " code:" + (detail.code ?? "-") + " param:" + (detail.param ?? "-") + ")"
      : `${e?.name || "Error"}: ${e?.message || "OCR error"}${stackLine ? " [" + stackLine + "]" : ""}`;
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
