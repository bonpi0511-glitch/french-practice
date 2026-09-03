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

type ExerciseItem = { prompt: string; answer: string; explanation_ja: string };

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

type TopicMode = "single" | "random";

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
  const [activeSourceText, setActiveSourceText] = useState("");
  const [activeMaterialLabel, setActiveMaterialLabel] = useState("");
  const [revealedExercises, setRevealedExercises] = useState<Set<string>>(new Set());

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
          exercises: Array.isArray(e?.exercises) ? e.exercises : [],
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
  }, [messages, loading]);

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

  function readFileAsText(file: File) {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("ファイルの読み込みに失敗しました"));
      reader.readAsText(file, "utf-8");
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
        const fd = new FormData();
        imageFiles.forEach((f) => fd.append("files", f));
        const res = await fetch("/api/ocr", { method: "POST", body: fd });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "画像からの文字起こしに失敗しました");
        if (data.text) collected.push(data.text);
      } catch (e: any) {
        setOcrError(e.message);
      } finally {
        setOcrLoading(false);
      }
    }

    const combined = collected.filter(Boolean).join("\n\n");
    const label = files.map((f) => f.name).join(", ");
    if (combined) {
      setSourceText(combined);
      // アップロードした教材は自動でボキャブラリーバンクに蓄積する
      addToVocabBank(combined, label);
    }
    setFileName(label);
  }

  function historyForApi() {
    return messages.map((m) =>
      m.role === "assistant"
        ? { role: "assistant" as const, content: m.french }
        : { role: "user" as const, content: m.french }
    );
  }

  async function callChatApi(text: string, userMessage?: string) {
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
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "会話の生成に失敗しました");
    return data as {
      reply: string;
      reply_translation_ja: string;
      correction_fr: string | null;
      correction_note_ja: string | null;
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
    if (!sourceText.trim()) {
      alert("テキストを貼り付けるか、テキストファイルをアップロードしてください");
      return null;
    }
    return { text: sourceText, label: fileName || "手入力テキスト" };
  }

  async function startConversation() {
    const topic = pickTopicText();
    if (!topic) return;
    if (topicMode === "single") localStorage.setItem(STORAGE_KEY, sourceText);
    setActiveSourceText(topic.text);
    setActiveMaterialLabel(topic.label);
    setError("");
    setLoading(true);
    setMessages([]);
    setStarted(true);
    try {
      const data = await callChatApi(topic.text);
      setMessages([{ role: "assistant", french: data.reply, translation: data.reply_translation_ja }]);
      if (autoSpeak) speakText(data.reply);
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
    const userMsg: Message = { role: "user", french: text, correction: null, correctionNote: null };
    setMessages((prev) => [...prev, userMsg]);
    setLoading(true);
    try {
      const data = await callChatApi(activeSourceText, text);
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
          { role: "assistant", french: data.reply, translation: data.reply_translation_ja },
        ];
      });
      if (autoSpeak) speakText(data.reply);
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
            onClick={() => addToVocabBank(sourceText, "手入力テキスト")}
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
          </div>
        </div>

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
          <button className="btn btn-primary" disabled={loading || ocrLoading} onClick={startConversation}>
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
              {topicMode === "random" ? "🎲 今回のお題: " : "📄 今回のお題: "}
              {activeMaterialLabel}
            </p>
          )}

          <div ref={scrollRef} className="mt-3 max-h-[520px] space-y-3 overflow-y-auto rounded-xl border border-stone-200 bg-stone-50 p-4">
            {messages.map((m, i) =>
              m.role === "assistant" ? (
                <div key={i} className="flex flex-col items-start">
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
                  <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-[#1c2b4a] px-4 py-2 text-sm text-white">
                    {m.french}
                  </div>
                  {m.correction && (
                    <div className="mt-1 max-w-[85%] rounded-xl border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
                      <div className="font-bold">添削: {m.correction}</div>
                      {m.correctionNote && <div className="mt-1">{m.correctionNote}</div>}
                    </div>
                  )}
                </div>
              )
            )}
            {loading && <div className="text-xs text-stone-400">相手が入力中...</div>}
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
                    <button
                      className="shrink-0 text-xs text-red-600 underline"
                      onClick={() => removeFromBank(entry.id)}
                    >
                      削除
                    </button>
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
            教材に含まれていた練習問題（穴埋め・正誤問題など）です。自分で考えてから「答えを見る」を押して確認しましょう。
          </p>

          <div className="mt-3 space-y-3">
            {accumulatedExercises.map(({ key, materialLabel, item }, i) => (
              <div key={key} className="rounded-xl border border-stone-200 bg-white p-3">
                <div className="text-[11px] text-stone-400">{materialLabel}</div>
                <p className="mt-1 text-sm font-semibold text-stone-800">
                  {i + 1}. {item.prompt}
                </p>
                {revealedExercises.has(key) ? (
                  <div className="mt-2 rounded-lg bg-stone-50 p-2 text-sm">
                    <div className="font-bold text-[#1c2b4a]">答え: {item.answer}</div>
                    <p className="mt-1 text-stone-600">{item.explanation_ja}</p>
                  </div>
                ) : (
                  <button
                    className="btn btn-secondary mt-2 text-xs"
                    onClick={() => toggleExerciseAnswer(key)}
                  >
                    答えを見る
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
