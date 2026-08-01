// The Dojo Bay — directory UI. Loads data/*.json and content/*.md at runtime.
// Requires: assets/js/qrcode.js (global `qrcode`) and assets/js/markdown.js (global `markdown`).
(function(){
  "use strict";
async function loadJSON(url){
    const r = await fetch(url, {cache:"no-store"});
    if(!r.ok) throw new Error(url+" -> HTTP "+r.status);
    return await r.json();
  }
  async function loadText(url){
    const r = await fetch(url, {cache:"no-store"});
    if(!r.ok) throw new Error(url+" -> HTTP "+r.status);
    return await r.text();
  }

  const esc = s => String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  function flag(cc){ if(!cc) return ""; return cc.toUpperCase().replace(/./g,c=>String.fromCodePoint(127397+c.charCodeAt(0))); }
  function uptime(checks){ if(!checks||!checks.length) return {pct:null,up:0,total:0}; const up=checks.filter(c=>c.up).length; return {pct:Math.round(up/checks.length*1000)/10,up,total:checks.length}; }
  function copyFallback(text){
    const ta=document.createElement("textarea");ta.value=text;document.body.appendChild(ta);ta.select();
    try{document.execCommand("copy")}catch(e){}document.body.removeChild(ta);return Promise.resolve();
  }
  function copy(text){
    if(navigator.clipboard&&navigator.clipboard.writeText)
      return navigator.clipboard.writeText(text).catch(()=>copyFallback(text));
    return copyFallback(text);
  }
  function flash(btn,t){const o=btn.innerHTML;btn.innerHTML=t;btn.classList.add("done");setTimeout(()=>{btn.innerHTML=o;btn.classList.remove("done")},1500);}

  function qrSVG(text, px, ec){
    // ec "H" (30% recovery) is required for QRs carrying a centre avatar; the
    // overlay covers ~5% of the symbol, leaving ample margin for scanners.
    const qr = qrcode(0, ec||"M"); qr.addData(text); qr.make();
    const n=qr.getModuleCount(), margin=2, total=n+margin*2, cell=px/total;
    let r="";
    for(let row=0;row<n;row++) for(let col=0;col<n;col++) if(qr.isDark(row,col)){
      r+='<rect x="'+((col+margin)*cell).toFixed(2)+'" y="'+((row+margin)*cell).toFixed(2)+'" width="'+(cell+0.6).toFixed(2)+'" height="'+(cell+0.6).toFixed(2)+'" fill="#0a0a0a"/>';
    }
    return '<svg width="'+px+'" height="'+px+'" viewBox="0 0 '+px+' '+px+'" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Pairing QR code"><rect width="'+px+'" height="'+px+'" fill="#fff"/>'+r+'</svg>';
  }

  /* ---------------- site config (edit these) ----------------
     REPO_URL  : the GitHub repository the footer mark links to.
     ONION_URL : this site's own .onion address. Leave "" to hide the
                 header pill (e.g. while testing, or when the site is
                 served onion-only and the pill would be redundant). */
  const REPO_URL  = "https://github.com/Dojobay/dojobay";
  const ONION_URL = "http://dojobayeryasshgghz537de5ckgd5hhi4z5sdeil3roeh65fwhdnu2yd.onion/";
  // PayNym profile links point at the paynym.rs onion, so a visitor stays on Tor.
  const PAYNYM_WEB = "http://paynym25chftmsywv4v2r67agbrr62lcxagsf4tymbzpeeucucy2ivad.onion";
  const SRC_ICON = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="5" r="2.2"/><circle cx="6" cy="19" r="2.2"/><circle cx="18" cy="9" r="2.2"/><path d="M6 7.2v9.6M18 11.2c0 3.2-2.6 4.3-5.6 4.3H10"/></svg>`;
  const GH_LOGO = `<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M12 .5C5.37.5 0 5.78 0 12.29c0 5.2 3.44 9.6 8.21 11.16.6.11.82-.25.82-.56 0-.28-.01-1.02-.02-2-3.34.71-4.04-1.58-4.04-1.58-.55-1.36-1.34-1.73-1.34-1.73-1.09-.73.08-.72.08-.72 1.2.08 1.84 1.21 1.84 1.21 1.07 1.79 2.81 1.27 3.5.97.11-.76.42-1.27.76-1.56-2.67-.3-5.47-1.31-5.47-5.84 0-1.29.47-2.34 1.24-3.17-.12-.3-.54-1.52.12-3.16 0 0 1.01-.32 3.3 1.21.96-.26 1.98-.39 3-.4 1.02.01 2.04.14 3 .4 2.29-1.53 3.3-1.21 3.3-1.21.66 1.64.24 2.86.12 3.16.77.83 1.24 1.88 1.24 3.17 0 4.54-2.81 5.54-5.49 5.83.43.36.81 1.09.81 2.2 0 1.59-.01 2.87-.01 3.26 0 .31.21.68.83.56C20.56 21.88 24 17.48 24 12.29 24 5.78 18.63.5 12 .5z"/></svg>`;

  // Header/hero brand mark. Same torii as favicon.svg and the PWA icons, minus
  // the rounded background chip (it sits on the page, not on a tile) and themed
  // via the accent variables. viewBox frames the shared artwork paths.
  const LOGO = `
  <svg width="34" height="34" viewBox="34 89.5 252 252" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <g fill="var(--accent)">
      <path d="M40 96 Q160 112 280 96 L280 116 Q160 132 40 116 Z"/>
      <path d="M154 116 H166 V124 H154 Z"/>
      <path d="M74 124 H246 V144 H74 Z"/>
      <path d="M104 126 H124 L118 250 H98 Z"/>
      <path d="M196 126 H216 L222 250 H202 Z"/>
    </g>
    <g stroke="var(--accent-2)" stroke-width="14" stroke-linecap="round" fill="none">
      <path d="M50 272 q13.75 -13 27.5 0 t27.5 0 t27.5 0 t27.5 0 t27.5 0 t27.5 0 t27.5 0 t27.5 0"/>
      <path d="M50 300 q13.75 -13 27.5 0 t27.5 0 t27.5 0 t27.5 0 t27.5 0 t27.5 0 t27.5 0 t27.5 0" opacity="0.72"/>
      <path d="M50 328 q13.75 -13 27.5 0 t27.5 0 t27.5 0 t27.5 0 t27.5 0 t27.5 0 t27.5 0 t27.5 0" opacity="0.48"/>
    </g>
  </svg>`;

  const MODAL_META = {
    about:      {title:"About The Dojo Bay",         file:"content/about.md"},
    faq:        {title:"Frequently asked questions", file:"content/faq.md"},
  };
  const modalCache = {};

  let DOJOS=null, HIST=null, net="mainnet";
  // Mobile menu: state read by the header template at render time (the same
  // pattern as the Manage button and the build hash), never DOM-poked.
  let menuOpen=false;

  // Is the published data still current?
  //
  // The updater rewrites data/dojos.json every interval_minutes. If that timer
  // dies, nginx keeps serving the last file indefinitely and every badge stays
  // confidently green, which is the one failure this directory must not have:
  // the whole proposition is that the status is real. Past a few intervals we
  // stop asserting status and say so.
  //
  // A clock that is behind makes generated_at look like the future, which is
  // simply not stale. A clock far ahead can produce a false warning, so the
  // banner mentions it rather than insisting the site is broken.
  const STALE_INTERVALS = 3;
  function freshness(doc){
    const iv = Number(doc && doc.interval_minutes) > 0 ? Number(doc.interval_minutes) : 10;
    const t = Date.parse((doc && doc.generated_at) || "");
    if(!isFinite(t)) return { stale:true, unknown:true, intervalMin:iv, ageMin:null };
    const ageMin = (Date.now() - t) / 60000;
    return { stale: ageMin > iv*STALE_INTERVALS, unknown:false, intervalMin:iv, ageMin };
  }
  function humanAge(mins){
    if(mins==null) return "an unknown time";
    if(mins < 90) return Math.max(1,Math.round(mins)) + " minutes";
    if(mins < 60*36) return Math.round(mins/60) + " hours";
    return Math.round(mins/1440) + " days";
  }

  // One renderer for every endpoint row, so all three look and behave the same.
  // A row is always present: with a usable URL it shows the value and a working
  // copy button; without one it reads N/A with the copy button greyed out and
  // inert, keeping the row's three-column geometry. Anything that is not an
  // http(s)/tcp/ssl URL counts as absent, which covers a payload that carries
  // an explorer with an empty or placeholder url rather than omitting it.
  function epRow(label, url, naNote){
    const ok = typeof url === "string" && /^(https?|tcp|ssl):\/\//i.test(url.trim());
    if(!ok) return `<div class="ep"><span class="k">${esc(label)}</span>`
      + `<span class="u na" title="${esc(naNote)}">N/A</span>`
      + `<button class="copybtn" disabled title="Nothing to copy: ${esc(naNote.toLowerCase())}">copy</button></div>`;
    const u = url.trim();
    return `<div class="ep"><span class="k">${esc(label)}</span>`
      + `<span class="u" title="${esc(u)}">${esc(u)}</span>`
      + `<button class="copybtn" data-act="copyurl" data-v="${esc(u)}">copy</button></div>`;
  }

  // Electrum/indexer endpoint for the card. build-public.mjs publishes
  // indexer_url (what the updater read from the node's /support/services, else
  // whatever the pairing payload declared); the payload shapes are still read
  // as a fallback so a stale dojos.json keeps working.
  function indexerUrl(n){
    const ok = (u) => (typeof u === "string" && /^(tcp|ssl):\/\/[a-z2-7]{56}\.onion:\d{2,5}(\/.*)?$/i.test(u)) ? u : null;
    if(ok(n.indexer_url)) return n.indexer_url;
    const p = n.payload || {};
    let c = p.indexer;
    if((!c || !c.url) && Array.isArray(p.services)) c = p.services.find(s => s && s.type === "indexer");
    return ok(c && c.url);
  }

  // ---- 90-day daily history (lazily fetched once, cached) -------------------
  let HIST90 = null, DAILY = {nodes:{}};
  function loadHist90(){
    if(!HIST90) HIST90 = loadJSON("data/history-daily.json").catch(()=>({nodes:{}})).then(d=>{DAILY=d;return d;});
    return HIST90;
  }
  function heightSparkline(days){
    const pts = days.map((d,i)=>({i,h:d.close})).filter(p=>typeof p.h==="number");
    if(pts.length<2) return "";
    const W=280,H=32,pad=2, hs=pts.map(p=>p.h), min=Math.min(...hs), max=Math.max(...hs), span=(max-min)||1, n=(days.length-1)||1;
    const coords=pts.map(p=>{const x=pad+(p.i/n)*(W-2*pad); const y=H-pad-((p.h-min)/span)*(H-2*pad); return x.toFixed(1)+","+y.toFixed(1);});
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" aria-label="closing block height over 90 days"><polyline points="${coords.join(" ")}" fill="none" stroke="var(--accent-2)" stroke-width="1.5"/></svg>`;
  }
  async function renderHist90(mount, id){
    if(!mount) return;
    const body = mount.querySelector(".h90-body");
    let data; try{ data = await loadHist90(); }catch(e){ if(body) body.innerHTML='<span class="faint">No history yet.</span>'; return; }
    const days = (data.nodes && data.nodes[id] && data.nodes[id].days) || [];
    if(!days.length){ if(body) body.innerHTML='<span class="faint">No daily history yet.</span>'; return; }
    const view = days.slice(-90);
    const bars = view.map(d=>{
      const pct = d.pct==null?null:d.pct;
      const cls = pct==null?"na":(pct>=99?"up":(pct>=80?"mid":"down"));
      const t = `${d.d}: ${pct==null?"no data":pct+"% up"}${d.close!=null?", close "+Number(d.close).toLocaleString("en-GB"):""}`;
      return `<span class="d90 ${cls}" title="${esc(t)}"></span>`;
    }).join("");
    const closes = view.filter(d=>d.close!=null).map(d=>d.close);
    const latest = closes.length?closes[closes.length-1]:null;
    // Day-count reliability: a day counts as up when at least half of its
    // probe checks succeeded (pct >= 50); the percentage is derived from the
    // same ratio so the two figures always agree, e.g. "94.4% · 68/72 days".
    const withData = view.filter(d=>d.pct!=null);
    const upDays = withData.filter(d=>Number(d.pct)>=50).length;
    const relTxt = withData.length
      ? (p=>`${p%1===0?p:p.toFixed(1)}% · ${upDays}/${withData.length} days`)(100*upDays/withData.length)
      : `${view.length} day${view.length>1?"s":""}`;
    if(body) body.innerHTML =
      `<div class="d90strip">${bars}</div>`+
      `<div class="d90foot"><span class="faint" title="days with at least half of their checks up, of days with data">${relTxt}</span>`+
      (latest!=null?`<span class="faint">closing height ${Number(latest).toLocaleString("en-GB")}</span>`:"")+`</div>`+
      heightSparkline(view);
  }

  function relStrip(checks){
    const u=uptime(checks);
    const bars=(checks||[]).map(c=>`<div class="b ${c.up?"up":"down"}" title="${esc(c.t)} · ${c.up?"up":"down"}"></div>`).join("");
    const pct=u.pct==null?"—":(u.pct%1===0?u.pct:u.pct.toFixed(1))+"%";
    return `<div class="rel">
      <div class="rel-head"><span class="eyebrow">Reliability · 24h</span><span class="pct">${pct} <span class="n">${u.up}/${u.total}</span></span></div>
      <div class="rel-bars">${bars}</div>
      <div class="rel-axis"><span>24h ago</span><span>now</span></div></div>`;
  }

  function card(n){
    const checks=(HIST.nodes[n.id]||{}).checks||[];
    const pn=n.paynym
      ?`<a class="pn" href="${PAYNYM_WEB}/${esc(n.paynym)}" target="_blank" rel="noopener">${esc(n.paynym)}</a>`
      :`<span class="nopn">no PayNym</span>`;
    const jur=n.jurisdiction?`<span class="jur">${n.country?`<span class="flag">${flag(n.country)}</span>`:""}${esc(n.jurisdiction)}</span>`:"";
    // Card title: the node's short name alone ("yellow"). Names are unique
    // per network and the PayNym (linked) plus payment-code chip sit directly
    // beneath, so the composite "+paynym · name" title proved redundant.
    const title = n.name || n.paynym || n.id;
    return `<div class="card ${n.status}" data-id="${esc(n.id)}" data-pc="${esc(n.paymentCode||"")}">
      <div class="ctop">
        <span class="sd ${n.status}"></span>
        ${n.name_url
          ? `<a class="cname" href="${esc(n.name_url)}" target="_blank" rel="noopener" title="${esc(title)}">${esc(title)} <span class="ext">↗</span></a>`
          : `<span class="cname" title="${esc(title)}">${esc(title)}</span>`}
        <span class="cbadge ${n.status}">${n.status==="active"?"Active":"Inactive"}</span>
      </div>
      <div class="csub">${pn}${jur?'<span style="color:var(--faint)">·</span>'+jur:""}</div>
      ${n.paymentCode?`<button class="pcode mono" data-act="copycode" data-v="${esc(n.paymentCode)}" title="${esc(n.paymentCode)} — click to copy">${esc(n.paymentCode.slice(0,8))}…${esc(n.paymentCode.slice(-8))}</button>`:""}
      ${n.operator_domain?`<a class="vdomain" href="https://${esc(n.operator_domain)}" target="_blank" rel="noopener noreferrer" title="The operator proved control of ${esc(n.operator_domain)}: a TXT record on the domain names their payment code, and they signed a statement naming the domain. This proves control of the domain, not that the operator is trustworthy.">✓ ${esc(n.operator_domain)}</a>`:""}
      ${n.operator_domain_proof?`<button class="vproof" data-act="domproof" title="Check this claim yourself: the DNS lookup and the signature to verify">verify</button>`:""}
      ${relStrip(checks)}
      <div class="hist90" data-hist="${esc(n.id)}"><div class="eyebrow">Reliability · 90 days</div><div class="h90-body"><span class="loading">Loading…</span></div></div>
      <div class="meta">
        <div class="full"><div class="eyebrow">Hardware</div><div class="v">${esc(n.hardware||"—")}</div></div>
        <div><div class="eyebrow">Dojo version</div><div class="v">v${esc(n.version||"?")}</div></div>
        <div><div class="eyebrow">Block height</div><div class="v">${n.block_height!=null?Number(n.block_height).toLocaleString("en-GB"):"—"}</div></div>
        <div class="full"><div class="eyebrow">Last checked</div><div class="v">${esc((n.checked_at||"").replace("T"," ").replace("Z",""))}</div></div>
      </div>
      <div class="eps card-eps">
        ${epRow("Dojo API", n.payload.pairing && n.payload.pairing.url, "This node publishes no Dojo API endpoint")}
        ${epRow("Explorer", n.payload.explorer && n.payload.explorer.url, "This node publishes no block explorer")}
        ${epRow("Electrum Server", indexerUrl(n), "This node does not publish an Electrum endpoint, or runs a Dojo older than v1.27.0")}
      </div>
      <button class="reveal" data-act="pair">Pairing details</button>
    </div>`;
  }

  function pairHTML(n){
    const pairingOnly = JSON.stringify({pairing:n.payload.pairing, explorer:n.payload.explorer}, null, 2);
    const qr = qrSVG(JSON.stringify(n.payload), 208, "H");
    // NOT loading="lazy": this sits at the centre of a QR in a popup that has
    // just opened, so deferring the fetch costs a visible Tor round trip at
    // exactly the wrong moment. High priority and eager decoding instead; the
    // file is small, same-origin and cached for a day by nginx, and the card's
    // Pairing details button warms it on hover (see warmAvatar).
    const avatar = n.paymentCode
      ? `<img class="qr-avatar" alt="" fetchpriority="high" decoding="async" src="data/avatars/${encodeURIComponent(n.paymentCode)}.png" onerror="this.remove()">`
      : "";
    const signedBox = n.signed ? `
      <div class="box signed">
        <div class="lbl"><span class="t">Signed message</span><button class="copybtn" data-act="copysigned" data-id="${esc(n.id)}">Copy</button></div>
        <pre>${esc(n.signed)}</pre>
      </div>` : "";
    return `<div class="pair">
      <div class="qr"><div class="tile">${qr}${avatar}</div><span class="cap">Scan to pair</span></div>
      <div class="box">
        <div class="lbl"><span class="t">Pairing code</span><button class="copybtn" data-act="copypairing" data-id="${esc(n.id)}">Copy</button></div>
        <pre>${esc(pairingOnly)}</pre>
      </div>
      ${signedBox}
    </div>`;
  }

  // "For the machines among us": how to check a domain badge without trusting
  // this site. Both halves are independently checkable — the TXT record comes
  // from the operator's own DNS, and the signature verifies against the payment
  // code already shown on the card. Neither step involves this instance, and
  // neither puts paynym.rs on the request path.
  function domainProofHTML(n){
    const p = n.operator_domain_proof;
    if(!p) return "<p>No published proof for this node.</p>";
    const msg = (p.signed.match(/SIGNED MESSAGE-----\n([\s\S]*?)\n-----BEGIN BITCOIN SIGNATURE/)||["",""])[1];
    const addr = (p.signed.match(/Address:\s*(\S+)/)||["",""])[1];
    const sig = (p.signed.match(/\n([A-Za-z0-9+/=]{80,})\n*-----END BITCOIN SIGNATURE/)||["",""])[1];
    const blk = (label, body) =>
      `<div class="proofblk"><div class="k">${esc(label)}</div>`
      + `<pre class="mono">${esc(body)}</pre>`
      + `<button class="copybtn" data-act="copyurl" data-v="${esc(body)}">copy</button></div>`;
    return `<p class="dnote">The operator of this node claims <b>${esc(p.domain)}</b>. Two independent
        checks prove it, and you can run both yourself without trusting this directory.</p>
      <h3>1. The domain names the payment code</h3>
      <p class="dnote">Look up the TXT record from the operator's own DNS. It must contain the payment
        code shown on the card.</p>
      ${blk("with dig", "dig +short TXT " + p.txt_name)}
      ${blk("or over HTTPS, no dig required",
        "curl -sH 'accept: application/dns-json' \\\n  'https://cloudflare-dns.com/dns-query?name=" + p.txt_name + "&type=TXT'")}
      ${blk("expected to contain", p.txt_value)}
      <h3>2. The payment code names the domain</h3>
      <p class="dnote">The operator signed this text with the notification address of that payment code.
        Verify it with any Bitcoin message verifier, for example the
        <a href="https://paymentcode.io/lab" target="_blank" rel="noopener noreferrer">BIP47 lab</a>,
        or <span class="mono">bitcoin-cli verifymessage</span>.</p>
      ${blk("message", msg)}
      ${blk("signing address", addr)}
      ${blk("signature", sig)}
      ${blk("or verify the whole block at once", p.signed)}
      <p class="dnote">Both must hold. The TXT record alone shows only that whoever controls the domain
        published a code; the signature alone shows only that the code's owner mentioned the domain.
        Together they show the same party holds both. This proves control of a domain, not that the
        operator is trustworthy.${p.verified_at?" This instance last confirmed it on "+esc(p.verified_at.slice(0,10))+".":""}</p>`;
  }

  function openDomainProof(n){
    document.getElementById("ov-title").textContent = (n.operator_domain||"domain") + " · verify";
    document.getElementById("ov-body").innerHTML = domainProofHTML(n);
    document.getElementById("ov").classList.add("show");
  }

  // Pairing details open in the shared popup (the same surface as Verify)
  // rather than expanding beneath the card.
  function openPair(n){
    document.getElementById("ov-title").textContent = (n.name||n.id) + " · pairing";
    document.getElementById("ov-body").innerHTML = pairHTML(n);
    document.getElementById("ov").classList.add("show");
  }

  // Card ordering: 7-day uptime desc, then 24h uptime desc, then name. A node
  // with NO history ranks as 0.5% on the missing figure: below anything alive,
  // above a long-standing dead node sitting at 0%, so fresh listings gather
  // near the end without looking worse than known-dead ones.
  const NO_HISTORY_PCT = 0.5;
  function pct7(id){
    const days=(((DAILY||{}).nodes||{})[id]||{}).days||[];
    const last=days.slice(-7);
    if(!last.length) return null;
    return last.reduce((a,d)=>a+(Number(d.pct)||0),0)/last.length;
  }
  function pct24(id){
    const c=((HIST.nodes||{})[id]||{}).checks||[];
    if(!c.length) return null;
    return 100*c.filter(x=>x.up).length/c.length;
  }
  function byUptime(a,b){
    const a7=pct7(a.id)??NO_HISTORY_PCT, b7=pct7(b.id)??NO_HISTORY_PCT;
    if(a7!==b7) return b7-a7;
    const a24=pct24(a.id)??NO_HISTORY_PCT, b24=pct24(b.id)??NO_HISTORY_PCT;
    if(a24!==b24) return b24-a24;
    return String(a.name||a.id).localeCompare(String(b.name||b.id),"en",{sensitivity:"base"});
  }

  function render(){
    const list=DOJOS.nodes.filter(n=>n.network===net).sort(byUptime);
    const active=list.filter(n=>n.status==="active").length;
    const gen=(DOJOS.generated_at||"").replace("T"," ").slice(0,16)+" UTC";
    const FRESH=freshness(DOJOS);
    const dismissed=(()=>{try{return localStorage.getItem("db_banner")==="off"}catch(e){return false}})();

    document.getElementById("root").innerHTML = `
    ${dismissed?"":`<div class="banner"><div class="wrap">
      <span class="txt">Support Bill &amp; Keonne against the unjust prosecution of Samourai Wallet's developers.</span>
      <a href="https://billandkeonne.org/" target="_blank" rel="noopener">Learn more</a>
      <span class="sep">·</span>
      <a href="https://www.change.org/p/stand-up-for-freedom-pardon-the-innocent-coders-jailed-for-building-privacy-tools" target="_blank" rel="noopener">Sign the petition</a>
      <button class="close" data-act="dismiss" aria-label="Dismiss">✕</button>
    </div></div>`}

    <header><div class="wrap">
      <button class="burger" data-act="burger" aria-label="Menu" aria-expanded="${menuOpen}">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          ${menuOpen?'<path d="M6 6 L18 18 M18 6 L6 18"/>':'<path d="M4 7h16 M4 12h16 M4 17h16"/>'}
        </svg>
      </button>
      <a class="brand" href="./" aria-label="The Dojo Bay">${LOGO}
        <span><div class="name disp">THE DOJO BAY</div><div class="sub mono">public dojo directory</div></span></a>
      <nav class="${menuOpen?"open":""}">
        <button class="lnk" data-modal="about">About</button>
        <button class="lnk" data-modal="faq">FAQ</button>
        <button class="lnk" id="manage-link" data-act="manage"${BACKEND?"":" hidden"}>Manage my Dojo</button>
        <a class="onion-pill" href="data/dojos.json" download="dojos.json" title="Download the directory as JSON">JSON ↓</a>
      </nav>
    </div></header>

    <div class="wrap controls">
      <div class="seg">
        <button data-net="mainnet" class="${net==="mainnet"?"on":""}">mainnet</button>
        <button data-net="testnet" class="${net==="testnet"?"on":""}">testnet</button>
      </div>
      <div class="fresh${FRESH.stale?" stale":""}"><span class="dot"></span><b>${active}</b> of ${list.length} active
        <span class="sep">·</span> checked ${esc(gen)}
        <span class="sep">·</span> re-checks every ${FRESH.intervalMin} min</div>
    </div>

    <main class="wrap">
      ${FRESH.stale?`<div class="stale-banner" role="status">
        <b>These statuses are out of date.</b>
        This directory last refreshed ${esc(humanAge(FRESH.ageMin))} ago${FRESH.unknown?"":`, and should refresh every ${FRESH.intervalMin} minutes`}.
        The checker has probably stopped, so the badges below are greyed out: treat every node as unknown rather than up or down.
        (If your device's clock is wrong, this warning can appear on a healthy directory.)
      </div>`:""}
      <div class="grid${FRESH.stale?" stale":""}">${list.map(card).join("")}</div>
      <p class="note">The Dojo Bay is a federation of independent operators across different jurisdictions, and every node is reachable over Tor. Nodes go up and down without notice, and only the operator can restart one. Pairing exposes your XPUBs to that node, so do your own due diligence, or <a href="https://dojo-osp.org/install/requirements" target="_blank" rel="noopener">run your own Dojo</a>.</p>
    </main>

    <footer><div class="wrap">
      ${OPERATOR&&OPERATOR.paymentCode?`<img class="op-avatar" alt="" title="Directory operator's PayNym" src="data/avatars/${encodeURIComponent(OPERATOR.paymentCode)}.png" onerror="this.remove()">`:""}
      <button class="lnk verify-link" data-act="verify" title="Verify this directory's onion address is signed by its operator">Verify</button>
      <span class="foot-spacer"></span>
      <a class="gh" href="data/dojobay-src.zip" download="dojobay-src.zip" aria-label="Download this instance's source code (zip)" title="Download this instance's source code (zip)">${SRC_ICON}</a>
      <a class="gh" href="${REPO_URL}" target="_blank" rel="noopener" aria-label="Source code on GitHub" title="Source code on GitHub">${GH_LOGO}</a>
      <span class="ver">${VERSION?`<a href="${REPO_URL}/commit/${esc(VERSION.commit)}" target="_blank" rel="noopener" title="${esc(VERSION.built||"")}">build ${esc(VERSION.commit)}</a>`:""}</span>
    </div></footer>

    <div class="ov" id="ov"><div class="modal" role="dialog" aria-modal="true">
      <div class="modal-head"><h2 id="ov-title"></h2><button class="x" data-act="closemodal" aria-label="Close">✕</button></div>
      <div class="modal-body" id="ov-body"></div>
    </div></div>`;

    // 90-day strips: one lazily-cached fetch of history-daily.json fills every
    // card; re-renders re-hydrate from the same cached promise.
    document.querySelectorAll(".hist90[data-hist]").forEach(m=>renderHist90(m, m.getAttribute("data-hist")));
  }

  async function openModal(key){
    const m=MODAL_META[key]; if(!m) return;
    document.getElementById("ov-title").textContent=m.title;
    const body=document.getElementById("ov-body");
    document.getElementById("ov").classList.add("show");
    if(modalCache[key]==null){
      body.innerHTML='<p class="loading">Loading\u2026</p>';
      try{ modalCache[key]=markdown.render(await loadText(m.file)); }
      catch(e){ modalCache[key]='<p class="loading">Could not load content ('+e.message+').</p>'; }
    }
    body.innerHTML=modalCache[key];
  }
  function showLoadError(err){
    const local = location.protocol==="file:" || location.hostname==="localhost" || location.hostname==="127.0.0.1";
    if(local) return showServeHint(err);
    document.getElementById("root").innerHTML =
      '<div style="max-width:640px;margin:14vh auto;padding:0 22px">'
      + '<h1 class="disp" style="font-size:22px;margin-bottom:14px">Directory data unavailable</h1>'
      + '<p style="color:#a0a0a0;line-height:1.7">The node list could not be loaded. If this persists, the server\'s <code style="color:#e6a39b">data/dojos.json</code> is missing or unreadable.</p>'
      + '<p style="color:#6b6b6b;font-family:\'JetBrains Mono\',monospace;font-size:12px;margin-top:14px">'+esc(String(err && err.message || err))+'</p></div>';
  }
  function showServeHint(err){
    document.getElementById("root").innerHTML =
      '<div style="max-width:640px;margin:14vh auto;padding:0 22px">'
      + '<h1 class="disp" style="font-size:22px;margin-bottom:14px">Serve this over HTTP</h1>'
      + '<p style="color:#a0a0a0;line-height:1.7">The directory loads its data and text from separate files, which browsers block when the page is opened straight from disk. From the project folder run:</p>'
      + '<pre style="background:#070707;border:1px solid #2a2a2a;border-radius:8px;padding:13px;color:#e6a39b;font-family:\'JetBrains Mono\',monospace;font-size:13px;margin:12px 0">npm run dev</pre>'
      + '<p style="color:#a0a0a0;line-height:1.7">then open <a style="color:#b5302a" href="http://localhost:8080">http://localhost:8080</a>.</p>'
      + '<p style="color:#6b6b6b;font-family:\'JetBrains Mono\',monospace;font-size:12px;margin-top:14px">'+String(err && err.message || err)+'</p></div>';
  }
  function closeModal(){const o=document.getElementById("ov");if(o)o.classList.remove("show");}

  // Verify popup: shows the operator's BIP47-signed proof of this onion address,
  // as a scannable QR plus the copyable signed message. Source: data/operator.json.
  let OPERATOR = null;
  // Loaded at boot (state read by the footer template at render time); the
  // Verify popup reuses the same state and lazily loads it as a fallback.
  async function loadOperator(){
    try{ OPERATOR = await loadJSON("data/operator.json"); if(DOJOS) render(); }catch(e){ /* no operator.json: footer shows no avatar */ }
  }
  async function openVerify(){
    const titleEl=document.getElementById("ov-title"), body=document.getElementById("ov-body");
    if(!titleEl||!body) return;
    titleEl.textContent = "Verify this directory";
    document.getElementById("ov").classList.add("show");
    body.innerHTML = '<p class="loading">Loading…</p>';
    try{ if(!OPERATOR) OPERATOR = await loadJSON("data/operator.json"); }
    catch(e){ body.innerHTML='<p class="loading">Operator signature unavailable.</p>'; return; }
    const signed = OPERATOR.verifySigned || "";
    body.innerHTML =
      '<p style="font-size:13px;color:var(--muted)">This directory\u2019s operator has signed its onion address with their BIP47 payment code. '+
      'Scan or copy the signed message and verify it against the payment code to confirm you are on the genuine site and not a phishing clone.</p>'+
      '<div style="text-align:center;margin:16px 0"><div style="display:inline-block;background:#fff;border-radius:10px;padding:12px">'+qrSVG(signed,300)+'</div></div>'+
      '<div class="lbl"><span class="t">Signed message</span><button class="copybtn" data-act="copyverify">Copy</button></div>'+
      '<pre class="verify-pre">'+esc(signed)+'</pre>';
  }

  // Warm the PayNym avatar as soon as the operator shows intent to open a
  // card's pairing popup, so the image is already in cache by the time the QR
  // renders. Fetching every card's avatar up front would mean one Tor request
  // per listed node on page load, which is far worse than one on hover.
  const warmed = new Set();
  function warmAvatar(card){
    const code = card && card.getAttribute("data-pc");
    if(!code || warmed.has(code)) return;
    warmed.add(code);
    const img = new Image();
    img.src = "data/avatars/" + encodeURIComponent(code) + ".png";
  }
  for(const evt of ["pointerenter","focusin"]){
    document.addEventListener(evt, e=>{
      const t = e.target instanceof Element ? evEl(e)?.closest('[data-act="pair"]') : null;
      if(t) warmAvatar(t.closest(".card"));
    }, true);
  }

  document.addEventListener("click", e=>{
    const netBtn=evEl(e)?.closest("[data-net]");
    if(netBtn){net=netBtn.getAttribute("data-net");render();return;}
    const mBtn=evEl(e)?.closest("[data-modal]");
    if(mBtn){ if(menuOpen){menuOpen=false;render();} openModal(mBtn.getAttribute("data-modal"));return;}
    const act=evEl(e)?.closest("[data-act]");
    if(!act){ if(evEl(e)?.id==="ov") closeModal(); return; }
    const a=act.getAttribute("data-act");
    if(a==="burger"){menuOpen=!menuOpen;render();return;}
    if(a==="dismiss"){try{localStorage.setItem("db_banner","off")}catch(e){}render();return;}
    if(a==="closemodal"){closeModal();return;}
    if(a==="verify"){ openVerify(); return; }
    if(a==="copyverify"){ if(OPERATOR) copy(OPERATOR.verifySigned).then(()=>flash(act,"Copied ✓")); return; }
    if(a==="copycode"){ copy(act.getAttribute("data-v")).then(()=>flash(act,"Copied ✓")); return; }
    // node resolution that works from a card OR from inside the popup
    const byIdAttr=()=>DOJOS.nodes.find(x=>x.id===act.getAttribute("data-id"));
    if(a==="copypairing"){const n=byIdAttr();copy(JSON.stringify({pairing:n.payload.pairing,explorer:n.payload.explorer},null,2)).then(()=>flash(act,"Copied ✓"));return;}
    if(a==="copysigned"){copy(byIdAttr().signed).then(()=>flash(act,"Copied ✓"));return;}
    const cardEl=evEl(e)?.closest(".card");
    const node=()=>DOJOS.nodes.find(x=>x.id===cardEl.getAttribute("data-id"));
    if(a==="pair"){ openPair(node()); return; }
    if(a==="domproof"){ openDomainProof(node()); return; }
    if(a==="copyurl"){copy(act.getAttribute("data-v")).then(()=>flash(act,"✓"));return;}
  });
  document.addEventListener("keydown", e=>{ if(e.key==="Escape") closeModal(); });

  /* ================= Manage my Dojo (self-service, step 2) =================
     Everything below is inert unless a backend answers /api/me. On the static
     step-1 onion there is no API, so the nav button stays hidden and nothing
     here runs. */
  // e.target is typed EventTarget, which has no DOM methods; every listener here
  // is on a rendered element. One helper narrows it, rather than casting at each
  // call site.
  /** @param {Event} e @returns {Element|null} */
  const evEl = (e) => (e.target instanceof Element ? e.target : null);

  const api = {
    async call(path, method="GET", body){
      const r = await fetch("/api"+path, {method, headers: body?{"Content-Type":"application/json"}:{}, body: body?JSON.stringify(body):undefined, credentials:"same-origin", cache:"no-store"});
      let j=null; try{ j=await r.json(); }catch(e){}
      return {status:r.status, body:j};
    }
  };
  let ME = null;
  let BACKEND = false;
  async function detectBackend(){
    try{
      const r = await api.call("/me");
      if(r.status===200 && r.body){
        ME = r.body;
        BACKEND = true;
        // render() rebuilds the header, so drive visibility from state and
        // re-render if the page is already up, rather than poking the DOM once.
        if(DOJOS) render();
        else { const el=document.getElementById("manage-link"); if(el) el.hidden=false; }
      }
    }catch(e){ /* no backend: stay hidden */ }
  }

  async function openManage(){
    document.getElementById("ov-title").textContent = "Manage my Dojo";
    document.getElementById("ov").classList.add("show");
    // One Auth47 session covers both this panel and /admin (same cookie), so
    // re-read /api/me before rendering: a sign-in or sign-out that happened on
    // the admin page (or another tab) is picked up here instead of asking the
    // operator to authenticate twice.
    const body = document.getElementById("ov-body");
    if(body) body.innerHTML = '<p class="loading">Checking session…</p>';
    await refreshMe();
    renderManage();
  }
  async function refreshMe(){ const r=await api.call("/me"); if(r.status===200) ME=r.body; }

  // ---- verified domain -----------------------------------------------------
  // One domain per operator, proven in both directions: a TXT record on the
  // domain names the payment code, and the operator signs a statement naming the
  // domain. DOMAIN holds what the server reported; DOMAIN_PREP holds the exact
  // record and text for a domain being set up, both fetched from the server so
  // the instructions can never drift from what verification checks.
  let DOMAIN = null, DOMAIN_PREP = null, DOMAIN_MSG = "";

  async function refreshDomain(){
    const r = await api.call("/domain","GET");
    // Settle to an object either way, so a failed or unsupported lookup does not
    // make every subsequent render re-request it.
    DOMAIN = r.status===200 && r.body ? r.body : { claim:null, unavailable:true };
  }

  function domainSection(){
    const c = DOMAIN && DOMAIN.claim;
    const msg = DOMAIN_MSG ? `<p class="dmsg">${esc(DOMAIN_MSG)}</p>` : "";
    if(c && !c.verified){
      return `<div class="dbox">
        <p>Saved for <b>${esc(c.domain)}</b> — waiting for the TXT record.</p>
        <p class="dnote">Your signature is verified and stored, so you do not need to sign again.
          We re-check DNS automatically every few minutes${c.last_check?`; last looked ${esc(c.last_check.slice(0,16).replace("T"," "))} UTC`:""}.
          ${c.last_result?`<br>Last result: <span class="dwrap">${esc(c.last_result)}</span>`:""}</p>
        <div class="medit-actions">
          <button class="copybtn" data-mact="domrecheck">Check now</button>
          <button class="copybtn" data-mact="domchange">Change domain</button>
          <button class="copybtn" data-mact="domremove">Remove</button>
        </div>${msg}</div>`;
    }
    if(c && c.verified){
      return `<div class="dbox">
        <p>Verified: <a href="https://${esc(c.domain)}" target="_blank" rel="noopener noreferrer">${esc(c.domain)}</a>
          <span class="ok-tick">✓</span></p>
        <p class="dnote">Shown on your cards, and your card link may point anywhere on this domain.
          ${c.failing_since?`<b>The TXT record is currently missing</b> (since ${esc(c.failing_since.slice(0,10))}); the badge is removed if it stays missing for ${esc(String(c.grace_days))} days.`:""}
          ${c.last_check?`Last checked ${esc(c.last_check.slice(0,10))}.`:""}</p>
        <div class="medit-actions">
          <button class="copybtn" data-mact="domchange">Change domain</button>
          <button class="copybtn" data-mact="domremove">Remove</button>
        </div>${msg}</div>`;
    }
    if(DOMAIN_PREP){
      return `<div class="dbox">
        <p>Two steps for <b>${esc(DOMAIN_PREP.domain)}</b>${DOMAIN_PREP.punycode?' <span class="dnote">(shown in punycode)</span>':""}:</p>
        <p class="dnote">1. Publish this TXT record on your domain:</p>
        <div class="ep"><span class="k">Host</span><span class="u mono">${esc(DOMAIN_PREP.txt_host||"_dojobay")}</span><button class="copybtn" data-act="copyurl" data-v="${esc(DOMAIN_PREP.txt_host||"_dojobay")}">copy</button></div>
        <div class="ep"><span class="k">Value</span><span class="u mono">${esc(DOMAIN_PREP.txt_value)}</span><button class="copybtn" data-act="copyurl" data-v="${esc(DOMAIN_PREP.txt_value)}">copy</button></div>
        <p class="dnote">Most control panels (Namecheap, Cloudflare, Route 53) treat Host as relative to
          your domain, so enter <b>${esc(DOMAIN_PREP.txt_host||"_dojobay")}</b> exactly. Entering the full
          <span class="mono">${esc(DOMAIN_PREP.txt_name)}</span> there creates
          <span class="mono">${esc(DOMAIN_PREP.txt_name)}.${esc(DOMAIN_PREP.domain)}</span> instead, which
          will not be found. A few panels do want the full name; use it only if yours asks for an FQDN.
          Existing records for a website are unaffected: this is a separate TXT record.</p>
        <p class="dnote">2. Sign this EXACT text in your wallet under <b>PayNym → Sign message</b>, then paste the whole signed block below:</p>
        <pre class="dsign mono">${esc(DOMAIN_PREP.sign_text)}</pre>
        <button class="copybtn" data-act="copyurl" data-v="${esc(DOMAIN_PREP.sign_text)}">copy the text to sign</button>
        <label>Signed block <textarea class="d-signed" rows="7" placeholder="-----BEGIN BITCOIN SIGNED MESSAGE-----"></textarea></label>
        <div class="medit-actions">
          <button class="copybtn" data-mact="domverify">Verify</button>
          <button class="copybtn" data-mact="domcancel">Cancel</button>
        </div>${msg}</div>`;
    }
    return `<div class="dbox">
      <p class="dnote">Optional. Prove you control a domain and your cards show it, and your card
        title can link to it. Verification is by DNS TXT record plus a wallet signature; nothing
        is published until both check out. This proves control of a domain, not that you are
        trustworthy, and a maintainer can revoke a badge.</p>
      <label>Domain <input class="d-domain" maxlength="253" placeholder="example.com"></label>
      <div class="medit-actions"><button class="copybtn" data-mact="domprep">Continue</button></div>${msg}</div>`;
  }

  async function renderManage(){
    const body = document.getElementById("ov-body");
    if(!ME || !ME.authenticated){ return renderLogin(body); }
    if(DOMAIN===null){ await refreshDomain(); }
    // The API already returns mainnet-then-testnet, alphabetical by name;
    // sort again here so the panel never depends on response ordering.
    const subs = (ME.submissions||[]).slice().sort((a,b)=>
      a.network!==b.network ? (a.network==="mainnet"?-1:1)
      : String(a.name||a.id).localeCompare(String(b.name||b.id),"en",{sensitivity:"base"}));
    body.innerHTML = `
      <p style="margin-bottom:6px">Signed in as <code>${esc(ME.paymentCode.slice(0,12))}…${esc(ME.paymentCode.slice(-4))}</code>
        <button class="copybtn" data-mact="logout" style="margin-left:8px">Sign out</button></p>
      ${ME.admin?'<p style="font-size:12.5px;color:var(--muted)">This payment code moderates the directory: <a href="/admin" style="color:var(--accent)">open the admin console →</a> (same sign-in; signing out here signs you out there too).</p>':""}
      <p style="font-size:13px;color:var(--muted)">Add or edit a Dojo you operate. Submissions are checked for a live Tor connection and, if you supply a signed payload, for a valid signature, then reviewed by a maintainer before they appear.</p>
      <h3>Verified domain</h3>
      ${domainSection()}
      <h3>Your Dojos</h3>
      ${subs.length? subs.map(manageRow).join("") : '<p style="color:var(--faint)">None yet.</p>'}
      <h3>Add / replace a Dojo</h3>
      ${dojoForm()}
      <div id="manage-msg" style="margin-top:12px"></div>`;
  }
  function statusPill(s){
    const c = s==="approved"?"active":(s==="rejected"?"inactive":"");
    const label = s==="approved"?"Approved":(s==="rejected"?"Rejected":"Pending review");
    return `<span class="cbadge ${c}" style="background:${s==="pending"?"var(--panel2)":""}">${label}</span>`;
  }
  // Inline editing of display fields (name, hardware, Dojo version). One row
  // at a time: EDIT_ID holds the open row; other Edit buttons disable while
  // it is set. Renaming keeps the record id (and history); uniqueness is
  // enforced per network by the API (409).
  let EDIT_ID = null;
  function editForm(r, actPrefix){
    const ver = r.version || (r.payload && r.payload.pairing && r.payload.pairing.version) || "";
    return `<div class="medit">
      <label>Name <input class="e-name" maxlength="40" value="${esc(r.name||"")}"></label>
      <label>Hardware <input class="e-hw" maxlength="120" value="${esc(r.hardware||"")}"></label>
      <div class="e-ver-note" style="font-size:12px;color:var(--muted)">Dojo version is read live from the node (${esc(ver?("v"+ver):"detected on next probe")}) and can't be edited here.</div>
      <label>Link (optional; the card title links here) <input class="e-url" maxlength="200" value="${esc(r.name_url||"")}" placeholder="https://…"></label>
      <div class="medit-actions">
        <button class="copybtn" data-${actPrefix}="editsave" data-id="${esc(r.id)}">Save</button>
        <button class="copybtn" data-${actPrefix}="editcancel">Cancel</button>
        <span class="edit-msg" style="font-size:12px;color:var(--down)"></span>
      </div>
    </div>`;
  }
  function manageRow(r){
    const editing = EDIT_ID === r.id;
    return `<div class="box" style="padding:12px 14px;background:var(--panel2)">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
        <span class="mono" style="font-size:12.5px"><b>${esc(r.name||r.id)}</b> · ${esc(r.network)} · ${esc(r.jurisdiction||"—")} · ${esc(r.hardware||"—")}</span>
        <span style="display:flex;gap:8px;align-items:center">
          <button class="copybtn" data-mact="edit" data-id="${esc(r.id)}"${EDIT_ID&&!editing?" disabled":""}>${editing?"Editing…":"Edit"}</button>
          ${statusPill(r.status)}
        </span>
      </div>
      ${editing?editForm(r,"mact"):""}
      <div class="mono" style="font-size:11px;color:var(--muted);margin-top:6px;word-break:break-all">${esc(r.payload?.pairing?.url||"")}</div>
      <button class="copybtn" data-mact="delete" data-id="${esc(r.id)}" style="margin-top:8px">Delete</button>
    </div>`;
  }
  function dojoForm(){
    return `<div class="box" style="background:var(--panel2);padding:14px">
      <div class="mform">
        <label>Network
          <select id="m-net"><option value="mainnet">mainnet</option><option value="testnet">testnet</option></select></label>
        <label>Node name (unique per network; shown on the card next to your PayNym) <input id="m-name" maxlength="40" placeholder="e.g. yellow"></label>
        <label>Jurisdiction <input id="m-jur" maxlength="64" placeholder="e.g. Europe, Canada"></label>
        <label>Country code (optional, 2 letters for a flag) <input id="m-cc" maxlength="2" placeholder="FI"></label>
        <label>Hardware <input id="m-hw" maxlength="120" placeholder="e.g. N100 16GB"></label>
        <label>Link (optional; the card title links here) <input id="m-url" maxlength="200" placeholder="https://…"></label>
        <label>Pairing code (JSON) <textarea id="m-payload" rows="6" placeholder='{"pairing":{"type":"dojo.api",...},"explorer":{...}}'></textarea></label>
        <label>Signed pairing message (optional, but verified if provided) <textarea id="m-signed" rows="5" placeholder="-----BEGIN BITCOIN SIGNED MESSAGE-----&#10;...&#10;-----END BITCOIN SIGNATURE-----"></textarea></label>
        <button class="reveal" data-mact="submit" style="margin-top:4px">Check connection &amp; submit</button>
      </div>
    </div>`;
  }

  function renderLogin(body){
    body.innerHTML = `
      <p>Sign in with your Dojo's <strong>PayNym</strong> using Auth47 to manage its listing. Scan this with <a href="https://web.archive.org/web/20240424023506/https://samouraiwallet.com/" target="_blank" rel="noopener">Samourai</a> or <a href="http://ashigaruprvm4u263aoj6wxnipc4jrhb2avjll4nnk255jkdmj2obqqd.onion/" target="_blank" rel="noopener">Ashigaru</a> (Settings → Pair wallet → Auth47), or tap to open.</p>
      <div id="auth47-box" style="text-align:center;margin:18px 0"><p class="loading">Requesting challenge…</p></div>
      <p style="font-size:12.5px;color:var(--faint)">Auth47 proves you control the payment code without revealing any key. Nothing is stored beyond your payment code and the Dojo details you submit.</p>`;
    startAuth47();
  }
  let pollTimer=null;
  let onAuthSuccess=null;
  async function startAuth47(){
    clearInterval(pollTimer);
    const boxEl = () => document.getElementById("auth47-box");
    const r = await api.call("/auth47/challenge","POST",{});
    if(r.status!==200){ if(boxEl()) boxEl().innerHTML='<p class="loading">Login unavailable.</p>'; return; }
    const {uri,nonce} = r.body;
    if(boxEl()) boxEl().innerHTML =
      `<a href="${esc(uri)}"><div class="tile" style="display:inline-block;background:#fff;border-radius:10px;padding:12px">${qrSVG(uri,200)}</div></a>
       <div class="mono" style="font-size:10.5px;color:var(--faint);margin-top:8px;word-break:break-all">${esc(uri)}</div>`;
    pollTimer = setInterval(async ()=>{
      const p = await api.call("/auth47/poll?nonce="+encodeURIComponent(nonce));
      if(p.status===200 && p.body && p.body.authenticated){ clearInterval(pollTimer); await refreshMe(); (onAuthSuccess||renderManage)(); }
    }, 2500);
  }

  document.addEventListener("click", async e=>{
    const manageBtn = evEl(e)?.closest('[data-act="manage"]');
    if(manageBtn){ if(menuOpen){menuOpen=false;render();} openManage(); return; }
    const m = evEl(e)?.closest("[data-mact]");
    if(!m) return;
    const act = m.getAttribute("data-mact");
    const msg = document.getElementById("manage-msg");
    if(act==="logout"){ await api.call("/logout","POST",{}); clearInterval(pollTimer); await refreshMe(); ME={authenticated:false}; EDIT_ID=null; DOMAIN=null; DOMAIN_PREP=null; renderManage(); return; }

    // ---- verified domain ----
    if(act==="domprep"){
      const v=/** @type {HTMLInputElement} */ (document.querySelector(".d-domain") || {}).value||"";
      DOMAIN_MSG=""; const r=await api.call("/domain/prepare","POST",{domain:v});
      if(r.status!==200){ DOMAIN_MSG=(r.body&&r.body.error)||("HTTP "+r.status); }
      else DOMAIN_PREP=r.body;
      renderManage(); return;
    }
    if(act==="domrecheck"){
      const claim=DOMAIN&&DOMAIN.claim; if(!claim) return;
      /** @type {HTMLButtonElement} */ (m).disabled=true; m.textContent="Checking DNS…";
      const r=await api.call("/domain/recheck","POST",{});
      DOMAIN_MSG = r.status===200 ? "Verified."
        : ((r.body&&(r.body.error||r.body.note))||("HTTP "+r.status));
      await refreshDomain(); renderManage(); return;
    }
    if(act==="domcancel"){ DOMAIN_PREP=null; DOMAIN_MSG=""; renderManage(); return; }
    if(act==="domchange"){ DOMAIN_PREP=null; DOMAIN_MSG=""; DOMAIN={claim:null}; renderManage(); return; }
    if(act==="domremove"){
      await api.call("/domain","DELETE",{}); DOMAIN_PREP=null; DOMAIN_MSG="Removed.";
      await refreshDomain(); await refreshMe(); renderManage(); return;
    }
    if(act==="domverify"){
      const ta=document.querySelector(".d-signed");
      /** @type {HTMLButtonElement} */ (m).disabled=true; m.textContent="Checking DNS…"; DOMAIN_MSG="";
      const r=await api.call("/domain","POST",{domain:DOMAIN_PREP.domain,signed:(ta&&/** @type {HTMLTextAreaElement} */ (ta).value)||""});
      if(r.status===200){ DOMAIN_PREP=null; DOMAIN_MSG="Verified."; await refreshDomain(); }
      else if(r.status===202){ DOMAIN_PREP=null; DOMAIN_MSG=(r.body&&r.body.note)||"Saved; waiting for DNS."; await refreshDomain(); }
      else {
        // 503 means we could not reach enough resolvers: not the operator's fault.
        DOMAIN_MSG=((r.body&&r.body.error)||("HTTP "+r.status))
          + (r.body&&r.body.hint?"  "+r.body.hint:"")
          + (r.status===503?"  This is a lookup problem at our end, not a problem with your record. Try again shortly.":"");
      }
      renderManage(); return;
    }
    if(act==="delete"){ await api.call("/dojo/delete","POST",{id:m.getAttribute("data-id")}); await refreshMe(); EDIT_ID=null; renderManage(); return; }
    if(act==="edit"){ EDIT_ID=m.getAttribute("data-id"); renderManage(); return; }
    if(act==="editcancel"){ EDIT_ID=null; renderManage(); return; }
    if(act==="editsave"){
      const box=m.closest(".medit");
      const r=await api.call("/dojo/edit","POST",{
        id:m.getAttribute("data-id"),
        name:/** @type {HTMLInputElement} */ (box.querySelector(".e-name")).value,
        hardware:/** @type {HTMLInputElement} */ (box.querySelector(".e-hw")).value,
        name_url:/** @type {HTMLInputElement} */ (box.querySelector(".e-url")).value,
      });
      if(r.status!==200){ const em=box.querySelector(".edit-msg"); if(em) em.textContent=(r.body&&r.body.error)||("HTTP "+r.status); return; }
      EDIT_ID=null; await refreshMe(); renderManage(); return;
    }
    if(act==="submit"){
      let payload;
      try{ payload = JSON.parse(/** @type {HTMLInputElement} */ (document.getElementById("m-payload")).value); }
      catch(err){ if(msg) msg.innerHTML='<span style="color:var(--down)">Pairing code is not valid JSON.</span>'; return; }
      // Validate the name (required + unique across approved and pending
      // records) BEFORE the slow Tor connection gate, so a taken name fails in
      // milliseconds. The POST re-checks server-side and answers 409 anyway.
      const name = /** @type {HTMLInputElement} */ (document.getElementById("m-name")).value.trim();
      if(!name){ if(msg) msg.innerHTML='<span style="color:var(--down)">Give your node a name first.</span>'; return; }
      const nc = await api.call("/dojo/name-check?network="+encodeURIComponent(/** @type {HTMLInputElement} */ (document.getElementById("m-net")).value)+"&name="+encodeURIComponent(name));
      if(nc.status!==200 || !nc.body || !nc.body.available){
        if(msg) msg.innerHTML='<span style="color:var(--down)">'+esc((nc.body&&(nc.body.reason||nc.body.error))||"That name is not available.")+'</span>'; return;
      }
      if(msg) msg.innerHTML='<span class="loading">Checking Tor connection… this can take up to 30s.</span>';
      const r = await api.call("/dojo","POST",{
        network: /** @type {HTMLInputElement} */ (document.getElementById("m-net")).value,
        name,
        jurisdiction: /** @type {HTMLInputElement} */ (document.getElementById("m-jur")).value,
        country: /** @type {HTMLInputElement} */ (document.getElementById("m-cc")).value,
        hardware: /** @type {HTMLInputElement} */ (document.getElementById("m-hw")).value,
        name_url: /** @type {HTMLInputElement} */ (document.getElementById("m-url")).value,
        payload,
        signed: /** @type {HTMLInputElement} */ (document.getElementById("m-signed")).value.trim() || null,
      });
      if(r.status===200){ if(msg) msg.innerHTML='<span style="color:var(--up)">'+esc(r.body.note||"Submitted.")+'</span>'; await refreshMe(); setTimeout(renderManage,1200); }
      else { if(msg) msg.innerHTML='<span style="color:var(--down)">'+esc((r.body&&r.body.error)||("Error "+r.status))+'</span>'; }
      return;
    }
  });

  detectBackend();


  // Build hash. render() rebuilds the whole footer, so (exactly like the
  // Manage button) the hash must live in state the template reads at render
  // time; a one-shot DOM injection vanished on the first re-render.
  let VERSION = null;
  async function loadVersion(){
    try{
      const v = await loadJSON("data/version.json");
      if(v && v.commit && v.commit !== "dev"){ VERSION = v; if(DOJOS) render(); }
    }catch(e){ /* no version file: show nothing */ }
  }

  // ================= Admin console (/admin) =================================
  // Reuses the Auth47 login flow. A session whose payment code is in the
  // backend's ADMIN_PAYMENT_CODES sees a moderation panel; others are refused.
  function adminShell(inner){
    document.getElementById("root").innerHTML = `
    <header><div class="wrap">
      <a class="brand" href="./" aria-label="The Dojo Bay">${LOGO}
        <span><div class="name disp">THE DOJO BAY</div><div class="sub mono">operator console</div></span></a>
      <nav><a class="lnk" href="./">\u2190 Directory</a></nav>
    </div></header>
    <main class="wrap"><h2 class="disp" style="margin:18px 0 14px">Moderation</h2>${inner}</main>`;
  }
  let ADM_EDIT_ID = null;
  function adminRow(s){
    const editing = ADM_EDIT_ID === s.id;
    const pr=s.probe;
    const strip = (pr && pr.checks && pr.checks.length) ? relStrip(pr.checks)
      : '<p style="font-size:12px;color:var(--faint);margin:6px 0">No probe data yet (the updater runs every 10 minutes).</p>';
    const height = (pr && pr.block_height!=null) ? Number(pr.block_height).toLocaleString("en-GB") : "\u2014";
    const st = pr ? pr.status : "not yet probed";
    return `<div class="admin-row" data-id="${esc(s.id)}">
      <div class="admin-head"><b>${esc(s.paynym&&s.name?s.paynym+" · "+s.name:(s.paynym||s.name||s.id))}</b> <span class="abadge ${esc(s.status)}">${esc(s.status)}</span>
        <span class="mono" style="font-size:11px;color:var(--faint)">${esc(s.network)}</span></div>
      <div class="mono" style="font-size:11px;word-break:break-all;color:var(--muted);margin:2px 0">${esc(s.pairingUrl||"")}</div>
      <div style="font-size:12px;color:var(--muted);margin:4px 0">live probe: <b>${esc(st)}</b> \u00b7 block ${height} \u00b7 ${s.signed?"signed \u2713":"no signature"} \u00b7 v${esc(s.version||"?")}${s.hardware?" \u00b7 "+esc(s.hardware):""}</div>
      ${strip}
      <div class="admin-actions">
        ${s.status!=="approved"?`<button class="abtn ok" data-adm="approve" data-id="${esc(s.id)}">Approve</button>`:""}
        ${s.status!=="rejected"?`<button class="abtn" data-adm="reject" data-id="${esc(s.id)}">Reject</button>`:""}
        <button class="abtn" data-adm="edit" data-id="${esc(s.id)}"${ADM_EDIT_ID&&!editing?" disabled":""}>${editing?"Editing…":"Edit"}</button>
        <button class="abtn danger" data-adm="remove" data-id="${esc(s.id)}">Remove</button>
      </div>
      ${editing?editForm(s,"adm"):""}</div>`;
  }
  async function renderAdminPanel(){
    if(!ME || !ME.authenticated){
      adminShell('<p style="font-size:13px;color:var(--muted)">Sign in with your operator PayNym via Auth47 (<a href="https://web.archive.org/web/20240424023506/https://samouraiwallet.com/" target="_blank" rel="noopener">Samourai</a> or <a href="http://ashigaruprvm4u263aoj6wxnipc4jrhb2avjll4nnk255jkdmj2obqqd.onion/" target="_blank" rel="noopener">Ashigaru</a> \u2192 Settings \u2192 Pair wallet \u2192 Auth47).</p><div id="auth47-box" style="text-align:center;margin:18px 0"><p class="loading">Requesting challenge\u2026</p></div>');
      onAuthSuccess = renderAdminPanel; startAuth47(); return;
    }
    if(!ME.admin){
      adminShell('<p>The payment code <code>'+esc(ME.paymentCode.slice(0,12))+'\u2026</code> is not an administrator of this directory.</p><p style="margin-top:10px"><button class="abtn" data-adm="logout">Sign out</button></p>');
      return;
    }
    if(!ADMIN_UPDATES && !ADMIN_UPDATES_LOADING){
      ADMIN_UPDATES_LOADING = true;
      api.call("/admin/updates").then(r=>{ ADMIN_UPDATES = r.body || {available:false,error:"HTTP "+r.status}; renderAdminPanel(); }).catch(()=>{ ADMIN_UPDATES={available:false,error:"request failed"}; renderAdminPanel(); });
    }
    adminShell('<p class="loading">Loading submissions\u2026</p>');
    const r = await api.call("/admin/submissions");
    if(r.status===401){ ME={authenticated:false}; renderAdminPanel(); return; }   // signed out elsewhere (Manage panel / another tab)
    if(r.status!==200){ adminShell('<p>Could not load submissions ('+r.status+').</p>'); return; }
    const subs=r.body.submissions||[];
    const pending=subs.filter(s=>s.status==="pending");
    const others=subs.filter(s=>s.status!=="pending");
    adminShell(
      '<p style="font-size:13px;color:var(--muted)">Signed in as <code>'+esc(ME.paymentCode.slice(0,12))+'\u2026'+esc(ME.paymentCode.slice(-4))+'</code> '+
      '<button class="abtn" data-adm="logout" style="margin-left:8px">Sign out</button> '+
      '<span style="font-size:12px;color:var(--faint)">(the same Auth47 session as Manage my Dojo; signing out here signs you out there too)</span></p>'+
      updatesLine()+
      (ADMIN_NOTICE?'<p style="font-size:12.5px;color:var(--down);border:1px solid var(--down);border-radius:8px;padding:8px 12px">'+esc(ADMIN_NOTICE)+'</p>':"")+
      '<h3 style="margin:16px 0 8px">Pending review ('+pending.length+')</h3>'+
      (pending.length? pending.map(adminRow).join("") : '<p style="color:var(--faint)">Nothing awaiting review.</p>')+
      '<h3 style="margin:22px 0 8px">Approved / rejected ('+others.length+')</h3>'+
      (others.length? others.map(adminRow).join("") : '<p style="color:var(--faint)">None.</p>')
    );
  }
  let ADMIN_NOTICE = null;
  let ADMIN_UPDATES = null, ADMIN_UPDATES_LOADING = false;
  let UPDATE_RUN = null;   // {phase, log[], done, ok, error, needsRefresh}
  let UPDATE_POLL = null;
  const UPDATE_PHASES = ["starting","fetching","applying","restarting"];
  function updatesLine(){
    if(UPDATE_RUN) return updateProgress();
    if(!ADMIN_UPDATES) return ADMIN_UPDATES_LOADING ? '<p style="font-size:12px;color:var(--faint)">Checking for updates…</p>' : "";
    const u = ADMIN_UPDATES;
    if(!u.available) return '<p style="font-size:12px;color:var(--faint)">Update check unavailable: '+esc(u.error||"unknown")+'</p>';
    const behind = u.commits_behind>0
      ? '<b style="color:var(--warn,#e0a020)">'+u.commits_behind+' commit'+(u.commits_behind===1?"":"s")+' behind main</b>'
      : 'up to date with main';
    // current_release is set when the running commit IS a released tag, so we can
    // say which release this is rather than guessing from timestamps. When it is
    // not set the count is a timestamp approximation, and says so.
    const rel = u.latest_release
      ? (u.releases_behind>0
          ? ' · <b>'+u.releases_behind+' release'+(u.releases_behind===1?"":"s")+' behind</b>'
            +(u.releases_behind_approx?' (approximate; latest ':' (latest ')+esc(u.latest_release)+')'
          : (u.current_release
              ? ' · running release <b>'+esc(u.current_release)+'</b>'
              : ' · latest release '+esc(u.latest_release)))
      : "";
    const behindAny = u.commits_behind>0 || u.releases_behind>0;
    const controls = '<div class="upd-controls">'
      + '<button class="abtn ok" data-adm="update-github">Update from GitHub</button>'
      + '<button class="abtn" data-adm="update-peer">Update from a peer .onion…</button>'
      + '</div>';
    return '<div class="upd-line"><p style="font-size:12px;color:var(--muted)">Codebase <code>'+esc(u.commit)+'</code> — '+behind+rel+'</p>'
      + (behindAny? controls : '<div class="upd-controls">'+controls+'<span style="font-size:11px;color:var(--faint)">(you can still reinstall the current code)</span></div>')
      + '</div>';
  }
  function updateProgress(){
    const j = UPDATE_RUN;
    const idx = Math.max(0, UPDATE_PHASES.indexOf(j.phase));
    const pct = j.done ? 100 : Math.round(((idx+0.5)/UPDATE_PHASES.length)*100);
    const barColor = j.error ? 'var(--down)' : (j.done? 'var(--up)' : 'var(--accent)');
    const tail = (j.log||[]).slice(-6).map(l=>esc(l)).join('<br>');
    let head;
    if(j.error) head = '<b style="color:var(--down)">Update failed:</b> '+esc(j.error);
    else if(j.done && j.needsRefresh) head = '<b style="color:var(--up)">Update applied.</b> Waiting for the service to come back, then reloading…';
    else head = '<b>Updating from '+esc(j.sourceLabel||j.source||"source")+'…</b> '+esc(j.phase);
    return '<div class="upd-line">'
      + '<p style="font-size:12.5px">'+head+'</p>'
      + '<div class="upd-bar"><div class="upd-bar-fill" style="width:'+pct+'%;background:'+barColor+'"></div></div>'
      + '<pre class="upd-log">'+tail+'</pre>'
      + (j.error? '<button class="abtn" data-adm="update-dismiss">Dismiss</button>':'')
      + '</div>';
  }
  async function startUpdate(source, extra){
    UPDATE_RUN = /** @type {{ phase: string, log: string[], done: boolean, source: any, error?: string }} */
      ({ phase:"starting", log:["requesting update…"], done:false, source });
    renderAdminPanel();
    const r = await api.call("/admin/update","POST",{ source, ...(extra||{}) });
    if(r.status===409){ UPDATE_RUN=null; ADMIN_NOTICE="An update is already in progress."; renderAdminPanel(); return; }
    if(r.status!==202){ UPDATE_RUN.error=(r.body&&r.body.error)||("HTTP "+r.status); UPDATE_RUN.done=true; renderAdminPanel(); return; }
    pollUpdate();
  }
  function pollUpdate(){
    clearInterval(UPDATE_POLL);
    let restartWaits = 0;
    UPDATE_POLL = setInterval(async ()=>{
      let r;
      try{ r = await api.call("/admin/update/status"); }
      catch(e){ r = null; }
      // Once the service restarts, /api calls fail transiently; treat a run
      // that reached needsRefresh as success and hard-reload when it returns.
      if(UPDATE_RUN && UPDATE_RUN.needsRefresh){
        if(!r || r.status!==200){ restartWaits++; return; }   // backend still down
        // backend answered again -> new code is live -> hard reload
        clearInterval(UPDATE_POLL);
        location.reload();
        return;
      }
      if(!r || r.status!==200) return;
      const j = r.body && r.body.job;
      if(j){ UPDATE_RUN = { ...UPDATE_RUN, ...j }; renderAdminPanel(); }
      if(j && j.done){
        if(j.ok && j.needsRefresh){
          UPDATE_RUN.needsRefresh = true;   // next successful poll after restart triggers reload
        } else {
          clearInterval(UPDATE_POLL);
        }
      }
    }, 1200);
  }
  document.addEventListener("click", async e=>{
    const b=evEl(e)?.closest("[data-adm]"); if(!b) return;
    const act=b.getAttribute("data-adm"), id=b.getAttribute("data-id");
    if(act==="logout"){ await api.call("/logout","POST",{}); ME={authenticated:false}; ADM_EDIT_ID=null; renderAdminPanel(); return; }
    if(act==="update-github"){ if(confirm("Update this instance from GitHub over Tor? The service will restart.")) startUpdate("github"); return; }
    if(act==="update-peer"){
      const onion=prompt("Trusted peer .onion to update from:"); if(!onion) return;
      const code=prompt("That operator's BIP47 payment code (verifies who you're trusting):")||"";
      if(confirm("Update this instance from "+onion+" over Tor? The service will restart.")) startUpdate("peer",{onion,code});
      return;
    }
    if(act==="update-dismiss"){ UPDATE_RUN=null; clearInterval(UPDATE_POLL); ADMIN_UPDATES=null; renderAdminPanel(); return; }
    if(act==="edit"){ ADM_EDIT_ID=b.getAttribute("data-id"); renderAdminPanel(); return; }
    if(act==="editcancel"){ ADM_EDIT_ID=null; renderAdminPanel(); return; }
    if(act==="editsave"){
      const box=b.closest(".medit");
      const r=await api.call("/admin/edit","POST",{
        id:b.getAttribute("data-id"),
        name:/** @type {HTMLInputElement} */ (box.querySelector(".e-name")).value,
        hardware:/** @type {HTMLInputElement} */ (box.querySelector(".e-hw")).value,
        name_url:/** @type {HTMLInputElement} */ (box.querySelector(".e-url")).value,
      });
      if(r.status!==200){ const em=box.querySelector(".edit-msg"); if(em) em.textContent=(r.body&&r.body.error)||("HTTP "+r.status); return; }
      ADM_EDIT_ID=null; renderAdminPanel(); return;
    }
    if(act==="remove" && !confirm("Remove this submission permanently?")) return;
    /** @type {HTMLButtonElement} */ (b).disabled=true; const o=b.textContent; b.textContent="\u2026";
    let r=null;
    if(act==="approve") r=await api.call("/admin/approve","POST",{id});
    else if(act==="reject") r=await api.call("/admin/reject","POST",{id});
    else if(act==="remove") r=await api.call("/admin/remove","POST",{id});
    // The moderation change and the publish (rebuild of data/dojos.json) are
    // two steps; report a failure of either, rather than silently showing a
    // node as approved that never reached the public list.
    ADMIN_NOTICE = null;
    if(r && r.status!==200) ADMIN_NOTICE = act+" failed: "+((r.body&&r.body.error)||("HTTP "+r.status));
    else if(r && r.body && r.body.rebuild && r.body.rebuild.error) ADMIN_NOTICE = act+" saved, but publishing failed: "+r.body.rebuild.error;
    await refreshMe(); renderAdminPanel();
  });

  const IS_ADMIN_PAGE = location.pathname.replace(/\/+$/,"") === "/admin";

  (async function(){
    if(IS_ADMIN_PAGE){ document.title="Admin \u2014 The Dojo Bay"; await refreshMe(); renderAdminPanel(); return; }
    try{
      [DOJOS,HIST]=await Promise.all([loadJSON("data/dojos.json"),loadJSON("data/history.json"),loadHist90()]);
      render();
      loadVersion();
      loadOperator();
    }catch(e){ showLoadError(e); }
  })();
})();
