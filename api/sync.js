// Vercel Serverless Function: /api/sync
// The Odds API'den Dünya Kupası oranlarını çeker, Firestore "matches" koleksiyonuna yazar.
// Maç başlamasına <= 1 saat kalınca oranlar DONDURULUR (artık güncellenmez).
//
// Gerekli ortam değişkenleri (Vercel > Settings > Environment Variables):
//   ODDS_API_KEY  -> The Odds API anahtarın (GİZLİ)
//   SYNC_SECRET   -> kendi belirlediğin rastgele bir parola (URL'de ?token= ile gönderilir)
//
// Tetikleme: cron-job.org gibi ücretsiz bir servis şu adresi periyodik çağırır:
//   https://SENIN-APP.vercel.app/api/sync?token=SYNC_SECRET

const PROJECT = "fantasyfootbalgame";
const FB_WEB_KEY = "AIzaSyAbeNEfOCgwBHqzXEXat6szSxF-o5doYN0"; // public web key (gizli değil)
const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const FREEZE_MS = 60 * 60 * 1000; // 1 saat

// İngilizce takım adı -> [bayrak, Türkçe ad]
const NAMES = {
  "Qatar":["🇶🇦","Katar"],"Switzerland":["🇨🇭","İsviçre"],"Brazil":["🇧🇷","Brezilya"],
  "Morocco":["🇲🇦","Fas"],"Haiti":["🇭🇹","Haiti"],"Scotland":["🏴󠁧󠁢󠁳󠁣󠁴󠁿","İskoçya"],
  "Australia":["🇦🇺","Avustralya"],"Turkey":["🇹🇷","Türkiye"],"Türkiye":["🇹🇷","Türkiye"],
  "Germany":["🇩🇪","Almanya"],"Curaçao":["🇨🇼","Curaçao"],"Netherlands":["🇳🇱","Hollanda"],
  "Japan":["🇯🇵","Japonya"],"Ivory Coast":["🇨🇮","Fildişi Sahili"],"Ecuador":["🇪🇨","Ekvador"],
  "Sweden":["🇸🇪","İsveç"],"Tunisia":["🇹🇳","Tunus"],"Spain":["🇪🇸","İspanya"],
  "Cape Verde":["🇨🇻","Cabo Verde"],"Belgium":["🇧🇪","Belçika"],"Egypt":["🇪🇬","Mısır"],
  "Saudi Arabia":["🇸🇦","Suudi Arabistan"],"Uruguay":["🇺🇾","Uruguay"],"Argentina":["🇦🇷","Arjantin"],
  "France":["🇫🇷","Fransa"],"England":["🏴󠁧󠁢󠁥󠁮󠁧󠁿","İngiltere"],"Portugal":["🇵🇹","Portekiz"],
  "Italy":["🇮🇹","İtalya"],"Croatia":["🇭🇷","Hırvatistan"],"Mexico":["🇲🇽","Meksika"],
  "United States":["🇺🇸","ABD"],"USA":["🇺🇸","ABD"],"Canada":["🇨🇦","Kanada"],"Poland":["🇵🇱","Polonya"],
  "Senegal":["🇸🇳","Senegal"],"Denmark":["🇩🇰","Danimarka"],"Colombia":["🇨🇴","Kolombiya"],
  "South Korea":["🇰🇷","Güney Kore"],"Korea Republic":["🇰🇷","Güney Kore"],"Iran":["🇮🇷","İran"],
  "Nigeria":["🇳🇬","Nijerya"],"Ghana":["🇬🇭","Gana"],"Cameroon":["🇨🇲","Kamerun"],
  "Serbia":["🇷🇸","Sırbistan"],"Norway":["🇳🇴","Norveç"],"Austria":["🇦🇹","Avusturya"],
  "Ukraine":["🇺🇦","Ukrayna"],"Algeria":["🇩🇿","Cezayir"],"Paraguay":["🇵🇾","Paraguay"],
  "Peru":["🇵🇪","Peru"],"Chile":["🇨🇱","Şili"],"Panama":["🇵🇦","Panama"],"Jordan":["🇯🇴","Ürdün"],
  "Uzbekistan":["🇺🇿","Özbekistan"],"New Zealand":["🇳🇿","Yeni Zelanda"],"South Africa":["🇿🇦","Güney Afrika"],
};
function info(n){ return NAMES[n] || ["⚽", n]; }
function median(a){ if(!a.length) return null; const s=[...a].sort((x,y)=>x-y); const m=Math.floor(s.length/2); return s.length%2?s[m]:(s[m-1]+s[m])/2; }
function fmt(n){ return n==null?"0":(Math.round(n*100)/100).toFixed(2); }
function S(v){ return {stringValue:String(v)}; }

module.exports = async function handler(req, res){
  const secret = process.env.SYNC_SECRET;
  if(secret && req.query.token !== secret) return res.status(401).json({error:"unauthorized"});
  const KEY = process.env.ODDS_API_KEY;
  if(!KEY) return res.status(500).json({error:"ODDS_API_KEY tanımlı değil"});
  try{
    const url = `https://api.the-odds-api.com/v4/sports/soccer_fifa_world_cup/odds/?apiKey=${KEY}&regions=eu&markets=h2h&oddsFormat=decimal`;
    const r = await fetch(url);
    if(!r.ok) return res.status(502).json({error:"Odds API hatası", status:r.status, body:await r.text()});
    const games = await r.json();
    const now = Date.now();
    let written = 0, frozenCount = 0;
    for(const g of games){
      const h = g.home_team, a = g.away_team;
      const H=[], D=[], A=[];
      for(const bk of g.bookmakers||[]) for(const mk of bk.markets||[]) if(mk.key==="h2h")
        for(const o of mk.outcomes){ (o.name===h?H:o.name===a?A:D).push(o.price); }
      const [hf,htr] = info(h), [af,atr] = info(a);
      const kickoff = new Date(g.commence_time).getTime();
      const frozen = now >= kickoff - FREEZE_MS;
      if(frozen) frozenCount++;

      const fields = {
        group: S("Grup Aşaması"), home: S(htr), hf: S(hf), away: S(atr), af: S(af),
        datetime: S(g.commence_time), frozen: {booleanValue: frozen},
      };
      const mask = ["group","home","hf","away","af","datetime","frozen"];
      // Oranlar yalnızca dondurulmadan ÖNCE güncellenir; donunca son değer kalır.
      if(!frozen){
        fields.odds = {mapValue:{fields:{ h:S(fmt(median(H))), d:S(fmt(median(D))), a:S(fmt(median(A))) }}};
        mask.push("odds");
      }
      const maskQ = mask.map(f=>`updateMask.fieldPaths=${f}`).join("&");
      const w = await fetch(`${FS}/matches/${g.id}?key=${FB_WEB_KEY}&${maskQ}`, {
        method:"PATCH", headers:{"Content-Type":"application/json"}, body: JSON.stringify({fields})
      });
      if(w.ok) written++;
    }
    return res.status(200).json({ok:true, games:games.length, written, frozen:frozenCount, ts:new Date().toISOString()});
  }catch(e){ return res.status(500).json({error:String(e)}); }
};
