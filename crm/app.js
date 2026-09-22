// The CRM client application.
//
// Served as a static asset and loaded as a module, rather than inlined into
// the page. It lived in a template literal until 2026-09-22, where no linter
// or syntax check could see it and a broken grid could ship unnoticed.
//
// Public by URL and deliberately so: this is interface code with no secrets
// in it. Every lead it displays still comes from /leads, behind Cloudflare
// Access.
//
// Customer-supplied values reach the DOM through textContent or .value and
// never innerHTML. That, not the CSP, is what stops a form submission from
// running as markup.
(function(){
  var D = JSON.parse(document.getElementById('data').textContent);
  var rows = D.rows, view = D.view;
  var REF_LABEL = {sent:'Sent — waiting', booked:'Booked', no_booking:"Didn't book"};

  var COLS = [
    {k:'name', label:'Name', type:'name', w:240},
    {k:'phone', label:'Phone', type:'phone', w:170},
    {k:'status', label:'Status', type:'select', opts:D.setStatuses, w:110}
  ];
  if (view === 'archive') {
    COLS.push(
      {k:'archived_at', label:'Archived', type:'date', w:120},
      {k:'archived_at', label:'Deletes in', type:'purgein', w:110},
      {k:'created_at', label:'Received', type:'date', w:120},
      {k:'city', label:'City', type:'text', w:120},
      {k:'service', label:'Service', type:'text', w:150},
      {k:'id', label:'', type:'archiveacts', w:190}
    );
  } else if (view === 'referrals') {
    COLS.push(
      {k:'id', label:'Referral #', type:'ref', w:95},
      {k:'referred_at', label:'Sent', type:'date', w:120},
      {k:'referral_status', label:'Outcome', type:'select', opts:D.refStatuses, labels:REF_LABEL, w:140},
      {k:'referral_paid_at', label:'$' + D.fee + ' paid', type:'paid', w:80},
      {k:'referral_invoice_id', label:'Invoice', type:'inv', w:150},
      {k:'address', label:'Address', type:'text', w:220},
      {k:'system', label:'Piano', type:'text', w:170},
      {k:'notes', label:'Notes', type:'text', w:280}
    );
  } else {
    COLS.push(
      {k:'created_at', label:'Received', type:'date', w:120},
      {k:'system', label:'Piano / system', type:'text', w:170},
      {k:'service', label:'Service', type:'text', w:150},
      {k:'city', label:'City', type:'text', w:120},
      {k:'address', label:'Address', type:'text', w:210},
      {k:'email', label:'Email', type:'text', w:210},
      {k:'message', label:'What they said', type:'long', w:260},
      {k:'notes', label:'Notes', type:'text', w:260}
    );
    if (view !== 'repair') {
      COLS.push(
        {k:'referral_status', label:'Referral', type:'refer', opts:D.refStatuses, labels:REF_LABEL, blank:true, w:140},
        {k:'referral_paid_at', label:'$' + D.fee + ' paid', type:'paid', w:80}
      );
    }
    COLS.push({k:'pipeline', label:'Pipeline', type:'select', opts:['repair','tuning'], w:100});
  }

  var head = document.getElementById('head'), body = document.getElementById('body');
  var q = document.getElementById('q'), sf = document.getElementById('sf');
  var shown = document.getElementById('shown'), empty = document.getElementById('empty');
  var dlg = document.getElementById('dlg'), dlgbody = document.getElementById('dlgbody');
  var sortKey = null, sortDir = 1;

  function el(tag, props, kids){
    var n = document.createElement(tag);
    if (props) for (var p in props) {
      if (p === 'text') n.textContent = props[p];
      else if (p === 'on') for (var ev in props.on) n.addEventListener(ev, props.on[ev]);
      else if (p in n) n[p] = props[p]; else n.setAttribute(p, props[p]);
    }
    (kids || []).forEach(function(k){ if (k) n.appendChild(k); });
    return n;
  }
  function fmt(ts){
    if (!ts) return '';
    var d = new Date(ts); if (isNaN(d)) return ts;
    return d.toLocaleDateString([], {month:'short', day:'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : '2-digit'});
  }
  function fmtLong(ts){ var d = new Date(ts); return isNaN(d) ? '' : d.toLocaleString(); }
  function tel(p){ return String(p || '').replace(/[^0-9+]/g, ''); }
  function money(c){ return '$' + (Number(c || 0) / 100).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2}); }
  var INV_LABEL = {open:'Unpaid', paid:'Paid', void:'Void', uncollectible:'Uncollectible', draft:'Draft'};
  function invById(id){
    for (var i = 0; i < D.invoices.length; i++) if (D.invoices[i].id === id) return D.invoices[i];
    return null;
  }
  function showDlg(){ if (!dlg.open) dlg.showModal(); }
  function fields(r){ try { return JSON.parse(r.fields || '{}') || {}; } catch(e){ return {}; } }

  function post(payload){
    return fetch('/leads', {method:'POST', credentials:'same-origin',
      headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)})
    .then(function(res){
      return res.json().catch(function(){ return {}; }).then(function(j){
        if (!res.ok) throw new Error(j.error || ('Error ' + res.status));
        return j;
      });
    });
  }
  function flash(td, ok){
    td.classList.remove('ok','bad'); void td.offsetWidth;
    td.classList.add(ok ? 'ok' : 'bad');
  }

  // ---- stats (tuning, referrals, all)
  function renderStats(){
    var box = document.getElementById('stats');
    if (box.hidden) return;
    var r = D.ref, owed = (r.booked - r.paid) * D.fee;
    // "Didn't book" and a raw paid count live in the filter; five boxes keep
    // the grid above the fold on a phone.
    var items = [
      [r.sent, 'Referred'], [r.sent - r.booked - r.lost, 'Waiting to hear'], [r.booked, 'Booked'],
      ['$' + owed, 'Owed to you', 'owed'], ['$' + (r.paid * D.fee), 'Earned']
    ];
    box.textContent = '';
    items.forEach(function(it){
      box.appendChild(el('div', {className:'stat' + (it[2] ? ' ' + it[2] : '')},
        [el('b', {text:String(it[0])}), el('span', {text:it[1]})]));
    });
  }
  // Recount after a change, from rows we can see plus the server's totals.
  function bumpRef(before, after){
    function add(r, s){
      if (!r.referred_at) return;
      D.ref.sent += s;
      if (r.referral_status === 'booked') D.ref.booked += s;
      if (r.referral_status === 'no_booking') D.ref.lost += s;
      if (r.referral_status === 'booked' && r.referral_paid_at) D.ref.paid += s;
    }
    add(before, -1); add(after, 1); renderStats();
  }

  // ---- filter options
  var FILTERS = view === 'referrals'
    ? [['', 'All referrals'], ['ref:sent', 'Waiting to hear'], ['ref:booked', 'Booked'],
       ['ref:unpaid', 'Booked, not paid'], ['ref:paid', 'Paid'], ['ref:no_booking', "Didn't book"]]
    : [['', 'Every status'], ['open', 'Not closed']].concat(D.statuses.map(function(s){ return [s, s]; }));
  FILTERS.forEach(function(f){ sf.appendChild(el('option', {value:f[0], text:f[1]})); });

  function passes(r){
    var f = sf.value;
    if (f === 'open' && r.status === 'closed') return false;
    if (f && f.indexOf('ref:') === 0) {
      var want = f.slice(4);
      if (want === 'unpaid') { if (r.referral_status !== 'booked' || r.referral_paid_at) return false; }
      else if (want === 'paid') { if (!r.referral_paid_at) return false; }
      else if (r.referral_status !== want) return false;
    } else if (f && f !== 'open' && r.status !== f) return false;
    var s = q.value.trim().toLowerCase();
    if (!s) return true;
    return ['name','phone','email','city','address','system','service','message','notes','id']
      .some(function(k){ return String(r[k] == null ? '' : r[k]).toLowerCase().indexOf(s) >= 0; });
  }

  // ---- grid
  function renderHead(){
    head.textContent = '';
    COLS.forEach(function(c, i){
      var th = el('th', {text: c.label + (sortKey === c.k ? (sortDir > 0 ? ' ▲' : ' ▼') : ''),
        className: (i === 0 ? 'sticky ' : '') + (sortKey === c.k ? 'sorted' : ''),
        on:{click:function(){ if (sortKey === c.k) sortDir = -sortDir; else { sortKey = c.k; sortDir = 1; } render(); }}});
      th.style.minWidth = c.w + 'px';
      head.appendChild(th);
    });
  }

  function cellSelect(r, c, td){
    var v = r[c.k] == null ? '' : r[c.k];
    var sel = el('select', {'aria-label':c.label});
    if (c.blank || !v) sel.appendChild(el('option', {value:'', text:'—'}));
    // A stored value nobody may choose any more — 'referred' — still has to
    // show on the leads that already carry it. Added disabled, so it displays
    // without being something you could pick for yourself.
    if (v && c.opts.indexOf(String(v)) < 0) {
      sel.appendChild(el('option', {value:String(v), disabled:true,
        text:(c.labels && c.labels[v]) || String(v)}));
    }
    c.opts.forEach(function(o){ sel.appendChild(el('option', {value:o, text:(c.labels && c.labels[o]) || o})); });
    sel.value = String(v);
    if (c.k === 'referral_status' && !r.referred_at) sel.disabled = true;
    sel.addEventListener('change', function(){
      if (!sel.value) { sel.value = String(r[c.k] || ''); return; }
      save(r, c.k, sel.value, td);
    });
    return sel;
  }

  function cell(r, c, i){
    var td = el('td', {className: i === 0 ? 'sticky' : ''});
    td.style.minWidth = c.w + 'px'; td.style.maxWidth = (c.w + 80) + 'px';
    var v = r[c.k] == null ? '' : r[c.k];

    function input(){
      var inp = el('input', {value:String(v), 'aria-label':c.label});
      inp.addEventListener('change', function(){ save(r, c.k, inp.value, td); });
      return inp;
    }

    if (c.type === 'name') {
      td.appendChild(el('div', {className:'namecell'}, [
        el('button', {className:'open', text:'Open', title:'Open the whole lead', type:'button',
          on:{click:function(){ openLead(r); }}}),
        view === 'archive' ? null : el('button', {className:'ghost sm arch', type:'button',
          text:'Archive', title:'Hide this lead; deleted permanently in about ' + D.purgeDays + ' days',
          on:{click:function(){ archiveAction(r, 'archive'); }}}),
        input()
      ]));
    } else if (c.type === 'phone') {
      td.appendChild(el('div', {className:'phonecell'}, [
        input(), tel(v) ? el('a', {href:'tel:' + tel(v), text:'call', title:'Call'}) : null
      ]));
    } else if (c.type === 'text') {
      td.appendChild(input());
    } else if (c.type === 'purgein') {
      var left = D.purgeDays -
        Math.floor((Date.now() - new Date(r.archived_at).getTime()) / 86400000);
      td.appendChild(el('div', {className:'ro' + (left <= 3 ? ' soon' : ''),
        text: left > 0 ? left + (left === 1 ? ' day' : ' days') : 'any time now'}));
    } else if (c.type === 'archiveacts') {
      td.appendChild(el('div', {className:'cellacts'}, [
        el('button', {className:'ghost sm', type:'button', text:'Restore',
          on:{click:function(){ archiveAction(r, 'restore'); }}}),
        el('button', {className:'danger', type:'button', text:'Delete now',
          on:{click:function(){ archiveAction(r, 'purge'); }}})
      ]));
    } else if (c.type === 'refer') {
      // Before a referral exists this column used to be a disabled dropdown —
      // the one control named "Referral", greyed out on exactly the leads you
      // want to refer. It is now the button that starts the referral.
      if (r.referred_at) {
        td.appendChild(cellSelect(r, c, td));
      } else if (r.pipeline === 'tuning') {
        td.appendChild(el('button', {className:'refergo', type:'button', text:'Refer →',
          title:'Send this lead to World Class',
          on:{click:function(){ openRefer(r); }}}));
      }
      // A repair lead gets nothing here: World Class takes tuning work. The
      // All tab mixes both pipelines, so this column would otherwise put a
      // prominent button on jobs that should never be handed over.
    } else if (c.type === 'select') {
      td.appendChild(cellSelect(r, c, td));
    } else if (c.type === 'paid') {
      var cb = el('input', {type:'checkbox', checked:!!v, 'aria-label':'Paid',
        title: r.referred_at ? (v ? 'Paid ' + fmtLong(v) : 'Mark as paid') : 'Not referred yet'});
      cb.disabled = !r.referred_at;
      cb.addEventListener('change', function(){
        var before = Object.assign({}, r);
        post({action:'paid', id:r.id, paid:cb.checked}).then(function(j){
          r.referral_paid_at = j.value;
          if (j.value) r.referral_status = 'booked';
          bumpRef(before, r); flash(td, true);
          if (j.value) render();
        }, function(e){ cb.checked = !cb.checked; flash(td, false); alert(e.message); });
      });
      td.appendChild(cb);
    } else if (c.type === 'inv') {
      var inv = v ? invById(v) : null;
      var billed = inv ? (inv.number || 'Invoice') + ' · ' + (INV_LABEL[inv.status] || inv.status)
        : (r.referral_status === 'booked' && !r.referral_paid_at ? 'Not billed yet' : '');
      td.appendChild(el('div', {className:'ro', text:billed, title:billed}));
    } else if (c.type === 'ref') {
      td.appendChild(el('div', {className:'ro', text:'PPT-' + r.id}));
    } else if (c.type === 'date') {
      td.appendChild(el('div', {className:'ro', text:fmt(v), title:fmtLong(v)}));
    } else {
      td.appendChild(el('div', {className:'ro', text:String(v), title:String(v)}));
    }
    return td;
  }

  function rowEl(r){
    var tr = el('tr', {className: r.status === 'new' ? 'is-new' : r.status === 'closed' ? 'done' : ''});
    COLS.forEach(function(c, i){ tr.appendChild(cell(r, c, i)); });
    return tr;
  }

  function render(){
    renderHead();
    var list = rows.filter(passes);
    if (sortKey) {
      list.sort(function(a, b){
        var x = a[sortKey] == null ? '' : String(a[sortKey]), y = b[sortKey] == null ? '' : String(b[sortKey]);
        if (!x && y) return 1; if (x && !y) return -1;
        return x.localeCompare(y, undefined, {numeric:true, sensitivity:'base'}) * sortDir;
      });
    }
    body.textContent = '';
    var frag = document.createDocumentFragment();
    list.forEach(function(r){ frag.appendChild(rowEl(r)); });
    body.appendChild(frag);
    empty.hidden = list.length > 0;
    renderBanner();
    shown.textContent = list.length === rows.length
      ? rows.length + (rows.length === 1 ? ' row' : ' rows') : list.length + ' of ' + rows.length;
  }

  function archiveAction(r, action){
    if (action === 'purge' &&
        !confirm('Delete ' + (r.name || 'this lead') +
                 ' permanently? This cannot be undone.')) return;
    post({action:action, id:r.id}).then(function(){
      // It no longer belongs on this tab either way: archived leaves the
      // working views, restored leaves the Archive tab.
      rows = rows.filter(function(x){ return x !== r; });
      render();
    }, function(e){ alert(e.message); });
  }

  function save(r, field, value, td){
    var before = Object.assign({}, r);
    post({action:'update', id:r.id, field:field, value:value}).then(function(j){
      r[field] = j.value;
      if (field === 'referral_status' && j.value !== 'booked') r.referral_paid_at = null;
      if (field === 'referral_status') bumpRef(before, r);
      flash(td, true);
      // Moved to the other pipeline: it no longer belongs on this tab.
      if (field === 'pipeline' && (view === 'repair' || view === 'tuning') && j.value !== view) {
        rows = rows.filter(function(x){ return x !== r; });
      }
      if (field === 'status' || field === 'pipeline' || field === 'referral_status') render();
    }, function(e){ flash(td, false); alert(e.message); });
  }

  // ---- lead detail + World Class referral

  // Straight from the grid's Refer button: just the referral form, no detour
  // through the full lead record.
  function openRefer(r){
    dlgbody.textContent = '';
    dlgHeader('Refer ' + (r.name || 'this lead'),
      [r.phone, r.city].filter(Boolean).join(' · ') || ('PPT-' + r.id));
    if (r.message) dlgbody.appendChild(el('div', {className:'msg', text:r.message}));
    dlgbody.appendChild(referBox(r, fields(r)));
    dlgbody.appendChild(el('p', null, [
      el('button', {className:'linkbtn', type:'button', text:'See the whole lead instead',
        on:{click:function(){ openLead(r); }}})
    ]));
    showDlg();
  }

  function openLead(r){
    dlgbody.textContent = '';
    var f = fields(r);
    var meta = [r.service, r.system, r.city].filter(Boolean).join(' · ');

    dlgbody.appendChild(el('div', {className:'hd'}, [
      el('div', null, [
        el('h2', {text: r.name || 'No name given'}),
        el('div', {className:'muted', text:'Received ' + fmtLong(r.created_at) + ' · PPT-' + r.id})
      ]),
      el('button', {className:'x', type:'button', text:'×', 'aria-label':'Close', on:{click:function(){ dlg.close(); }}})
    ]));
    if (meta) dlgbody.appendChild(el('div', {className:'meta', text:meta}));

    var contact = el('div', {className:'contact'});
    if (tel(r.phone)) contact.appendChild(el('a', {href:'tel:' + tel(r.phone), text:r.phone}));
    if (r.email) contact.appendChild(el('a', {href:'mailto:' + r.email, text:r.email}));
    if (r.address) contact.appendChild(el('a', {href:'https://maps.google.com/?q=' + encodeURIComponent(r.address),
      target:'_blank', rel:'noopener', text:'Map'}));
    dlgbody.appendChild(contact);

    if (r.message) dlgbody.appendChild(el('div', {className:'msg', text:r.message}));

    var keys = Object.keys(f);
    if (keys.length) {
      var dl = el('dl');
      keys.forEach(function(k){
        dl.appendChild(el('dt', {text:k.replace(/[_-]+/g, ' ')}));
        dl.appendChild(el('dd', {text:String(f[k])}));
      });
      dlgbody.appendChild(el('details', null, [el('summary', {text:'Everything they submitted'}), dl]));
    }
    if (r.notes) dlgbody.appendChild(el('div', {className:'msg', text:r.notes}));

    dlgbody.appendChild(referBox(r, f));
    dlgbody.appendChild(el('div', {className:'refer'}, [
      el('h3', {text:'Invoice'}),
      el('button', {className:'ghost', type:'button', text:'Create an invoice for ' + (r.name || 'this customer'),
        on:{click:function(){ invoiceDialog({billTo:r.name, email:r.email, leadId:r.id}); }}})
    ]));
    showDlg();
  }

  // ---- invoicing (Stripe)
  function dlgHeader(title, sub){
    dlgbody.appendChild(el('div', {className:'hd'}, [
      el('div', null, [el('h2', {text:title}), sub ? el('div', {className:'muted', text:sub}) : null]),
      el('button', {className:'x', type:'button', text:'×', 'aria-label':'Close', on:{click:function(){ dlg.close(); }}})
    ]));
  }

  // The monthly World Class bill on the Referrals tab.
  function renderBanner(){
    if (view === 'archive') {
      var ab = document.getElementById('banner');
      ab.textContent = 'Archived leads are deleted permanently about ' +
        D.purgeDays + ' days after archiving. Restore one to keep it.';
      ab.hidden = false;
      return;
    }
    var b = document.getElementById('banner');
    if (view !== 'referrals') return;
    var due = rows.filter(function(r){ return r.referral_status === 'booked' && !r.referral_paid_at && !r.referral_invoice_id; });
    b.textContent = '';
    b.hidden = !due.length;
    if (!due.length) return;
    b.appendChild(el('span', {text: due.length + (due.length === 1 ? ' booked referral' : ' booked referrals') +
      ' not billed yet · ' + money(due.length * D.fee * 100)}));
    b.appendChild(el('button', {className:'go', type:'button', text:'Invoice World Class', on:{click:function(){
      invoiceDialog({title:'Invoice World Class', billTo:'World Class Piano Tuners', email:D.lastWcEmail, referrals:due,
        memo:'Tuning referral fees — ' + new Date().toLocaleDateString([], {month:'long', year:'numeric'})});
    }}}));
  }

  function invoiceDialog(pre){
    dlgbody.textContent = '';
    dlgHeader(pre.title || 'New invoice', 'Stripe emails it with a link to pay by card or bank.');
    if (!D.stripeReady) {
      dlgbody.appendChild(el('p', {className:'warn',
        text:"Stripe isn't connected yet. Add a STRIPE_SECRET_KEY secret in Cloudflare Pages settings, then redeploy."}));
      showDlg(); return;
    }
    var box = el('div', {className:'refer'});
    var billTo = el('input', {type:'text', value: pre.billTo || '', placeholder:'Name or company'});
    var email = el('input', {type:'email', value: pre.email || '', placeholder:'billing@example.com'});
    var days = el('input', {type:'number', value:'14', min:'1', max:'90'});
    var memo = el('textarea', {value: pre.memo || '', placeholder:'Shown on the invoice (optional)'});
    var totalEl = el('div', {className:'total'});
    var msg = el('p', {className:'warn'});
    var btn = el('button', {className:'go full', type:'button', text:'Create & send invoice'});
    var lineBox = el('div');
    var getLines, addLine;

    if (pre.referrals) {
      // Only which referrals — the server prices them.
      var checks = pre.referrals.map(function(r){
        var cb = el('input', {type:'checkbox', checked:true});
        cb.addEventListener('change', update);
        lineBox.appendChild(el('label', {className:'chk'}, [cb,
          document.createTextNode('PPT-' + r.id + (r.name ? ' — ' + r.name : '') + ' · ' + money(D.fee * 100))]));
        return {cb:cb, r:r};
      });
      getLines = function(){
        return checks.filter(function(c){ return c.cb.checked; }).map(function(c){ return {id:c.r.id, cents:D.fee * 100}; });
      };
    } else {
      var items = [];
      addLine = function(desc){
        var d = el('input', {type:'text', value: desc || '', placeholder:'Description'});
        var a = el('input', {type:'number', step:'0.01', min:'0', placeholder:'0.00', className:'amt', 'aria-label':'Amount'});
        var row = el('div', {className:'line'}, [d, a]);
        var item = {d:d, a:a};
        row.appendChild(el('button', {className:'x', type:'button', text:'×', title:'Remove line', on:{click:function(){
          if (items.length === 1) { d.value = ''; a.value = ''; update(); return; }
          items.splice(items.indexOf(item), 1); row.remove(); update();
        }}}));
        [d, a].forEach(function(i){ i.addEventListener('input', update); });
        items.push(item); lineBox.appendChild(row);
        return item;
      };
      addLine('');
      getLines = function(){
        return items.map(function(it){
          return {description: it.d.value.trim(), amount: it.a.value, cents: Math.round(parseFloat(it.a.value || '0') * 100) || 0};
        }).filter(function(l){ return l.description || l.cents; });
      };
    }
    function update(){
      var t = getLines().reduce(function(sum, l){ return sum + l.cents; }, 0);
      totalEl.textContent = 'Total ' + money(t);
      btn.disabled = t <= 0;
    }

    box.appendChild(el('label', {text:'Bill to'})); box.appendChild(billTo);
    box.appendChild(el('label', {text:'Email'})); box.appendChild(email);
    box.appendChild(el('label', {text: pre.referrals ? 'Referrals on this invoice' : 'Line items'})); box.appendChild(lineBox);
    if (!pre.referrals) box.appendChild(el('button', {className:'linkbtn', type:'button', text:'+ Add line',
      on:{click:function(){ addLine('').d.focus(); }}}));
    box.appendChild(el('label', {text:'Due in (days)'})); box.appendChild(days);
    box.appendChild(el('label', {text:'Memo'})); box.appendChild(memo);
    box.appendChild(totalEl); box.appendChild(btn); box.appendChild(msg);
    dlgbody.appendChild(box);
    update();

    btn.addEventListener('click', function(){
      var lines = getLines();
      var t = lines.reduce(function(sum, l){ return sum + l.cents; }, 0);
      if (!confirm('Email a ' + money(t) + ' invoice to ' + email.value.trim() + '?')) return;
      btn.disabled = true; btn.textContent = 'Creating…'; msg.textContent = '';
      var payload = {action:'invoice', billTo:billTo.value, email:email.value, days:days.value, memo:memo.value, leadId:pre.leadId || null};
      if (pre.referrals) payload.referralIds = lines.map(function(l){ return l.id; });
      else payload.lines = lines.map(function(l){ return {description:l.description, amount:l.amount}; });
      post(payload).then(function(j){
        var inv = j.invoice;
        D.invoices.unshift(inv);
        if (pre.referrals) {
          D.lastWcEmail = inv.email;
          rows.forEach(function(r){ if (payload.referralIds.indexOf(r.id) >= 0) r.referral_invoice_id = inv.id; });
        }
        if (view === 'invoices') renderInvoices(); else render();
        dlgbody.textContent = '';
        dlgHeader('Invoice ' + (inv.number || '') + ' sent', money(inv.amount_cents) + ' to ' + inv.email);
        if (j.warning) dlgbody.appendChild(el('p', {className:'warn', text:j.warning}));
        if (inv.hosted_url) dlgbody.appendChild(el('p', null, [
          el('a', {href:inv.hosted_url, target:'_blank', rel:'noopener', className:'go', text:'View invoice'})]));
      }, function(e){ btn.disabled = false; btn.textContent = 'Create & send invoice'; msg.textContent = e.message; });
    });
    showDlg();
  }

  // ---- Invoices tab
  function renderInvoices(){
    var f = sf.value, s = q.value.trim().toLowerCase(), now = new Date();
    var list = D.invoices.filter(function(i){
      if (f && i.status !== f) return false;
      if (!s) return true;
      return [i.bill_to, i.email, i.description, i.number, i.lines]
        .some(function(v){ return String(v || '').toLowerCase().indexOf(s) >= 0; });
    });
    head.textContent = '';
    ['Date', 'Invoice #', 'Bill to', 'Email', 'For', 'Amount', 'Status', 'Due', ''].forEach(function(h, i){
      head.appendChild(el('th', {text:h, className: i === 0 ? 'sticky' : ''}));
    });
    body.textContent = '';
    list.forEach(function(inv){
      var lines = []; try { lines = JSON.parse(inv.lines || '[]'); } catch(e){}
      var what = inv.description || lines.map(function(l){ return l.description; }).join('; ');
      var overdue = inv.status === 'open' && inv.due_date && new Date(inv.due_date) < now;
      function ro(t, cls){
        var td = el('td', {className: cls || ''});
        td.appendChild(el('div', {className:'ro', text:t, title:t}));
        return td;
      }
      var tr = el('tr', {className: inv.status === 'void' ? 'done' : ''});
      tr.appendChild(ro(fmt(inv.created_at), 'sticky'));
      tr.appendChild(ro(inv.number || '—'));
      tr.appendChild(ro(inv.bill_to || ''));
      tr.appendChild(ro(inv.email || ''));
      tr.appendChild(ro(what));
      tr.appendChild(ro(money(inv.amount_cents)));
      var st = ro(overdue ? 'Overdue' : (INV_LABEL[inv.status] || inv.status));
      st.firstChild.className += ' st-' + (overdue ? 'overdue' : inv.status);
      tr.appendChild(st);
      tr.appendChild(ro(inv.status === 'paid' ? 'Paid ' + fmt(inv.paid_at) : fmt(inv.due_date)));
      var acts = el('div', {className:'acts'});
      if (inv.hosted_url) {
        acts.appendChild(el('a', {href:inv.hosted_url, target:'_blank', rel:'noopener', text:'View'}));
        acts.appendChild(el('button', {className:'linkbtn', type:'button', text:'Copy link', on:{click:function(e){
          var b = e.target;
          navigator.clipboard.writeText(inv.hosted_url).then(function(){ b.textContent = 'Copied ✓'; },
            function(){ prompt('Copy this link:', inv.hosted_url); });
        }}}));
      }
      if (inv.status === 'open') acts.appendChild(el('button', {className:'linkbtn', type:'button', text:'Void', on:{click:function(){
        if (!confirm('Void invoice ' + (inv.number || '') + ' for ' + money(inv.amount_cents) + '? It can no longer be paid.')) return;
        post({action:'void', id:inv.id}).then(function(j){ Object.assign(inv, j.invoice); renderInvoices(); },
          function(e){ alert(e.message); });
      }}}));
      tr.appendChild(el('td', null, [acts]));
      body.appendChild(tr);
    });
    empty.hidden = list.length > 0;
    empty.textContent = D.stripeReady ? 'No invoices yet.'
      : "Stripe isn't connected yet. Add a STRIPE_SECRET_KEY secret in Cloudflare Pages settings, then redeploy.";
    shown.textContent = list.length + (list.length === 1 ? ' invoice' : ' invoices');

    var unpaid = 0, late = 0, paid = 0;
    D.invoices.forEach(function(i){
      if (i.status === 'open') { unpaid += i.amount_cents; if (i.due_date && new Date(i.due_date) < now) late += i.amount_cents; }
      if (i.status === 'paid') paid += i.amount_cents;
    });
    var box = document.getElementById('stats');
    box.textContent = '';
    [[money(unpaid), 'Unpaid', 'owed'], [money(late), 'Overdue'], [money(paid), 'Collected']].forEach(function(it){
      box.appendChild(el('div', {className:'stat' + (it[2] ? ' ' + it[2] : '')}, [el('b', {text:it[0]}), el('span', {text:it[1]})]));
    });
  }

  function initInvoices(){
    sf.textContent = '';
    [['', 'All invoices'], ['open', 'Unpaid'], ['paid', 'Paid'], ['void', 'Void']].forEach(function(f){
      sf.appendChild(el('option', {value:f[0], text:f[1]}));
    });
    var tools = document.getElementById('tools');
    tools.insertBefore(el('button', {className:'go', type:'button', text:'New invoice',
      on:{click:function(){ invoiceDialog({}); }}}), tools.firstChild);
    q.placeholder = 'Search name, email, invoice #…';
    q.addEventListener('input', renderInvoices);
    sf.addEventListener('change', renderInvoices);
    renderInvoices();
  }

  function referBox(r, f){
    var box = el('div', {className:'refer'});
    box.appendChild(el('h3', {text:'World Class referral'}));

    if (r.referred_at) {
      box.appendChild(el('div', {className:'sent',
        text:'Referred ' + fmtLong(r.referred_at) + ' as PPT-' + r.id + ' — ' +
          (REF_LABEL[r.referral_status] || 'sent') + (r.referral_paid_at ? ', paid ' + fmt(r.referral_paid_at) : '') +
          '. Track the outcome in the Referral column.'}));
      return box;
    }

    var addr = el('input', {type:'text', value: r.address || '', placeholder:'Street, city, ZIP'});
    var piano = el('input', {type:'text', value: r.system || (f.pianos ? f.pianos + ' piano(s)' : ''), placeholder:'e.g. Yamaha U1 upright'});
    var times = el('input', {type:'text', value: f.preferred_dates || '', placeholder:'e.g. weekday mornings'});
    var note = el('textarea', {placeholder:'Anything World Class should know — gate code, pitch raise likely, etc.'});
    var tell = el('input', {type:'checkbox', disabled: !r.email});
    var mark = el('button', {className:'go full', type:'button', text:'Mark as referred'});
    var texter = el('a', {className:'ghost', text:'Text details'});
    var copier = el('button', {className:'ghost', type:'button', text:'Copy details'});
    var emailer = D.wcReady ? el('button', {className:'linkbtn', type:'button', text:'Or email it to World Class instead'}) : null;
    var msg = el('p', {className:'warn'});

    // Referrals go to a person by phone, so the details are laid out to
    // paste into a text. The contact is picked in Messages.
    function details(){
      return ['Tuning referral PPT-' + r.id, r.name, r.phone, r.email, addr.value.trim(),
        piano.value.trim() && 'Piano: ' + piano.value.trim(),
        times.value.trim() && 'Best times: ' + times.value.trim(),
        note.value.trim() && 'Note: ' + note.value.trim(),
        r.message && 'They said: ' + r.message
      ].filter(Boolean).join('\n');
    }
    function refreshText(){ texter.href = 'sms:?&body=' + encodeURIComponent(details()); }
    [addr, piano, times, note].forEach(function(i){ i.addEventListener('input', refreshText); });
    refreshText();
    copier.addEventListener('click', function(){
      navigator.clipboard.writeText(details()).then(function(){
        copier.textContent = 'Copied ✓'; setTimeout(function(){ copier.textContent = 'Copy details'; }, 1500);
      }, function(){ alert('Could not copy on this device — use Text details instead.'); });
    });

    function go(isManual){
      if (!isManual && !addr.value.trim() && !confirm('No address yet — send anyway? World Class will have to ask for it.')) return;
      var b = isManual ? mark : emailer, label = b.textContent;
      b.disabled = true; b.textContent = isManual ? 'Saving…' : 'Sending…'; msg.textContent = '';
      var before = Object.assign({}, r);
      post({action:'refer', id:r.id, manual:isManual, address:addr.value, system:piano.value,
            times:times.value, note:note.value, tellCustomer:tell.checked})
      .then(function(j){
        Object.assign(r, j.row);
        bumpRef(before, r); render(); openLead(r);
      }, function(e){ b.disabled = false; b.textContent = label; msg.textContent = e.message; });
    }
    mark.addEventListener('click', function(){ go(true); });
    if (emailer) emailer.addEventListener('click', function(){ go(false); });

    [['Address', addr], ['Piano', piano], ['Preferred times', times], ['Note for World Class', note]]
      .forEach(function(p){ box.appendChild(el('label', {text:p[0]})); box.appendChild(p[1]); });
    box.appendChild(el('div', {className:'pair'}, [texter, copier]));
    box.appendChild(el('label', {className:'chk'}, [tell,
      document.createTextNode(r.email ? 'Email ' + r.email + ' that World Class will call them' : 'No customer email on file')]));
    box.appendChild(mark);
    box.appendChild(msg);
    if (emailer) box.appendChild(el('p', null, [emailer]));
    return box;
  }

  dlg.addEventListener('click', function(e){ if (e.target === dlg) dlg.close(); });
  if (view === 'invoices') {
    initInvoices();
  } else {
    q.addEventListener('input', render);
    sf.addEventListener('change', render);
    renderStats();
    render();
  }
})();
