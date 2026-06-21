require("dotenv").config();

const express   = require("express");
const axios     = require("axios");
const cors      = require("cors");
const rateLimit = require("express-rate-limit");
const fs        = require("fs");
const path      = require("path");
const crypto    = require("crypto");

const app  = express();
const PORT = process.env.PORT || 3000;
const MODE = (process.env.PAYMENT_MODE || "manual").toLowerCase();

// ─── 금액 검증 ─────────────────────────────────────────────────────────────────
const PRESET_AMOUNTS = [5000, 10000, 20000, 50000];

function validateAmount(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0) return false;
  if (PRESET_AMOUNTS.includes(n)) return true;
  if (n >= 1000 && n <= 100000 && n % 100 === 0) return true;
  return false;
}

// ─── 저장소 설정 ───────────────────────────────────────────────────────────────
// 우선순위: Supabase(환경변수 있을 때) > 파일(로컬 개발)
// Render 무료 플랜은 재시작 시 파일이 사라지므로 Supabase 필수

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY; // service role key (server-only)
const USE_SUPABASE = !!(SB_URL && SB_KEY);

// 로컬 파일 경로 (로컬 개발 전용)
const DATA_DIR  = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "orders.json");

if (!USE_SUPABASE) {
  // 로컬 파일 초기화
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, "[]", "utf-8");
  } catch (e) {
    console.warn("⚠️  data 폴더 초기화 실패:", e.message);
  }
}

// ─── Supabase 헬퍼 ─────────────────────────────────────────────────────────────
// 테이블: orders (id TEXT PK, data JSONB, created_at TIMESTAMPTZ)
// 생성 SQL은 README 참고

const sbHeaders = () => ({
  apikey:        SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  "Content-Type": "application/json",
  Prefer:        "return=minimal",
});

async function sbInsert(order) {
  try {
    await axios.post(
      `${SB_URL}/rest/v1/orders`,
      { id: order.id, data: order },
      { headers: sbHeaders() }
    );
  } catch (e) {
    // 동일 id가 이미 저장돼 있음 = 웹훅/Return URL 중 한쪽이 먼저 저장한 정상 케이스
    if (e.response?.status === 409) {
      console.log(`ℹ️  주문 ${order.id} 이미 저장됨 — 중복 저장 스킵`);
      return;
    }
    throw e;
  }
}

async function sbReadAll() {
  const res = await axios.get(
    `${SB_URL}/rest/v1/orders?select=data&order=created_at.asc`,
    { headers: sbHeaders() }
  );
  return res.data.map(row => row.data);
}

// ─── 로컬 파일 헬퍼 (append 방식 + UTF-8) ─────────────────────────────────────
function fileRead() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf-8");
    return JSON.parse(raw);
  } catch { return []; }
}

function fileAppend(order) {
  const all = fileRead();
  all.push(order);
  fs.writeFileSync(DATA_FILE, JSON.stringify(all, null, 2), "utf-8");
}

// ─── 통합 저장소 API (async) ───────────────────────────────────────────────────
async function readOrders() {
  if (USE_SUPABASE) {
    return await sbReadAll(); // Supabase: 항상 최신 데이터
  }
  return fileRead(); // 로컬: 파일에서 읽기
}

async function saveOrder(order) {
  if (USE_SUPABASE) {
    await sbInsert(order); // Supabase: DB에 직접 append
  } else {
    fileAppend(order); // 로컬: 파일에 append (UTF-8)
  }
  return order;
}

// ─── 주문 객체 생성 ────────────────────────────────────────────────────────────
function makeOrder(fields) {
  return {
    id:              fields.id || crypto.randomUUID(),
    mode:            fields.mode            || MODE,
    status:          fields.status          || "intent",
    performanceId:   fields.performanceId   || process.env.PERFORMANCE_ID   || "pilot",
    performanceName: fields.performanceName || process.env.PERFORMANCE_NAME || "공연",
    amount:          parseInt(fields.amount, 10),
    choco:           fields.choco    || null,
    label:           fields.label    || null,
    message:         fields.message  || "",
    createdAt:       new Date().toISOString(),
    paymentKey:      fields.paymentKey || null,
    orderId:         fields.orderId   || null,
    userAgent:       fields.userAgent || null,
    source:          fields.source    || null, // "webhook" | "return_url_fallback" | null
  };
}

