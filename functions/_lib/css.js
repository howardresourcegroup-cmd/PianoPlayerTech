// The dashboard stylesheet. A module so functions/leads.js can stay a route
// handler. Pages bundles underscore-prefixed paths without routing them.

export const CSS = `
:root{--ground:#17120e;--surface:#211a14;--raised:#2b221a;--text:#f0e6d8;
--soft:#cabbaa;--muted:#9d8f7f;--gold:#d4b25a;--border:#3a2f24;--ok:#8fb583;--bad:#e8927c}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{margin:0;background:var(--ground);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{padding:1.2rem 16px 4rem;margin:0 auto;max-width:none}
/* A data application, not an article: the grid should use the whole window.
   Gutters grow a little on very wide screens so content is not flush to the
   bezel, but nothing is capped. */
@media(min-width:1500px){.wrap{padding-left:28px;padding-right:28px}}
/* Only the sign-in and error cards stay narrow -- .narrow sets its own width. */
h1{font-size:1.3rem;margin:0}
h2{font-size:1.1rem;margin:0}
.muted{color:var(--muted);font-size:.88rem}
code{background:var(--raised);padding:.1em .4em;border-radius:4px;font-size:.85em}
.card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:1rem 1.1rem}
.narrow{max-width:420px;margin:12vh auto 0}
.top{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin-bottom:1rem;flex-wrap:wrap}
.top form{margin:0}
.linkbtn{background:none;border:0;color:var(--muted);font:inherit;font-size:.85rem;text-decoration:underline;cursor:pointer;padding:0}
.linkbtn:hover{color:var(--gold)}
.tabs{display:flex;gap:.4rem;margin-bottom:.9rem;flex-wrap:wrap}
.tab{padding:.5rem .9rem;border-radius:8px;border:1px solid var(--border);background:var(--surface);
color:var(--soft);text-decoration:none;font-size:.9rem;font-weight:500}
.tab.on{background:var(--raised);color:var(--text);border-color:var(--gold)}
.pill{display:inline-block;min-width:1.3rem;margin-left:.35rem;padding:0 .35rem;border-radius:9px;
background:var(--gold);color:#17120e;font-size:.72rem;font-weight:700;line-height:1.3rem;text-align:center}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:.5rem;margin-bottom:.9rem}
@media(max-width:600px){.stat{padding:.45rem .6rem}.stat b{font-size:1.1rem}}
.stat{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:.6rem .8rem}
.stat b{display:block;font-size:1.35rem;font-variant-numeric:tabular-nums}
.stat span{color:var(--muted);font-size:.8rem}
.stat.owed{border-color:var(--gold)}
.stat.owed b{color:var(--gold)}
.tools{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin-bottom:.6rem}
.tools input,.tools select{background:var(--surface);color:var(--text);border:1px solid var(--border);
border-radius:7px;padding:.45rem .6rem;font:inherit}
.tools input{flex:1;min-width:180px}
.tools a{color:var(--gold);font-size:.88rem}
.gridwrap{overflow:auto;max-height:calc(100vh - 230px);border:1px solid var(--border);border-radius:8px;background:var(--surface)}
table{border-collapse:separate;border-spacing:0;width:max-content;min-width:100%}
th,td{border-bottom:1px solid var(--border);border-right:1px solid var(--border);padding:0;text-align:left;vertical-align:middle}
th{position:sticky;top:0;z-index:2;background:var(--raised);color:var(--soft);font-weight:600;font-size:.8rem;
padding:.5rem .6rem;white-space:nowrap;cursor:pointer;user-select:none}
th:hover{color:var(--text)}
th.sorted{color:var(--gold)}
td{height:36px}
td.sticky,th.sticky{position:sticky;left:0;z-index:1;background:var(--surface);box-shadow:1px 0 0 var(--border)}
th.sticky{z-index:3;background:var(--raised)}
td .ro{padding:0 .6rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--soft)}
td input,td select{width:100%;height:36px;background:transparent;border:0;color:var(--text);font:inherit;padding:0 .6rem}
td select{cursor:pointer}
td input:focus,td select:focus{outline:2px solid var(--gold);outline-offset:-2px;background:var(--ground)}
td input[type=checkbox]{width:18px;height:18px;margin:0 auto;display:block;accent-color:var(--ok);cursor:pointer}
td input[type=checkbox]:disabled{opacity:.3;cursor:not-allowed}
.namecell{display:flex;align-items:center}
.namecell input{flex:1;font-weight:600}
.open{flex:none;margin-right:.35rem;background:var(--raised);border:1px solid var(--border);color:var(--gold);
border-radius:5px;padding:0 .45rem;height:24px;cursor:pointer;font:inherit;font-size:.78rem;font-weight:600}
.open:hover{border-color:var(--gold)}
/* The Referral column's call to action. Gold-filled so it reads as the one
   thing to press on a tuning lead that hasn't been handed over yet. */
.refergo{width:100%;background:var(--gold);border:1px solid var(--gold);color:#1a1205;
border-radius:5px;padding:.3rem .5rem;cursor:pointer;font:inherit;font-size:.8rem;font-weight:700}
.refergo:hover{filter:brightness(1.08)}
/* Destructive, and looks it. Only appears in the Archive tab. */
.danger{flex:none;background:none;border:1px solid var(--bad);color:var(--bad);
border-radius:5px;padding:.25rem .5rem;cursor:pointer;font:inherit;font-size:.75rem}
.danger:hover{background:var(--bad);color:var(--ground)}
/* .ghost is flex:1 and .pair carries vertical margins -- both wrong inside a
   36px table cell, hence these overrides and a separate wrapper. */
.ghost.sm{flex:none;font-size:.72rem;padding:0 .45rem;height:24px;line-height:1}
.namecell .arch{margin-left:.3rem}
.cellacts{display:flex;gap:.35rem;align-items:center;padding:0 .4rem;margin:0}
.ro.soon{color:var(--bad)}
.phonecell{display:flex;align-items:center}
.phonecell a{flex:none;color:var(--gold);text-decoration:none;padding:0 .5rem;font-size:.8rem}
tr.is-new td.sticky{box-shadow:inset 3px 0 0 var(--gold),1px 0 0 var(--border)}
tr.done td{opacity:.55}
td.ok{animation:ok 1s}
td.bad{background:#4a2218}
@keyframes ok{from{background:#2c3a26}to{background:transparent}}
.empty{text-align:center;color:var(--muted);padding:3rem 1rem}
dialog{border:1px solid var(--border);border-radius:12px;background:var(--surface);color:var(--text);
padding:0;width:min(560px,calc(100vw - 32px));max-height:calc(100vh - 32px)}
dialog::backdrop{background:rgba(0,0,0,.6)}
.dlg{padding:1.1rem 1.2rem 1.3rem;overflow:auto}
.dlg .hd{display:flex;justify-content:space-between;align-items:flex-start;gap:1rem}
.x{background:none;border:0;color:var(--muted);font-size:1.5rem;line-height:1;cursor:pointer;padding:0}
.meta{color:var(--gold);font-size:.88rem;margin:.2rem 0 .6rem}
.contact{display:flex;flex-wrap:wrap;gap:.4rem 1rem;margin:.5rem 0}
.contact a{color:var(--gold);font-weight:600;text-decoration:none}
.msg{white-space:pre-wrap;color:var(--soft);background:var(--ground);border-radius:7px;padding:.6rem .8rem;margin:.6rem 0}
details summary{cursor:pointer;color:var(--muted);font-size:.85rem;margin-top:.5rem}
dl{display:grid;grid-template-columns:auto 1fr;gap:.25rem .9rem;margin:.5rem 0 0;font-size:.85rem}
dt{color:var(--muted);white-space:nowrap}
dd{margin:0;color:var(--soft);word-break:break-word}
.refer{margin-top:1.1rem;padding-top:1rem;border-top:1px solid var(--border)}
.refer h3{margin:0 0 .5rem;font-size:.95rem}
.refer label{display:block;font-size:.8rem;color:var(--muted);margin:.55rem 0 .2rem}
.refer input[type=text],.refer textarea{width:100%;background:var(--ground);color:var(--text);border:1px solid var(--border);
border-radius:6px;padding:.5rem .65rem;font:inherit}
.refer textarea{min-height:4rem;resize:vertical}
.pair{display:flex;gap:.5rem;margin:.8rem 0 .2rem}
.ghost{flex:1;text-align:center;padding:.55rem;border:1px solid var(--border);border-radius:7px;background:var(--raised);
color:var(--text);font:inherit;font-weight:500;cursor:pointer;text-decoration:none}
.ghost:hover{border-color:var(--gold)}
.refer .chk{display:flex;gap:.5rem;align-items:center;color:var(--soft);font-size:.88rem;margin:.7rem 0}
.sent{background:#233020;border:1px solid #3c5236;border-radius:8px;padding:.6rem .8rem;color:#cfe3c7;font-size:.9rem}
.go{padding:.6rem 1rem;border:0;border-radius:7px;background:var(--gold);color:#17120e;font:inherit;font-weight:600;cursor:pointer}
.go:disabled{opacity:.5;cursor:not-allowed}
.go.full{width:100%}
.warn{color:var(--bad);font-size:.85rem}
.banner{display:flex;align-items:center;justify-content:space-between;gap:.8rem;flex-wrap:wrap;background:var(--surface);
border:1px solid var(--gold);border-radius:8px;padding:.6rem .8rem;margin-bottom:.8rem}
.tools .go{padding:.45rem .9rem}
a.go{display:inline-block;text-decoration:none}
.refer input[type=email],.refer input[type=number]{width:100%;background:var(--ground);color:var(--text);
border:1px solid var(--border);border-radius:6px;padding:.5rem .65rem;font:inherit}
.line{display:flex;gap:.4rem;align-items:center;margin-bottom:.4rem}
.line input[type=text]{flex:1}
.refer .line .amt{flex:0 0 105px;width:105px}
.total{font-weight:600;font-size:1rem;margin:.9rem 0 .5rem}
.acts{display:flex;gap:.8rem;align-items:center;padding:0 .6rem;white-space:nowrap}
.acts a{color:var(--gold)}
.ro.st-paid{color:var(--ok)}
.ro.st-open{color:var(--gold)}
.ro.st-overdue{color:var(--bad);font-weight:600}
input[type=password]{width:100%;padding:.7rem .8rem;border-radius:7px;border:1px solid var(--border);
background:var(--ground);color:var(--text);font:inherit;margin:.7rem 0}
input[type=password]:focus{outline:none;border-color:var(--gold)}
.err{color:var(--bad);font-size:.87rem;margin:0}

/* ---- record view: tabs, timeline, history ---- */
.rtabs{display:flex;gap:.3rem;border-bottom:1px solid var(--border);margin:.9rem 0 .9rem;flex-wrap:wrap}
.rtab{background:none;border:none;border-bottom:2px solid transparent;color:var(--muted);
font:inherit;padding:.5rem .75rem;cursor:pointer;border-radius:6px 6px 0 0}
.rtab:hover{color:var(--text);background:var(--raised)}
.rtab.on{color:var(--gold);border-bottom-color:var(--gold)}
.rtab .n{font-size:.78rem;color:var(--muted);margin-left:.3rem}
.rtab.on .n{color:var(--gold)}
.panel[hidden]{display:none}
.loading{color:var(--muted);font-size:.9rem;padding:.6rem 0}

.compose{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:.7rem;margin-bottom:.9rem}
.compose textarea{width:100%;min-height:62px;background:var(--ground);color:var(--text);
border:1px solid var(--border);border-radius:6px;padding:.5rem .65rem;font:inherit;resize:vertical}
.compose .row{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin-top:.5rem}
.compose select,.compose input[type=datetime-local]{background:var(--ground);color:var(--text);
border:1px solid var(--border);border-radius:6px;padding:.4rem .5rem;font:inherit}
.compose .go{margin-left:auto;padding:.45rem 1rem}

.tl{list-style:none;margin:0;padding:0}
.tl li{display:flex;align-items:flex-start;gap:.7rem;padding:.65rem 0;border-bottom:1px solid var(--border)}
.tl li:last-child{border-bottom:none}
.tl .kind{flex:0 0 auto;font-size:.72rem;text-transform:uppercase;letter-spacing:.04em;
padding:.16rem .45rem;border-radius:4px;background:var(--raised);color:var(--soft);height:fit-content}
.tl .kind.status{background:transparent;border:1px solid var(--border);color:var(--muted)}
.tl .kind.followup,.tl .kind.task{background:var(--gold);color:var(--ground);font-weight:600}
.tl .kind.call{color:var(--gold)}
.tl .grow{flex:1;min-width:0}
.tl .subj{font-weight:600;overflow-wrap:anywhere}
.tl .txt{color:var(--soft);white-space:pre-wrap;overflow-wrap:anywhere;margin-top:.15rem}
.tl .when{color:var(--muted);font-size:.8rem;margin-top:.25rem}
.tl .due{font-size:.8rem;color:var(--gold);margin-top:.25rem}
.tl .due.late{color:var(--bad);font-weight:600}
.tl .done .subj,.tl .done .txt{text-decoration:line-through;color:var(--muted)}
.tl .tick{flex:0 0 auto;margin-top:.28rem}
.tl .del{background:none;border:none;color:var(--muted);cursor:pointer;font-size:1rem;padding:0 .2rem}
.tl .del:hover{color:var(--bad)}

.hist{list-style:none;margin:0;padding:0}
.hist li{display:flex;gap:.7rem;align-items:baseline;padding:.55rem 0;border-bottom:1px solid var(--border)}
.hist li:last-child{border-bottom:none}
.hist .date{flex:0 0 5.6rem;color:var(--muted);font-size:.83rem}
.hist .what{flex:1;min-width:0;overflow-wrap:anywhere}
.hist .tagp{font-size:.72rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);
border:1px solid var(--border);border-radius:4px;padding:.12rem .4rem}
.hist .amt{color:var(--gold);font-weight:600;white-space:nowrap}
.quick{display:flex;gap:.4rem;flex-wrap:wrap;margin:0 0 .8rem}
.chip{background:var(--surface);border:1px solid var(--border);color:var(--soft);
font:inherit;font-size:.86rem;padding:.3rem .7rem;border-radius:999px;cursor:pointer}
.chip:hover{border-color:var(--gold);color:var(--text)}
.chip.on{background:var(--gold);border-color:var(--gold);color:var(--ground);font-weight:600}
/* ---- bulk bar and pager ---- */
.bulkbar{display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;margin:0 0 .8rem;
padding:.5rem .8rem;background:var(--surface);border:1px solid var(--gold);border-radius:8px}
.bulkbar .count{font-weight:600;color:var(--gold)}
.bulkbar select{background:var(--ground);color:var(--text);border:1px solid var(--border);
border-radius:6px;padding:.35rem .5rem;font:inherit}
.bulkbar .go.sm,.bulkbar .ghost.sm{padding:.35rem .8rem;font-size:.88rem}
.bulkmsg{color:var(--muted);font-size:.86rem}
.pager{display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;margin:.7rem 0 0}
.pager select{background:var(--ground);color:var(--text);border:1px solid var(--border);
border-radius:6px;padding:.35rem .5rem;font:inherit}
.pager .ghost.sm{padding:.3rem .7rem;font-size:.88rem}
.pager button:disabled{opacity:.4;cursor:default}
th.pickcol,td.pickcol{width:34px;min-width:34px;max-width:34px;text-align:center;padding:0 .2rem}
td.pickcol input,th.pickcol input{margin:0;cursor:pointer}
.fubadge{background:var(--bad);color:#fff;border-radius:999px;padding:.05rem .45rem;
font-size:.75rem;font-weight:600;margin-left:.35rem}

/* On a phone the badge and the text fight over one line and the text loses.
   Give the badge its own row and let the entry have the full width. */
@media(max-width:560px){
  .tl li{flex-wrap:wrap;gap:.45rem}
  .tl .tick{order:0}
  .tl .kind{order:1}
  .tl .del{order:2;margin-left:auto}
  .tl .grow{order:3;flex:1 0 100%}
  .hist li{flex-wrap:wrap}
  .hist .date{flex:0 0 auto}
  .hist .what{flex:1 0 100%}
  .compose .go{margin-left:0;flex:1}
}
`;
