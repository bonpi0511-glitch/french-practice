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
  qtype: z.enum(["choice", "multi", "text"]).default("text"),
  choices: z.array(z.string()).max(20).default([]),
});

const Extraction = z.object({
  // exercises を作る前に、教材中の大問・小問（空欄）を全部数え上げさせるための
  // 下書き欄。最終的な結果には使わないが、ここで先に列挙させることで
  // 見落とし（特に対話の穴埋めの1問目など）を防ぐ。
  analysis: z.string().catch(""),
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

type OutExercise = {
  prompt: string;
  groupTitle: string;
  answer: string;
  explanation_ja: string;
  qtype: "choice" | "multi" | "text";
  choices: string[];
};

// 「Complétez le dialogue ...」のような対話穴埋め問題は、AIによる自由な抽出だと
// 空欄を見落としがち（何度プロンプトを調整しても再発した）なので、最後の砦として
// 正規表現で機械的に空欄を数え上げ、AIの結果が足りない場合はここで補う。
const DIALOGUE_INSTRUCTION_RE = /complétez.{0,20}dialogue/i;
const NEW_BIG_QUESTION_RE =
  /^\s*\d+\s*[.\)]?\s*(entourez|cochez|répondez|reliez|complétez|associez|choisissez|vrai|faux)/i;
const BLANK_LINE_RE = /^\s*\d*\.?\s*[—–\-]?\s*_{2,}\s*$/;

// ctx（直前のセリフ）が「この空欄が何番目のどの空欄か」を決める安定した
// 識別子で、after（直後のセリフ）はあくまで表示用の補助情報（見つからない
// こともある）。この2つを分けて持たせておくことで、同じ空欄が「afterあり」
// 「afterなし」など表示のリッチさが違う形で複数回抽出されても、ctxベースで
// 同一の空欄だと判定できるようにする。
type DialogueBlank = { ctx: string; blank: string; after: string };
type DialogueGroup = { groupTitle: string; items: DialogueBlank[] };

function extractDialogueBlanks(text: string): DialogueGroup[] {
  const lines = text.split(/\r?\n/);
  const groups: DialogueGroup[] = [];
  let i = 0;
  while (i < lines.length) {
    if (DIALOGUE_INSTRUCTION_RE.test(lines[i])) {
      const instructionLine = lines[i].trim();
      const blockLines: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        if (NEW_BIG_QUESTION_RE.test(lines[j]) && !DIALOGUE_INSTRUCTION_RE.test(lines[j])) break;
        blockLines.push(lines[j]);
        j++;
      }
      const items: DialogueBlank[] = [];
      for (let k = 0; k < blockLines.length; k++) {
        if (!BLANK_LINE_RE.test(blockLines[k])) continue;
        let ctx = "";
        for (let m = k - 1; m >= 0; m--) {
          const cand = blockLines[m].trim();
          if (cand && !BLANK_LINE_RE.test(blockLines[m])) {
            ctx = cand;
            break;
          }
        }
        // 直後のセリフ（次の空欄ではない、確定した行）も分かる場合は含める。
        // 空欄の答えが、その後の相手の返答（「はい、〜をどうぞ」など）から
        // しか判断できないことがあるため（例: 最後の空欄の答えは、その次の
        // 「Voilà, deux petites tartes au citron.」という行を見て初めて分かる）。
        let after = "";
        for (let m = k + 1; m < blockLines.length; m++) {
          const cand = blockLines[m].trim();
          if (!cand) continue;
          if (!BLANK_LINE_RE.test(blockLines[m])) after = cand;
          break;
        }
        items.push({ ctx, blank: blockLines[k].trim(), after });
      }
      if (items.length > 0) groups.push({ groupTitle: instructionLine, items });
      i = j;
    } else {
      i++;
    }
  }
  return groups;
}