// ─── 미들웨어 ──────────────────────────────────────────────────────────────────
const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
app.use(cors({
  origin: allowedOrigin === "*" ? "*" : allowedOrigin.split(",").map(s => s.trim()),
  optionsSuccessStatus: 200,
}));
app.use(express.json());
app.use(express.static(__dirname));

app.use("/api/", rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "요청이 너무 많습니다. 잠시 후 다시 시도해주세요." },
}));

function requireAdmin(req, res, next) {
  const key = req.headers["x-admin-key"];
  if (!key || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ success: false, message: "관리자 인증 실패" });
  }
  next();
}

// ─── API: 설정 ────────────────────────────────────────────────────────────────
app.get("/api/config", (req, res) => {
  res.json({
    mode:            MODE,
    clientKey:       process.env.TOSS_CLIENT_KEY  || null, // toss 모드용
    mid:             process.env.WEROUTE_MID       || null, // weroute 모드용
    performanceId:   process.env.PERFORMANCE_ID    || "pilot",
    performanceName: process.env.PERFORMANCE_NAME  || "공연",
  });
});

// ─── API: 결제의사 저장 (manual mode) ────────────────────────────────────────
app.post("/api/intent", async (req, res) => {
  const { amount, choco, label, message, performanceId, performanceName } = req.body;

  if (!validateAmount(amount)) {
    return res.status(400).json({
      success: false,
      message: `유효하지 않은 금액입니다. (허용: ${PRESET_AMOUNTS.map(n => n.toLocaleString()).join(", ")}원 또는 1,000~100,000원 100원 단위)`,
    });
  }

  try {
    const order = await saveOrder(makeOrder({
      mode: "manual", status: "intent",
      performanceId, performanceName,
      amount, choco, label, message,
      userAgent: req.headers["user-agent"],
    }));
    res.json({ success: true, id: order.id });
  } catch (e) {
    console.error("❌ intent 저장 실패:", e.message);
    res.status(500).json({ success: false, message: "저장 중 오류가 발생했습니다." });
  }
});

// ─── API: 결제 승인 (toss mode) ───────────────────────────────────────────────
app.post("/api/confirm-payment", async (req, res) => {
  const { paymentKey, orderId, amount, choco, label, message, performanceId, performanceName } = req.body;

  if (!paymentKey || !orderId || !amount) {
    return res.status(400).json({ success: false, message: "필수 파라미터 누락" });
  }
  if (!validateAmount(amount)) {
    return res.status(400).json({ success: false, message: "유효하지 않은 결제 금액" });
  }

  const base = { choco, label, message, performanceId, performanceName, paymentKey, orderId, userAgent: req.headers["user-agent"] };

  try {
    const authHeader = "Basic " + Buffer.from(process.env.TOSS_SECRET_KEY + ":").toString("base64");
    const tossRes    = await axios.post(
      "https://api.tosspayments.com/v1/payments/confirm",
      { paymentKey, orderId, amount: parseInt(amount, 10) },
      { headers: { Authorization: authHeader, "Content-Type": "application/json" } }
    );

    const order = await saveOrder(makeOrder({
      ...base, mode: "toss", status: "paid",
      amount:     parseInt(amount, 10),
      paymentKey: tossRes.data.paymentKey,
      orderId:    tossRes.data.orderId,
    }));

    return res.json({ success: true, order });

  } catch (err) {
    const errData = err.response?.data || {};
    console.error("❌ 결제 승인 실패:", errData);

    try {
      await saveOrder(makeOrder({ ...base, mode: "toss", status: "failed", amount: parseInt(amount, 10) }));
    } catch {}

    return res.status(400).json({
      success: false,
      code:    errData.code    || "UNKNOWN",
      message: errData.message || "결제 승인 중 오류가 발생했습니다.",
    });
  }
});

