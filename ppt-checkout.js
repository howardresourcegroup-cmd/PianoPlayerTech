/* PPT Stripe checkout — call pptCheckout(priceId, email) */
(function () {
  var PK = 'pk_live_51TjLwYBmP21fsanu09EUMI42o9NF5oIu94SpjuydXrQYwTLASfSrQkcdScY9MDZHAtpJiK57nLmcwNXz0nYfNzqr00IsgUkHgv';
  var STANDARD_PRICE  = 'price_1TjTApBmP21fsanuIfmJ93d9';
  var BULK_PRICE      = 'price_1TjTApBmP21fsanuR2QOaYui';
  var DIAGNOSIS_PRICE = 'price_1TjTApBmP21fsanuzzToLLl3';

  var LABELS = {};
  LABELS[STANDARD_PRICE]  = '$175';
  LABELS[BULK_PRICE]      = '$125';
  LABELS[DIAGNOSIS_PRICE] = '$100';

  window.PPT_PRICES = { standard: STANDARD_PRICE, bulk: BULK_PRICE, diagnosis: DIAGNOSIS_PRICE };

  var overlay, stripeInst, elementsInst;

  function closeCheckout() {
    elementsInst = null;
    if (overlay) { overlay.remove(); overlay = null; }
  }

  function setStatus(msg) {
    var el = document.getElementById('ppt-co-status');
    if (el) { el.textContent = msg; el.style.display = 'block'; }
  }

  function buildModal(priceId) {
    var existing = document.getElementById('ppt-co-overlay');
    if (existing) existing.remove();

    var label = LABELS[priceId] || '';
    var o = document.createElement('div');
    o.id = 'ppt-co-overlay';
    o.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.82);z-index:9999;display:flex;align-items:center;justify-content:center;padding:1rem;';
    o.innerHTML =
      '<div id="ppt-co-modal" style="background:#1a1a1a;border:1px solid #c9a84c;border-radius:8px;width:100%;max-width:480px;max-height:90vh;overflow-y:auto;padding:2rem;position:relative;">' +
        '<button id="ppt-co-close" style="position:absolute;top:0.75rem;right:1rem;background:none;border:none;color:rgba(245,240,232,0.4);font-size:1.6rem;cursor:pointer;line-height:1;" aria-label="Close">&times;</button>' +
        '<p id="ppt-co-status" style="text-align:center;color:rgba(245,240,232,0.5);padding:2rem 1rem;font-family:Inter,sans-serif;font-size:0.9rem;">Loading secure checkout…</p>' +
        '<div id="ppt-co-form" style="display:none;">' +
          '<div id="ppt-co-element"></div>' +
          '<p id="ppt-co-err" style="display:none;color:#e57373;font-family:Inter,sans-serif;font-size:0.85rem;margin-top:0.75rem;"></p>' +
          '<button id="ppt-co-pay" style="width:100%;margin-top:1.25rem;padding:0.9rem;background:#c9a84c;color:#1a1a1a;border:none;border-radius:5px;font-family:Inter,sans-serif;font-weight:700;font-size:1rem;cursor:pointer;">Pay ' + label + '</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(o);
    overlay = o;
    document.getElementById('ppt-co-close').addEventListener('click', closeCheckout);
    o.addEventListener('click', function(e) { if (e.target === o) closeCheckout(); });
  }

  function mountElements(clientSecret, priceId) {
    elementsInst = stripeInst.elements({
      clientSecret: clientSecret,
      appearance: {
        theme: 'night',
        variables: {
          colorPrimary: '#c9a84c',
          colorBackground: '#1a1a1a',
          colorText: '#f5f0e8',
          colorTextSecondary: 'rgba(245,240,232,0.6)',
          colorDanger: '#e57373',
          borderRadius: '4px',
          fontFamily: 'Inter, sans-serif',
        }
      }
    });

    var pe = elementsInst.create('payment');
    pe.on('ready', function() {
      document.getElementById('ppt-co-status').style.display = 'none';
      document.getElementById('ppt-co-form').style.display = 'block';
    });
    pe.mount('#ppt-co-element');

    document.getElementById('ppt-co-pay').addEventListener('click', function() {
      var btn = document.getElementById('ppt-co-pay');
      var errEl = document.getElementById('ppt-co-err');
      btn.disabled = true;
      btn.textContent = 'Processing…';
      errEl.style.display = 'none';

      stripeInst.confirmPayment({
        elements: elementsInst,
        confirmParams: { return_url: 'https://pianoplayertech.com/checkout-return' },
      }).then(function(result) {
        if (result.error) {
          errEl.textContent = result.error.message;
          errEl.style.display = 'block';
          btn.disabled = false;
          btn.textContent = 'Pay ' + (LABELS[priceId] || '');
        }
        // On success Stripe redirects — no else needed
      });
    });
  }

  window.pptCheckout = function(priceId, email) {
    buildModal(priceId);

    fetch('/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ priceId: priceId, customerEmail: email || '' }),
    })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (!d.clientSecret) { setStatus('Something went wrong. Please call (470) 758-9572.'); return; }
      function proceed() {
        if (!stripeInst) stripeInst = Stripe(PK);
        mountElements(d.clientSecret, priceId);
      }
      if (window.Stripe) { proceed(); return; }
      var s = document.createElement('script');
      s.src = 'https://js.stripe.com/v3/';
      s.onload = proceed;
      s.onerror = function() { setStatus('Could not load payment. Please call (470) 758-9572.'); };
      document.head.appendChild(s);
    })
    .catch(function() { setStatus('Could not connect. Please call (470) 758-9572.'); });
  };
})();
