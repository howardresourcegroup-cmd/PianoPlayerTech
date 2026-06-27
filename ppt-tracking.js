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

  // Lead form submit — capture phase so it fires even when a handler
  // calls preventDefault() (e.g. the AJAX fetch forms).
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (f && f.tagName === 'FORM' && !f.hasAttribute('data-no-conversion')) {
      fire(window.PPT_CONV.lead);
    }
  }, true);
})();
