"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Level = "beginner" | "intermediate" | "advanced";

type Message =
  | { role: "assistant"; french: string; translation: string }
  | {
      role: "user";
      french: string;
      correction: string | null;
      correctionNote: string | null;
    };

type VocabPair = { fr: string; ja: string };

type GrammarPoint = { title: string; explanation_ja: string; examples: string[] };

type ExerciseItem = {
  prompt: string;
  answer: string;
  explanation_ja: string;
  qtype: "choice" | "text";
  choices: string[];
};

type MaterialEntry = {
  id: string;
  addedAt: string;
  label: string;
  preview: string;
  text: string;
  vocabulary: VocabPair[];
  grammarPoints: GrammarPoint[];
  exercises: ExerciseItem[];
};

type TopicMode = "single" | "random" | "pick";

const LEVEL_OPTIONS: { value: Level; label: string }[] = [
  { value: "beginner", label: "初級（簡単な単語・短い文）" },
  { value: "intermediate", label: "中級（一般的な語彙）" },
  { value: "advanced", label: "上級（自然な言い回し）" },
];

const STORAGE_KEY = "source_text";
const BANK_STORAGE_KEY = "vocab_bank";

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

// アップロードしたテキストの先頭行を、蓄積データのタイトルとして使う
// （教科書などは最初の行に単元名・見出しが書かれていることが多いため）
function extractTitleFromText(text: string): string {
  const firstLine = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return "";
  return firstLine.length > 60 ? firstLine.slice(0, 60) + "…" : firstLine;
}

// 教材テキストから「話者名: セリフ」形式の会話行をそのまま抜き出す。
// 初心者モードでは、AIにアレンジさせずこの配列の順番通りにセリフを1つずつ使うことで、
// 会話を教材の内容だけで（プロンプトの指示に頼らず）確実に完結させる。
function parseDialogueLines(text: string): { speaker: string; line: string }[] {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const pattern = /^([^:：]{1,40})[:：]\s*(.+)$/;
  const result: { speaker: string; line: string }[] = [];
  let collecting = false;
  for (const l of lines) {
    const m = l.match(pattern);
    if (m) {
      const speaker = m[1].trim();
      if (speaker && !/^\d+[.)]?$/.test(speaker)) {
        result.push({ speaker, line: m[2].trim() });
        collecting = true;
        continue;
      }
    }
    if (collecting) break; // 会話文ブロックが終わったとみなす
  }
  return result;
}

const BEGINNER_CLOSING_FR = "Merci beaucoup, c'est tout pour cette leçon !";
const BEGINNER_CLOSING_JA = "ありがとうございました。今回のレッスンはこれで終わりです。";

