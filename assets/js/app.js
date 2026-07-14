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

  function qrSVG(text, px){
    const qr = qrcode(0,"M"); qr.addData(text); qr.make();
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
  const GH_LOGO = `<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M12 .5C5.37.5 0 5.78 0 12.29c0 5.2 3.44 9.6 8.21 11.16.6.11.82-.25.82-.56 0-.28-.01-1.02-.02-2-3.34.71-4.04-1.58-4.04-1.58-.55-1.36-1.34-1.73-1.34-1.73-1.09-.73.08-.72.08-.72 1.2.08 1.84 1.21 1.84 1.21 1.07 1.79 2.81 1.27 3.5.97.11-.76.42-1.27.76-1.56-2.67-.3-5.47-1.31-5.47-5.84 0-1.29.47-2.34 1.24-3.17-.12-.3-.54-1.52.12-3.16 0 0 1.01-.32 3.3 1.21.96-.26 1.98-.39 3-.4 1.02.01 2.04.14 3 .4 2.29-1.53 3.3-1.21 3.3-1.21.66 1.64.24 2.86.12 3.16.77.83 1.24 1.88 1.24 3.17 0 4.54-2.81 5.54-5.49 5.83.43.36.81 1.09.81 2.2 0 1.59-.01 2.87-.01 3.26 0 .31.21.68.83.56C20.56 21.88 24 17.48 24 12.29 24 5.78 18.63.5 12 .5z"/></svg>`;

  const LOGO = `
  <svg width="34" height="34" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M6 13 Q24 9 42 13 L42 16 Q24 12.5 6 16 Z" fill="var(--accent)"/>
    <rect x="10" y="19.5" width="28" height="3.2" rx="1" fill="var(--accent)"/>
    <path d="M14 16 L16 30 L13 30 L11.5 16 Z" fill="var(--accent)"/>
    <path d="M34 16 L32 30 L35 30 L36.5 16 Z" fill="var(--accent)"/>
    <path d="M7 36 q4.5 -3 9 0 t9 0 t9 0 t9 0" stroke="var(--accent-2)" stroke-width="2" stroke-linecap="round" fill="none" opacity="0.95"/>
    <path d="M7 41 q4.5 -3 9 0 t9 0 t9 0 t9 0" stroke="var(--accent-2)" stroke-width="2" stroke-linecap="round" fill="none" opacity="0.55"/>
  </svg>`;

  const MODAL_META = {
    about:      {title:"About The Dojo Bay",         file:"content/about.md"},
    faq:        {title:"Frequently asked questions", file:"content/faq.md"},
    disclaimer: {title:"Disclaimer",                 file:"content/disclaimer.md"},
  };
  const modalCache = {};

  let DOJOS=null, HIST=null, net="mainnet";

  // Electrum/indexer endpoint for the card: accept a flattened payload.indexer
  // or pull the entry from a modern services[] array. tcp/ssl onion only.
  function indexerUrl(n){
    const p = n.payload || {};
    let c = p.indexer;
    if((!c || !c.url) && Array.isArray(p.services)) c = p.services.find(s => s && s.type === "indexer");
    const u = c && c.url;
    return (typeof u === "string" && /^(tcp|ssl):\/\/[a-z2-7]{56}\.onion:\d{2,5}(\/.*)?$/i.test(u)) ? u : null;
  }

  // ---- 90-day daily history (lazily fetched once, cached) -------------------
  let HIST90 = null;
  function loadHist90(){
    if(!HIST90) HIST90 = loadJSON("data/history-daily.json").catch(()=>({nodes:{}}));
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
    if(body) body.innerHTML =
      `<div class="d90strip">${bars}</div>`+
      `<div class="d90foot"><span class="faint">${view.length} day${view.length>1?"s":""}</span>`+
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
    // Card title: operator-managed records carry a short node name alongside
    // the PayNym ("+91xTx93x3 · yellow"); curated nodes show their name alone.
    const title = (n.paynym && n.name && n.name !== n.paynym) ? `${n.paynym} · ${n.name}` : (n.name || n.paynym || n.id);
    return `<div class="card ${n.status}" data-id="${esc(n.id)}">
      <div class="ctop">
        <span class="sd ${n.status}"></span>
        ${n.name_url
          ? `<a class="cname" href="${esc(n.name_url)}" target="_blank" rel="noopener" title="${esc(title)}">${esc(title)} <span class="ext">↗</span></a>`
          : `<span class="cname" title="${esc(title)}">${esc(title)}</span>`}
        <span class="cbadge ${n.status}">${n.status==="active"?"Active":"Inactive"}</span>
      </div>
      <div class="csub">${pn}${jur?'<span style="color:var(--faint)">·</span>'+jur:""}</div>
      ${relStrip(checks)}
      <div class="meta">
        <div class="full"><div class="eyebrow">Hardware</div><div class="v">${esc(n.hardware||"—")}</div></div>
        <div><div class="eyebrow">Dojo version</div><div class="v">v${esc(n.version||"?")}</div></div>
        <div><div class="eyebrow">Block height</div><div class="v">${n.block_height!=null?Number(n.block_height).toLocaleString("en-GB"):"—"}</div></div>
        <div class="full"><div class="eyebrow">Last checked</div><div class="v">${esc((n.checked_at||"").replace("T"," ").replace("Z",""))}</div></div>
      </div>
      <button class="reveal" data-act="reveal">Pairing details</button>
      <div class="pair-host"></div>
    </div>`;
  }

  function pairHTML(n){
    const pairingOnly = JSON.stringify({pairing:n.payload.pairing, explorer:n.payload.explorer}, null, 2);
    const qr = qrSVG(JSON.stringify(n.payload), 208);
    const signedBox = n.signed ? `
      <div class="box signed">
        <div class="lbl"><span class="t">Signed message</span><button class="copybtn" data-act="copysigned">Copy</button></div>
        <pre>${esc(n.signed)}</pre>
      </div>` : "";
    return `<div class="pair">
      <div class="qr"><div class="tile">${qr}</div><span class="cap">Scan to pair</span></div>
      <div class="box">
        <div class="lbl"><span class="t">Pairing code</span><button class="copybtn" data-act="copypairing">Copy</button></div>
        <pre>${esc(pairingOnly)}</pre>
      </div>
      ${signedBox}
      <div class="eps">
        <div class="ep"><span class="k">Dojo API</span><span class="u" title="${esc(n.payload.pairing.url)}">${esc(n.payload.pairing.url)}</span><button class="copybtn" data-act="copyurl" data-v="${esc(n.payload.pairing.url)}">copy</button></div>
        ${n.payload.explorer?`<div class="ep"><span class="k">Explorer</span><span class="u" title="${esc(n.payload.explorer.url)}">${esc(n.payload.explorer.url)}</span><button class="copybtn" data-act="copyurl" data-v="${esc(n.payload.explorer.url)}">copy</button></div>`:""}
        ${(()=>{const iu=indexerUrl(n);return iu?`<div class="ep"><span class="k">Electrum Server</span><span class="u" title="${esc(iu)}">${esc(iu)}</span><button class="copybtn" data-act="copyurl" data-v="${esc(iu)}">copy</button></div>`:"";})()}
      </div>
      <div class="hist90" data-hist="${esc(n.id)}"><div class="eyebrow">History · 90 days</div><div class="h90-body"><span class="loading">Loading…</span></div></div>
    </div>`;
  }

  function render(){
    const list=DOJOS.nodes.filter(n=>n.network===net);
    const active=list.filter(n=>n.status==="active").length;
    const gen=(DOJOS.generated_at||"").replace("T"," ").slice(0,16)+" UTC";
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
      <a class="brand" href="./" aria-label="The Dojo Bay">${LOGO}
        <span><div class="name disp">THE DOJO BAY</div><div class="sub mono">public dojo directory</div></span></a>
      <nav>
        <button class="lnk" data-modal="about">About</button>
        <button class="lnk" data-modal="faq">FAQ</button>
        <button class="lnk" data-modal="disclaimer">Disclaimer</button>
        <button class="lnk" id="manage-link" data-act="manage"${BACKEND?"":" hidden"}>Manage my Dojo</button>
        <a class="onion-pill" href="data/dojos.json" download="dojos.json" title="Download the directory as JSON">JSON ↓</a>
      </nav>
    </div></header>

    <div class="wrap controls">
      <div class="seg">
        <button data-net="mainnet" class="${net==="mainnet"?"on":""}">mainnet</button>
        <button data-net="testnet" class="${net==="testnet"?"on":""}">testnet</button>
      </div>
      <div class="fresh"><span class="dot"></span><b>${active}</b> of ${list.length} active
        <span class="sep">·</span> checked ${esc(gen)}
        <span class="sep">·</span> re-checks every 10 min</div>
    </div>

    <main class="wrap">
      <div class="grid">${list.map(card).join("")}</div>
      <p class="note">The Dojo Bay is a federation of independent operators across different jurisdictions, and every node is reachable over Tor. Nodes go up and down without notice, and only the operator can restart one. Pairing exposes your XPUBs to that node, so do your own due diligence, or <a href="https://dojo-osp.org/install/requirements" target="_blank" rel="noopener">run your own Dojo</a>.</p>
    </main>

    <footer><div class="wrap">
      <button class="lnk verify-link" data-act="verify" title="Verify this directory's onion address is signed by its operator">Verify</button>
      <span class="foot-spacer"></span>
      <a class="gh" href="${REPO_URL}" target="_blank" rel="noopener" aria-label="Source code on GitHub" title="Source code on GitHub">${GH_LOGO}</a>
      <span class="ver">${VERSION?`<a href="${REPO_URL}/commit/${esc(VERSION.commit)}" target="_blank" rel="noopener" title="${esc(VERSION.built||"")}">build ${esc(VERSION.commit)}</a>`:""}</span>
    </div></footer>

    <div class="ov" id="ov"><div class="modal" role="dialog" aria-modal="true">
      <div class="modal-head"><h2 id="ov-title"></h2><button class="x" data-act="closemodal" aria-label="Close">✕</button></div>
      <div class="modal-body" id="ov-body"></div>
    </div></div>`;
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

  document.addEventListener("click", e=>{
    const netBtn=e.target.closest("[data-net]");
    if(netBtn){net=netBtn.getAttribute("data-net");render();return;}
    const mBtn=e.target.closest("[data-modal]");
    if(mBtn){openModal(mBtn.getAttribute("data-modal"));return;}
    const act=e.target.closest("[data-act]");
    if(!act){ if(e.target.id==="ov") closeModal(); return; }
    const a=act.getAttribute("data-act");
    if(a==="dismiss"){try{localStorage.setItem("db_banner","off")}catch(e){}render();return;}
    if(a==="closemodal"){closeModal();return;}
    if(a==="verify"){ openVerify(); return; }
    if(a==="copyverify"){ if(OPERATOR) copy(OPERATOR.verifySigned).then(()=>flash(act,"Copied ✓")); return; }
    const cardEl=e.target.closest(".card");
    const node=()=>DOJOS.nodes.find(x=>x.id===cardEl.getAttribute("data-id"));
    if(a==="reveal"){
      const host=cardEl.querySelector(".pair-host"), btn=cardEl.querySelector(".reveal");
      if(host.innerHTML.trim()){host.innerHTML="";btn.classList.remove("open");btn.textContent="Pairing details";}
      else{host.innerHTML=pairHTML(node());btn.classList.add("open");btn.textContent="Hide pairing details";
        renderHist90(host.querySelector(".hist90"), node().id);}
      return;
    }
    if(a==="copypairing"){const n=node();copy(JSON.stringify({pairing:n.payload.pairing,explorer:n.payload.explorer},null,2)).then(()=>flash(act,"Copied ✓"));return;}
    if(a==="copysigned"){copy(node().signed).then(()=>flash(act,"Copied ✓"));return;}
    if(a==="copyurl"){copy(act.getAttribute("data-v")).then(()=>flash(act,"✓"));return;}
  });
  document.addEventListener("keydown", e=>{ if(e.key==="Escape") closeModal(); });

  /* ================= Manage my Dojo (self-service, step 2) =================
     Everything below is inert unless a backend answers /api/me. On the static
     step-1 onion there is no API, so the nav button stays hidden and nothing
     here runs. */
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

  function openManage(){
    document.getElementById("ov-title").textContent = "Manage my Dojo";
    document.getElementById("ov").classList.add("show");
    renderManage();
  }
  async function refreshMe(){ const r=await api.call("/me"); if(r.status===200) ME=r.body; }

  async function renderManage(){
    const body = document.getElementById("ov-body");
    if(!ME || !ME.authenticated){ return renderLogin(body); }
    // The API already returns mainnet-then-testnet, alphabetical by name;
    // sort again here so the panel never depends on response ordering.
    const subs = (ME.submissions||[]).slice().sort((a,b)=>
      a.network!==b.network ? (a.network==="mainnet"?-1:1)
      : String(a.name||a.id).localeCompare(String(b.name||b.id),"en",{sensitivity:"base"}));
    body.innerHTML = `
      <p style="margin-bottom:6px">Signed in as <code>${esc(ME.paymentCode.slice(0,12))}…${esc(ME.paymentCode.slice(-4))}</code>
        <button class="copybtn" data-mact="logout" style="margin-left:8px">Sign out</button></p>
      <p style="font-size:13px;color:var(--muted)">Add or edit a Dojo you operate. Submissions are checked for a live Tor connection and, if you supply a signed payload, for a valid signature, then reviewed by a maintainer before they appear.</p>
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
  function manageRow(r){
    return `<div class="box" style="padding:12px 14px;background:var(--panel2)">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
        <span class="mono" style="font-size:12.5px"><b>${esc(r.name||r.id)}</b> · ${esc(r.network)} · ${esc(r.jurisdiction||"—")} · ${esc(r.hardware||"—")}</span>
        ${statusPill(r.status)}
      </div>
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
        <label>Pairing code (JSON) <textarea id="m-payload" rows="6" placeholder='{"pairing":{"type":"dojo.api",...},"explorer":{...}}'></textarea></label>
        <label>Signed pairing message (optional, but verified if provided) <textarea id="m-signed" rows="5" placeholder="-----BEGIN BITCOIN SIGNED MESSAGE-----&#10;...&#10;-----END BITCOIN SIGNATURE-----"></textarea></label>
        <button class="reveal" data-mact="submit" style="margin-top:4px">Check connection &amp; submit</button>
      </div>
    </div>`;
  }

  function renderLogin(body){
    body.innerHTML = `
      <p>Sign in with your Dojo's <strong>PayNym</strong> using Auth47 to manage its listing. Scan this with Samourai or Ashigaru (Settings → Pair wallet → Auth47), or tap to open.</p>
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
    const manageBtn = e.target.closest('[data-act="manage"]');
    if(manageBtn){ openManage(); return; }
    const m = e.target.closest("[data-mact]");
    if(!m) return;
    const act = m.getAttribute("data-mact");
    const msg = document.getElementById("manage-msg");
    if(act==="logout"){ await api.call("/logout","POST",{}); clearInterval(pollTimer); await refreshMe(); ME={authenticated:false}; renderManage(); return; }
    if(act==="delete"){ await api.call("/dojo/delete","POST",{id:m.getAttribute("data-id")}); await refreshMe(); renderManage(); return; }
    if(act==="submit"){
      let payload;
      try{ payload = JSON.parse(document.getElementById("m-payload").value); }
      catch(err){ if(msg) msg.innerHTML='<span style="color:var(--down)">Pairing code is not valid JSON.</span>'; return; }
      // Validate the name (required + unique across approved and pending
      // records) BEFORE the slow Tor connection gate, so a taken name fails in
      // milliseconds. The POST re-checks server-side and answers 409 anyway.
      const name = document.getElementById("m-name").value.trim();
      if(!name){ if(msg) msg.innerHTML='<span style="color:var(--down)">Give your node a name first.</span>'; return; }
      const nc = await api.call("/dojo/name-check?network="+encodeURIComponent(document.getElementById("m-net").value)+"&name="+encodeURIComponent(name));
      if(nc.status!==200 || !nc.body || !nc.body.available){
        if(msg) msg.innerHTML='<span style="color:var(--down)">'+esc((nc.body&&(nc.body.reason||nc.body.error))||"That name is not available.")+'</span>'; return;
      }
      if(msg) msg.innerHTML='<span class="loading">Checking Tor connection… this can take up to 30s.</span>';
      const r = await api.call("/dojo","POST",{
        network: document.getElementById("m-net").value,
        name,
        jurisdiction: document.getElementById("m-jur").value,
        country: document.getElementById("m-cc").value,
        hardware: document.getElementById("m-hw").value,
        payload,
        signed: document.getElementById("m-signed").value.trim() || null,
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
  function adminRow(s){
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
        <button class="abtn danger" data-adm="remove" data-id="${esc(s.id)}">Remove</button>
      </div></div>`;
  }
  async function renderAdminPanel(){
    if(!ME || !ME.authenticated){
      adminShell('<p style="font-size:13px;color:var(--muted)">Sign in with your operator PayNym via Auth47 (Samourai or Ashigaru \u2192 Settings \u2192 Pair wallet \u2192 Auth47).</p><div id="auth47-box" style="text-align:center;margin:18px 0"><p class="loading">Requesting challenge\u2026</p></div>');
      onAuthSuccess = renderAdminPanel; startAuth47(); return;
    }
    if(!ME.admin){
      adminShell('<p>The payment code <code>'+esc(ME.paymentCode.slice(0,12))+'\u2026</code> is not an administrator of this directory.</p><p style="margin-top:10px"><button class="abtn" data-adm="logout">Sign out</button></p>');
      return;
    }
    adminShell('<p class="loading">Loading submissions\u2026</p>');
    const r = await api.call("/admin/submissions");
    if(r.status!==200){ adminShell('<p>Could not load submissions ('+r.status+').</p>'); return; }
    const subs=r.body.submissions||[];
    const pending=subs.filter(s=>s.status==="pending");
    const others=subs.filter(s=>s.status!=="pending");
    adminShell(
      '<p style="font-size:13px;color:var(--muted)">Signed in as <code>'+esc(ME.paymentCode.slice(0,12))+'\u2026'+esc(ME.paymentCode.slice(-4))+'</code> '+
      '<button class="abtn" data-adm="logout" style="margin-left:8px">Sign out</button></p>'+
      '<h3 style="margin:16px 0 8px">Pending review ('+pending.length+')</h3>'+
      (pending.length? pending.map(adminRow).join("") : '<p style="color:var(--faint)">Nothing awaiting review.</p>')+
      '<h3 style="margin:22px 0 8px">Approved / rejected ('+others.length+')</h3>'+
      (others.length? others.map(adminRow).join("") : '<p style="color:var(--faint)">None.</p>')
    );
  }
  document.addEventListener("click", async e=>{
    const b=e.target.closest("[data-adm]"); if(!b) return;
    const act=b.getAttribute("data-adm"), id=b.getAttribute("data-id");
    if(act==="logout"){ await api.call("/logout","POST",{}); ME={authenticated:false}; renderAdminPanel(); return; }
    if(act==="remove" && !confirm("Remove this submission permanently?")) return;
    b.disabled=true; const o=b.textContent; b.textContent="\u2026";
    if(act==="approve") await api.call("/admin/approve","POST",{id});
    else if(act==="reject") await api.call("/admin/reject","POST",{id});
    else if(act==="remove") await api.call("/admin/remove","POST",{id});
    await refreshMe(); renderAdminPanel();
  });

  const IS_ADMIN_PAGE = location.pathname.replace(/\/+$/,"") === "/admin";

  (async function(){
    if(IS_ADMIN_PAGE){ document.title="Admin \u2014 The Dojo Bay"; await refreshMe(); renderAdminPanel(); return; }
    try{
      [DOJOS,HIST]=await Promise.all([loadJSON("data/dojos.json"),loadJSON("data/history.json")]);
      render();
      loadVersion();
    }catch(e){ showLoadError(e); }
  })();
})();