// ─── API: 위루트 결제통지 Webhook (weroute mode) ──────────────────────────────
// 위루트가 결제 완료 후 이 URL로 POST 전송
// 성공 응답: HTTP 200 + body {}
app.post("/api/webhook/weroute", express.urlencoded({ extended: true }), async (req, res) => {
  const body = req.body;
  console.log("📩 위루트 Webhook 수신:", JSON.stringify(body));

  // signature 검증: sha256("sign_key=값&timestamp=값&mid=값")
  const SIGN_KEY = process.env.WEROUTE_PAY_KEY;
  if (SIGN_KEY && body.signature && body.timestamp && body.mid) {
    const raw  = `sign_key=${SIGN_KEY}&timestamp=${body.timestamp}&mid=${body.mid}`;
    const hash = crypto.createHash("sha256").update(raw, "utf8").digest("hex");
    if (hash !== body.signature) {
      console.warn("⚠️  signature 불일치 — 위조 요청 의심");
      return res.status(200).json({ message: "signature 불일치" });
    }
  }

  // 취소 건 무시
  if (body.is_cancel === "1") {
    console.log("ℹ️  취소 건 — 스킵");
    return res.status(200).send("{}");
  }

  // temp 필드에 결제 시 담아 보낸 메타데이터 복원 (label, message, choco 등)
  let meta = {};
  try { meta = JSON.parse(body.temp || "{}"); } catch {}

  try {
    await saveOrder(makeOrder({
      id:              body.ord_num ? `weroute-${body.ord_num}` : undefined,
      mode:            "weroute",
      status:          "paid",
      performanceId:   meta.performanceId   || process.env.PERFORMANCE_ID   || "pilot",
      performanceName: meta.performanceName || process.env.PERFORMANCE_NAME || "공연",
      amount:          parseInt(body.amount, 10),
      choco:           meta.choco   || null,
      label:           meta.label   || null,
      message:         meta.message || "",
      paymentKey:      body.trx_id  || null,
      orderId:         body.ord_num || null,
      source:          "webhook",
    }));
    console.log("✅  위루트 결제 저장 완료:", body.ord_num);

    // 퍼널 집계용 결제완료 이벤트 — 원래 세션ID로 정확히 귀속
    try {
      await saveEvent({
        id:        crypto.randomUUID(),
        event:     "pay_success",
        sessionId: meta.sessionId || body.ord_num || null,
        data:      { amount: body.amount || null, ord_num: body.ord_num || null },
        ua:        null,
        createdAt: new Date().toISOString(),
      });
    } catch (e) {
      console.warn("⚠️  pay_success 이벤트 기록 실패(webhook):", e.message);
    }

    return res.status(200).send("{}");
  } catch (e) {
    console.error("❌ Webhook 저장 실패:", e.message);
    return res.status(500).json({ message: "저장 실패: " + e.message });
  }
});

// ─── API: 위루트 Return URL (weroute mode) ────────────────────────────────────
// 결제창에서 완료 버튼 클릭 시 도착 (미클릭 시 미도달 — DB 저장은 Webhook 담당)
app.get("/api/return/weroute", async (req, res) => {
  console.log("🔁 위루트 Return URL 도착:", req.query);
  const q = req.query;

  // 결제 성공으로 보이는 경우, 안전장치로 한 번 더 저장 시도
  // (정식 기록은 Webhook 담당 — 동일 ord_num이면 sbInsert가 중복을 자동으로 걸러줌)
  if (q.result_cd === "0000" && q.is_cancel !== "1" && q.ord_num) {
    let meta = {};
    try { meta = JSON.parse(q.temp || "{}"); } catch {}

    try {
      await saveOrder(makeOrder({
        id:              `weroute-${q.ord_num}`,
        mode:            "weroute",
        status:          "paid",
        performanceId:   meta.performanceId   || process.env.PERFORMANCE_ID   || "pilot",
        performanceName: meta.performanceName || process.env.PERFORMANCE_NAME || "공연",
        amount:          parseInt(q.amount, 10),
        choco:           meta.choco   || null,
        label:           meta.label   || null,
        message:         meta.message || "",
        paymentKey:      q.trx_id  || null,
        orderId:         q.ord_num || null,
        source:          "return_url_fallback",
      }));
      console.log("✅  Return URL 경유 저장 완료(또는 이미 저장됨):", q.ord_num);
    } catch (e) {
      // 저장 실패해도 사용자 화면 이동은 막지 않음 — 로그로만 남김
      console.error("❌ Return URL 저장 실패:", e.message);
    }

    // 퍼널 집계용 결제완료 이벤트 — 서버가 직접 기록 (클라이언트 JS 의존 없음)
    try {
      await saveEvent({
        id:        crypto.randomUUID(),
        event:     "pay_success",
        sessionId: meta.sessionId || q.ord_num || null,
        data:      { amount: q.amount || null, ord_num: q.ord_num || null },
        ua:        req.headers["user-agent"] || null,
        createdAt: new Date().toISOString(),
      });
    } catch (e) {
      console.warn("⚠️  pay_success 이벤트 기록 실패:", e.message);
    }
  }

  const params = new URLSearchParams(req.query).toString();
  res.redirect(`/success?${params}`);
});

