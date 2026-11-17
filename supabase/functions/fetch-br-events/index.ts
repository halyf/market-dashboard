import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// Normaliza o campo "importance" do biquote para o formato aceito pela
// constraint da tabela: 'high' | 'medium' | 'low' (minúsculo)
function normalizeImpact(raw: any): "high" | "medium" | "low" {
  if (raw == null) return "medium";
  const s = String(raw).toLowerCase().trim();
  if (s === "high" || s === "3" || s === "alto") return "high";
  if (s === "low"  || s === "1" || s === "baixo") return "low";
  if (s === "medium" || s === "med" || s === "2" || s === "médio" || s === "medio") return "medium";
  return "medium";
}

Deno.serve(async (req) => {
  // Autenticação manual (verify_jwt está desabilitado nesta função)
  const token = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (token !== Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    // 1. Buscar eventos do Brasil no biquote.io (sem chave, JSON limpo)
    const res = await fetch(
      "https://biquote.io/api/calendar?countries=BR",
      { headers: { "Accept": "application/json" } }
    );

    if (!res.ok) {
      return new Response(
        JSON.stringify({ error: `biquote respondeu ${res.status}` }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    const events = await res.json();
    console.log("[biquote] Total de eventos recebidos:", events.length);

    // 2. Filtrar apenas eventos futuros e com impacto medium ou high
    const now = new Date();
    const future = events.filter((e: any) => {
      const t = new Date(e.time);
      if (isNaN(t.getTime()) || t <= now) return false;
      const impact = normalizeImpact(e.importance);
      return impact !== "low"; // Opção B: filtra ruído
    });

    console.log("[biquote] Eventos futuros (impacto médio/alto):", future.length);

    // 3. Mapear para o formato da tabela economic_events
    const rows = future.map((e: any) => ({
      event_time: e.time,
      event_name: e.name,
      country: "BR",
      impact: normalizeImpact(e.importance),
      note: e.forecast != null
        ? `Consenso: ${e.forecast}${e.unit === "percent" ? "%" : ""}`
        : null,
    }));

    // 4. Deduplicar DENTRO do batch (biquote retorna o mesmo evento 2-3x)
    const seen = new Set<string>();
    const uniqueRows = rows.filter((r) => {
      const key = `${r.event_time}|${r.event_name}|${r.country}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    console.log(
      "[biquote] Total:", rows.length,
      "| Únicos:", uniqueRows.length,
      "| Duplicados no batch:", rows.length - uniqueRows.length
    );

    // 5. Inserir com upsert (ignora duplicatas que já existam no banco)
    let inserted = 0;
    if (uniqueRows.length > 0) {
      const { error, data } = await supabase
        .from("economic_events")
        .upsert(uniqueRows, {
          onConflict: "country,event_time,event_name",
          ignoreDuplicates: true,
        })
        .select();

      if (error) {
        console.error("[biquote] Erro ao inserir:", error.message);
        return new Response(
          JSON.stringify({
            error: error.message,
            attempted: uniqueRows.slice(0, 3),
          }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
      inserted = data?.length ?? 0;
    }

    // 6. Limpar eventos antigos (mais de 7 dias) para economizar espaço
    await supabase
      .from("economic_events")
      .delete()
      .lt("event_time", new Date(Date.now() - 7 * 86400000).toISOString());

    return new Response(
      JSON.stringify({
        fetched: events.length,
        upcoming: future.length,
        unique_in_batch: uniqueRows.length,
        inserted,
        skipped_duplicates: rows.length - uniqueRows.length,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("[biquote] Erro geral:", err);
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
