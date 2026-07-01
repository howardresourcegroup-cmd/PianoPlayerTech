/* PianoPlayerTech — Google Ads conversion tracking
 *
 * Fires a conversion to Google Ads (tag AW-18254090927) on the two actions
 * that matter for this business: a lead form submission and a tap-to-call.
 *
 * SETUP (one-time): in Google Ads -> Goals -> Conversions, create two
 * conversion actions and paste their labels below. A label looks like
 * "AW-18254090927/AbC-dEfGhIj". Until real labels are in place the guard
 * below makes this script a no-op, so it is safe to ship now.
 */
(function () {
  window.PPT_CONV = window.PPT_CONV || {
    lead: 'AW-18254090927/XVSRCPr89MQcEK-lnYBE', // "Submit lead form" conversion
    call: 'AW-18254090927/K0HlCPu8icUcEK-lnYBE'  // "Phone call clicks" conversion
  };

  function fire(sendTo) {
    if (typeof gtag !== 'function') return;
    if (!sendTo || /REPLACE_WITH/.test(sendTo)) return; // not configured yet
    gtag('event', 'conversion', { send_to: sendTo });
  }

  // Tap-to-call — any tel: link, anywhere on the page.
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href^="tel:"]');
    if (a) fire(window.PPT_CONV.call);
  });

  // Lead capture -> Airtable (via the /api/lead Pages Function, which holds
  // the Airtable token server-side). Uses sendBeacon so the write survives
  // the page navigation that native (non-AJAX) form submits trigger. It is
  // fire-and-forget and wrapped in try/catch, so it can never block or break
  // the Formspree submission. Add data-no-airtable to a form to skip it.
  function toAirtable(form) {
    try {
      if (!form || form.hasAttribute('data-no-airtable')) return;
      var fields = {};
      new FormData(form).forEach(function (value, key) {
        // Skip Formspree meta/honeypot fields (_subject, _next, _gotcha…) and blanks.
        if (key && key.charAt(0) !== '_' && String(value).trim() !== '') {
          fields[key] = value;
        }
      });
      var payload = {
        source: (location.pathname || '/') + (form.id ? ' #' + form.id : ''),
        page: location.href,
        fields: fields
      };
      var blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/lead', blob);
      } else {
        fetch('/api/lead', { method: 'POST', body: blob, keepalive: true }).catch(function () {});
      }
    } catch (err) { /* never let lead capture affect the form */ }
  }

  // Lead form submit — capture phase so it fires even when a handler
  // calls preventDefault() (e.g. the AJAX fetch forms).
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (!f || f.tagName !== 'FORM') return;
    toAirtable(f);
    if (!f.hasAttribute('data-no-conversion')) {
      fire(window.PPT_CONV.lead);
    }
  }, true);
})();
