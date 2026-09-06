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

    const imageContent: any[] = [];
    for (const file of files) {
      const dataUrl = await fileToDataUrl(file);
      imageContent.push({ type: "input_image", image_url: dataUrl });
    }

    // 会話文・文法・語彙と、練習問題（Activités）を「別々のAI呼び出し」に分けて書き起こす。
    // 1回の呼び出しに全部詰め込むと、特に後半にある練習問題（設問3〜6など）が
    // 省略・要約されてしまうことがあったため、それぞれに専念させることで見落としを防ぐ。
    const transcribe = async (instructionText: string, maxTokens: number) => {
      const response = await client.responses.create({
        model: process.env.OPENAI_VISION_MODEL || "gpt-4.1",
        input: [{ role: "user", content: [{ type: "input_text", text: instructionText }, ...imageContent] }],
        text: { format: { type: "json_object" } },
        // OCRは「創作」ではなく「書き写し」なので、ハルシネーション（架空の文の生成）を
        // 抑えるために温度を低くする
        temperature: 0.1,
        // 内容が多いページでも途中で切れないよう、出力トークン数を多めに確保する
        max_output_tokens: maxTokens,
      });
      const text = getTextFromResponse(response);
      return Extraction.parse(JSON.parse(text)).text;
    };

    const mainInstruction = `これはフランス語学習用テキスト（教科書のページなど）の写真です。これはOCR（文字起こし）タスクです。あなたの仕事は「内容を要約・言い換え・新しく作文すること」では決してなく、写真に写っている文字を一字一句そのまま書き写すことです。

絶対に守るルール（最優先）:
- 実際に写真に印刷されている文字だけを書き写す。存在しない文・単語を絶対に作らない・推測で補わない・言い換えない。
- 会話文（Dialogue）は特に重要です。話者名（L'employée / La cliente など、女性形・男性形の綴りも含めて正確に）とセリフを、句読点・アポストロフィ・省略記号（…）も含めて完全に一字一句そのまま書き写す。1行も省略せず、1語も変えない。
- 文字が読み取りにくい・不鮮明な箇所があれば、無理に埋めず [判読不能] と書く（絶対に架空の単語で埋めない）。
- 練習問題「Activités」欄（穴埋め問題・正誤問題・選択問題など、番号付きの設問が並んでいる欄）は、このタスクでは書き起こさなくてよい（別のタスクで扱うため）。

書き起こす内容（写真に写っているものすべて、セクションごとに分けて。Activités欄は含めない）:
- 会話文（Dialogue） — 最優先で完全に正確に
- 語彙リスト「Vocabulaire」
- 決まり文句「Manières de dire」
- 文法解説「Grammaire」の見出し・ルール説明・例文（省略せず、元の構造〈箇条書きなど〉が分かるように）

書き起こし終えたら、会話文（Dialogue）部分を見直し、写真の文字と一字一句完全に一致しているか自分で確認してから出力してください。
JSON のみで返してください: {"text":"書き起こしたフランス語テキスト"}`;

    const exercisesInstruction = `これはフランス語学習用テキスト（教科書のページなど）の写真です。これはOCR（文字起こし）タスクです。あなたの仕事は、写真の中の**練習問題欄（「Activités」など、番号付きの設問が並んでいる欄）だけ**を、最初から最後まで1つも省略せず、一字一句そのまま書き写すことです。会話文・語彙リスト・文法解説など、練習問題欄以外の部分は書き起こさなくてよい。

絶対に守るルール（最優先）:
- 実際に写真に印刷されている文字だけを書き写す。存在しない文・単語を絶対に作らない・推測で補わない・言い換えない・要約しない。
- 大問（1, 2, 3...という番号がついた各設問グループ）が複数ある場合、**最後の大問まで1つも飛ばさず**すべて書き起こす。1つの大問に複数の小問（1. ___ baguette / 2. ___ glace のような番号付きの項目）がある場合も、その小問をすべて省略せず書き起こす。
- 各大問について、まずその指示文（例:「Complétez par « un », « une » ou « des ».」「Relisez le dialogue ci-contre. Vrai ou faux ?」）を書き、その後に番号付きの小問・選択肢・空欄（___ で表す）を元の構造のまま書き起こす。チェックボックスの記号自体は省略してよい。
- 【重要】1つの大問が左右2列（2カラム）に分かれてレイアウトされていることがよくある（例: 左列に 1〜5、右列に 6〜10 が並ぶ）。この場合、左右の見た目の位置に惑わされず、まず左列を1番から番号順に最後まで書き写し、そのあとで右列を続きの番号から書き写すこと。左右の列を交互に読んだり、列を混同したりしない。
- 各小問の番号（1, 2, 3...）は、写真に印刷されている番号を絶対にそのまま使う。番号を書き間違えたり、他の小問の番号と混同したり、勝手に振り直したりしない。書き写した後、印刷されている番号の並び（1,2,3,4,5,6,7,8,9,10 のように連番になっているか）と、自分が書いた番号が一致しているか必ず見直す。
- 文字が読み取りにくい・不鮮明な箇所があれば、無理に埋めず [判読不能] と書く。

書き終えたら、(1) 写真に写っている大問の数と、書き起こしたテキスト中の大問の数が一致しているか、(2) 各大問内の小問の番号が印刷されている番号・順序と完全に一致しているか、の両方を必ず見直してから出力してください（練習問題欄が写真に無い場合のみ text を空文字にする）。
JSON のみで返してください: {"text":"書き起こした練習問題のテキスト"}`;

    const [mainText, exercisesText] = await Promise.all([
      transcribe(mainInstruction, 4000),
      transcribe(exercisesInstruction, 8000),
    ]);

    const combined = [mainText.trim(), exercisesText.trim()].filter(Boolean).join("\n\n");
    return NextResponse.json({ text: combined });
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
