import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

export const runtime = "nodejs";
export const maxDuration = 60;

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
    const audio = form.get("audio");
    if (!(audio instanceof File)) {
      return NextResponse.json({ error: "No audio uploaded." }, { status: 400 });
    }

    const client = new OpenAI({ apiKey });

    const transcription = await client.audio.transcriptions.create({
      file: audio,
      model: "whisper-1",
      language: "fr",
    });

    return NextResponse.json({ text: transcription.text || "" });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Transcription error" }, { status: 500 });
  }
}
