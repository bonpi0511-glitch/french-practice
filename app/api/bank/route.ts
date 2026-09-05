import { NextRequest, NextResponse } from "next/server";
import { createClient } from "redis";

export const runtime = "nodejs";
export const maxDuration = 30;

// 家族全員で1つの蓄積ボキャブラリーバンクを共有するため、キーは固定の1つだけ使う
// （ログイン機能が無いシンプルな家族利用アプリのため、ユーザーごとの分離はしない）
const BANK_KEY = "family_vocab_bank_v1";

function getRedisUrl(): string {
  // Vercel の Redis 連携（Marketplace経由）は REDIS_URL という名前で
  // 接続文字列を追加する
  return process.env.REDIS_URL || process.env.KV_URL || "";
}

async function withRedis<T>(fn: (client: any) => Promise<T>): Promise<T> {
  const url = getRedisUrl();
  if (!url) throw new Error("REDIS_URL is not set. Vercel の Storage で Redis を作成・接続してください。");
  const client = createClient({ url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.quit().catch(() => {});
  }
}

export async function GET() {
  try {
    const raw = await withRedis<string | null>((client) => client.get(BANK_KEY));
    const bank = raw ? JSON.parse(raw) : [];
    return NextResponse.json({ bank: Array.isArray(bank) ? bank : [] });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || "Failed to load shared bank", bank: [] },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const json = await req.json();
    if (!Array.isArray(json?.bank)) {
      return NextResponse.json({ error: "bank must be an array" }, { status: 400 });
    }
    await withRedis<unknown>((client) => client.set(BANK_KEY, JSON.stringify(json.bank)));
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Failed to save shared bank" }, { status: 500 });
  }
}
