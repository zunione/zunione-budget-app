import { useState, useEffect, useCallback } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { signInWithPopup, signOut, onAuthStateChanged } from "firebase/auth";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { auth, provider, db } from "./firebase";

// ── 공휴일 ──────────────────────────────────────────────────────────────────
const HOLIDAYS = new Set([
  "2025-01-01","2025-01-28","2025-01-29","2025-01-30","2025-03-01","2025-05-05",
  "2025-05-06","2025-06-06","2025-08-15","2025-10-03","2025-10-05","2025-10-06",
  "2025-10-07","2025-10-09","2025-12-25",
  "2026-01-01","2026-02-16","2026-02-17","2026-02-18","2026-03-01","2026-03-02",
  "2026-05-05","2026-05-24","2026-06-06","2026-08-15","2026-08-17","2026-10-03",
  "2026-10-04","2026-10-05","2026-10-09","2026-12-25",
  "2027-01-01","2027-02-06","2027-02-07","2027-02-08","2027-02-09","2027-03-01",
  "2027-05-05","2027-05-13","2027-06-06","2027-08-15","2027-08-16","2027-09-24",
  "2027-09-25","2027-09-26","2027-10-03","2027-10-09","2027-12-25",
]);

function dateStr(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
function isBusinessDay(d) {
  const day = d.getDay();
  return day !== 0 && day !== 6 && !HOLIDAYS.has(dateStr(d));
}
function prevBizDay(d) {
  const r = new Date(d); r.setDate(r.getDate() - 1);
  while (!isBusinessDay(r)) r.setDate(r.getDate() - 1);
  return r;
}
function nextBizDay(d) {
  const r = new Date(d); r.setDate(r.getDate() + 1);
  while (!isBusinessDay(r)) r.setDate(r.getDate() + 1);
  return r;
}
function getPayday(y, m) {
  const d = new Date(y, m - 1, 24);
  return isBusinessDay(d) ? d : prevBizDay(d);
}
function getCardPayDate(y, m) {
  const d = new Date(y, m - 1, 25);
  return isBusinessDay(d) ? d : nextBizDay(d);
}
function getSalaryMonthByOffset(offset) {
  const now = new Date();
  const curY = now.getFullYear(), curM = now.getMonth() + 1;
  const curPayday = getPayday(curY, curM);
  let baseM, baseY;
  if (now >= curPayday) { baseM = curM; baseY = curY; }
  else { baseM = curM === 1 ? 12 : curM - 1; baseY = curM === 1 ? curY - 1 : curY; }
  let tm = baseM + offset;
  let ty = baseY + Math.floor((tm - 1) / 12);
  tm = ((tm - 1) % 12 + 12) % 12 + 1;
  const start = getPayday(ty, tm);
  const nm = tm === 12 ? 1 : tm + 1;
  const ny = tm === 12 ? ty + 1 : ty;
  const nextP = getPayday(ny, nm);
  const end = new Date(nextP); end.setDate(end.getDate() - 1);
  return { start, end, label: `${ny}년 ${nm}월`, payMonth: tm, payYear: ty };
}
function getBillingByOffset(offset) {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth() + 1;
  let payM, payY;
  if (now.getDate() <= 10) { payM = m; payY = y; }
  else { payM = m === 12 ? 1 : m + 1; payY = m === 12 ? y + 1 : y; }
  let tm = payM + offset;
  let ty = payY + Math.floor((tm - 1) / 12);
  tm = ((tm - 1) % 12 + 12) % 12 + 1;
  const prevM = tm === 1 ? 12 : tm - 1;
  const prevY = tm === 1 ? ty - 1 : ty;
  return {
    paymentDate: getCardPayDate(ty, tm),
    billingStart: new Date(prevY, prevM - 1, 11),
    billingEnd: new Date(ty, tm - 1, 10),
  };
}

const fmt = n => n.toLocaleString("ko-KR");
const BUDGET = 450000;
const DEDUCTIONS = [
  { name: "비상금", amount: 100000 },
  { name: "십일조", amount: 200000 },
  { name: "가용현금", amount: 150000 },
  { name: "카드값", amount: 450000 },
  { name: "적금", amount: 500000 },
];
const TOTAL_DED = DEDUCTIONS.reduce((s, d) => s + d.amount, 0);
const WD = ["일","월","화","수","목","금","토"];
const fmtD = d => `${d.getMonth()+1}/${d.getDate()}(${WD[d.getDay()]})`;

function parseSMS(text) {
  const res = [];
  const now = new Date();
  const getYear = mo => mo > now.getMonth() + 1 ? now.getFullYear() - 1 : now.getFullYear();
  const mkDate = (mo, dy) => `${getYear(+mo)}-${String(+mo).padStart(2,"0")}-${String(+dy).padStart(2,"0")}`;
  const used = [];
  const isUsed = idx => used.some(([s,e]) => idx >= s && idx < e);
  let m;

  // 멀티라인 NH카드: "카드승인\n이름\n금액원 방법\nMM/DD HH:MM\n가맹점"
  const reA = /승인\r?\n[^\r\n]+\r?\n([\d,]+)원[^\r\n]*\r?\n(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})\r?\n([^\r\n]+)/g;
  while ((m = reA.exec(text)) !== null) {
    res.push({ id:Date.now()+Math.random(), date:mkDate(m[2],m[3]), time:`${m[4]}:${m[5]}`, amount:parseInt(m[1].replace(/,/g,"")), merchant:m[6].trim(), type:"지출" });
    used.push([m.index, m.index+m[0].length]);
  }

  // 신한카드: "카드명승인 이름 금액원(방법)MM/DD HH:MM 가맹점  누적..."
  const reB = /승인[^0-9\r\n]*?([\d,]+)원[^\s\d\r\n]*(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})\s+([^\r\n]+?)(?:\s{2,}|누적|\r?\n|$)/g;
  while ((m = reB.exec(text)) !== null) {
    if (isUsed(m.index)) continue;
    res.push({ id:Date.now()+Math.random(), date:mkDate(m[2],m[3]), time:`${m[4]}:${m[5]}`, amount:parseInt(m[1].replace(/,/g,"")), merchant:m[6].trim(), type:"지출" });
    used.push([m.index, m.index+m[0].length]);
  }

  // NH농협: "MM/DD HH:MM 카드명 승인 금액원 가맹점 잔액..."
  const reC = /(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})[^\r\n]*?승인\s*([\d,]+)원\s+([^\r\n]+?)(?:\s+잔액|\r?\n|$)/g;
  while ((m = reC.exec(text)) !== null) {
    if (isUsed(m.index)) continue;
    res.push({ id:Date.now()+Math.random(), date:mkDate(m[1],m[2]), time:`${m[3]}:${m[4]}`, amount:parseInt(m[5].replace(/,/g,"")), merchant:m[6].trim(), type:"지출" });
    used.push([m.index, m.index+m[0].length]);
  }

  // 이체: "MM/DD 금액원 출금/입금 내용"
  const reD = /(\d{1,2})\/(\d{1,2})\s*([\d,]+)원\s*(출금|입금)\s*([^\r\n]+)/g;
  while ((m = reD.exec(text)) !== null) {
    if (isUsed(m.index)) continue;
    res.push({ id:Date.now()+Math.random(), date:mkDate(m[1],m[2]), time:"", amount:parseInt(m[3].replace(/,/g,"")), merchant:m[5].trim(), type:m[4]==="입금"?"수입":"지출" });
  }

  return res;
}