export default function FrenchPracticePage() {
  const [sourceText, setSourceText] = useState("");
  const [fileName, setFileName] = useState("");
  const [level, setLevel] = useState<Level>("beginner");
  const [messages, setMessages] = useState<Message[]>([]);
  const [started, setStarted] = useState(false);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrError, setOcrError] = useState("");
  const [vocabBank, setVocabBank] = useState<MaterialEntry[]>([]);
  const [bankLoading, setBankLoading] = useState(false);
  const [topicMode, setTopicMode] = useState<TopicMode>("single");
  const [selectedMaterialId, setSelectedMaterialId] = useState("");
  // false: AIが先に話す（教材の1人目の役）／true: ユーザーが先に話す（役割を交代）
  const [roleSwapped, setRoleSwapped] = useState(false);
  // true にすると、会話画面で自分（ユーザー）が話した内容の吹き出しを表示しない
  const [hideUserMessages, setHideUserMessages] = useState(false);
  const [activeSourceText, setActiveSourceText] = useState("");
  const [activeMaterialLabel, setActiveMaterialLabel] = useState("");
  // 会話中の話者ラベル（例:「L'employé」「La cliente」）。AIの最初の応答で決まる
  const [aiRoleLabel, setAiRoleLabel] = useState("");
  const [userRoleLabel, setUserRoleLabel] = useState("");
  // 初心者モード：自分が話す前に「回答例」を表示する
  const [beginnerMode, setBeginnerMode] = useState(false);
  const [suggestion, setSuggestion] = useState<{ fr: string; ja: string } | null>(null);
  const [suggestionLoading, setSuggestionLoading] = useState(false);
  // 初心者モードで、教材の会話文を最後まで使い終えた（AIがそれ以上アレンジしない）状態
  const [conversationFinished, setConversationFinished] = useState(false);
  const [revealedExercises, setRevealedExercises] = useState<Set<string>>(new Set());
  const [exerciseAnswers, setExerciseAnswers] = useState<Record<string, string>>({});
  const [checkedExercises, setCheckedExercises] = useState<Record<string, boolean>>({});

  // 音声関連
  const [autoSpeak, setAutoSpeak] = useState(true);
  const [speechSupported, setSpeechSupported] = useState(false);
  const [micSupported, setMicSupported] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceError, setVoiceError] = useState("");
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) setSourceText(saved);
    try {
      const savedBank = localStorage.getItem(BANK_STORAGE_KEY);
      if (savedBank) {
        const parsed = JSON.parse(savedBank);
        // 古いバージョンで保存されたデータに新しい項目（text / exercises など）が
        // 無くてもクラッシュしないよう、読み込み時に補完する
        const normalized: MaterialEntry[] = (Array.isArray(parsed) ? parsed : []).map((e: any) => ({
          id: e?.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          addedAt: e?.addedAt || new Date().toISOString(),
          label: e?.label || "",
          preview: e?.preview || "",
          text: e?.text || e?.preview || "",
          vocabulary: Array.isArray(e?.vocabulary) ? e.vocabulary : [],
          grammarPoints: Array.isArray(e?.grammarPoints) ? e.grammarPoints : [],
          exercises: (Array.isArray(e?.exercises) ? e.exercises : []).map((ex: any) => ({
            prompt: ex?.prompt || "",
            answer: ex?.answer || "",
            explanation_ja: ex?.explanation_ja || "",
            qtype: ex?.qtype === "choice" ? "choice" : "text",
            choices: Array.isArray(ex?.choices) ? ex.choices : [],
          })),
        }));
        setVocabBank(normalized);
      }
    } catch {}
    setSpeechSupported(typeof window !== "undefined" && "speechSynthesis" in window);
    setMicSupported(
      typeof window !== "undefined" &&
        !!navigator.mediaDevices?.getUserMedia &&
        typeof MediaRecorder !== "undefined"
    );
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading, input, suggestion, conversationFinished]);

  function saveBank(next: MaterialEntry[]) {
    setVocabBank(next);
    localStorage.setItem(BANK_STORAGE_KEY, JSON.stringify(next));
  }

  // 個別に呼び出し、失敗したものは空扱いにして他の結果は保存する
  async function extractPart<T>(path: string, text: string, key: string, fallbackErrorLabel: string): Promise<{ data: T[]; error: string | null }> {
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || fallbackErrorLabel);
      return { data: (data[key] as T[]) || [], error: null };
    } catch (e: any) {
      return { data: [], error: `${fallbackErrorLabel}: ${e.message}` };
    }
  }

  async function addToVocabBank(text: string, label: string) {
    if (!text.trim()) return;
    setBankLoading(true);
    setOcrError("");
    try {
      const [vocab, grammar, exercises] = await Promise.all([
        extractPart<VocabPair>("/api/vocab", text, "vocabulary", "ボキャブラリー抽出に失敗しました"),
        extractPart<GrammarPoint>("/api/grammar", text, "grammarPoints", "文法解説の抽出に失敗しました"),
        extractPart<ExerciseItem>("/api/exercises", text, "exercises", "設問の抽出に失敗しました"),
      ]);

      const entry: MaterialEntry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        addedAt: new Date().toISOString(),
        label,
        preview: text.trim().slice(0, 80),
        text: text.trim().slice(0, 6000),
        vocabulary: vocab.data,
        grammarPoints: grammar.data,
        exercises: exercises.data,
      };
      saveBank([...vocabBank, entry]);

      const errors = [vocab.error, grammar.error, exercises.error].filter(Boolean) as string[];
      if (errors.length) setOcrError(`一部の情報は取得できませんでした（${errors.join(" / ")}）。教材自体はバンクに保存されています。`);
    } finally {
      setBankLoading(false);
    }
  }

  function removeFromBank(id: string) {
    saveBank(vocabBank.filter((e) => e.id !== id));
  }

  // Most recent materials first, deduped by French term, capped for the API payload.
  const accumulatedVocab = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (let i = vocabBank.length - 1; i >= 0; i--) {
      for (const v of vocabBank[i].vocabulary) {
        const key = v.fr.trim().toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(`${v.fr} — ${v.ja}`);
      }
    }
    return out.slice(0, 150);
  }, [vocabBank]);

  const totalVocabCount = useMemo(() => {
    const seen = new Set<string>();
    vocabBank.forEach((e) => e.vocabulary.forEach((v) => seen.add(v.fr.trim().toLowerCase())));
    return seen.size;
  }, [vocabBank]);

  // Most recent materials first, deduped by grammar point title.
  const accumulatedGrammar = useMemo(() => {
    const seen = new Set<string>();
    const out: GrammarPoint[] = [];
    for (let i = vocabBank.length - 1; i >= 0; i--) {
      for (const g of vocabBank[i].grammarPoints) {
        const key = g.title.trim().toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(g);
      }
    }
    return out.slice(0, 20);
  }, [vocabBank]);

  // 教材ごとの設問を、新しいものから並べてまとめる（最大30問）
  const accumulatedExercises = useMemo(() => {
    const out: { key: string; materialLabel: string; item: ExerciseItem }[] = [];
    for (let i = vocabBank.length - 1; i >= 0; i--) {
      const entry = vocabBank[i];
      entry.exercises.forEach((item, idx) => {
        out.push({ key: `${entry.id}-${idx}`, materialLabel: entry.label, item });
      });
    }
    return out.slice(0, 30);
  }, [vocabBank]);

  function toggleExerciseAnswer(key: string) {
    setRevealedExercises((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function setExerciseAnswer(key: string, value: string) {
    // 回答を書き換えたら、それまでの採点結果は一旦引っ込める
    setCheckedExercises((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setExerciseAnswers((prev) => ({ ...prev, [key]: value }));
  }

  function checkExercise(key: string) {
    setCheckedExercises((prev) => ({ ...prev, [key]: true }));
  }

  function normalizeAnswerText(s: string) {
    return s
      .trim()
      .toLowerCase()
      .replace(/[.,!?;:]+$/g, "")
      .replace(/\s+/g, " ");
  }

  function isExerciseAnswerCorrect(key: string, correctAnswer: string) {
    return normalizeAnswerText(exerciseAnswers[key] || "") === normalizeAnswerText(correctAnswer);
  }

  function readFileAsText(file: File) {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("ファイルの読み込みに失敗しました"));
      reader.readAsText(file, "utf-8");
    });
  }

  // スマホの写真はそのままだと数MBになり、アップロードに失敗することがあるため、
  // 送信前に長辺2000px・JPEG圧縮にリサイズする（失敗時は元のファイルをそのまま使う）
  function resizeImageFile(file: File, maxDim = 2600, quality = 0.92): Promise<File> {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const img = new window.Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          URL.revokeObjectURL(url);
          resolve(file);
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob(
          (blob) => {
            URL.revokeObjectURL(url);
            if (!blob) {
              resolve(file);
              return;
            }
            const newName = file.name.replace(/\.\w+$/, "") + ".jpg";
            resolve(new File([blob], newName, { type: "image/jpeg" }));
          },
          "image/jpeg",
          quality
        );
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(file);
      };
      img.src = url;
    });
  }

  async function handleFiles(fileList: FileList | null) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setOcrError("");

    const textFiles = files.filter((f) => f.type.startsWith("text/") || /\.(txt|md)$/i.test(f.name));
    const imageFiles = files.filter((f) => f.type.startsWith("image/"));
    const collected: string[] = [];

    if (textFiles.length) {
      try {
        const texts = await Promise.all(textFiles.map(readFileAsText));
        collected.push(...texts);
      } catch (e: any) {
        setOcrError(e.message);
      }
    }

    if (imageFiles.length) {
      setOcrLoading(true);
      try {
        const resized = await Promise.all(
          imageFiles.map(async (f) => {
            try {
              return await resizeImageFile(f);
            } catch {
              return f;
            }
          })
        );
        const fd = new FormData();
        resized.forEach((f) => fd.append("files", f));
        const res = await fetch("/api/ocr", { method: "POST", body: fd });
        // まずテキストとして読み、JSONとして解釈できるか確認する。
        // （Vercelのエラーページ(HTML)やゲートウェイのエラーがそのまま返ってくると
        //   res.json() が謎のエラーになり原因が分からなくなるため、必ず内容を確認する）
        const raw = await res.text();
        let data: any = null;
        try {
          data = raw ? JSON.parse(raw) : null;
        } catch {
          const snippet = raw.slice(0, 200).replace(/\s+/g, " ").trim();
          throw new Error(
            `サーバーから予期しない応答がありました（status: ${res.status}）。内容: ${snippet || "(空)"}`
          );
        }
        if (!res.ok) throw new Error(data?.error || `画像からの文字起こしに失敗しました（status: ${res.status}）`);
        if (data?.text) collected.push(data.text);
      } catch (e: any) {
        setOcrError(e.message || String(e));
      } finally {
        setOcrLoading(false);
      }
    }

    const combined = collected.filter(Boolean).join("\n\n");
    const fileLabel = files.map((f) => f.name).join(", ");
    if (combined) {
      setSourceText(combined);
      // アップロードした教材は自動でボキャブラリーバンクに蓄積する
      // （テキストの先頭行をタイトルとして使い、無ければファイル名にフォールバック）
      addToVocabBank(combined, extractTitleFromText(combined) || fileLabel);
    }
    setFileName(fileLabel);
  }

  function historyForApi() {
    return messages.map((m) =>
      m.role === "assistant"
        ? { role: "assistant" as const, content: m.french }
        : { role: "user" as const, content: m.french }
    );
  }

  // 初心者モード：自分が話す前に「回答例」をAIに考えてもらう
  async function fetchSuggestion(
    text: string,
    history: { role: "user" | "assistant"; content: string }[],
    roleLabels?: { ai: string; user: string }
  ) {
    if (!beginnerMode) return;
    setSuggestionLoading(true);
    setSuggestion(null);
    // 教材の会話文が抽出できる場合は、次に対応するセリフをそのまま使う
    // （AIの応答に頼らず、確実に教材通りにする）
    const dialogueLines = parseDialogueLines(text);
    const forcedText = dialogueLines[history.length]?.line;
    try {
      const res = await fetch("/api/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceText: text,
          level,
          history,
          roleSwapped,
          aiRoleLabel: roleLabels?.ai ?? aiRoleLabel,
          userRoleLabel: roleLabels?.user ?? userRoleLabel,
          forcedSuggestion: forcedText,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "回答例の取得に失敗しました");
      setSuggestion({ fr: forcedText ?? data.suggestion_fr, ja: data.suggestion_ja });
    } catch {
      setSuggestion(null);
    } finally {
      setSuggestionLoading(false);
    }
  }

  async function callChatApi(text: string, userMessage?: string, forcedReply?: string) {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceText: text,
        level,
        history: historyForApi(),
        userMessage,
        vocabularyBank: accumulatedVocab,
        grammarNotes: accumulatedGrammar.map((g) => `${g.title}: ${g.explanation_ja}`),
        roleSwapped,
        aiRoleLabel,
        userRoleLabel,
        beginnerMode,
        forcedReply,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "会話の生成に失敗しました");
    return data as {
      reply: string;
      reply_translation_ja: string;
      correction_fr: string | null;
      correction_note_ja: string | null;
      ai_role_label: string;
      user_role_label: string;
      is_finished: boolean;
    };
  }

  // フランス語音声で読み上げる
  function speakText(text: string) {
    if (!text || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = "fr-FR";
    const voices = window.speechSynthesis.getVoices();
    const frVoice = voices.find((v) => v.lang?.toLowerCase().startsWith("fr"));
    if (frVoice) utter.voice = frVoice;
    window.speechSynthesis.speak(utter);
  }

  function pickTopicText(): { text: string; label: string } | null {
    if (topicMode === "random") {
      if (!vocabBank.length) {
        alert("ランダムモードを使うには、先に教材を1つ以上アップロード（またはボキャブラリーバンクに保存）してください");
        return null;
      }
      const pick = vocabBank[Math.floor(Math.random() * vocabBank.length)];
      return { text: pick.text, label: pick.label };
    }
    if (topicMode === "pick") {
      const picked = vocabBank.find((e) => e.id === selectedMaterialId);
      if (!picked) {
        alert("蓄積した教材の中から使うものを選んでください");
        return null;
      }
      return { text: picked.text, label: picked.label };
    }
    if (!sourceText.trim()) {
      alert("テキストを貼り付けるか、テキストファイルをアップロードしてください");
      return null;
    }
    return { text: sourceText, label: fileName || "手入力テキスト" };
  }

  async function startConversation(explicitTopic?: { text: string; label: string }) {
    const topic = explicitTopic || pickTopicText();
    if (!topic) return;
    if (!explicitTopic && topicMode === "single") localStorage.setItem(STORAGE_KEY, sourceText);
    setActiveSourceText(topic.text);
    setActiveMaterialLabel(topic.label);
    setError("");
    setMessages([]);
    setAiRoleLabel("");
    setUserRoleLabel("");
    setSuggestion(null);
    setConversationFinished(false);
    setStarted(true);
    if (roleSwapped) {
      // 役割交代モード：AIからは話しかけず、ユーザーの最初の発言を待つ
      fetchSuggestion(topic.text, []);
      return;
    }
    setLoading(true);
    // 初心者モードでは、教材の会話文が抽出できる限り、AIの最初の発言もそこから
    // そのまま取る（無ければ通常通りAIに考えてもらう）
    let forcedReply: string | undefined;
    let willFinish = false;
    if (beginnerMode) {
      const dialogueLines = parseDialogueLines(topic.text);
      if (dialogueLines.length > 0) {
        const nextLine = dialogueLines[0];
        if (nextLine) {
          forcedReply = nextLine.line;
        } else {
          forcedReply = BEGINNER_CLOSING_FR;
          willFinish = true;
        }
      }
    }
    try {
      const data = await callChatApi(topic.text, undefined, forcedReply);
      const replyFr = forcedReply ?? data.reply;
      const replyJa = forcedReply === BEGINNER_CLOSING_FR ? BEGINNER_CLOSING_JA : data.reply_translation_ja;
      setMessages([{ role: "assistant", french: replyFr, translation: replyJa }]);
      setAiRoleLabel(data.ai_role_label || "");
      setUserRoleLabel(data.user_role_label || "");
      const finished = willFinish || !!data.is_finished;
      setConversationFinished(finished);
      if (autoSpeak) speakText(replyFr);
      if (!finished) {
        fetchSuggestion(
          topic.text,
          [{ role: "assistant", content: replyFr }],
          { ai: data.ai_role_label || "", user: data.user_role_label || "" }
        );
      }
    } catch (e: any) {
      setError(e.message);
      setStarted(false);
    } finally {
      setLoading(false);
    }
  }

  async function sendMessage() {
    const text = input.trim();
    if (!text || loading) return;
    setError("");
    setInput("");
    setSuggestion(null);
    const priorHistory = historyForApi();
    const userMsg: Message = { role: "user", french: text, correction: null, correctionNote: null };
    setMessages((prev) => [...prev, userMsg]);
    setLoading(true);
    // 初心者モードでは、教材の会話文が抽出できる限り、AIの次の発言もそこから
    // 順番にそのまま取る（使い切ったら会話を終える）
    let forcedReply: string | undefined;
    let willFinish = false;
    if (beginnerMode) {
      const dialogueLines = parseDialogueLines(activeSourceText);
      if (dialogueLines.length > 0) {
        const aiTurnIndex = priorHistory.length + 1;
        const nextLine = dialogueLines[aiTurnIndex];
        if (nextLine) {
          forcedReply = nextLine.line;
        } else {
          forcedReply = BEGINNER_CLOSING_FR;
          willFinish = true;
        }
      }
    }
    try {
      const data = await callChatApi(activeSourceText, text, forcedReply);
      const replyFr = forcedReply ?? data.reply;
      const replyJa = forcedReply === BEGINNER_CLOSING_FR ? BEGINNER_CLOSING_JA : data.reply_translation_ja;
      setMessages((prev) => {
        const next = [...prev];
        const lastIdx = next.length - 1;
        if (next[lastIdx]?.role === "user") {
          next[lastIdx] = {
            role: "user",
            french: text,
            correction: data.correction_fr,
            correctionNote: data.correction_note_ja,
          };
        }
        return [
          ...next,
          { role: "assistant", french: replyFr, translation: replyJa },
        ];
      });
      setAiRoleLabel(data.ai_role_label || "");
      setUserRoleLabel(data.user_role_label || "");
      const finished = willFinish || !!data.is_finished;
      setConversationFinished(finished);
      if (autoSpeak) speakText(replyFr);
      if (!finished) {
        fetchSuggestion(
          activeSourceText,
          [...priorHistory, { role: "user", content: text }, { role: "assistant", content: replyFr }],
          { ai: data.ai_role_label || "", user: data.user_role_label || "" }
        );
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  function resetConversation() {
    setMessages([]);
    setStarted(false);
    setError("");
    setAiRoleLabel("");
    setUserRoleLabel("");
    setSuggestion(null);
    setConversationFinished(false);
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  }

  async function startRecording() {
    setVoiceError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported("audio/mp4")
        ? "audio/mp4"
        : MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "";
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      audioChunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(audioChunksRef.current, { type: mimeType || "audio/webm" });
        await transcribeAudio(blob, mimeType || "audio/webm");
      };
      recorder.start();
      mediaRecorderRef.current = recorder;
      setRecording(true);
    } catch {
      setVoiceError("マイクを使用できませんでした。ブラウザの設定でマイクへのアクセスを許可してください。");
    }
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop();
    setRecording(false);
  }

  async function transcribeAudio(blob: Blob, mimeType: string) {
    setTranscribing(true);
    try {
      const ext = mimeType.includes("mp4") ? "mp4" : "webm";
      const fd = new FormData();
      fd.append("audio", blob, `recording.${ext}`);
      const res = await fetch("/api/transcribe", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "音声の文字起こしに失敗しました");
      setInput((prev) => (prev ? `${prev} ${data.text}`.trim() : data.text));
    } catch (e: any) {
      setVoiceError(e.message);
    } finally {
      setTranscribing(false);
    }
  }

  return (
    <main className="mx-auto max-w-3xl p-4">
      <section className="card p-6">
        <p className="text-sm font-bold text-stone-500">🇫🇷 Français</p>
        <h1 className="mt-2 text-3xl font-bold">フランス語 会話練習アプリ</h1>
        <p className="mt-2 text-stone-600">
          テキストをアップロード（または貼り付け）すると、その内容をもとにAIがフランス語で会話練習の相手をしてくれます。
          マイクで話しかけたり、AIの返答を音声で聞くこともできます。
        </p>
      </section>

      <section className="card mt-4 p-5">
        <h2 className="text-xl font-bold">1. 会話の元になるテキストを用意</h2>
        <p className="mt-1 text-sm text-stone-600">
          テキストファイル（.txt / .md）、または教科書などのページ写真をアップロードできます。写真はAIが文字を読み取ってテキスト化します。
        </p>
        <p className="mt-1 text-xs text-stone-500">
          💡 読み取り精度を上げるコツ: 見開き2ページ全体より、会話文（Dialogue）部分だけを大きく・まっすぐ・明るい場所で撮影すると誤読が減ります。読み取り結果は下のテキスト欄で必ず確認し、間違いがあれば直接修正してください。
        </p>
        <input
          className="input mt-3 w-full"
          type="file"
          multiple
          accept="image/*,.txt,.md,text/plain"
          onChange={(e) => handleFiles(e.target.files)}
        />
        {ocrLoading && <p className="mt-1 text-xs text-stone-500">写真から文字を読み取っています...</p>}
        {bankLoading && <p className="mt-1 text-xs text-stone-500">ボキャブラリーと文法解説を抽出してバンクに追加しています...</p>}
        {fileName && !ocrLoading && <p className="mt-1 text-xs text-stone-500">読み込み済み: {fileName}</p>}
        {ocrError && (
          <div className="mt-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            エラー: {ocrError}
          </div>
        )}

        <textarea
          className="input mt-3 w-full"
          rows={8}
          placeholder="ここにフランス語の記事・会話文などのテキストを貼り付けることもできます"
          value={sourceText}
          onChange={(e) => setSourceText(e.target.value)}
        />
        <div className="mt-2">
          <button
            className="btn btn-secondary text-xs"
            disabled={bankLoading || !sourceText.trim()}
            onClick={() => addToVocabBank(sourceText, extractTitleFromText(sourceText) || "手入力テキスト")}
          >
            このテキストをボキャブラリーバンクに保存
          </button>
        </div>

        <div className="mt-3">
          <label className="text-sm font-semibold text-stone-600">レベル</label>
          <select
            className="input mt-1 w-full md:w-64"
            value={level}
            onChange={(e) => setLevel(e.target.value as Level)}
          >
            {LEVEL_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-stone-500">
            会話の難易度と、蓄積ボキャブラリーの復習頻度をこのレベルに合わせて調整します。
          </p>
        </div>

        <div className="mt-3">
          <label className="text-sm font-semibold text-stone-600">会話のテーマ</label>
          <div className="mt-1 flex flex-col gap-1 text-sm text-stone-700">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="topicMode"
                checked={topicMode === "single"}
                onChange={() => setTopicMode("single")}
              />
              このテキスト（上のテキスト欄の内容）で話す
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="topicMode"
                checked={topicMode === "random"}
                onChange={() => setTopicMode("random")}
                disabled={vocabBank.length === 0}
              />
              蓄積した教材からAIがランダムに選ぶ
              {vocabBank.length > 0 ? `（${vocabBank.length}件から）` : "（教材の蓄積が必要です）"}
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="topicMode"
                checked={topicMode === "pick"}
                onChange={() => setTopicMode("pick")}
                disabled={vocabBank.length === 0}
              />
              蓄積した教材から選んで話す
            </label>
            {topicMode === "pick" && (
              <select
                className="input mt-1"
                value={selectedMaterialId}
                onChange={(e) => setSelectedMaterialId(e.target.value)}
              >
                <option value="">-- 教材を選択 --</option>
                {vocabBank
                  .slice()
                  .reverse()
                  .map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.label}（{formatDate(entry.addedAt)}）
                    </option>
                  ))}
              </select>
            )}
          </div>
        </div>

        <label className="mt-3 flex items-center gap-2 text-sm text-stone-600">
          <input
            type="checkbox"
            checked={roleSwapped}
            onChange={(e) => setRoleSwapped(e.target.checked)}
          />
          🔄 役割を交代する（先にあなたが話す）
        </label>
        <p className="mt-1 text-xs text-stone-500">
          教材の会話は2人の話者を想定しています。オフだとAIが1人目の役で話しかけ、あなたが2人目の役で応答します。オンにすると逆に、あなたが先に話しかけ、AIがもう一方の役を演じます。
        </p>

        <label className="mt-3 flex items-center gap-2 text-sm text-stone-600">
          <input
            type="checkbox"
            checked={hideUserMessages}
            onChange={(e) => setHideUserMessages(e.target.checked)}
          />
          🙈 自分の発言を会話画面に表示しない
        </label>
        <p className="mt-1 text-xs text-stone-500">
          オンにすると、会話練習画面であなたが送った・話した内容の吹き出しが表示されなくなります（AIの発言・添削は今まで通り表示されます。会話の判定自体には影響しません）。
        </p>

        <label className="mt-3 flex items-center gap-2 text-sm text-stone-600">
          <input
            type="checkbox"
            checked={beginnerMode}
            onChange={(e) => setBeginnerMode(e.target.checked)}
          />
          🔰 初心者モード（話す前に回答例を表示する）
        </label>
        <p className="mt-1 text-xs text-stone-500">
          何も話せない・思いつかない場合向けです。オンにすると、自分の番になるたびに「回答例」の吹き出しが薄い緑色で表示されます。読む・聞く・入力欄にコピーして使う、いずれの練習にも使えます。
        </p>

        {speechSupported && (
          <label className="mt-3 flex items-center gap-2 text-sm text-stone-600">
            <input
              type="checkbox"
              checked={autoSpeak}
              onChange={(e) => setAutoSpeak(e.target.checked)}
            />
            🔊 AIの返答を自動で読み上げる
          </label>
        )}

        <div className="mt-4 flex flex-wrap gap-3">
          <button className="btn btn-primary" disabled={loading || ocrLoading} onClick={() => startConversation()}>
            {loading && !started ? "準備中..." : started ? "テキストを変えて再スタート" : "会話を始める"}
          </button>
          {started && (
            <button className="btn btn-secondary" onClick={resetConversation}>
              会話をリセット
            </button>
          )}
        </div>

        {error && (
          <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            エラー: {error}
          </div>
        )}
      </section>

      {started && (
        <section className="card mt-4 p-5">
          <h2 className="text-xl font-bold">2. 会話練習</h2>
          {activeMaterialLabel && (
            <p className="mt-1 text-xs text-stone-500">
              {topicMode === "random" ? "🎲 今回のお題: " : topicMode === "pick" ? "📌 今回のお題: " : "📄 今回のお題: "}
              {activeMaterialLabel}
            </p>
          )}

          <div ref={scrollRef} className="mt-3 max-h-[520px] space-y-3 overflow-y-auto rounded-xl border border-stone-200 bg-stone-50 p-4">
            {roleSwapped && messages.length === 0 && (
              <div className="rounded-xl border border-dashed border-stone-300 bg-white p-3 text-xs text-stone-500">
                🔄 役割交代モードです。まずはあなたから、教材の会話を参考にフランス語で話しかけてみましょう。
              </div>
            )}
            {messages.map((m, i) =>
              m.role === "assistant" ? (
                <div key={i} className="flex flex-col items-start">
                  {aiRoleLabel && (
                    <div className="mb-0.5 text-[11px] font-semibold text-stone-400">{aiRoleLabel}</div>
                  )}
                  <div className="max-w-[85%] rounded-2xl rounded-tl-sm bg-white border border-stone-200 px-4 py-2 text-sm">
                    {m.french}
                  </div>
                  <div className="mt-1 flex max-w-[85%] items-center gap-2 text-xs text-stone-500">
                    <span>{m.translation}</span>
                    {speechSupported && (
                      <button
                        className="shrink-0 text-stone-400 hover:text-stone-600"
                        onClick={() => speakText(m.french)}
                        title="もう一度聞く"
                      >
                        🔊
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <div key={i} className="flex flex-col items-end">
                  {!hideUserMessages && userRoleLabel && (
                    <div className="mb-0.5 text-[11px] font-semibold text-stone-400">{userRoleLabel}</div>
                  )}
                  {!hideUserMessages && (
                    <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-[#1c2b4a] px-4 py-2 text-sm text-white">
                      {m.french}
                    </div>
                  )}
                  {m.correction && (
                    <div className="mt-1 max-w-[85%] rounded-xl border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
                      <div className="font-bold">添削: {m.correction}</div>
                      {m.correctionNote && <div className="mt-1">{m.correctionNote}</div>}
                    </div>
                  )}
                </div>
              )
            )}
            {beginnerMode && suggestionLoading && (
              <div className="text-xs text-stone-400">回答例を考えています...</div>
            )}
            {beginnerMode && suggestion && (
              <div className="flex flex-col items-end">
                {userRoleLabel && (
                  <div className="mb-0.5 text-[11px] font-semibold text-emerald-600">
                    💡 {userRoleLabel}（回答例）
                  </div>
                )}
                <div className="max-w-[85%] rounded-2xl rounded-tr-sm border-2 border-emerald-300 bg-emerald-50 px-4 py-2 text-sm text-emerald-900">
                  {suggestion.fr}
                </div>
                <div className="mt-1 flex max-w-[85%] items-center gap-2 text-xs text-stone-500">
                  <span>{suggestion.ja}</span>
                  {speechSupported && (
                    <button
                      className="shrink-0 text-stone-400 hover:text-stone-600"
                      onClick={() => speakText(suggestion.fr)}
                      title="聞く"
                    >
                      🔊
                    </button>
                  )}
                  <button
                    className="shrink-0 text-emerald-700 underline"
                    onClick={() => setInput(suggestion.fr)}
                  >
                    入力欄に使う
                  </button>
                </div>
              </div>
            )}
            {!hideUserMessages && !loading && input.trim() && (
              <div className="flex flex-col items-end">
                <div className="max-w-[85%] rounded-2xl rounded-tr-sm border-2 border-dashed border-[#1c2b4a] bg-white px-4 py-2 text-sm text-[#1c2b4a] opacity-70">
                  {input}
                </div>
                <span className="mt-1 text-xs text-stone-400">送信前のプレビュー</span>
              </div>
            )}
            {loading && <div className="text-xs text-stone-400">相手が入力中...</div>}
            {conversationFinished && (
              <div className="rounded-xl border border-dashed border-emerald-300 bg-emerald-50 p-3 text-xs text-emerald-800">
                🎉 教材の会話はここまでです。AIはこれ以上、新しいセリフを作りません。別の教材で続けたい場合は「テキストを変えて再スタート」を使ってください。
              </div>
            )}
          </div>

          {voiceError && (
            <div className="mt-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              エラー: {voiceError}
            </div>
          )}

          <div className="mt-3 flex gap-2">
            {micSupported && (
              <button
                type="button"
                className={`btn shrink-0 ${recording ? "btn-danger" : "btn-secondary"}`}
                disabled={loading || transcribing}
                onClick={recording ? stopRecording : startRecording}
                title={recording ? "録音を停止して文字起こし" : "マイクで話す"}
              >
                {recording ? "⏹ 停止" : transcribing ? "認識中..." : "🎤 話す"}
              </button>
            )}
            <input
              className="input flex-1"
              placeholder="フランス語で返信してみましょう（マイクでも入力できます）"
              value={input}
              disabled={loading}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") sendMessage();
              }}
            />
            <button className="btn btn-primary shrink-0" disabled={loading || !input.trim()} onClick={sendMessage}>
              送信
            </button>
          </div>
        </section>
      )}

      {vocabBank.length > 0 && (
        <section className="card mt-4 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-xl font-bold">📚 蓄積ボキャブラリーバンク</h2>
            <span className="text-sm text-stone-500">単語・表現 {totalVocabCount} 件蓄積中</span>
          </div>
          <p className="mt-1 text-sm text-stone-600">
            これまでにアップロードした教材から集めた語彙です。会話中にレベルに合わせて自然に復習として登場します。
          </p>

          <div className="mt-3 max-h-64 overflow-y-auto rounded-xl border border-stone-200 bg-stone-50 p-2">
            {vocabBank
              .slice()
              .reverse()
              .map((entry) => (
                <div key={entry.id} className="mb-2 rounded-lg border border-stone-200 bg-white p-2 last:mb-0">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-xs font-bold text-stone-700">{entry.label}</div>
                      <div className="text-[11px] text-stone-400">
                        {formatDate(entry.addedAt)} ・ 語彙 {entry.vocabulary.length} 件
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        className="text-xs text-[#1c2b4a] underline"
                        onClick={() => {
                          setTopicMode("pick");
                          setSelectedMaterialId(entry.id);
                          startConversation({ text: entry.text, label: entry.label });
                        }}
                      >
                        この教材で話す
                      </button>
                      <button
                        className="text-xs text-red-600 underline"
                        onClick={() => removeFromBank(entry.id)}
                      >
                        削除
                      </button>
                    </div>
                  </div>
                  {entry.vocabulary.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {entry.vocabulary.slice(0, 12).map((v, i) => (
                        <span
                          key={i}
                          className="rounded-full bg-stone-100 px-2 py-0.5 text-[11px] text-stone-700"
                          title={v.ja}
                        >
                          {v.fr}
                        </span>
                      ))}
                      {entry.vocabulary.length > 12 && (
                        <span className="text-[11px] text-stone-400">+{entry.vocabulary.length - 12}</span>
                      )}
                    </div>
                  )}
                </div>
              ))}
          </div>
        </section>
      )}

      {accumulatedGrammar.length > 0 && (
        <section className="card mt-4 p-5">
          <h2 className="text-xl font-bold">📖 文法解説（日本語）</h2>
          <p className="mt-1 text-sm text-stone-600">
            アップロードした教材の文法解説欄（Grammaire など）を、AIが日本語でわかりやすく解説したものです。会話中の添削もこの内容を踏まえて説明されます。
          </p>

          <div className="mt-3 space-y-3">
            {accumulatedGrammar.map((g, i) => (
              <div key={i} className="rounded-xl border border-stone-200 bg-white p-3">
                <div className="text-sm font-bold text-stone-800">{g.title}</div>
                <p className="mt-1 text-sm text-stone-700">{g.explanation_ja}</p>
                {g.examples.length > 0 && (
                  <ul className="mt-2 list-disc pl-5 text-xs text-stone-500">
                    {g.examples.map((ex, j) => (
                      <li key={j}>{ex}</li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {accumulatedExercises.length > 0 && (
        <section className="card mt-4 p-5">
          <h2 className="text-xl font-bold">📝 設問（練習問題）</h2>
          <p className="mt-1 text-sm text-stone-600">
            教材に含まれていた練習問題（穴埋め・正誤問題など）です。回答してから「採点する」を押すか、「答えを見る」で正解を確認しましょう。
          </p>

          <div className="mt-3 space-y-3">
            {accumulatedExercises.map(({ key, materialLabel, item }, i) => {
              const checked = !!checkedExercises[key];
              const revealed = revealedExercises.has(key);
              const correct = checked ? isExerciseAnswerCorrect(key, item.answer) : false;
              return (
                <div key={key} className="rounded-xl border border-stone-200 bg-white p-3">
                  <div className="text-[11px] text-stone-400">{materialLabel}</div>
                  <p className="mt-1 text-sm font-semibold text-stone-800">
                    {i + 1}. {item.prompt}
                  </p>

                  <div className="mt-2 space-y-2">
                    {item.qtype === "choice" && item.choices.length > 0 ? (
                      <div className="flex flex-wrap gap-2">
                        {item.choices.map((choice) => (
                          <button
                            key={choice}
                            type="button"
                            onClick={() => setExerciseAnswer(key, choice)}
                            className={`rounded-lg border px-3 py-1.5 text-xs ${
                              exerciseAnswers[key] === choice
                                ? "border-[#1c2b4a] bg-[#1c2b4a] text-white"
                                : "border-stone-300 bg-white text-stone-700"
                            }`}
                          >
                            {choice}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <input
                        type="text"
                        value={exerciseAnswers[key] || ""}
                        onChange={(e) => setExerciseAnswer(key, e.target.value)}
                        placeholder="回答を入力..."
                        className="input w-full"
                      />
                    )}

                    <div className="flex flex-wrap gap-2">
                      <button
                        className="btn btn-primary text-xs"
                        disabled={!(exerciseAnswers[key] || "").trim()}
                        onClick={() => checkExercise(key)}
                      >
                        採点する
                      </button>
                      <button className="btn btn-secondary text-xs" onClick={() => toggleExerciseAnswer(key)}>
                        {revealed ? "答えを隠す" : "答えを見る"}
                      </button>
                    </div>
                  </div>

                  {checked && (
                    <div className={`mt-2 rounded-lg p-2 text-sm ${correct ? "bg-emerald-50" : "bg-rose-50"}`}>
                      <div className={`font-bold ${correct ? "text-emerald-700" : "text-rose-700"}`}>
                        {correct ? "✅ 正解！" : "❌ 不正解"}
                      </div>
                      <div className="mt-1 font-bold text-[#1c2b4a]">正解: {item.answer}</div>
                      <p className="mt-1 text-stone-600">{item.explanation_ja}</p>
                    </div>
                  )}

                  {revealed && (
                    <div className="mt-2 rounded-lg bg-stone-50 p-2 text-sm">
                      <div className="font-bold text-[#1c2b4a]">正解: {item.answer}</div>
                      <p className="mt-1 text-stone-600">{item.explanation_ja}</p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </main>
  );
}
