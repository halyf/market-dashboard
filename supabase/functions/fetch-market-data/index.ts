import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// Todos os ativos via Yahoo Finance (EUA + Brasil)
const YAHOO_ASSETS = [
  // EUA — 12 índices
  { symbol: "SPX",      id: "^GSPC"   },
  { symbol: "NDX",      id: "^NDX"    },
  { symbol: "IXIC",     id: "^IXIC"   },
  { symbol: "DJI",      id: "^DJI"    },
  { symbol: "RUT",      id: "^RUT"    },
  { symbol: "RUI",      id: "^RUI"    },
  { symbol: "MID",      id: "^SP400"  },
  { symbol: "SML",      id: "^SP600"  },
  { symbol: "NYA",      id: "^NYA"    },
  { symbol: "DJT",      id: "^DJT"    },
  { symbol: "SOX",      id: "^SOX"    },
  { symbol: "W5000",    id: "^W5000"  },
  // Brasil — 12 ações (sufixo .SA)
  { symbol: "PETR4.SA", id: "PETR4.SA" },
  { symbol: "VALE3.SA", id: "VALE3.SA" },
  { symbol: "ITUB4.SA", id: "ITUB4.SA" },
  { symbol: "BBDC4.SA", id: "BBDC4.SA" },
  { symbol: "ABEV3.SA", id: "ABEV3.SA" },
  { symbol: "BBAS3.SA", id: "BBAS3.SA" },
  { symbol: "B3SA3.SA", id: "B3SA3.SA" },
  { symbol: "WEGE3.SA", id: "WEGE3.SA" },
  { symbol: "MGLU3.SA", id: "MGLU3.SA" },
  { symbol: "RENT3.SA", id: "RENT3.SA" },
  { symbol: "PRIO3.SA", id: "PRIO3.SA" },
  { symbol: "SUZB3.SA", id: "SUZB3.SA" },
];

// Cripto via CoinGecko
const COINGECKO_ASSETS = [
  { symbol: "BTC",  id: "bitcoin"      },
  { symbol: "ETH",  id: "ethereum"     },
  { symbol: "BNB",  id: "binancecoin"  },
  { symbol: "SOL",  id: "solana"       },
  { symbol: "XRP",  id: "ripple"       },
  { symbol: "ADA",  id: "cardano"      },
  { symbol: "DOGE", id: "dogecoin"     },
  { symbol: "AVAX", id: "avalanche-2"  },
  { symbol: "DOT",  id: "polkadot"     },
  { symbol: "LINK", id: "chainlink"    },
  { symbol: "TRX",  id: "tron"         },
  { symbol: "LTC",  id: "litecoin"     },
];

async function fetchYahoo(symbol: string): Promise<number | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json",
      },
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.chart?.result?.[0]?.meta?.regularMarketPrice ?? null;
  } catch { return null; }
}

async function fetchCoinGeckoBulk(ids: string[]): Promise<Record<string, number>> {
  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=usd`;
    const res = await fetch(url);
    if (!res.ok) return {};
    const json = await res.json();
    const map: Record<string, number> = {};
    Object.keys(json).forEach((id) => {
      if (typeof json[id]?.usd === "number") map[id] = json[id].usd;
    });
    return map;
  } catch { return {}; }
}

Deno.serve(async (req) => {
  const token = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (token !== Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) {
    return new Response("Unauthorized", { status: 401 });
  }

  const ts = new Date().toISOString();
  const prices: { symbol: string; price: number }[] = [];
  const errors: string[] = [];

  // 1. Yahoo — 24 chamadas (12 EUA + 12 BR)
  for (const a of YAHOO_ASSETS) {
    const p = await fetchYahoo(a.id);
    if (p !== null) prices.push({ symbol: a.symbol, price: p });
    else errors.push(`Yahoo: ${a.symbol}`);
    // pequena pausa para não estourar rate limit
    await new Promise((r) => setTimeout(r, 100));
  }

  // 2. CoinGecko — 1 chamada em lote
  const cgMap = await fetchCoinGeckoBulk(COINGECKO_ASSETS.map((a) => a.id));
  for (const a of COINGECKO_ASSETS) {
    if (cgMap[a.id] !== undefined) prices.push({ symbol: a.symbol, price: cgMap[a.id] });
    else errors.push(`CoinGecko: ${a.symbol}`);
  }

  // 3. Busca os IDs do banco em uma única query
  const { data: assetRows } = await supabase.from("assets").select("id, symbol");
  const symbolToId: Record<string, number> = {};
  (assetRows || []).forEach((r: any) => { symbolToId[r.symbol] = r.id; });

  // 4. Insere os registros
  const rows = prices
    .filter((p) => symbolToId[p.symbol] !== undefined)
    .map((p) => ({ asset_id: symbolToId[p.symbol], price: p.price, timestamp: ts }));

  if (rows.length > 0) {
    const { error } = await supabase.from("price_history").insert(rows);
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
  }

  return new Response(
    JSON.stringify({ inserted: rows.length, errors }),
    { headers: { "Content-Type": "application/json" } }
  );
});
