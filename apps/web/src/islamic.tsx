import { useCallback, useEffect, useState } from "react";
import * as adhan from "adhan";
import { Check, RotateCcw, Settings2 } from "lucide-react";
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

// Calculation methods the user can pick manually. "auto" resolves by country.
const METHODS: { id: string; label: string }[] = [
  { id: "auto", label: "تلقائي (حسب البلد)" },
  { id: "TN", label: "تونس" },
  { id: "DZ", label: "الجزائر" },
  { id: "MA", label: "المغرب" },
  { id: "EGYPT", label: "مصر" },
  { id: "UMM_AL_QURA", label: "أم القرى (السعودية)" },
  { id: "DUBAI", label: "دبي / الإمارات" },
  { id: "KUWAIT", label: "الكويت" },
  { id: "QATAR", label: "قطر" },
  { id: "TURKEY", label: "تركيا" },
  { id: "TEHRAN", label: "إيران" },
  { id: "KARACHI", label: "كراتشي" },
  { id: "SINGAPORE", label: "سنغافورة" },
  { id: "JAKIM", label: "ماليزيا / إندونيسيا" },
  { id: "FRANCE", label: "فرنسا" },
  { id: "NORTH_AMERICA", label: "أمريكا الشمالية" },
  { id: "MWL", label: "رابطة العالم الإسلامي" }
];

function methodParams(id: string): adhan.CalculationParameters {
  const M = adhan.CalculationMethod;
  const custom = (fajr: number, isha: number) => {
    const p = M.Other();
    p.fajrAngle = fajr;
    p.ishaAngle = isha;
    return p;
  };
  switch (id) {
    case "TN": return custom(18, 18);
    case "DZ": return custom(18, 17);
    case "MA": return custom(19, 17);
    case "EGYPT": return M.Egyptian();
    case "UMM_AL_QURA": return M.UmmAlQura();
    case "DUBAI": return M.Dubai();
    case "KUWAIT": return M.Kuwait();
    case "QATAR": return M.Qatar();
    case "TURKEY": return M.Turkey();
    case "TEHRAN": return M.Tehran();
    case "KARACHI": return M.Karachi();
    case "SINGAPORE": return M.Singapore();
    case "JAKIM": return custom(20, 18);
    case "FRANCE": return custom(12, 12);
    case "NORTH_AMERICA": return M.NorthAmerica();
    default: return M.MuslimWorldLeague();
  }
}

function countryToMethod(cc?: string): string {
  const map: Record<string, string> = {
    TN: "TN", DZ: "DZ", MA: "MA", EG: "EGYPT", SA: "UMM_AL_QURA", AE: "DUBAI", KW: "KUWAIT",
    QA: "QATAR", TR: "TURKEY", IR: "TEHRAN", SG: "SINGAPORE", ID: "JAKIM", MY: "JAKIM",
    FR: "FRANCE", US: "NORTH_AMERICA", CA: "NORTH_AMERICA", PK: "KARACHI", IN: "KARACHI",
    BD: "KARACHI", AF: "KARACHI"
  };
  return (cc && map[cc]) || "MWL";
}

type PrayerSettings = {
  method: string;
  madhab: "shafi" | "hanafi";
  tune: Record<PrayerKey, number>;
};

const DEFAULT_SETTINGS: PrayerSettings = {
  method: "auto",
  madhab: "shafi",
  tune: { fajr: 0, sunrise: 0, dhuhr: 0, asr: 0, maghrib: 0, isha: 0 }
};

function loadSettings(): PrayerSettings {
  try {
    const raw = localStorage.getItem("nexus-prayer-settings");
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return DEFAULT_SETTINGS;
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
  const [coords, setCoords] = useState<{ lat: number; lon: number } | null>(null);
  const [cc, setCc] = useState<string | undefined>(undefined);
  const [rows, setRows] = useState<{ key: PrayerKey; label: string; time: string }[] | null>(null);
  const [nextKey, setNextKey] = useState<PrayerKey | null>(null);
  const [error, setError] = useState("");
  const [settings, setSettings] = useState<PrayerSettings>(loadSettings);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!navigator.geolocation) {
      setError("الموقع غير متاح في هذا المتصفح");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude, longitude } = pos.coords;
        setCoords({ lat: latitude, lon: longitude });
        setCc(await detectCountry(latitude, longitude));
      },
      () => setError("فعّل الموقع لعرض مواقيت الصلاة"),
      { timeout: 10000, maximumAge: 3600000 }
    );
  }, []);

  // Recompute whenever location or settings change.
  useEffect(() => {
    if (!coords) return;
    const id = settings.method === "auto" ? countryToMethod(cc) : settings.method;
    const params = methodParams(id);
    params.madhab = settings.madhab === "hanafi" ? adhan.Madhab.Hanafi : adhan.Madhab.Shafi;
    params.adjustments = { ...settings.tune };
    const pt = new adhan.PrayerTimes(new adhan.Coordinates(coords.lat, coords.lon), new Date(), params);
    const times: Record<PrayerKey, Date> = {
      fajr: pt.fajr, sunrise: pt.sunrise, dhuhr: pt.dhuhr, asr: pt.asr, maghrib: pt.maghrib, isha: pt.isha
    };
    setRows(PRAYERS.map((p) => ({ key: p.key, label: p.label, time: times[p.key].toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) })));
    const np = pt.nextPrayer();
    setNextKey(np === adhan.Prayer.None ? "fajr" : (np as PrayerKey));
  }, [coords, cc, settings]);

  const update = useCallback((patch: Partial<PrayerSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      localStorage.setItem("nexus-prayer-settings", JSON.stringify(next));
      return next;
    });
  }, []);

  if (error) return <p className="empty" dir="rtl">{error}</p>;
  if (!rows) return <p className="empty" dir="rtl">…جارٍ تحديد موقعك</p>;

  return (
    <div dir="rtl">
      <button className="prayer-edit-btn" onClick={() => setEditing((e) => !e)}>
        <Settings2 size={14} /> تعديل الطريقة
      </button>

      {editing && (
        <div className="prayer-settings">
          <label>
            الطريقة
            <select value={settings.method} onChange={(e) => update({ method: e.target.value })}>
              {METHODS.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          </label>
          <label>
            مذهب العصر
            <select value={settings.madhab} onChange={(e) => update({ madhab: e.target.value as "shafi" | "hanafi" })}>
              <option value="shafi">الجمهور (شافعي)</option>
              <option value="hanafi">حنفي</option>
            </select>
          </label>
          <div className="prayer-tune">
            <span className="tune-hint">تعديل بالدقائق (±) لمطابقة التوقيت الرسمي</span>
            {PRAYERS.map((p) => (
              <label key={p.key} className="tune-row">
                {p.label}
                <input
                  type="number"
                  value={settings.tune[p.key]}
                  onChange={(e) => update({ tune: { ...settings.tune, [p.key]: Number(e.target.value) || 0 } })}
                />
              </label>
            ))}
          </div>
          <button className="link-button" onClick={() => update(DEFAULT_SETTINGS)}>إعادة الضبط</button>
        </div>
      )}

      <div className="prayer-list">
        {rows.map((p) => (
          <div key={p.key} className={`prayer-row ${nextKey === p.key ? "next" : ""}`}>
            <span>{p.label}</span>
            <time>{p.time}</time>
          </div>
        ))}
      </div>
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
