import { useEffect, useMemo, useState } from "react";
import { Check, RotateCcw } from "lucide-react";
import { ADHKAR_MASAA, ADHKAR_SABAH, type Dhikr } from "./adhkar";

type Timings = { Fajr: string; Sunrise: string; Dhuhr: string; Asr: string; Maghrib: string; Isha: string };

const PRAYERS: { key: keyof Timings; label: string }[] = [
  { key: "Fajr", label: "الفجر" },
  { key: "Sunrise", label: "الشروق" },
  { key: "Dhuhr", label: "الظهر" },
  { key: "Asr", label: "العصر" },
  { key: "Maghrib", label: "المغرب" },
  { key: "Isha", label: "العشاء" }
];

export function IslamicPanel() {
  const [mode, setMode] = useState<"prayer" | "sabah" | "masaa">("prayer");
  return (
    <section className="panel islamic-panel">
      <div className="islamic-tabs">
        <button className={mode === "prayer" ? "active" : ""} onClick={() => setMode("prayer")}>مواقيت الصلاة</button>
        <button className={mode === "sabah" ? "active" : ""} onClick={() => setMode("sabah")}>أذكار الصباح</button>
        <button className={mode === "masaa" ? "active" : ""} onClick={() => setMode("masaa")}>أذكار المساء</button>
      </div>
      {mode === "prayer" ? <PrayerTimes /> : <AdhkarReader list={mode === "sabah" ? ADHKAR_SABAH : ADHKAR_MASAA} />}
    </section>
  );
}

function PrayerTimes() {
  const [timings, setTimings] = useState<Timings | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const today = new Date().toDateString();
    const cached = localStorage.getItem("nexus-prayer");
    if (cached) {
      const parsed = JSON.parse(cached) as { day: string; timings: Timings };
      if (parsed.day === today) {
        setTimings(parsed.timings);
        return;
      }
    }
    if (!navigator.geolocation) {
      setError("الموقع غير متاح");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const url = `https://api.aladhan.com/v1/timings?latitude=${pos.coords.latitude}&longitude=${pos.coords.longitude}&method=3`;
          const res = await fetch(url);
          const data = await res.json();
          const t = data.data.timings as Timings;
          setTimings(t);
          localStorage.setItem("nexus-prayer", JSON.stringify({ day: today, timings: t }));
        } catch {
          setError("تعذّر تحميل المواقيت");
        }
      },
      () => setError("فعّل الموقع لعرض مواقيت الصلاة"),
      { timeout: 10000 }
    );
  }, []);

  const nextKey = useMemo(() => {
    if (!timings) return null;
    const now = new Date();
    const mins = now.getHours() * 60 + now.getMinutes();
    for (const p of PRAYERS) {
      const [h, m] = timings[p.key].split(":").map(Number);
      if (h * 60 + m > mins) return p.key;
    }
    return "Fajr" as keyof Timings;
  }, [timings]);

  if (error) return <p className="empty" dir="rtl">{error}</p>;
  if (!timings) return <p className="empty" dir="rtl">…جارٍ تحديد موقعك</p>;

  return (
    <div className="prayer-list" dir="rtl">
      {PRAYERS.map((p) => (
        <div key={p.key} className={`prayer-row ${nextKey === p.key ? "next" : ""}`}>
          <span>{p.label}</span>
          <time>{timings[p.key]}</time>
        </div>
      ))}
    </div>
  );
}

function AdhkarReader({ list }: { list: Dhikr[] }) {
  const [index, setIndex] = useState(0);
  const [remaining, setRemaining] = useState(list[0]?.count ?? 1);

  useEffect(() => {
    setIndex(0);
    setRemaining(list[0]?.count ?? 1);
  }, [list]);

  const dhikr = list[index];
  if (!dhikr) {
    return (
      <div className="adhkar-done" dir="rtl">
        <Check size={28} />
        <p>تقبّل الله، أتممت الأذكار 🤍</p>
        <button className="primary-button" onClick={() => { setIndex(0); setRemaining(list[0].count); }}>
          <RotateCcw size={16} /> إعادة
        </button>
      </div>
    );
  }

  function next() {
    const ni = index + 1;
    setIndex(ni);
    setRemaining(list[ni]?.count ?? 1);
  }

  function tap() {
    if (remaining <= 1) next();
    else setRemaining((r) => r - 1);
  }

  return (
    <div className="adhkar-reader" dir="rtl">
      <div className="adhkar-progress">{index + 1} / {list.length}</div>
      <p className="adhkar-text">{dhikr.text}</p>
      <button className="adhkar-count" onClick={tap}>
        {remaining > 0 ? `اضغط (${remaining})` : "تم"}
      </button>
      <button className="link-button adhkar-skip" onClick={next}>التالي ←</button>
    </div>
  );
}
