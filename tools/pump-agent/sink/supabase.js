// sink จริง: คุยกับ Supabase ของ UDOM Next ผ่าน RPC (โครงเดียวกับ tools/print-agent)
// ต้อง: npm install @supabase/supabase-js   และสร้างบัญชี role AGENT ใน staff_profiles
"use strict";

module.exports = function supabaseSink(cfg) {
  const { createClient } = require("@supabase/supabase-js");
  const sb = createClient(cfg.supabase_url, cfg.supabase_anon_key,
    { auth: { persistSession: false, autoRefreshToken: true } });

  let ready = sb.auth.signInWithPassword({ email: cfg.email, password: cfg.password })
    .then(({ error }) => { if (error) throw new Error("ล็อกอินไม่สำเร็จ: " + error.message); });

  // ส่งไม่สำเร็จ = เก็บไว้ในคิวในหน่วยความจำ แล้วลองใหม่รอบหน้า
  // (เฟสถัดไปควรเปลี่ยนเป็น SQLite เพื่อให้รอดตอน agent รีสตาร์ต)
  const retry = { tot: [], tx: [] };

  async function rpc(fn, args) {
    await ready;
    const { data, error } = await sb.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data;
  }

  return {
    async claimCommands() {
      try { return (await rpc("claim_pump_commands", { p_agent_id: cfg.agent_id })) || []; }
      catch (e) { console.error("ดึงคำสั่งไม่ได้:", e.message); return []; }
    },
    finishCommand(id, status, error) {
      return rpc("finish_pump_command", { p_command_id: id, p_status: status, p_error: error })
        .catch((e) => console.error("รายงานผลคำสั่งไม่ได้:", e.message));
    },
    pushLive(row) {
      // UPDATE ทับแถวเดิม 1 แถว/หัวจ่าย — PWA ฟังผ่าน Supabase Realtime
      return rpc("push_nozzle_live", { p_row: row })
        .catch((e) => console.error("ส่งสถานะสดไม่ได้:", e.message));
    },
    async pushTotalizers(rows) {
      retry.tot.push(...rows);
      try { await rpc("push_totalizer_snapshots", { p_rows: retry.tot }); retry.tot = []; }
      catch (e) { console.error(`ส่ง totalizer ไม่ได้ (ค้าง ${retry.tot.length} แถว):`, e.message); }
    },
    async pushTransaction(tx) {
      retry.tx.push(tx);
      try { await rpc("push_pump_transactions", { p_rows: retry.tx }); retry.tx = []; }
      catch (e) { console.error(`ส่ง transaction ไม่ได้ (ค้าง ${retry.tx.length} รายการ):`, e.message); }
    },
    heartbeat(hb) {
      return rpc("pump_agent_heartbeat", {
        p_agent_id: hb.agent_id, p_nozzles: hb.nozzles, p_bus_stats: hb.bus_stats,
      }).catch((e) => console.error("heartbeat ไม่ได้:", e.message));
    },
  };
};
