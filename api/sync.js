// Vercel Serverless Function: /api/sync
// 1) The Odds API'den oranları çeker -> Firestore "matches" (maçtan <=1s kala DONDURUR)
// 2) Biten maçların skorlarını çeker -> Firestore "results" (puanlar otomatik dağılır)
// Akıllı/krediyi koruyan mantık: oranlar sadece yaklaşan maçlar için ve en çok 4 saatte bir;
// skorlar sadece yeni bitmiş (sonucu olmayan) maç varsa çekilir.
//
// Ortam değişkenleri (Vercel > Settings > Environment Variables):
//   ODDS_API_KEY  -> The Odds API anahtarın (GİZLİ)
//   SYNC_SECRET   -> kendi belirlediğin parola (URL'de ?token= ile)

const PROJECT = "fantasyfootbalgame";
const FB_WEB_KEY = "AIzaSyAbeNEfOCgwBHqzXEXat6szSxF-o5doYN0";
const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const SPORT = "soccer_fifa_world_cup";
const HOUR = 3600 * 1000;
const FREEZE_MS = 1 * HOUR;        // maçtan 1 saat önce dondur
const ODDS_THROTTLE = 4 * HOUR;    // oranları en çok 4 saatte bir tazele
const FINISHED_AFTER = 1.9 * HOUR; // kickoff üstünden bu kadar geçince "bitmiş say"

const NAMES = {
  "Qatar":["🇶🇦","Katar"],"Switzerland":["🇨🇭","İsviçre"],"Brazil":["🇧🇷","Brezilya"],"Morocco":["🇲🇦","Fas"],
  "Haiti":["🇭🇹","Haiti"],"Scotland":["🏴󠁧󠁢󠁳󠁣󠁴󠁿","İskoçya"],"Australia":["🇦🇺","Avustralya"],"Turkey":["🇹🇷","Türkiye"],
  "Türkiye":["🇹🇷","Türkiye"],"Germany":["🇩🇪","Almanya"],"Curaçao":["🇨🇼","Curaçao"],"Netherlands":["🇳🇱","Hollanda"],
  "Japan":["🇯🇵","Japonya"],"Ivory Coast":["🇨🇮","Fildişi Sahili"],"Ecuador":["🇪🇨","Ekvador"],"Sweden":["🇸🇪","İsveç"],
  "Tunisia":["🇹🇳","Tunus"],"Spain":["🇪🇸","İspanya"],"Cape Verde":["🇨🇻","Cabo Verde"],"Belgium":["🇧🇪","Belçika"],
  "Egypt":["🇪🇬","Mısır"],"Saudi Arabia":["🇸🇦","Suudi Arabistan"],"Uruguay":["🇺🇾","Uruguay"],"Argentina":["🇦🇷","Arjantin"],
  "France":["🇫🇷","Fransa"],"England":["🏴󠁧󠁢󠁥󠁮󠁧󠁿","İngiltere"],"Portugal":["🇵🇹","Portekiz"],"Italy":["🇮🇹","İtalya"],
  "Croatia":["🇭🇷","Hırvatistan"],"Mexico":["🇲🇽","Meksika"],"United States":["🇺🇸","ABD"],"USA":["🇺🇸","ABD"],
  "Canada":["🇨🇦","Kanada"],"Poland":["🇵🇱","Polonya"],"Senegal":["🇸🇳","Senegal"],"Denmark":["🇩🇰","Danimarka"],
  "Colombia":["🇨🇴","Kolombiya"],"South Korea":["🇰🇷","Güney Kore"],"Korea Republic":["🇰🇷","Güney Kore"],
  "Iran":["🇮🇷","İran"],"Nigeria":["🇳🇬","Nijerya"],"Ghana":["🇬🇭","Gana"],"Cameroon":["🇨🇲","Kamerun"],
  "Serbia":["🇷🇸","Sırbistan"],"Norway":["🇳🇴","Norveç"],"Austria":["🇦🇹","Avusturya"],"Ukraine":["🇺🇦","Ukrayna"],
  "Algeria":["🇩🇿","Cezayir"],"Paraguay":["🇵🇾","Paraguay"],"Peru":["🇵🇪","Peru"],"Chile":["🇨🇱","Şili"],
  "Panama":["🇵🇦","Panama"],"Jordan":["🇯🇴","Ürdün"],"Uzbekistan":["🇺🇿","Özbekistan"],"New Zealand":["🇳🇿","Yeni Zelanda"],
  "South Africa":["🇿🇦","Güney Afrika"],"Bosnia & Herzegovina":["🇧🇦","Bosna Hersek"],"DR Congo":["🇨🇩","DR Kongo"],
};
const info = n => NAMES[n] || ["⚽", n];
const median = a => { if(!a.length) return null; const s=[...a].sort((x,y)=>x-y), m=s.length>>1; return s.length%2?s[m]:(s[m-1]+s[m])/2; };
const fmt = n => n==null?"0":(Math.round(n*100)/100).toFixed(2);
const S = v => ({stringValue:String(v)});
const I = v => ({integerValue:String(v)});

