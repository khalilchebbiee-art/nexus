import { useEffect, useState } from "react";
import * as adhan from "adhan";
import { Check, RotateCcw } from "lucide-react";
import { ADHKAR_MASAA, ADHKAR_SABAH, type Dhikr } from "./adhkar";

const PRAYERS = [
  { key: "fajr", label: "الفجر" },
  { key: "sunrise", label: "الشروق" },
  { key: "dhuhr", label: "الظهر" },
  { key: "asr", label: "العصر" },
  { key: "maghrib", label: "المغرب" },
  { key: "isha", label: "العشاء" }
] as const;

type PrayerKey = (typeof PRAYERS)[number]["key"];

// Picks the official calculation convention for the detected country so times
// match the local authority (Tunisia, Saudi, Egypt, North America, etc.).
function paramsForCountry(cc?: string): adhan.CalculationParameters {
  const M = adhan.CalculationMethod;
  const custom = (fajr: number, isha: number) => {
    const p = M.Other();
    p.fajrAngle = fajr;
    p.ishaAngle = isha;
    return p;
  };
  let params: adhan.CalculationParameters;
  let hanafi = false;
  switch (cc) {
    case "TN": params = custom(18, 18); break; // Tunisia
    case "DZ": params = custom(18, 17); break; // Algeria
    case "MA": params = custom(19, 17); break; // Morocco
    case "EG": params = M.Egyptian(); break;
    case "SA": params = M.UmmAlQura(); break;
    case "AE": params = M.Dubai(); break;
    case "KW": params = M.Kuwait(); break;
    case "QA": params = M.Qatar(); break;
    case "TR": params = M.Turkey(); break;
    case "IR": params = M.Tehran(); break;
    case "SG": params = M.Singapore(); break;
    case "ID":
    case "MY": params = custom(20, 18); break; // Kemenag / JAKIM
    case "FR": params = custom(12, 12); break; // UOIF
    case "US":
    case "CA": params = M.NorthAmerica(); break;
    case "PK":
    case "IN":
    case "BD":
    case "AF": params = M.Karachi(); hanafi = true; break;
    default: params = M.MuslimWorldLeague();
  }
  params.madhab = hanafi ? adhan.Madhab.Hanafi : adhan.Madhab.Shafi;
  return params;
}

async function detectCountry(lat: number, lon: number): Promise<string | undefined> {
  const cached = localStorage.getItem("nexus-cc");
  if (cached) return cached;
  try {
    const res = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`);
    const data = await res.json();
    const cc = data.countryCode as string | undefined;
    if (cc) localStorage.setItem("nexus-cc", cc);
    return cc;
  } catch {
    return undefined; // offline / blocked -> fall back to Muslim World League
  }
}

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
  const [rows, setRows] = useState<{ key: PrayerKey; label: string; time: string }[] | null>(null);
  const [nextKey, setNextKey] = useState<PrayerKey | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!navigator.geolocation) {
      setError("الموقع غير متاح في هذا المتصفح");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude, longitude } = pos.coords;
        const cc = await detectCountry(latitude, longitude);
        const params = paramsForCountry(cc);
        const pt = new adhan.PrayerTimes(new adhan.Coordinates(latitude, longitude), new Date(), params);
        const times: Record<PrayerKey, Date> = {
          fajr: pt.fajr,
          sunrise: pt.sunrise,
          dhuhr: pt.dhuhr,
          asr: pt.asr,
          maghrib: pt.maghrib,
          isha: pt.isha
        };
        setRows(
          PRAYERS.map((p) => ({
            key: p.key,
            label: p.label,
            time: times[p.key].toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
          }))
        );
        const np = pt.nextPrayer();
        setNextKey(np === adhan.Prayer.None ? "fajr" : (np as PrayerKey));
      },
      () => setError("فعّل الموقع لعرض مواقيت الصلاة"),
      { timeout: 10000, maximumAge: 3600000 }
    );
  }, []);

  if (error) return <p className="empty" dir="rtl">{error}</p>;
  if (!rows) return <p className="empty" dir="rtl">…جارٍ تحديد موقعك</p>;

  return (
    <div className="prayer-list" dir="rtl">
      {rows.map((p) => (
        <div key={p.key} className={`prayer-row ${nextKey === p.key ? "next" : ""}`}>
          <span>{p.label}</span>
          <time>{p.time}</time>
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
