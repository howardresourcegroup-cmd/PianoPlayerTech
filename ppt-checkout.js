/* PPT embedded Stripe checkout — call pptCheckout(priceId, email) */
(function () {
  var PUBLISHABLE_KEY = 'pk_live_51SntOIKUqvlOAPcxuXEtYclQnSC9hx09UTj1QKnniZN6zIr8XeuO453C9eQ6JUYFKplMokljvF5RFGuoHehI6P4B00iRH0Wonz';
  var STANDARD_PRICE  = 'price_1The4pKUqvlOAPcx5t5xtN1w';  // tuning $175
  var BULK_PRICE      = 'price_1The4qKUqvlOAPcxeXhFVaUt';  // tuning $125
  var DIAGNOSIS_PRICE = 'price_1The93KUqvlOAPcx1mOLTkKf';  // diagnosis $100

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
      var appearance = {
        theme: 'night',
        variables: {
          colorPrimary: '#c9a84c',
          colorBackground: '#111111',
          colorText: '#f5f0e8',
          colorTextSecondary: 'rgba(245,240,232,0.55)',
          colorDanger: '#e05252',
          fontFamily: 'Inter, system-ui, sans-serif',
          borderRadius: '4px',
          spacingUnit: '5px',
        },
        rules: {
          '.Input': { border: '1.5px solid rgba(201,168,76,0.35)', backgroundColor: '#1a1a1a' },
          '.Input:focus': { border: '1.5px solid #c9a84c', boxShadow: 'none' },
          '.Label': { color: 'rgba(245,240,232,0.75)', fontWeight: '500' },
        }
      };
      stripe.initEmbeddedCheckout({ clientSecret: clientSecret, appearance: appearance })
        .then(function(co) {
          checkout = co;
          document.getElementById('ppt-co-loading').style.display = 'none';
          co.mount('#ppt-co-mount');
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
