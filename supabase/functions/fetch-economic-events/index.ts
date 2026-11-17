import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const FXMD_URL = "https://api.fxmacrodata.com/v1/calendar/usd";

interface FxmdEvent {
  name: string;
  announcement_datetime_utc: string;
  event_importance: string; // "high" | "medium" | "low"
  release: string;
}

interface FxmdResponse {
  currency: string;
  data: FxmdEvent[];
}

function mapImpact(raw: string): "high" | "medium" | "low" {
  if (raw === "high" || raw === "medium" || raw === "low") return raw;
  return "medium";
}

Deno.serve(async (req) => {
  // Autenticação (verify_jwt desabilitado; valida service_role manualmente)
  const token = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (token !== Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const res = await fetch(FXMD_URL, {
      headers: { "Accept": "application/json" },
    });
    if (!res.ok) {
      return new Response(
        JSON.stringify({ error: `FXMacroData respondeu ${res.status}` }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    const json: FxmdResponse = await res.json();
    const events = json.data || [];

    // Filtra apenas eventos futuros (a partir de agora)
    const now = new Date();
    const rows = events
      .filter((e) => e.announcement_datetime_utc && new Date(e.announcement_datetime_utc) > now)
      .map((e) => ({
        event_time: e.announcement_datetime_utc,
        event_name: e.name || e.release || "Evento econômico",
        country: "US",
        impact: mapImpact(e.event_importance),
        note: e.release ? `Série: ${e.release}` : null,
      }));

    // Remove eventos que já existem (mesmo nome + mesmo horário)
    const { data: existing } = await supabase
      .from("economic_events")
      .select("event_time, event_name")
      .eq("country", "US");

    const existingSet = new Set(
      (existing || []).map((e: any) => `${e.event_time}|${e.event_name}`)
    );

    const toInsert = rows.filter(
      (r) => !existingSet.has(`${r.event_time}|${r.event_name}`)
    );

    let inserted = 0;
    if (toInsert.length > 0) {
      const { error, data } = await supabase
        .from("economic_events")
        .insert(toInsert)
        .select();
      if (error) {
        return new Response(
          JSON.stringify({ error: error.message }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
      inserted = data?.length ?? 0;
    }

    // Limpa eventos passados (mais de 7 dias)
    await supabase
      .from("economic_events")
      .delete()
      .lt("event_time", new Date(Date.now() - 7 * 86400000).toISOString());

    return new Response(
      JSON.stringify({
        fetched: events.length,
        upcoming: rows.length,
        inserted,
        skipped_duplicates: rows.length - toInsert.length,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
