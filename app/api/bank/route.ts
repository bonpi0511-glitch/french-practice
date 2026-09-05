import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";

export const runtime = "nodejs";
export const maxDuration = 30;

// 家族全員で1つの蓄積ボキャブラリーバンクを共有するため、キーは固定の1つだけ使う
// （ログイン機能が無いシンプルな家族利用アプリのため、ユーザーごとの分離はしない）
const BANK_KEY = "family_vocab_bank_v1";

// Vercel Marketplace の Redis（Upstash）連携は KV_REST_API_URL / KV_REST_API_TOKEN、
// Upstashを直接使う場合は UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN という
// 環境変数名になることがあるため、どちらでも動くようにしておく
function getRedis(): Redis | null {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export async function GET() {
  const redis = getRedis();
  if (!redis) {
    return NextResponse.json(
      { error: "共有バンク用のデータベース（Redis）が未設定です。", bank: [] },
      { status: 500 }
    );
  }
  try {
    const bank = await redis.get(BANK_KEY);
    return NextResponse.json({ bank: Array.isArray(bank) ? bank : [] });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || "Failed to load shared bank", bank: [] },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  const redis = getRedis();
  if (!redis) {
    return NextResponse.json(
      { error: "共有バンク用のデータベース（Redis）が未設定です。" },
      { status: 500 }
    );
  }
  try {
    const json = await req.json();
    if (!Array.isArray(json?.bank)) {
      return NextResponse.json({ error: "bank must be an array" }, { status: 400 });
    }
    await redis.set(BANK_KEY, json.bank);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Failed to save shared bank" }, { status: 500 });
  }
}