async function getColl(coll){
  const r = await fetch(`${FS}/${coll}?key=${FB_WEB_KEY}&pageSize=300`);
  if(!r.ok) return {};
  const j = await r.json(); const out = {};
  for(const d of (j.documents||[])){ const id=d.name.split("/").pop(); out[id]=d.fields||{}; }
  return out;
}
async function patch(path, fields, mask){
  const q = mask.map(f=>`updateMask.fieldPaths=${f}`).join("&");
  return fetch(`${FS}/${path}?key=${FB_WEB_KEY}&${q}`, {method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({fields})});
}

module.exports = async function handler(req, res){
  const secret = process.env.SYNC_SECRET;
  if(secret && req.query.token !== secret) return res.status(401).json({error:"unauthorized"});
  const KEY = process.env.ODDS_API_KEY;
  if(!KEY) return res.status(500).json({error:"ODDS_API_KEY yok"});
  const now = Date.now();
  const log = {oddsFetched:false, scoresFetched:false, matchesWritten:0, resultsWritten:0};
  try{
    const matchesDb = await getColl("matches");
    const resultsDb = await getColl("results");
    const meta = await getColl("meta");
    const lastOdds = meta.sync ? Number(meta.sync.lastOdds?.integerValue||0) : 0;
    const kickoff = m => new Date(m.datetime.stringValue).getTime();

    // --- ORAN gerekli mi? ---
    const list = Object.entries(matchesDb).map(([id,f])=>({id,f}));
    const freezeNow = list.some(({f})=> !(f.frozen&&f.frozen.booleanValue) && f.datetime && kickoff(f) <= now+FREEZE_MS && kickoff(f) > now-2*HOUR);
    const upcoming  = list.some(({f})=> !(f.frozen&&f.frozen.booleanValue) && f.datetime && kickoff(f) > now);
    const firstRun  = list.length===0;
    const doOdds = firstRun || freezeNow || (upcoming && (now-lastOdds)>=ODDS_THROTTLE);

    if(doOdds){
      const r = await fetch(`https://api.the-odds-api.com/v4/sports/${SPORT}/odds/?apiKey=${KEY}&regions=eu&markets=h2h&oddsFormat=decimal`);
      if(r.ok){
        log.oddsFetched=true;
        const games = await r.json();
        for(const g of games){
          const ex = matchesDb[g.id];
          if(ex && ex.frozen && ex.frozen.booleanValue) continue; // kilitli, dokunma
          const h=g.home_team, a=g.away_team, H=[],D=[],A=[];
          for(const bk of g.bookmakers||[]) for(const mk of bk.markets||[]) if(mk.key==="h2h")
            for(const o of mk.outcomes){ (o.name===h?H:o.name===a?A:D).push(o.price); }
          const [hf,htr]=info(h),[af,atr]=info(a);
          const ko=new Date(g.commence_time).getTime();
          const frozen = now >= ko - FREEZE_MS;
          const fields={ group:S("Grup Aşaması"), home:S(htr), hf:S(hf), away:S(atr), af:S(af),
            datetime:S(g.commence_time), frozen:{booleanValue:frozen},
            odds:{mapValue:{fields:{h:S(fmt(median(H))),d:S(fmt(median(D))),a:S(fmt(median(A)))}}} };
          const w=await patch(`matches/${g.id}`, fields, ["group","home","hf","away","af","datetime","frozen","odds"]);
          if(w.ok) log.matchesWritten++;
        }
        await patch("meta/sync", {lastOdds:I(now)}, ["lastOdds"]);
      }
    }

    // --- SKOR gerekli mi? (bitmiş ama sonucu olmayan maç var mı) ---
    const needScores = list.some(({id,f})=> f.datetime && kickoff(f) < now-FINISHED_AFTER && !resultsDb[id]);
    if(needScores){
      const r = await fetch(`https://api.the-odds-api.com/v4/sports/${SPORT}/scores/?apiKey=${KEY}&daysFrom=3&dateFormat=iso`);
      if(r.ok){
        log.scoresFetched=true;
        const games = await r.json();
        for(const g of games){
          if(!g.completed || !g.scores) continue;
          if(!matchesDb[g.id] || resultsDb[g.id]) continue;
          const hs=g.scores.find(s=>s.name===g.home_team), as=g.scores.find(s=>s.name===g.away_team);
          if(!hs||!as) continue;
          const w=await patch(`results/${g.id}`, {h:I(parseInt(hs.score)), a:I(parseInt(as.score))}, ["h","a"]);
          if(w.ok) log.resultsWritten++;
        }
      }
    }
    return res.status(200).json({ok:true, ts:new Date().toISOString(), ...log});
  }catch(e){ return res.status(500).json({error:String(e), ...log}); }
};