// ─── 이벤트 로그 저장소 ───────────────────────────────────────────────────────
const EVENTS_FILE = path.join(DATA_DIR, "events.json");

if (!USE_SUPABASE) {
  try {
    if (!fs.existsSync(EVENTS_FILE)) fs.writeFileSync(EVENTS_FILE, "[]", "utf-8");
  } catch (e) {
    console.warn("⚠️  events 파일 초기화 실패:", e.message);
  }
}

function fileReadEvents() {
  try { return JSON.parse(fs.readFileSync(EVENTS_FILE, "utf-8")); } catch { return []; }
}

function fileAppendEvent(ev) {
  const all = fileReadEvents();
  all.push(ev);
  fs.writeFileSync(EVENTS_FILE, JSON.stringify(all, null, 2), "utf-8");
}

async function saveEvent(ev) {
  if (USE_SUPABASE) {
    try {
      await axios.post(
        `${SB_URL}/rest/v1/events`,
        { id: ev.id, data: ev },
        { headers: sbHeaders() }
      );
    } catch (e) { console.warn("⚠️  Supabase 이벤트 저장 실패:", e.message); }
  } else {
    fileAppendEvent(ev);
  }
}

async function readEvents() {
  if (USE_SUPABASE) {
    try {
      const res = await axios.get(
        `${SB_URL}/rest/v1/events?select=data&order=created_at.asc`,
        { headers: sbHeaders() }
      );
      return res.data.map(r => r.data);
    } catch { return []; }
  }
  return fileReadEvents();
}

// ─── API: 이벤트 수집 ─────────────────────────────────────────────────────────
app.post("/api/event", async (req, res) => {
  const { event, sessionId, data } = req.body;
  if (!event) return res.status(400).json({ ok: false });

  const ev = {
    id:        crypto.randomUUID(),
    event,                          // page_enter | amount_select | custom_amount | message_select | message_type | pay_click | pay_success | pay_fail
    sessionId: sessionId || null,
    data:      data      || {},
    ua:        req.headers["user-agent"] || null,
    createdAt: new Date().toISOString(),
  };

  try {
    await saveEvent(ev);
    return res.json({ ok: true });
  } catch (e) {
    console.error("❌ 이벤트 저장 실패:", e.message);
    return res.status(500).json({ ok: false });
  }
});

