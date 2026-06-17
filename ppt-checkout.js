/* PPT embedded Stripe checkout — call pptCheckout(priceId, email) */
(function () {
  var PUBLISHABLE_KEY = 'pk_test_51TjLwhB3gZVLUU4jEQ9Ao4T4NfMwsuAMtgDUuB0BKAd3OzpKUMbWH8zLPZMVSNH3IfoqP1Ey4SVlO72fWSYfBOF200hUeYR8lM';
  var STANDARD_PRICE  = 'price_1TjM1gB3gZVLUU4jymKmZdS3';  // tuning $175
  var BULK_PRICE      = 'price_1TjM2JB3gZVLUU4jQl20btyU';  // tuning $125
  var DIAGNOSIS_PRICE = 'price_1TjM1NB3gZVLUU4jf61090zE';  // diagnosis $100

  window.PPT_PRICES = { standard: STANDARD_PRICE, bulk: BULK_PRICE, diagnosis: DIAGNOSIS_PRICE };

  var overlay, checkoutDiv, stripe, checkout;

  function buildOverlay() {
    if (document.getElementById('ppt-co-overlay')) return;
    var o = document.createElement('div');
    o.id = 'ppt-co-overlay';
    o.innerHTML =
      '<div id="ppt-co-modal">' +
        '<button id="ppt-co-close" aria-label="Close">&times;</button>' +
        '<div id="ppt-co-loading"><p>Loading secure checkout&hellip;</p></div>' +
        '<div id="ppt-co-mount"></div>' +
      '</div>';
    o.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.78);z-index:9999;display:flex;align-items:center;justify-content:center;padding:1rem;';
    document.getElementById('ppt-co-modal') && o.querySelector('#ppt-co-modal').setAttribute('style',
      'background:#1a1a1a;border:1px solid #c9a84c;border-radius:8px;width:100%;max-width:520px;max-height:90vh;overflow-y:auto;padding:1.5rem;position:relative;');
    document.body.appendChild(o);
    // style modal properly after append
    var modal = document.getElementById('ppt-co-modal');
    modal.style.cssText = 'background:#1a1a1a;border:1px solid #c9a84c;border-radius:8px;width:100%;max-width:520px;max-height:90vh;overflow-y:auto;padding:1.5rem;position:relative;';
    var closeBtn = document.getElementById('ppt-co-close');
    closeBtn.style.cssText = 'position:absolute;top:0.75rem;right:1rem;background:none;border:none;color:rgba(245,240,232,0.5);font-size:1.5rem;cursor:pointer;line-height:1;';
    closeBtn.addEventListener('click', pptCheckoutClose);
    var loading = document.getElementById('ppt-co-loading');
    loading.style.cssText = 'text-align:center;color:rgba(245,240,232,0.6);padding:2rem;font-family:Inter,sans-serif;font-size:0.9rem;';
    o.addEventListener('click', function(e) { if (e.target === o) pptCheckoutClose(); });
    overlay = o;
  }

  function pptCheckoutClose() {
    if (checkout) { checkout.destroy(); checkout = null; }
    if (overlay) { overlay.remove(); overlay = null; }
  }

  window.pptCheckout = function(priceId, email) {
    buildOverlay();
    document.getElementById('ppt-co-loading').style.display = 'block';
    document.getElementById('ppt-co-mount').innerHTML = '';

    // Load Stripe.js once
    function mountCheckout(clientSecret) {
      if (!stripe) stripe = Stripe(PUBLISHABLE_KEY);
      stripe.initEmbeddedCheckout({ clientSecret: clientSecret })
        .then(function(co) {
          checkout = co;
          document.getElementById('ppt-co-loading').style.display = 'none';
          co.mount('#ppt-co-mount');
        })
        .catch(function(err) {
          document.getElementById('ppt-co-loading').innerHTML =
            '<p>Checkout failed to load. Please call us at (470) 758-9572.</p>';
          console.error('Stripe initEmbeddedCheckout error:', err);
        });
    }

    function loadStripeAndMount(clientSecret) {
      if (window.Stripe) { mountCheckout(clientSecret); return; }
      var s = document.createElement('script');
      s.src = 'https://js.stripe.com/v3/';
      s.onload = function() { mountCheckout(clientSecret); };
      document.head.appendChild(s);
    }

    fetch('/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ priceId: priceId, customerEmail: email || '' })
    })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d.clientSecret) {
        loadStripeAndMount(d.clientSecret);
      } else {
        document.getElementById('ppt-co-loading').innerHTML =
          '<p>Something went wrong. Please call us at (470) 758-9572.</p>';
      }
    })
    .catch(function() {
      document.getElementById('ppt-co-loading').innerHTML =
        '<p>Could not connect. Please call us at (470) 758-9572.</p>';
    });
  };
})();