const C = {
  bg: "#F4F3EF",
  card: "#FFFFFF",
  cardBorder: "#E8E6E0",
  divider: "#EEECE6",
  accent: "#1A1A1A",
  text: "#1A1A1A",
  textSub: "#6B6B6B",
  textDim: "#9E9E9E",
  green: "#1A8C42",
  red: "#D4362C",
  orange: "#C47A1A",
  barFill: "#1A1A1A",
  btnBg: "#1A1A1A",
  btnText: "#FFFFFF",
};

// ── Firebase 저장/로드 ───────────────────────────────────────────────────────
async function loadFromFirestore(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  if (snap.exists()) return snap.data();
  return null;
}
async function saveToFirestore(uid, txs, income) {
  await setDoc(doc(db, "users", uid), { txs, income }, { merge: true });
}

// ── 로그인 화면 ──────────────────────────────────────────────────────────────
function LoginScreen() {
  const [loading, setLoading] = useState(false);
  return (
    <div style={{ minHeight:"100vh", background:C.bg, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", fontFamily:"'Pretendard Variable',-apple-system,sans-serif" }}>
      <div style={{ fontSize:48, marginBottom:16 }}>💰</div>
      <div style={{ fontSize:24, fontWeight:800, color:C.accent, marginBottom:8, letterSpacing:-0.5 }}>가계부</div>
      <div style={{ fontSize:13, color:C.textDim, marginBottom:48 }}>데이터는 계정에 안전하게 저장됩니다</div>
      <button
        onClick={async () => { setLoading(true); try { await signInWithPopup(auth, provider); } catch { setLoading(false); } }}
        disabled={loading}
        style={{ display:"flex", alignItems:"center", gap:12, background:C.card, border:`1px solid ${C.cardBorder}`, borderRadius:12, padding:"14px 24px", fontSize:15, fontWeight:600, color:C.accent, cursor:"pointer", fontFamily:"inherit", boxShadow:"0 2px 8px rgba(0,0,0,0.08)" }}
      >
        <svg width="20" height="20" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
        {loading ? "로그인 중..." : "Google로 계속하기"}
      </button>
    </div>
  );
}

// ── 메인 앱 ──────────────────────────────────────────────────────────────────
export default function App() {
  const [user, setUser] = useState(undefined); // undefined = 로딩중
  const [txs, setTxs] = useState([]);
  const [income, setIncome] = useState(0);
  const [view, setView] = useState("dash");
  const [sms, setSms] = useState("");
  const [mf, setMf] = useState({ date: new Date().toISOString().slice(0,10), amount: "", merchant: "" });
  const [toast, setToast] = useState("");
  const [showIncEdit, setShowIncEdit] = useState(false);
  const [incInput, setIncInput] = useState("0");
  const [monthOffset, setMonthOffset] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Auth 상태 감지
  useEffect(() => {
    return onAuthStateChanged(auth, async (u) => {
      setUser(u);
      if (u) {
        const data = await loadFromFirestore(u.uid);
        if (data) {
          if (data.txs) setTxs(data.txs);
          if (data.income) setIncome(data.income);
        }
        setLoaded(true);
      } else {
        setLoaded(false);
        setTxs([]);
      }
    });
  }, []);

  // Firestore 저장 (txs/income 변경시) - 로드 완료 후에만 저장
  const save = useCallback(async (t, i) => {
    if (!auth.currentUser) return;
    setSyncing(true);
    try { await saveToFirestore(auth.currentUser.uid, t, i); } catch (e) { console.error(e); }
    setSyncing(false);
  }, []);

  useEffect(() => {
    if (user && loaded) save(txs, income);
  }, [txs, income, save, user, loaded]);

  const flash = msg => { setToast(msg); setTimeout(() => setToast(""), 2200); };

  // 로딩중
  if (user === undefined) return (
    <div style={{ minHeight:"100vh", background:C.bg, display:"flex", alignItems:"center", justifyContent:"center" }}>
      <div style={{ color:C.textDim, fontSize:13 }}>불러오는 중...</div>
    </div>
  );

  // 미로그인
  if (!user) return <LoginScreen />;

  const today = new Date();
  const sal = getSalaryMonthByOffset(monthOffset);
  const bill = getBillingByOffset(monthOffset);
  const bsStr = dateStr(bill.billingStart), beStr = dateStr(bill.billingEnd);
  const bTxs = txs.filter(t => t.type==="지출" && t.date>=bsStr && t.date<=beStr);
  const spent = bTxs.reduce((s,t) => s+t.amount, 0);
  const remain = BUDGET - spent;
  const totalDays = Math.round((bill.billingEnd - bill.billingStart)/86400000)+1;
  const elapsed = Math.max(0, Math.round((today - bill.billingStart)/86400000));
  const daysLeft = Math.max(0, totalDays - elapsed);
  const dailyBgt = daysLeft > 0 ? Math.floor(remain / daysLeft) : 0;
  const pct = Math.min(100, (spent/BUDGET)*100);
  const over = spent > BUDGET;
  const investable = income - TOTAL_DED;
  const isCurrent = monthOffset === 0;

  const dailyData = (() => {
    const d = {};
    bTxs.forEach(t => { const k = parseInt(t.date.slice(8)); d[k]=(d[k]||0)+t.amount; });
    return Object.entries(d).sort(([a],[b])=>a-b).map(([k,v])=>({day:`${k}일`,amount:v}));
  })();

  const iS = { width:"100%", padding:"10px 14px", background:C.bg, border:`1px solid ${C.cardBorder}`, borderRadius:8, color:C.text, fontSize:13, fontFamily:"inherit", boxSizing:"border-box" };
  const cardStyle = { background:C.card, border:`1px solid ${C.cardBorder}`, borderRadius:16, padding:20 };
  const tab = (v,l) => <button key={v} onClick={()=>setView(v)} style={{ flex:"1 1 0", width:0, minWidth:0, overflow:"hidden", padding:"11px 0", border:"none", fontSize:13, cursor:"pointer", fontFamily:"inherit", background:"none", fontWeight:view===v?700:400, color:view===v?C.accent:C.textDim, borderBottom:view===v?`2px solid ${C.accent}`:"2px solid transparent" }}>{l}</button>;
  const navBtn = (label, onClick) => <button onClick={onClick} style={{ background:"none", border:"none", color:C.textSub, fontSize:16, cursor:"pointer", padding:"4px 8px" }}>{label}</button>;

  return (
    <div style={{ fontFamily:"'Pretendard Variable',-apple-system,sans-serif", background:C.bg, minHeight:"100vh", color:C.text, position:"relative" }}>
      {toast && <div style={{ position:"fixed",top:16,left:"50%",transform:"translateX(-50%)",background:C.accent,color:"#fff",padding:"8px 20px",borderRadius:20,fontSize:13,fontWeight:600,zIndex:999 }}>{toast}</div>}

      <div style={{ padding:"20px 20px 12px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <div>
          <div style={{ fontSize:11, color:C.textDim, letterSpacing:2, marginBottom:4, display:"flex", alignItems:"center", gap:6 }}>
            BUDGET TRACKER
            {syncing && <span style={{ fontSize:10, color:C.textDim }}>↑ 저장중...</span>}
          </div>
          <div style={{ fontSize:20, fontWeight:800, color:C.accent, letterSpacing:-0.5 }}>가계부</div>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:4 }}>
          {navBtn("◀", () => setMonthOffset(o => o - 1))}
          <div style={{ textAlign:"center", minWidth:100 }}>
            <div style={{ fontSize:13, fontWeight:700, color:C.accent }}>{sal.label}</div>
            <div style={{ fontSize:11, color:C.textSub }}>{fmtD(sal.start)} ~ {fmtD(sal.end)}</div>
          </div>
          {navBtn("▶", () => setMonthOffset(o => o + 1))}
        </div>
      </div>

      {!isCurrent && <div style={{ padding:"0 20px 8px", textAlign:"center" }}>
        <button onClick={() => setMonthOffset(0)} style={{ background:C.card, border:`1px solid ${C.cardBorder}`, color:C.accent, borderRadius:16, padding:"4px 14px", fontSize:11, cursor:"pointer", fontFamily:"inherit", fontWeight:600 }}>이번 달로 돌아가기</button>
      </div>}

      <div style={{ display:"flex", padding:"0 20px", borderBottom:`1px solid ${C.divider}` }}>
        {[["dash","대시보드"],["list","내역"],["add","추가"],["calc","급여계산"]].map(([v,l])=>tab(v,l))}
      </div>

      <div style={{ padding:"16px 20px", paddingBottom:80 }}>

        {view==="dash" && <>
          <div style={{ ...cardStyle, marginBottom:14 }}>
            <div style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}>
              <span style={{ fontSize:13, color:C.textSub }}>카드 예산</span>
              <span style={{ fontSize:11, color:C.textDim }}>{fmtD(bill.billingStart)} ~ {fmtD(bill.billingEnd)}</span>
            </div>
            <div style={{ display:"flex", alignItems:"baseline", gap:6, marginBottom:12 }}>
              <span style={{ fontSize:32, fontWeight:800, color:over?C.red:C.accent, letterSpacing:-1 }}>{fmt(spent)}</span>
              <span style={{ fontSize:14, color:C.textDim }}>/ {fmt(BUDGET)}원</span>
            </div>
            <div style={{ height:8, background:C.divider, borderRadius:4, overflow:"hidden", marginBottom:12 }}>
              <div style={{ width:`${pct}%`, height:"100%", borderRadius:4, transition:"width 0.6s", background:over?C.red:pct>80?C.orange:C.green }}/>
            </div>
            <div style={{ display:"flex", justifyContent:"space-between" }}>
              <div><div style={{ fontSize:11, color:C.textDim, marginBottom:2 }}>남은 금액</div><div style={{ fontSize:18, fontWeight:700, color:over?C.red:C.green }}>{over?`-${fmt(-remain)}`:fmt(remain)}원</div></div>
              <div style={{ textAlign:"center" }}><div style={{ fontSize:11, color:C.textDim, marginBottom:2 }}>{isCurrent?"남은 일수":"총 일수"}</div><div style={{ fontSize:18, fontWeight:700, color:C.accent }}>{isCurrent?daysLeft:totalDays}일</div></div>
              <div style={{ textAlign:"right" }}><div style={{ fontSize:11, color:C.textDim, marginBottom:2 }}>{isCurrent?"일 예산":"일 평균"}</div><div style={{ fontSize:18, fontWeight:700, color:isCurrent&&dailyBgt<10000?C.orange:C.accent }}>{isCurrent?(remain>0?fmt(dailyBgt):0):(bTxs.length>0?fmt(Math.round(spent/Math.max(1,elapsed))):0)}원</div></div>
            </div>
          </div>

          <div style={{ ...cardStyle, borderRadius:12, padding:"12px 16px", marginBottom:14, display:"flex", justifyContent:"space-between" }}>
            <span style={{ fontSize:12, color:C.textSub }}>💳 카드 결제일</span>
            <span style={{ fontSize:13, fontWeight:700, color:C.accent }}>{fmtD(bill.paymentDate)}</span>
          </div>

          <div style={{ ...cardStyle, marginBottom:14 }}>
            <div style={{ fontSize:13, color:C.textSub, marginBottom:8 }}>주식 투자 가능액</div>
            <div style={{ fontSize:28, fontWeight:800, color:C.green, letterSpacing:-1 }}>{fmt(Math.max(0,investable))}원</div>
            <div style={{ fontSize:11, color:C.textDim, marginTop:4 }}>실수령 {fmt(income)} − 고정지출 {fmt(TOTAL_DED)}</div>
          </div>

          {dailyData.length>0 && <div style={{ ...cardStyle, padding:"16px 12px" }}>
            <div style={{ fontSize:13, color:C.textSub, marginBottom:8, paddingLeft:8 }}>결제주기 일별 지출</div>
            <ResponsiveContainer width="100%" height={140}>
              <BarChart data={dailyData}><XAxis dataKey="day" tick={{fill:C.textDim,fontSize:10}} axisLine={false} tickLine={false}/><YAxis hide/><Tooltip formatter={v=>`${fmt(v)}원`} contentStyle={{background:C.card,border:`1px solid ${C.cardBorder}`,borderRadius:8,fontSize:12,color:C.text}}/><Bar dataKey="amount" fill={C.barFill} radius={[3,3,0,0]}/></BarChart>
            </ResponsiveContainer>
          </div>}
        </>}

        {view==="list" && <>
          <div style={{ fontSize:12, color:C.textDim, marginBottom:12 }}>결제주기 내역 · {fmtD(bill.billingStart)} ~ {fmtD(bill.billingEnd)}</div>
          {bTxs.length===0
            ? <div style={{ textAlign:"center", padding:"50px 20px", color:C.textDim }}><div style={{ fontSize:40, marginBottom:12 }}>📭</div><div style={{ fontSize:14 }}>이 결제주기에 내역이 없어요</div></div>
            : bTxs.sort((a,b)=>b.date.localeCompare(a.date)||(b.time||"").localeCompare(a.time||"")).map(tx =>
              <div key={tx.id} style={{ display:"flex", alignItems:"center", padding:"11px 0", borderBottom:`1px solid ${C.divider}`, gap:10 }}>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:14, fontWeight:600, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{tx.merchant}</div>
                  <div style={{ fontSize:11, color:C.textDim, marginTop:2 }}>{tx.date.slice(5)} {tx.time}</div>
                </div>
                <div style={{ fontSize:15, fontWeight:700, color:C.red, whiteSpace:"nowrap" }}>-{fmt(tx.amount)}</div>
                <button onClick={()=>{const next=txs.filter(t=>t.id!==tx.id);setTxs(next);flash("삭제됨");}} style={{ background:"none",border:"none",color:C.textDim,fontSize:14,cursor:"pointer",padding:4 }}>✕</button>
              </div>
            )
          }
        </>}

        {view==="add" && <>
          <div style={{ marginBottom:28 }}>
            <div style={{ fontSize:14, fontWeight:700, color:C.accent, marginBottom:6 }}>📱 문자 붙여넣기</div>
            <div style={{ fontSize:11, color:C.textDim, marginBottom:10, lineHeight:1.6 }}>은행 알림 문자를 복사해서 붙여넣으세요</div>
            <textarea
              value={sms}
              onChange={e => setSms(e.target.value)}
              placeholder={"[NH농협] 04/09 14:30 위카드(체크) 승인 35,000원 스타벅스 잔액 1,234,567원"}
              style={{ ...iS, height: 110, resize: "none", lineHeight: 1.5, padding: 14, maxWidth: "100%" }}
            />
            <button onClick={()=>{const p=parseSMS(sms);if(!p.length){flash("파싱 가능한 문자가 없어요");return;}const next=[...p,...txs];setTxs(next);setSms("");flash(`${p.length}건 추가!`);setMonthOffset(0);setView("list");}} style={{ width:"100%",marginTop:8,padding:12,background:C.btnBg,border:"none",borderRadius:10,color:C.btnText,fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"inherit" }}>자동 분석하기</button>
          </div>
          <div>
            <div style={{ fontSize:14, fontWeight:700, color:C.accent, marginBottom:10 }}>✏️ 직접 입력</div>
            <input type="date" value={mf.date} onChange={e=>setMf(p=>({...p,date:e.target.value}))} style={{ ...iS, marginBottom:8 }}/>
            <input type="number" value={mf.amount} onChange={e=>setMf(p=>({...p,amount:e.target.value}))} placeholder="금액 (원)" style={{ ...iS, marginBottom:8 }}/>
            <input value={mf.merchant} onChange={e=>setMf(p=>({...p,merchant:e.target.value}))} placeholder="어디서? (예: 스타벅스)" style={{ ...iS, marginBottom:10 }}/>
            <button onClick={()=>{if(!mf.amount||!mf.merchant){flash("금액과 내용을 입력하세요");return;}const next=[{id:Date.now()+Math.random(),...mf,amount:parseInt(mf.amount),time:"",type:"지출"},...txs];setTxs(next);setMf({date:new Date().toISOString().slice(0,10),amount:"",merchant:""});flash("추가 완료!");setMonthOffset(0);setView("list");}} style={{ width:"100%",padding:12,background:C.card,border:`1px solid ${C.cardBorder}`,borderRadius:10,color:C.accent,fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"inherit" }}>추가하기</button>
          </div>

          <div style={{ marginTop:32, paddingTop:16, borderTop:`1px solid ${C.divider}` }}>
            <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
              <img src={user.photoURL} alt="" style={{ width:28, height:28, borderRadius:"50%" }}/>
              <div>
                <div style={{ fontSize:12, fontWeight:600, color:C.accent }}>{user.displayName}</div>
                <div style={{ fontSize:11, color:C.textDim }}>{user.email}</div>
              </div>
              <button onClick={()=>signOut(auth)} style={{ marginLeft:"auto", background:"none", border:`1px solid ${C.cardBorder}`, color:C.textSub, borderRadius:6, padding:"4px 10px", fontSize:11, cursor:"pointer", fontFamily:"inherit" }}>로그아웃</button>
            </div>
            <button onClick={async()=>{if(!window.confirm("전체 데이터를 삭제할까요?"))return;setTxs([]);flash("초기화 완료");}} style={{ background:"none",border:`1px solid ${C.cardBorder}`,color:C.red,borderRadius:8,padding:"8px 16px",fontSize:12,cursor:"pointer",fontFamily:"inherit" }}>전체 데이터 초기화</button>
          </div>
        </>}

        {view==="calc" && <>
          <div style={{ ...cardStyle, marginBottom:16 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
              <div style={{ fontSize:14, fontWeight:700, color:C.accent }}>월 급여 계산기</div>
              <button onClick={()=>{setShowIncEdit(!showIncEdit);setIncInput(String(income));}} style={{ background:"none",border:`1px solid ${C.cardBorder}`,color:C.textSub,borderRadius:6,padding:"4px 12px",fontSize:11,cursor:"pointer",fontFamily:"inherit" }}>{showIncEdit?"닫기":"수정"}</button>
            </div>
            {showIncEdit && <div style={{ marginBottom:16, display:"flex", gap:8 }}>
              <input type="number" value={incInput} onChange={e=>setIncInput(e.target.value)} style={{ ...iS, flex:1 }} placeholder="실수령액"/>
              <button onClick={()=>{setIncome(parseInt(incInput)||0);setShowIncEdit(false);flash("수정됨");}} style={{ background:C.btnBg,border:"none",color:C.btnText,borderRadius:8,padding:"0 16px",fontWeight:700,cursor:"pointer",fontSize:13,fontFamily:"inherit" }}>확인</button>
            </div>}
            <div style={{ display:"flex", justifyContent:"space-between", padding:"10px 0", borderBottom:`1px solid ${C.divider}` }}>
              <span style={{ color:C.textSub, fontSize:13 }}>실수령 급여</span>
              <span style={{ fontSize:16, fontWeight:700, color:C.green }}>+{fmt(income)}원</span>
            </div>
            {DEDUCTIONS.map(d => <div key={d.name} style={{ display:"flex", justifyContent:"space-between", padding:"9px 0", borderBottom:`1px solid ${C.divider}` }}>
              <span style={{ color:C.textSub, fontSize:13 }}>{d.name}</span>
              <span style={{ fontSize:14, fontWeight:600, color:C.red }}>-{fmt(d.amount)}원</span>
            </div>)}
            <div style={{ display:"flex", justifyContent:"space-between", padding:"14px 0 4px", marginTop:4 }}>
              <span style={{ fontSize:14, fontWeight:700, color:C.accent }}>→ 주식 투자 가능액</span>
              <span style={{ fontSize:22, fontWeight:800, color:investable>=0?C.green:C.red }}>{fmt(investable)}원</span>
            </div>
          </div>

          <div style={{ ...cardStyle }}>
            <div style={{ fontSize:14, fontWeight:700, color:C.accent, marginBottom:14 }}>향후 급여일 / 결제일</div>
            {(() => {
              const rows = [];
              for (let i=0; i<8; i++) {
                const m = today.getMonth()+1+i;
                const y = today.getFullYear()+Math.floor((m-1)/12);
                const mm = ((m-1)%12)+1;
                rows.push({ month:`${y}.${String(mm).padStart(2,"0")}`, payday:fmtD(getPayday(y,mm)), cardDay:fmtD(getCardPayDate(y,mm)) });
              }
              return rows.map(r => <div key={r.month} style={{ display:"flex", justifyContent:"space-between", padding:"8px 0", borderBottom:`1px solid ${C.divider}`, fontSize:12 }}>
                <span style={{ color:C.textSub, width:60 }}>{r.month}</span>
                <span style={{ color:C.green }}>급여 {r.payday}</span>
                <span style={{ color:C.red }}>결제 {r.cardDay}</span>
              </div>);
            })()}
          </div>
        </>}

      </div>
    </div>
  );
}