// ─── API: 퍼널 통계 (관리자) ──────────────────────────────────────────────────
app.get("/api/admin/funnel", requireAdmin, async (req, res) => {
  try {
    const events = await readEvents();

    // 반드시 순서대로 거쳐야만 하는 핵심 퍼널 (항상 단조감소 — 뒤 단계가 앞 단계보다 많을 수 없음)
    const CORE_STEPS = [
      { key: "page_enter", label: "진입" },
      { key: "pay_click",  label: "결제 클릭" },
      { key: "pay_success",label: "결제 완료" },
    ];

    // 세션별로 어떤 이벤트들을 거쳤는지 집합으로 집계
    const sessions = {};
    events.forEach(ev => {
      const sid = ev.sessionId || ev.id;
      if (!sessions[sid]) sessions[sid] = new Set();
      sessions[sid].add(ev.event);
    });
    const allSessionIds = Object.keys(sessions);
    const sessionSets    = Object.values(sessions);
    const countUniqueSessions = (key) => sessionSets.filter(set => set.has(key)).length;

    // 핵심 퍼널: 이전 단계를 "거친 세션"만 남기며 누적 필터링 (진짜 깔때기)
    let surviving = allSessionIds;
    let prevCount = null;
    const funnel = CORE_STEPS.map((s, i) => {
      surviving = surviving.filter(sid => sessions[sid].has(s.key));
      const count = surviving.length;
      const step = {
        step:    i + 1,
        key:     s.key,
        label:   s.label,
        count,
        dropoff: i > 0 ? prevCount - count : 0,
        rate:    i > 0 && prevCount > 0 ? Math.round((count / prevCount) * 100) : 100,
      };
      prevCount = count;
      return step;
    });

    // 참여 지표: 필수 단계가 아닌 선택 행동들 — 독립 카운트, 깔때기에 끼워넣지 않음
    const extras = {
      amount_select:  countUniqueSessions("amount_select"),
      message_select: countUniqueSessions("message_select"),
      custom_amount:  countUniqueSessions("custom_amount"),
      message_type:   countUniqueSessions("message_type"),
      pay_fail:       countUniqueSessions("pay_fail"),
    };

    res.json({ success: true, funnel, extras, totalEvents: events.length });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});
app.get("/api/admin/orders", requireAdmin, async (req, res) => {
  try {
    const orders = await readOrders();
    res.json({ success: true, count: orders.length, orders });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.get("/api/admin/stats", requireAdmin, async (req, res) => {
  try {
    const orders   = await readOrders();
    const by       = (s) => orders.filter(o => o.status === s);
    const sum      = (list) => list.reduce((a, o) => a + (o.amount || 0), 0);
    const paid     = by("paid");
    const intent   = by("intent");
    const failed   = by("failed");

    res.json({
      success:     true,
      total:       orders.length,
      paid:        paid.length,
      intent:      intent.length,
      failed:      failed.length,
      totalPaid:   sum(paid),
      totalIntent: sum(intent),
      avgPaid:     paid.length   > 0 ? Math.round(sum(paid)   / paid.length)   : 0,
      avgIntent:   intent.length > 0 ? Math.round(sum(intent) / intent.length) : 0,
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.get("/api/admin/export.csv", requireAdmin, async (req, res) => {
  try {
    const orders = await readOrders();
    const header = "id,mode,status,performanceName,amount,choco,label,message,createdAt,paymentKey,orderId\n";
    const rows   = orders.map(o =>
      [
        o.id, o.mode, o.status,
        `"${(o.performanceName || "").replace(/"/g, '""')}"`,
        o.amount, o.choco || "", o.label || "",
        `"${(o.message || "").replace(/"/g, '""')}"`,
        o.createdAt, o.paymentKey || "", o.orderId || "",
      ].join(",")
    ).join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="ulkpay-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send("\uFEFF" + header + rows);
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─── HTML 라우트 ───────────────────────────────────────────────────────────────
app.get("/success", (req, res) => res.sendFile(path.join(__dirname, "success.html")));
app.get("/fail",    (req, res) => res.sendFile(path.join(__dirname, "fail.html")));

// ─── 서버 시작 ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  const storage = USE_SUPABASE ? "Supabase (영구 저장)" : "로컬 파일 data/orders.json";
  console.log(`\n✅  울컥페이 서버 실행 중`);
  console.log(`    URL     : http://localhost:${PORT}`);
  console.log(`    결제모드 : ${MODE.toUpperCase()}`);
  console.log(`    저장소  : ${storage}`);
  console.log(`    환경    : ${process.env.NODE_ENV || "development"}\n`);
  if (!USE_SUPABASE) {
    console.log(`    ⚠️  SUPABASE 미설정 — 로컬 파일 사용 중`);
    console.log(`    ⚠️  Render 배포 시 재시작하면 데이터 유실됨`);
    console.log(`    ⚠️  .env에 SUPABASE_URL + SUPABASE_SERVICE_KEY 설정 필요\n`);
  }
});
