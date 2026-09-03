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
        text: `これはフランス語学習用テキスト（教科書のページなど）の写真です。
会話練習・自習教材として使うために、写真に写っているフランス語の内容をできるだけ正確にテキストとして書き起こしてください。含めるべき内容:
- 会話文
- 語彙リスト「Vocabulaire」
- 決まり文句「Manières de dire」
- 文法解説「Grammaire」の見出し・ルール説明・例文
- 練習問題「Activités」欄の設問（例:「1. Complétez par « un », « une » ou « des ». 1. ___ baguette 2. ___ glace ...」「Vrai ou faux ? 1. La cliente achète du pain.」のように、番号・設問文・選択肢・空欄（___ で表す）をできるだけ元の構造のまま書き起こす。チェックボックスの記号自体は省略してよいが、設問の文章・番号・空欄・選択肢は省略しないこと）
「Grammaire」欄がある場合は、見出しと説明文・例文を省略せず、元の構造（箇条書きなど）が分かるように書き起こしてください。
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
    });

    const text = getTextFromResponse(response);
    const parsed = Extraction.parse(JSON.parse(text));
    return NextResponse.json(parsed);
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "OCR error" }, { status: 500 });
  }
}
