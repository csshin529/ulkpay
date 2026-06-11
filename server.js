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
  await axios.post(
    `${SB_URL}/rest/v1/orders`,
    { id: order.id, data: order },
    { headers: sbHeaders() }
  );
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
    id:              crypto.randomUUID(),
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
    clientKey:       process.env.TOSS_CLIENT_KEY || null,
    performanceId:   process.env.PERFORMANCE_ID   || "pilot",
    performanceName: process.env.PERFORMANCE_NAME || "공연",
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

// ─── 관리자 API ────────────────────────────────────────────────────────────────
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
  await axios.post(
    `${SB_URL}/rest/v1/orders`,
    { id: order.id, data: order },
    { headers: sbHeaders() }
  );
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
    id:              crypto.randomUUID(),
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
  };
}

// ─── 미들웨어 ──────────────────────────────────────────────────────────────────
const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
app.use(cors({
  origin: allowedOrigin === "*" ? "*" : allowedOrigin.split(",").map(s => s.trim()),
  optionsSuccessStatus: 200,
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

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
    clientKey:       process.env.TOSS_CLIENT_KEY || null,
    performanceId:   process.env.PERFORMANCE_ID   || "pilot",
    performanceName: process.env.PERFORMANCE_NAME || "공연",
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

// ─── 관리자 API ────────────────────────────────────────────────────────────────
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
app.get("/success", (req, res) => res.sendFile(path.join(__dirname, "public", "success.html")));
app.get("/fail",    (req, res) => res.sendFile(path.join(__dirname, "public", "fail.html")));

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