function normLine(s: string) {
  // 先頭の番号（「2. 」「2 」のように、ピリオドが付く場合と付かない場合の
  // どちらも表記ゆれとして起こる）は、比較の前に取り除く。
  // ピリオドを必須にすると「5 Complétez...」のようにピリオドの無い書き方を
  // 取りこぼし、同じ大問なのに別グループとして扱われてしまうため、
  // ピリオドは任意（?）にしてある。
  return s
    .replace(/^\s*\d+\.?\s*/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// 対話穴埋めの空欄は、専用のOCR呼び出しと通常のOCR呼び出しの両方が
// （除外の指示にもかかわらず）拾ってしまうことがあり、その場合、同じ空欄が
// 表記違い（番号の有無・afterが取れているかどうか等）で重複して抽出される
// ことがある。「直前のセリフ（ctx）」は、その空欄が対話の中で何番目の
// どの空欄かを一意に決める安定した情報なので、これだけを比較キーにする
// （afterの有無で長さが変わる prompt 全体をキーにすると、afterが取れた版と
// 取れなかった版が別物として扱われ、重複排除に失敗するため）。
function dialogueBlankKey(item: DialogueBlank): string {
  const base = item.ctx || item.blank;
  return base
    .replace(/[—–\-]?\s*_{2,}/g, "")
    .replace(/^\s*\d+\.?\s*/, "")
    .replace(/[—–\-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// 対話穴埋めの大問は、専用OCR呼び出しと通常のOCR呼び出しが両方拾ってしまうと、
// 本文中に同じ指示文（例:「5 Complétez le dialogue suivant.」）の対話ブロックが
// まるごと2回以上出現することがある。extractDialogueBlanks はその両方を
// 別々のグループとして見つけてしまうため、ここで指示文が同じグループを1つに
// まとめ、空欄も内容ベースで重複排除しておく。同じ空欄が複数回見つかった
// 場合は、afterまで取れている「より情報が多い方」を優先して残す。
function mergeDuplicateGroups(groups: DialogueGroup[]): DialogueGroup[] {
  const clusters: Record<string, DialogueGroup> = {};
  const order: string[] = [];
  groups.forEach((g) => {
    const key = normLine(g.groupTitle);
    if (!clusters[key]) {
      clusters[key] = { groupTitle: g.groupTitle, items: [] };
      order.push(key);
    }
    clusters[key].items = clusters[key].items.concat(g.items);
  });
  return order.map((key) => {
    const g = clusters[key];
    const keyToIndex: Record<string, number> = {};
    const items: DialogueBlank[] = [];
    g.items.forEach((it) => {
      const k = dialogueBlankKey(it);
      const existingIdx = keyToIndex[k];
      if (existingIdx === undefined) {
        keyToIndex[k] = items.length;
        items.push(it);
      } else if (!items[existingIdx].after && it.after) {
        // 既存の方に after が無く、今回の方にはあれば、より情報の多い方に差し替える
        items[existingIdx] = it;
      }
    });
    return { groupTitle: g.groupTitle, items };
  });
}

// 対話穴埋め（Complétez le dialogue のような形式）は、AIによる抽出を一切使わない。
// AI側は「一部だけ拾う」「同じ空欄を表記違いで重複させる」「セリフをまたいで
// 空欄をまとめてしまう」といった崩れ方を、プロンプトをどれだけ調整しても
// 繰り返した。AI結果とのすり合わせ（答えの流用など）をしようとするたびに
// 新しい不具合が生まれたため、この形式に関しては「本文をそのまま正規表現で
// 機械的に設問へ変換する」方針に統一する（AIの判断を挟まない）。
// 正解・解説は、この後 fillMissingAnswers で別途AIに埋めてもらう。
function buildDialogueExercises(rawText: string): OutExercise[] {
  const groups = mergeDuplicateGroups(extractDialogueBlanks(rawText));
  const items: OutExercise[] = [];
  groups.forEach((group) => {
    group.items.forEach((gi) => {
      const prompt = [gi.ctx, gi.blank, gi.after].filter(Boolean).join("\n");
      items.push({
        prompt,
        groupTitle: group.groupTitle,
        answer: "",
        explanation_ja: "",
        qtype: "text",
        choices: [],
      });
    });
  });
  return items;
}

// 正規表現で補った空欄のうち、AIの結果から答えを流用できなかったものだけ、
// 追加でAIに答えだけを埋めてもらう（対象が絞られた小さな依頼なので、
// 通常の抽出より確実にこなせる）。
async function fillMissingAnswers(
  client: OpenAI,
  model: string,
  merged: OutExercise[],
  needsAnswer: number[],
  sourceText: string
): Promise<OutExercise[]> {
  if (needsAnswer.length === 0) return merged;

  const FillItem = z.object({ index: z.number(), answer: stringish, explanation_ja: stringish });
  const FillResult = z.object({ answers: z.array(FillItem).default([]) });

  const list = needsAnswer
    .map((idx, i) => `${i}: ${merged[idx].prompt.replace(/\n/g, " / ")}`)
    .join("\n");

  try {
    const response = await client.responses.create({
      model,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `以下は、フランス語教材の対話文の穴埋め問題の一部です。教材本文を参考に、それぞれの空欄に入る自然なフランス語の返答（正解）と、日本語での短い解説を考えてください。

設問一覧（"index: 文脈 / — ___"の形式）:
${list}

教材本文:
"""
${sourceText.slice(0, 20000)}
"""

JSONのみで返してください: {"answers":[{"index":0,"answer":"","explanation_ja":""}]}`,
            },
          ],
        },
      ],
      text: { format: { type: "json_object" } },
      max_output_tokens: 2000,
      temperature: 0.3,
    });
    const text = getTextFromResponse(response);
    const parsed = FillResult.parse(JSON.parse(text));
    const result = merged.slice();
    parsed.answers.forEach((a) => {
      const targetIdx = needsAnswer[a.index];
      if (targetIdx !== undefined && result[targetIdx]) {
        result[targetIdx] = { ...result[targetIdx], answer: a.answer, explanation_ja: a.explanation_ja };
      }
    });
    return result;
  } catch {
    // 失敗しても致命的ではない（設問自体は表示される。答えが空欄のままになるだけ）
    return merged;
  }
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

作業手順（必ずこの順番で行うこと）:

【手順1】まず analysis 欄に、教材テキスト中の練習問題欄を最初から最後まで読み、見つけた大問（番号付きの見出し）と、その下にある小問・空欄を「1つ残らず」箇条書きで書き出す。大問ごとに「大問の指示文」→「その下にある小問の番号を全部列挙（例: 小問 1, 2, 3, 4）」という形で書く。特に対話文の穴埋め（Complétez le dialogue のような形式）では、対話の行を1行ずつ数え、空欄になっている行の番号を1つも取りこぼさず全部書き出すこと（1番目の行が空欄の場合も必ず含める）。この箇条書きが、次の手順で作る exercises の設問数と1対1で対応している必要がある。

【手順2】analysis で列挙した小問・空欄を1つずつ、以下の形式で exercises 配列に変換する。analysis に書いた数と exercises の数が一致しているか、最後に必ず見直す。

教材には、1つの大問（例:「2 Complétez par « un », « une », « des ».」）の下に複数の小問（1. ___ baguette / 2. ___ glace / ...）がぶら下がっている構成がよくあります。この場合、小問1つ1つを別々の設問として抽出しつつ、それぞれの prompt の先頭に、その小問が属する大問の指示文（何を答えればよいかの説明）を必ず含めてください。小問の番号や文だけを見ても何をすればよいか分からない状態にしないでください。

特に注意が必要な形式:
- 「リストの中から選ぶ・丸で囲む」形式（例:「Entourez les bonnes réponses.」の下に "un croissant, une fleur, des bonbons, ..." のような単語・フレーズのリストが並んでいる）: これは1問だけの設問として抽出し、qtype を "multi" にする。prompt には大問の指示文（例:「Que pouvez-vous acheter dans une boulangerie-pâtisserie ? Entourez les bonnes réponses.」）だけを入れ、リストの単語は prompt に含めず、代わりに choices にリストの項目を1つずつ全部（省略しない）そのまま入れる。answer には、そのリストの中で実際に正しい項目だけを「、」区切りで全部含める（choices と完全に同じ表記にする）。

【重要】「Complétez le dialogue suivant.」のような、対話文の中のセリフ（返答）を埋める形式の設問は、analysis にも exercises にも一切含めないこと（このタスクの対象外。この形式だけは別の仕組みで機械的に処理するため、AIによる抽出は行わない）。

その設問部分を見つけ、1問ずつ以下の形式に整理してください:
- prompt: 設問文（例:「Complétez par « un », « une » ou « des ». 1. ___ baguette」のように、その小問が属する大問の指示文＋元の番号・空欄（___）をセットで含める。「Vrai ou faux ? 1. La cliente achète du pain.」のように大問の指示（Vrai ou faux ?）も同様に含める。ただし選択肢そのものはここに含めず choices に分ける）
- group_title: prompt の先頭に含めた「大問の指示文」の部分だけを、そのまま入れる（例:「Complétez par « un », « une » ou « des ».」「Relisez le dialogue ci-contre. Vrai ou faux ?」）。同じ大問に属する小問は、すべて同じ group_title（一字一句同じ文字列）にすること。大問に属さない独立した設問の場合は空文字にする。
- answer: 正解（教材の会話文や文法解説の内容から判断できる場合はそれを使う。フランス語の単語・文・Vrai/Fauxなど、簡潔に。choice タイプの場合は choices のいずれかと完全に一致させる。正解が複数ある設問（複数選択など）の場合も、配列ではなく「、」で区切った1つの文字列にすること）
- explanation_ja: なぜその答えになるか、日本語で短く（1〜2文）説明
- qtype: 回答形式。以下のいずれか:
  - "choice": 正誤問題（Vrai/Faux）や、選択肢が明示されている、正解が1つだけの選択問題。この場合 choices に選べる選択肢をすべて入れる（Vrai/Fauxなら choices は ["Vrai","Faux"]）
  - "multi": 「Entourez les bonnes réponses.」のように、リストの中から正解が複数（1つとは限らない）ある形式。choices にリストの項目を全部入れる
  - "text": 穴埋め問題や自由記述問題など、選択肢が無く自分で単語・文を書いて答える形式。この場合 choices は空配列にする
- choices: qtype が "choice" または "multi" のときの選択肢一覧（フランス語のまま、省略しない）。"text" のときは空配列

教材テキスト中の小問の番号（1, 2, 3...）は、そのテキストに書かれている番号をそのまま使い、抽出する順序も元のテキストに現れる番号順（1→2→3...）にすること。番号を勝手に振り直したり、他の小問と入れ替えたりしない。

設問が教材中に無い場合は analysis に「設問なし」とだけ書き、exercises を空配列にしてください。設問ではない部分（会話文や語彙リストそのもの）は含めないでください。最大30問まで。
JSON のみで返してください（analysis を必ず exercises より先に書くこと）: {"analysis":"","exercises":[{"prompt":"","group_title":"","answer":"","explanation_ja":"","qtype":"text","choices":[]}]}

教材テキスト:
"""
${body.text.slice(0, 20000)}
"""`;

    const response = await client.responses.create({
      model: process.env.OPENAI_CHAT_MODEL || process.env.OPENAI_VISION_MODEL || "gpt-4.1",
      input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
      text: { format: { type: "json_object" } },
      // 設問数が多い教材（最大30問、各問に日本語の説明も付く）でも出力が途中で切れないよう、
      // 出力トークン数を十分に確保する（30問 × 説明文込みでも収まる余裕を持たせる）。
      // analysis欄（下書きの列挙）の分も見込んで、通常より多めに確保する。
      max_output_tokens: 16000,
      // group_title（大問の指示文）が小問ごとに表記ゆれ（空白・引用符など）で
      // バラバラにならないよう、温度を下げて安定した出力にする
      temperature: 0.1,
    });

    const text = getTextFromResponse(response);
    const parsed = Extraction.parse(JSON.parse(text));
    // クライアント側の型（groupTitle）に合わせて変換して返す
    const rawExercises: OutExercise[] = parsed.exercises.map((ex) => ({
      prompt: ex.prompt,
      groupTitle: ex.group_title,
      answer: ex.answer,
      explanation_ja: ex.explanation_ja,
      qtype: ex.qtype,
      choices: ex.choices,
    }));

    // 対話穴埋め問題は、AIには一切抽出させず（指示はしているが、それでも
    // 稀に紛れ込むことがあるため念のため除去）、常に正規表現による機械的な
    // 抽出結果だけを使う。それ以外の設問はこれまで通りAIの抽出結果を使う。
    const model = process.env.OPENAI_CHAT_MODEL || process.env.OPENAI_VISION_MODEL || "gpt-4.1";
    const nonDialogueExercises = rawExercises.filter((ex) => !DIALOGUE_INSTRUCTION_RE.test(ex.groupTitle || ""));
    const dialogueExercises = buildDialogueExercises(body.text);
    const combined = nonDialogueExercises.concat(dialogueExercises);
    const needsAnswer: number[] = [];
    combined.forEach((ex, idx) => {
      if (!ex.answer && DIALOGUE_INSTRUCTION_RE.test(ex.groupTitle || "")) needsAnswer.push(idx);
    });
    const exercises = await fillMissingAnswers(client, model, combined, needsAnswer, body.text);

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
